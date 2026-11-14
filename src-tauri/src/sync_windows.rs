//! Автосинхронизация клипа с треком по звуку.
//!
//! Звук клипа YouTube недоступен странице (чужой фрейм), поэтому слушаем то, что приложение
//! выводит на устройство звука, и сравниваем с самим треком. Отпечаток каждые 10 мс:
//! нарастание громкости в 16 полосах спектра (точное время атак) и хрома — 12 нот
//! (аккорды отличают один такт песни от другого). Нормированная взаимная корреляция
//! находит, какое место трека звучит в записи, с точностью до миллисекунд.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rustfft::num_complex::Complex32;
use rustfft::FftPlanner;
use serde_json::{json, Value};

use crate::zvuk::{ApiError, ApiResult, ZvukClient};

/// Шаг признаков: 10 мс.
const HOP: f64 = 0.01;
/// Полос спектра (атаки).
const NF: usize = 16;
/// Нот в хроме.
const NC: usize = 12;
/// Размерность отпечатка кадра.
const NB: usize = NF + NC;
const F_LO: f64 = 90.0;
const F_HI: f64 = 9000.0;

type Frames = Vec<[f32; NB]>;

/// Каждое измерение отпечатка — к единичному разбросу, чтобы атаки и хрома весили одинаково.
fn standardize(f: &mut Frames) {
    let n = f.len().max(1) as f32;
    for b in 0..NB {
        let m = f.iter().map(|x| x[b]).sum::<f32>() / n;
        let sd = (f.iter().map(|x| (x[b] - m) * (x[b] - m)).sum::<f32>() / n).sqrt().max(1e-6);
        for x in f.iter_mut() {
            x[b] = (x[b] - m) / sd;
        }
    }
}

pub struct Reference {
    frames: Frames,
    duration: f64,
}

pub struct Sync {
    http: reqwest::Client,
    refs: Mutex<HashMap<String, Arc<Reference>>>,
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

// ---------- Признаки ----------
fn features(mono: &[f32], rate: u32) -> Frames {
    let hop = ((rate as f64) * HOP).round().max(1.0) as usize;
    let win = if rate > 32000 { 2048 } else { 1024 };
    if mono.len() < win + hop {
        return vec![];
    }
    let fft = FftPlanner::<f32>::new().plan_fft_forward(win);
    let hann: Vec<f32> = (0..win).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / win as f32).cos()).collect();
    // границы полос (логарифмически) в номерах бинов
    let edges: Vec<usize> = (0..=NF)
        .map(|k| {
            let f = F_LO * (F_HI / F_LO).powf(k as f64 / NF as f64);
            ((f * win as f64 / rate as f64).round() as usize).clamp(1, win / 2)
        })
        .collect();
    // нота каждого бина для хромы (110 Гц – 4 кГц)
    let pcs: Vec<Option<usize>> = (0..win / 2)
        .map(|k| {
            let f = k as f64 * rate as f64 / win as f64;
            if !(110.0..=4000.0).contains(&f) {
                return None;
            }
            Some(((12.0 * (f / 440.0).log2()).round() as i64 + 69).rem_euclid(12) as usize)
        })
        .collect();
    let n = (mono.len() - win) / hop + 1;
    let mut out = Vec::with_capacity(n);
    let mut buf = vec![Complex32::new(0.0, 0.0); win];
    let mut prev = [0f32; NF];
    for i in 0..n {
        let s = i * hop;
        for j in 0..win {
            buf[j] = Complex32::new(mono[s + j] * hann[j], 0.0);
        }
        fft.process(&mut buf);
        let mut fr = [0f32; NB];
        let mut cur = [0f32; NF];
        for b in 0..NF {
            let (a, z) = (edges[b], edges[b + 1].max(edges[b] + 1));
            let mut e = 0f32;
            for k in a..z {
                e += buf[k].norm_sqr();
            }
            cur[b] = (1e-9 + e / (z - a) as f32).ln();
            if i > 0 {
                fr[b] = (cur[b] - prev[b]).max(0.0);
            }
        }
        prev = cur;
        let mut chroma = [0f32; NC];
        for (k, pc) in pcs.iter().enumerate() {
            if let Some(p) = pc {
                chroma[*p] += buf[k].norm();
            }
        }
        let sum = chroma.iter().sum::<f32>() + 1e-6;
        for c in 0..NC {
            fr[NF + c] = chroma[c] / sum;
        }
        out.push(fr);
    }
    standardize(&mut out);
    out
}

