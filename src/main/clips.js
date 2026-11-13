'use strict';
/**
 * Поиск официальных клипов на YouTube (YouTube Data API v3, ключ пользователя) и кэш найденного.
 * Работает в чистом Node.js: ключ передаётся вызывающим кодом.
 */
const fs = require('node:fs');
const path = require('node:path');

const API = 'https://www.googleapis.com/youtube/v3';

class ClipError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** ISO 8601 (PT3M25S) → секунды */
function isoDur(s) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(s || '');
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

const BAD = ['lyric', 'lyrics', 'текст', 'караоке', 'karaoke', 'cover', 'кавер', 'live', 'концерт', 'concert', 'reaction', 'реакция', 'remix', 'ремикс', 'speed up', 'sped up', 'slowed', '8d', 'nightcore', 'instrumental', 'минус', 'tutorial', 'разбор', 'fan made', 'fanmade', 'visualizer', 'audio', 'аудио', 'teaser', 'тизер', 'trailer', 'snippet', 'acoustic'];

/** Оценка «насколько это официальный клип именно этого трека». */
function scoreCandidate(v, track) {
  const t = norm(v.title);
  const ch = norm(v.channel);
  const artist = norm((track.artists || [])[0] || '');
  const tt = norm(track.title);
  let s = 0;
  if (tt && t.includes(tt)) s += 4;
  if (artist && (t.includes(artist) || ch.includes(artist))) s += 3;
  if (artist && ch.replace(/ (official|music|vevo)$/, '').includes(artist)) s += 1;
  if (/vevo$/.test(ch.replace(/\s/g, ''))) s += 2;
  if (/(official|официальн|клип|music video|\bmv\b)/.test(t)) s += 2;
  if (/ topic$/.test(ch)) s -= 5; // автоканалы YouTube с одной обложкой
  for (const w of BAD) if (t.includes(w) && !tt.includes(w)) s -= 3;
  if (track.duration && v.dur) {
    const d = Math.abs(v.dur - track.duration);
    if (d <= 12) s += 2;
    else if (d > 90) s -= 2;
  }
  return s;
}

function apiError(j, status) {
  const reason = j?.error?.errors?.[0]?.reason || '';
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') return new ClipError('Дневной лимит поиска YouTube исчерпан — найденные клипы продолжат работать', 'QUOTA');
  if (reason === 'keyInvalid' || /API key not valid/i.test(j?.error?.message || '')) return new ClipError('Ключ YouTube недействителен', 'BAD_KEY');
  if (reason === 'accessNotConfigured' || /has not been used|is disabled/i.test(j?.error?.message || ''))
    return new ClipError('В проекте Google не включён «YouTube Data API v3»', 'API_DISABLED');
  return new ClipError(j?.error?.message || `Ошибка YouTube (HTTP ${status})`, 'API');
}

async function getJson(url) {
  let r;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw new ClipError('YouTube недоступен: ' + e.message, 'NETWORK');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw apiError(j, r.status);
  return j;
}

/** Проверка ключа самым дешёвым запросом (1 единица квоты). */
async function checkKey(key) {
  await getJson(`${API}/videos?${new URLSearchParams({ part: 'id', id: 'dQw4w9WgXcQ', key })}`);
  return true;
}

/** Поиск кандидатов: track = { id, title, artists: [названия], duration } */
async function search(key, track) {
  const artist = (track.artists || [])[0] || '';
  const cyr = /[а-яё]/i.test(track.title + artist);
  const q = `${artist} ${track.title} ${cyr ? 'клип' : 'official video'}`.trim();
  const j = await getJson(`${API}/search?${new URLSearchParams({ part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: '8', q, key })}`);
  const ids = (j.items || []).map((i) => i.id && i.id.videoId).filter(Boolean);
  if (!ids.length) return [];
  const d = await getJson(`${API}/videos?${new URLSearchParams({ part: 'contentDetails,status,snippet', id: ids.join(','), key })}`);
  const cands = (d.items || [])
    .filter((v) => v.status?.embeddable !== false)
    .map((v) => ({ id: v.id, title: v.snippet?.title || '', channel: v.snippet?.channelTitle || '', dur: isoDur(v.contentDetails?.duration) }));
  for (const c of cands) c.score = scoreCandidate(c, track);
  cands.sort((a, b) => b.score - a.score);
  return cands;
}

/** Кэш найденного: { trackId: { cands, pick, manual, offset, at } } — хранится в отдельном файле. */
class ClipCache {
  constructor(dir) {
    this.file = path.join(dir, 'clips.json');
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
    this._t = null;
  }
  get(id) {
    return this.data[String(id)] || null;
  }
  set(id, entry) {
    this.data[String(id)] = entry;
    this.save();
    return entry;
  }
  clear() {
    this.data = {};
    this.save();
  }
  get size() {
    return Object.keys(this.data).length;
  }
  save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.data));
      } catch {}
    }, 300);
  }
}

/** Достаёт id ролика из ссылки YouTube (watch, youtu.be, shorts, embed) или из самого id. */
function parseVideoId(text) {
  const s = String(text || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/);
  return m ? m[1] : null;
}

module.exports = { search, checkKey, scoreCandidate, parseVideoId, ClipCache, ClipError, isoDur };