/// Ищет запись (query) внутри опорного трека в диапазоне сдвигов [lo, hi] (в кадрах).
/// Возвращает (сдвиг с долями кадра, уверенность — корреляция по хроме, лучшая хрома в другом месте песни).
fn best_match(q: &Frames, r: &Frames, lo: isize, hi: isize) -> Option<(f64, f32, f32)> {
    let c = matches(q, r, lo, hi, 2);
    let (lag, score) = *c.first()?;
    Some((lag, score, c.get(1).map(|x| x.1).unwrap_or(0.0).max(0.0)))
}

/// Несколько лучших мест трека для записи (не ближе 0,5 с друг к другу), лучшие первыми:
/// (сдвиг с долями кадра, корреляция по хроме). Повторяющийся припев или вступление из одного
/// аккорда дают несколько почти равных мест — какое из них верное, решает сверка нескольких замеров.
fn matches(q: &Frames, r: &Frames, lo: isize, hi: isize, k: usize) -> Vec<(f64, f32)> {
    // 1) грубо — по хроме: аккорды отличают одно место песни от другого (атаки повторяются каждый такт)
    let Some((clo, cs)) = ncc_scores(q, r, lo, hi, NF..NB) else { return vec![] };
    let mut idx: Vec<usize> = (0..cs.len()).collect();
    idx.sort_unstable_by(|a, b| cs[*b].total_cmp(&cs[*a]));
    let mut peaks: Vec<usize> = Vec::with_capacity(k);
    for i in idx {
        if peaks.len() == k {
            break;
        }
        if peaks.iter().all(|p| (*p as isize - i as isize).abs() > 50) {
            peaks.push(i);
        }
    }
    peaks
        .into_iter()
        .filter_map(|ci| {
            // 2) точно — по всему отпечатку (атаки дают миллисекунды) в окрестности ±0,25 с
            let center = clo + ci as isize;
            let (flo, fs) = ncc_scores(q, r, center - 25, center + 25, 0..NB)?;
            let (fi, &fbest) = fs.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1))?;
            // уточнение пика параболой — доли кадра (миллисекунды)
            let mut frac = 0f64;
            if fi > 0 && fi + 1 < fs.len() {
                let (y0, y1, y2) = (fs[fi - 1] as f64, fbest as f64, fs[fi + 1] as f64);
                let den = y0 - 2.0 * y1 + y2;
                if den.abs() > 1e-9 {
                    frac = (0.5 * (y0 - y2) / den).clamp(-0.5, 0.5);
                }
            }
            // уверенность — по грубому этапу (насколько это место похоже по аккордам)
            Some(((flo + fi as isize) as f64 + frac, cs[ci]))
        })
        .collect()
}

/// Нормированная взаимная корреляция записи с треком для каждого сдвига в [lo, hi]
/// по измерениям отпечатка `dims` (хрома — `NF..NB`, весь отпечаток — `0..NB`).
fn ncc_scores(q: &Frames, r: &Frames, lo: isize, hi: isize, dims: std::ops::Range<usize>) -> Option<(isize, Vec<f32>)> {
    let n = q.len();
    if n < 50 || r.len() < n {
        return None;
    }
    let max_lag = (r.len() - n) as isize;
    let (lo, hi) = (lo.clamp(0, max_lag), hi.clamp(0, max_lag));
    if lo > hi {
        return None;
    }
    let (d0, d1) = (dims.start, dims.end);
    // запись: центрируем каждую полосу и нормируем целиком
    let mut qz = q.clone();
    for b in d0..d1 {
        let m = q.iter().map(|f| f[b]).sum::<f32>() / n as f32;
        for f in qz.iter_mut() {
            f[b] -= m;
        }
    }
    let qn = qz.iter().flat_map(|f| f[d0..d1].iter()).map(|x| x * x).sum::<f32>().sqrt();
    if qn < 1e-6 {
        return None;
    }
    // префиксные суммы опорного трека для среднего и дисперсии окна — только по нужному отрезку [lo, hi + n)
    let base = lo as usize;
    let m = hi as usize + n - base;
    let mut s1 = vec![[0f64; NB]; m + 1];
    let mut s2 = vec![[0f64; NB]; m + 1];
    for i in 0..m {
        let x = &r[base + i];
        for b in d0..d1 {
            s1[i + 1][b] = s1[i][b] + x[b] as f64;
            s2[i + 1][b] = s2[i][b] + (x[b] as f64) * (x[b] as f64);
        }
    }
    let count = (hi - lo + 1) as usize;
    let mut scores = vec![0f32; count];
    for (k, lag) in (lo..=hi).enumerate() {
        let l = lag as usize;
        let mut dot = 0f32;
        for t in 0..n {
            let (a, c) = (&qz[t], &r[l + t]);
            for b in d0..d1 {
                dot += a[b] * c[b];
            }
        }
        let mut var = 0f64;
        let j = l - base;
        for b in d0..d1 {
            let sum = s1[j + n][b] - s1[j][b];
            let sq = s2[j + n][b] - s2[j][b];
            var += (sq - sum * sum / n as f64).max(0.0);
        }
        let rn = var.sqrt() as f32;
        scores[k] = if rn > 1e-6 { dot / (qn * rn) } else { 0.0 };
    }
    Some((lo, scores))
}

// ---------- Декодирование трека ----------
fn decode_mono(bytes: Vec<u8>) -> Result<(Vec<f32>, u32), String> {
    use symphonia::core::codecs::audio::AudioDecoderOptions;
    use symphonia::core::errors::Error;
    use symphonia::core::formats::probe::Hint;
    use symphonia::core::formats::{FormatOptions, TrackType};
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;

    let mss = MediaSourceStream::new(Box::new(std::io::Cursor::new(bytes)), Default::default());
    let mut format = symphonia::default::get_probe()
        .probe(&Hint::new(), mss, FormatOptions::default(), MetadataOptions::default())
        .map_err(|e| format!("формат: {e}"))?;
    let track = format.default_track(TrackType::Audio).ok_or("нет звуковой дорожки")?;
    let params = track.codec_params.as_ref().and_then(|p| p.audio()).ok_or("нет параметров звука")?.clone();
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&params, &AudioDecoderOptions::default())
        .map_err(|e| format!("декодер: {e}"))?;
    let mut mono: Vec<f32> = Vec::new();
    let mut rate = params.sample_rate.unwrap_or(44100);
    let mut inter: Vec<f32> = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) => break,
            Err(Error::IoError(_)) => break,
            Err(e) => return Err(format!("чтение: {e}")),
        };
        if packet.track_id != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(buf) => {
                rate = buf.spec().rate();
                let ch = buf.spec().channels().count().max(1);
                inter.resize(buf.samples_interleaved(), 0.0);
                buf.copy_to_slice_interleaved(&mut inter);
                for f in inter.chunks_exact(ch) {
                    mono.push(f.iter().sum::<f32>() / ch as f32);
                }
            }
            Err(Error::DecodeError(_)) => {}
            Err(_) => break,
        }
    }
    if mono.is_empty() {
        return Err("пустой звук".into());
    }
    Ok((mono, rate))
}

// ---------- Захват звука приложения ----------
struct Capture {
    mono: Vec<f32>,
    rate: u32,
    /// время (мс от эпохи) первого записанного сэмпла — с постоянной поправкой, которая сокращается при расчёте
    start_ms: f64,
    rms: f32,
}

/// Время QueryPerformanceCounter в единицах 100 нс (так WASAPI ставит метки пакетов).
fn qpc_100ns() -> u64 {
    use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
    let (mut c, mut f) = (0i64, 0i64);
    unsafe {
        let _ = QueryPerformanceCounter(&mut c);
        let _ = QueryPerformanceFrequency(&mut f);
    }
    if f <= 0 {
        return 0;
    }
    (c as u128 * 10_000_000 / f as u128) as u64
}

/// Записывает то, что звучит на устройстве вывода по умолчанию (там же играет и приложение).
/// Захват именно процесса WebView2 Windows отдаёт тишиной, поэтому слушаем устройство целиком:
/// посторонние звуки других программ могут помешать — тогда совпадение окажется неуверенным.
fn capture(seconds: f64) -> Result<Capture, String> {
    use wasapi::{Direction, SampleType, StreamMode, WaveFormat};
    let _ = wasapi::initialize_mta();
    let en = wasapi::DeviceEnumerator::new().map_err(|e| format!("звук недоступен: {e}"))?;
    let dev = en.get_default_device(Direction::Render).map_err(|e| format!("нет устройства вывода звука: {e}"))?;
    let mut client = dev.get_iaudioclient().map_err(|e| format!("захват звука: {e}"))?;
    let rate = 48000u32;
    let fmt = WaveFormat::new(32, 32, SampleType::Float, rate as usize, 2, None);
    client
        .initialize_client(&fmt, Direction::Capture, StreamMode::PollingShared { autoconvert: true, buffer_duration_hns: 2_000_000 }, None)
        .map_err(|e| format!("захват звука: {e}"))?;
    let cap = client.get_audiocaptureclient().map_err(|e| e.to_string())?;
    let need = (seconds * rate as f64) as usize;
    let mut mono: Vec<f32> = Vec::with_capacity(need + 9600);
    // кандидаты времени первого сэмпла: по меткам QPC пакетов и (запасной вариант) по моменту чтения
    let mut by_qpc: Vec<f64> = Vec::new();
    let mut by_read: Vec<f64> = Vec::new();
    let mut buf: Vec<u8> = Vec::new();
    client.start_stream().map_err(|e| e.to_string())?;
    let t_begin = Instant::now();
    let deadline = Duration::from_secs_f64(seconds + 4.0);
    while mono.len() < need {
        if t_begin.elapsed() > deadline {
            let _ = client.stop_stream();
            return Err("нет звука на устройстве вывода — включите музыку".into());
        }
        std::thread::sleep(Duration::from_millis(4));
        loop {
            let frames = match cap.get_next_packet_size() {
                Ok(Some(n)) if n > 0 => n as usize,
                _ => break,
            };
            buf.resize(frames * 8, 0);
            let (got, info) = cap.read_from_device(&mut buf).map_err(|e| e.to_string())?;
            let (t, q) = (now_ms(), qpc_100ns());
            let before = mono.len() as f64 / rate as f64 * 1000.0;
            for f in buf[..got as usize * 8].chunks_exact(8) {
                let l = f32::from_le_bytes([f[0], f[1], f[2], f[3]]);
                let r = f32::from_le_bytes([f[4], f[5], f[6], f[7]]);
                mono.push(0.5 * (l + r));
            }
            if info.timestamp > 0 && q >= info.timestamp && !info.flags.timestamp_error {
                by_qpc.push(t - (q - info.timestamp) as f64 / 10_000.0 - before);
            }
            by_read.push(t - mono.len() as f64 / rate as f64 * 1000.0);
        }
    }
    let _ = client.stop_stream();
    let pick = |mut v: Vec<f64>, q: f64| -> Option<f64> {
        if v.len() < 5 {
            return None;
        }
        v.sort_by(|a, b| a.total_cmp(b));
        Some(v[((v.len() - 1) as f64 * q) as usize])
    };
    // метки QPC точные — берём медиану; иначе нижний процентиль по моментам чтения
    let start_ms = pick(by_qpc, 0.5).or_else(|| pick(by_read, 0.05)).ok_or("нет звука на устройстве вывода")?;
    let rms = (mono.iter().map(|x| x * x).sum::<f32>() / mono.len() as f32).sqrt();
    Ok(Capture { mono, rate, start_ms, rms })
}

/// Служебная проверка захвата: устройство, уровень звука и согласие двух способов оценки времени.
pub fn diag_capture(seconds: f64) -> String {
    let name = wasapi::DeviceEnumerator::new()
        .ok()
        .and_then(|en| en.get_default_device(wasapi::Direction::Render).ok())
        .and_then(|d| d.get_friendlyname().ok())
        .unwrap_or_default();
    match capture(seconds) {
        Ok(c) => format!("устройство «{name}»: rms={:.6} сэмплов={} начало={:.1}", c.rms, c.mono.len(), c.start_ms),
        Err(e) => format!("устройство «{name}»: ошибка: {e}"),
    }
}

/// Служебно: сохранить звук (сырые f32) в папку из ZG_SYNC_DUMP — для разбора сравнения вне приложения.
fn dump(name: &str, mono: &[f32], rate: u32) {
    let Some(dir) = std::env::var_os("ZG_SYNC_DUMP") else { return };
    let dir = std::path::PathBuf::from(dir);
    let _ = std::fs::create_dir_all(&dir);
    let bytes: Vec<u8> = mono.iter().flat_map(|x| x.to_le_bytes()).collect();
    let _ = std::fs::write(dir.join(format!("{name}-{rate}.f32")), bytes);
}

fn read_f32(path: &std::path::Path) -> Option<(Vec<f32>, u32)> {
    let name = path.file_stem()?.to_str()?;
    let rate: u32 = name.rsplit('-').next()?.parse().ok()?;
    let b = std::fs::read(path).ok()?;
    Some((b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect(), rate))
}

/// Служебно: профиль совпадения записей из папки с опорным треком для разных вариантов отпечатка.
pub fn diag_match(dir: &std::path::Path) -> String {
    let mut out = String::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return "нет папки".into() };
    let files: Vec<_> = rd.flatten().map(|e| e.path()).collect();
    let Some((rmono, rrate)) = files.iter().find(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("ref-"))).and_then(|p| read_f32(p)) else {
        return "нет ref".into();
    };
    let rfull = features(&rmono, rrate);
    let mut caps: Vec<_> = files.iter().filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("cap-"))).collect();
    caps.sort();
    let mask = |f: &Frames, keep: &dyn Fn(usize) -> bool| -> Frames {
        f.iter().map(|x| {
            let mut y = *x;
            for b in 0..NB {
                if !keep(b) {
                    y[b] = 0.0;
                }
            }
            y
        }).collect()
    };
    for c in caps {
        let Some((cm, cr)) = read_f32(c) else { continue };
        let rms = (cm.iter().map(|x| x * x).sum::<f32>() / cm.len().max(1) as f32).sqrt();
        out.push_str(&format!("\n{} rms={rms:.5} {:.1}s", c.file_name().unwrap().to_string_lossy(), cm.len() as f32 / cr as f32));
        // громкие записи (звук клипа) — проверка гипотезы о другой скорости воспроизведения
        if rms > 0.02 {
            let mut line = String::from("\n   скорость:");
            for k in -12..=12 {
                let sp = 1.0 + k as f64 * 0.005;
                // запись, «проигранная» со скоростью sp: читаем исходник шагом sp
                let len = ((cm.len() as f64 - 2.0) / sp) as usize;
                let rs: Vec<f32> = (0..len)
                    .map(|i| {
                        let x = i as f64 * sp;
                        let j = x as usize;
                        let f = (x - j as f64) as f32;
                        cm[j] * (1.0 - f) + cm[j + 1] * f
                    })
                    .collect();
                let qq = features(&rs, cr);
                if let Some((_, s)) = ncc_scores(&qq, &rfull, 0, isize::MAX, 0..NB) {
                    let best = s.iter().cloned().fold(f32::MIN, f32::max);
                    line.push_str(&format!(" {sp:.3}:{best:.2}"));
                }
            }
            out.push_str(&line);
        }
        let q = features(&cm, cr);
        if let Some((lag, sc, sec)) = best_match(&q, &rfull, 0, isize::MAX) {
            out.push_str(&format!("\n   итог (2 этапа): {:.3}с уверенность {sc:.2} против {sec:.2}", lag * HOP));
        }
        let variants: [(&str, &dyn Fn(usize) -> bool); 3] = [("все", &|_| true), ("атаки", &|b| b < NF), ("хрома", &|b| b >= NF)];
        for (name, keep) in variants {
            let (qq, rr) = (mask(&q, keep), mask(&rfull, keep));
            if let Some((lo, s)) = ncc_scores(&qq, &rr, 0, isize::MAX, 0..NB) {
                let mut idx: Vec<usize> = (0..s.len()).collect();
                idx.sort_by(|a, b| s[*b].total_cmp(&s[*a]));
                let mut peaks: Vec<usize> = vec![];
                for i in idx {
                    if peaks.iter().all(|p| (*p as isize - i as isize).abs() > 50) {
                        peaks.push(i);
                    }
                    if peaks.len() == 4 {
                        break;
                    }
                }
                let txt: Vec<String> = peaks.iter().map(|i| format!("{:.2}с:{:.2}", (lo + *i as isize) as f64 * HOP, s[*i])).collect();
                out.push_str(&format!("\n   {name}: {}", txt.join("  ")));
            }
        }
    }
    out
}

/// Устройство вывода по умолчанию (id): задержка звукового тракта у каждого устройства своя.
pub async fn output_device() -> String {
    tauri::async_runtime::spawn_blocking(|| {
        let _ = wasapi::initialize_mta();
        wasapi::DeviceEnumerator::new()
            .ok()
            .and_then(|en| en.get_default_device(wasapi::Direction::Render).ok())
            .and_then(|d| d.get_id().ok())
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

impl Sync {
    pub fn new() -> Self {
        let http = reqwest::Client::builder().user_agent(crate::zvuk::user_agent()).connect_timeout(Duration::from_secs(15)).timeout(Duration::from_secs(90)).build().expect("http");
        Self { http, refs: Mutex::new(HashMap::new()) }
    }

    /// Скачивает и разбирает трек (лёгкий поток 128 кбит/с — для сравнения его хватает).
    pub async fn prepare(&self, client: &ZvukClient, track_id: &str) -> ApiResult<Value> {
        if let Some(r) = self.refs.lock().unwrap().get(track_id) {
            return Ok(json!({ "duration": r.duration }));
        }
        let st = client.get_stream(track_id, "mid").await?;
        let url = st.get("url").and_then(Value::as_str).ok_or_else(|| ApiError::new("NO_STREAM", "нет потока"))?.to_string();
        let bytes = self
            .http
            .get(&url)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| ApiError::new("NETWORK", format!("не удалось скачать трек: {}", crate::zvuk::short_err(&e))))?
            .bytes()
            .await
            .map_err(|e| ApiError::new("NETWORK", format!("не удалось скачать трек: {}", crate::zvuk::short_err(&e))))?
            .to_vec();
        let reference = tauri::async_runtime::spawn_blocking(move || -> Result<Reference, String> {
            let (mono, rate) = decode_mono(bytes)?;
            dump("ref", &mono, rate);
            let duration = mono.len() as f64 / rate as f64;
            Ok(Reference { frames: features(&mono, rate), duration })
        })
        .await
        .map_err(|e| ApiError::new("SYNC", e.to_string()))?
        .map_err(|e| ApiError::new("DECODE", format!("не удалось разобрать трек: {e}")))?;
        let duration = reference.duration;
        let mut refs = self.refs.lock().unwrap();
        if refs.len() > 4 {
            refs.clear();
        }
        refs.insert(track_id.to_string(), Arc::new(reference));
        Ok(json!({ "duration": duration }))
    }

    /// Записывает звук приложения и находит, какое место трека в нём звучит.
    /// lo/hi — где искать (секунды трека). Возвращает позицию первого записанного сэмпла.
    pub async fn measure(&self, track_id: &str, seconds: f64, lo: f64, hi: f64) -> ApiResult<Value> {
        let reference = self
            .refs
            .lock()
            .unwrap()
            .get(track_id)
            .cloned()
            .ok_or_else(|| ApiError::new("SYNC", "трек ещё не подготовлен"))?;
        let seconds = seconds.clamp(2.0, 12.0);
        tauri::async_runtime::spawn_blocking(move || -> ApiResult<Value> {
            let c = capture(seconds).map_err(|m| ApiError::new("CAPTURE", m))?;
            if c.rms < 2e-5 {
                return Err(ApiError::new(
                    "SILENT",
                    format!("звук не слышен — проверьте громкость в приложении (уровень {:.6}, {} сэмплов)", c.rms, c.mono.len()),
                ));
            }
            dump(&format!("cap-{}", c.start_ms as u64), &c.mono, c.rate);
            let q = features(&c.mono, c.rate);
            let (lo_f, hi_f) = ((lo / HOP).floor() as isize, (hi / HOP).ceil() as isize);
            // несколько мест-кандидатов: при повторах в песне решает сверка нескольких замеров
            let c6 = matches(&q, &reference.frames, lo_f, hi_f, 6);
            let (lag, score) = *c6.first().ok_or_else(|| ApiError::new("NOMATCH", "не удалось сравнить звук"))?;
            let second = c6.get(1).map(|x| x.1).unwrap_or(0.0).max(0.0);
            let cands: Vec<Value> = c6.iter().map(|(l, s)| json!({ "pos": l * HOP, "score": s })).collect();
            Ok(json!({
                "pos": lag * HOP,
                "score": score,
                "second": second,
                "cands": cands,
                "startMs": c.start_ms,
                "rms": c.rms,
                "duration": reference.duration,
            }))
        })
        .await
        .map_err(|e| ApiError::new("SYNC", e.to_string()))?
    }
}
