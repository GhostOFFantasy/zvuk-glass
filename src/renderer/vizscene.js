'use strict';
/* Сцена визуализатора: фон (обложка / своя картинка / своё видео), мягкая визуализация под ритм и компактная панель настроек.
   Используется во вкладке «Визуализатор» и внутри полноэкранного плеера. */
(function () {
  const STYLES = [
    { id: 'waves', name: 'Волны', icon: 'wave' },
    { id: 'aura', name: 'Аура', icon: 'sparkle' },
    { id: 'bars', name: 'Столбцы', icon: 'viz' },
    { id: 'ring', name: 'Кольцо', icon: 'album' },
    { id: 'off', name: 'Выкл', icon: 'close' },
  ];
  const BGS = [
    { id: 'cover', name: 'Обложка', icon: 'album' },
    { id: 'image', name: 'Картинка', icon: 'image' },
    { id: 'video', name: 'Видео', icon: 'video' },
    { id: 'clip', name: 'Клип', icon: 'film' },
  ];
  const OLD = { mirror: 'bars', particles: 'aura', wave: 'waves' };

  function settings() {
    const v = App.settings.viz || (App.settings.viz = {});
    if (OLD[v.style]) v.style = OLD[v.style];
    if (!STYLES.some((s) => s.id === v.style)) v.style = 'waves';
    if (!v.bg) v.bg = Custom.media.vizVideo ? 'video' : 'cover';
    if (v.dim == null) v.dim = 35;
    if (v.sensitivity == null) v.sensitivity = 1;
    if (v.pulse == null) v.pulse = true;
    return v;
  }
  const save = debounce(() => window.zvuk.settings.set({ viz: App.settings.viz }), 300);

  function vizOpts(v, centerFn) {
    const common = { soft: true, idle: true, maxDpr: 1, sensitivity: v.sensitivity, glow: false };
    if (v.style === 'waves') return { ...common, style: 'waves' };
    if (v.style === 'aura') return { ...common, style: 'aura', centerFn };
    if (v.style === 'bars') return { ...common, style: 'bars', bars: 64 };
    if (v.style === 'off') return { ...common, style: 'none', idle: false };
    return { ...common, style: 'orbit', centerFn };
  }

  /** Автосинхронизация по звуку: переключатель и состояние. */
  function autoBlock() {
    // на телефоне звук устройства слушать нельзя — подстройка по звуку есть только в Windows-версии
    if (window.ZG_MOBILE) return '';
    const on = Clip.auto;
    const s = Clip.sync;
    const a = Clip.autoInfo;
    let line = '';
    if (on) {
      if (s.state === 'run') line = `<div class="vz-sync run"><i></i>${esc(s.message)}</div>`;
      else if (s.state === 'fail') line = `<div class="vz-sync err">${esc(s.message)}</div>`;
      else if (s.state === 'wait') line = `<div class="vz-sync">${esc(s.message)}</div>`;
      else if (a) line = `<div class="vz-sync ok">${icon('check')}Подстроено по звуку · точность около 0,03 с</div>`;
      else line = '<div class="vz-sync">Подстройка начнётся, когда пойдёт клип: около 10 секунд, на пару секунд звук пойдёт из клипа. Другие звуки на компьютере лучше приглушить.</div>';
    }
    const busy = s.state === 'run';
    return `<div class="vz-auto">
      <div class="vz-auto-row"><button class="switch${on ? ' on' : ''}" data-vclip="auto"${busy ? ' disabled' : ''}></button>
        <span>Автосинхронизация<small>губы в такт: сдвиг по звуку клипа</small></span>
        ${on && !busy && (a || s.state === 'fail') ? `<button class="btn small" data-vclip="recal" title="Измерить заново">${icon('refresh')}</button>` : ''}</div>
      ${line}
    </div>`;
  }

  /** Блок «Клип» в панели настроек сцены. */
  function clipBlock() {
    const st = Clip.status;
    const info = Clip.info;
    const off = Clip.offset;
    let line = '';
    if (st === 'loading') line = '<span>Ищем официальный клип…</span>';
    else if (st === 'ok' && info) line = `<b>${esc(info.title)}</b><span>${esc(info.channel)}</span>`;
    else if (st === 'nokey') line = '<span>Для автопоиска нужен ключ YouTube. Можно и без него — вставьте ссылку на клип.</span>';
    else if (st === 'none') line = '<span>Официальный клип не найден. Попробуйте «Другой» или вставьте ссылку.</span>';
    else if (st === 'error') line = `<span class="err">${esc(Clip.message)}</span>`;
    else line = '<span>Клип появится, когда заиграет трек</span>';
    const hasMore = Clip.entry && Clip.entry.cands && Clip.entry.cands.length > 1;
    return `<div class="vz-clip">${line}
      <div class="vz-clip-btns">
        ${hasMore ? `<button class="btn small" data-vclip="next">${icon('refresh')}Другой</button>` : ''}
        <button class="btn small" data-vclip="link">${icon('link')}Ссылка</button>
        ${st === 'ok' && info ? `<button class="btn small" data-vclip="open" title="Открыть на YouTube">${icon('external')}</button>` : ''}
        ${st === 'nokey' ? `<button class="btn small primary" data-vclip="settings">${icon('settings')}Ключ</button>` : ''}
      </div>
      ${st === 'ok' ? autoBlock() : ''}
      ${st === 'ok' ? `<div class="vz-offset${Clip.auto ? ' locked' : ''}" title="${Clip.auto ? 'Недоступно, пока включена автосинхронизация' : 'Если клип опережает или отстаёт от музыки'}"><span>Сдвиг</span>
        <button class="btn small" data-vclip="minus"${Clip.auto ? ' disabled' : ''}>−1 с</button><b>${off > 0 ? '+' : ''}${off.toFixed(Clip.auto && Clip.autoInfo ? 2 : 1)} с</b><button class="btn small" data-vclip="plus"${Clip.auto ? ' disabled' : ''}>+1 с</button></div>` : ''}
      <div class="vz-q">
        <div class="vz-q-head"><span>Качество клипа</span>${Clip.actualQuality ? `<small title="Что YouTube показывает сейчас">сейчас ${esc(Clip.actualQuality)}</small>` : ''}</div>
        <div class="vz-q-opts">${Clip.QLIST.map(([id, label]) => `<button class="vz-qb${Clip.quality === id ? ' on' : ''}" data-vclipq="${id}">${label}</button>`).join('')}</div>
      </div>
    </div>`;
  }

  const VizScene = {
    STYLES,
    BGS,
    /**
     * layer — куда положить фон и холст; host — куда добавить кнопку и панель настроек;
     * kind: 'tab' | 'np'; centerFn(canvas) → { x, y, r } центр обложки.
     */
    mount({ layer, host, kind, centerFn }) {
      const v = settings();
      layer.insertAdjacentHTML('beforeend', `<div class="vz-media"></div><div class="vz-shade"></div><canvas class="vz-canvas"></canvas>`);
      const media = layer.querySelector('.vz-media');
      const shade = layer.querySelector('.vz-shade');
      const canvas = layer.querySelector('.vz-canvas');
      const gear = document.createElement('button');
      gear.className = 'icon-btn glass-btn vz-gear';
      gear.title = 'Настройки визуализатора';
      gear.innerHTML = icon('eq');
      const panel = document.createElement('div');
      panel.className = 'vz-panel glass-menu hidden';
      host.append(gear, panel);

      let video = null;
      let clip = null; // подключение к плееру клипа
      const renderMedia = () => {
        const s = settings();
        const t = Player.current;
        video = null;
        if (clip && s.bg !== 'clip') {
          clip.detach();
          clip = null;
        }
        if (s.bg === 'clip') {
          // под клипом — обложка, пока клип ищется или грузится
          if (!clip) {
            media.innerHTML = kind === 'tab' ? `<div class="vz-img blur" style="background-image:url('${esc(cover(t, 600))}')"></div>` : '';
            clip = Clip.attach(media);
          } else if (kind === 'tab') {
            const b = media.querySelector('.vz-img.blur');
            if (b) b.style.backgroundImage = `url('${cover(t, 600)}')`;
          }
          layer.classList.add('vz-has-media');
        } else if (s.bg === 'video' && Custom.media.vizVideo) {
          media.innerHTML = `<video src="${esc(Custom.media.vizVideo)}" muted loop playsinline autoplay></video>`;
          video = media.firstChild;
        } else if (s.bg === 'image' && Custom.media.vizImage) {
          media.innerHTML = `<div class="vz-img" style="background-image:url('${esc(Custom.media.vizImage)}')"></div>`;
        } else if (kind === 'tab') {
          media.innerHTML = `<div class="vz-img blur" style="background-image:url('${esc(cover(t, 600))}')"></div>`;
        } else media.innerHTML = '';
        if (s.bg !== 'clip') layer.classList.toggle('vz-has-media', Boolean(media.innerHTML));
        shade.style.background = `rgba(0,0,0,${(s.dim / 100).toFixed(2)})`;
      };

      const renderPanel = () => {
        const s = settings();
        const opt = (key, list) =>
          `<div class="vz-opts">${list.map((o) => `<button class="vz-opt${s[key] === o.id ? ' on' : ''}" data-vk="${key}" data-vv="${o.id}">${icon(o.icon)}<span>${o.name}</span></button>`).join('')}</div>`;
        const mediaKey = s.bg === 'video' ? 'vizVideo' : s.bg === 'image' ? 'vizImage' : null;
        const has = mediaKey && Custom.media[mediaKey];
        panel.innerHTML = `
          <div class="vz-h">Стиль</div>${opt('style', STYLES)}
          <div class="vz-h">Фон</div>${opt('bg', BGS)}
          ${mediaKey ? `<div class="vz-file">
            <button class="btn small${has ? '' : ' primary'}" data-vfile="${mediaKey}">${icon('upload')}${has ? 'Заменить' : s.bg === 'video' ? 'Выбрать видео' : 'Выбрать картинку'}</button>
            ${has ? `<button class="btn small" data-vclear="${mediaKey}">${icon('trash')}</button>` : ''}</div>` : ''}
          ${s.bg === 'video' && has ? `<label class="vz-check"><button class="switch${s.pulse ? ' on' : ''}" data-vtoggle="pulse"></button>Пульсировать в такт</label>` : ''}
          ${s.bg === 'clip' ? clipBlock() : ''}
          <div class="vz-h">Затемнение фона</div><div class="vz-range"><input type="range" class="range" data-vr="dim" min="0" max="85" step="1" value="${s.dim}"></div>
          <div class="vz-h">Чувствительность</div><div class="vz-range"><input type="range" class="range" data-vr="sensitivity" min="0.4" max="2.2" step="0.05" value="${s.sensitivity}"></div>`;
        panel.querySelectorAll('.range').forEach((r) => updateRangeFill(r));
      };

      const handle = Viz.attach(canvas, {
        ...vizOpts(v, centerFn),
        onFrame: (V) => {
          if (!video) return;
          const s = App.settings.viz;
          if (s.pulse) {
            video.style.transform = `scale(${(1.02 + V.bass * 0.035 + V.beat * 0.03).toFixed(3)})`;
            video.style.filter = `brightness(${(1 + V.beat * 0.3).toFixed(2)})`;
          } else {
            video.style.transform = '';
            video.style.filter = '';
          }
          // видео идёт вместе с музыкой
          if (Player.audio.paused !== video.paused) Player.audio.paused ? video.pause() : video.play().catch(() => {});
        },
      });

      gear.addEventListener('click', (e) => {
        e.stopPropagation();
        panel.classList.toggle('hidden');
        if (!panel.classList.contains('hidden')) renderPanel();
      });
      const outside = (e) => {
        if (!panel.isConnected) return document.removeEventListener('mousedown', outside);
        if (!panel.classList.contains('hidden') && !panel.contains(e.target) && e.target !== gear && !gear.contains(e.target)) panel.classList.add('hidden');
      };
      document.addEventListener('mousedown', outside);

      // статус клипа меняется сам (поиск, ошибки) — обновляем открытую панель
      const offClip = Clip.onChange(() => panel.isConnected && !panel.classList.contains('hidden') && settings().bg === 'clip' && renderPanel());

      panel.addEventListener('click', async (e) => {
        const s = settings();
        const qb = e.target.closest('[data-vclipq]');
        if (qb) {
          if (qb.dataset.vclipq !== Clip.quality) {
            Clip.setQuality(qb.dataset.vclipq);
            toast(qb.dataset.vclipq === 'auto' ? 'Качество клипа: автоматически' : `Качество клипа: ${qb.textContent}`, { iconName: 'check', ms: 1600 });
          }
          renderPanel();
          return;
        }
        const cb = e.target.closest('[data-vclip]');
        if (cb) {
          const a = cb.dataset.vclip;
          if (a === 'auto') {
            Clip.setAuto(!Clip.auto);
            if (Clip.auto) toast('Автосинхронизация: на пару секунд звук пойдёт из клипа', { iconName: 'sparkle', ms: 2600 });
          } else if (a === 'recal') Clip.calibrate(true);
          else if (a === 'next') await Clip.next();
          else if (a === 'minus') await Clip.shift(-1);
          else if (a === 'plus') await Clip.shift(1);
          else if (a === 'open' && Clip.info) window.zvuk.openZvuk(`https://www.youtube.com/watch?v=${Clip.info.id}`);
          else if (a === 'settings') App.navigate('settings');
          else if (a === 'link') {
            const url = await modal({ title: 'Ссылка на клип', text: 'Вставьте ссылку на ролик YouTube для этого трека — приложение запомнит её.', input: '', okText: 'Показать' });
            if (url) await Clip.setLink(url);
          }
          renderPanel();
          return;
        }
        const b = e.target.closest('[data-vk], [data-vfile], [data-vclear], [data-vtoggle]');
        if (!b) return;
        if (b.dataset.vk) {
          s[b.dataset.vk] = b.dataset.vv;
          if (b.dataset.vk === 'style') handle.set(vizOpts(s, centerFn));
          // выбрали «Картинка»/«Видео», а файла ещё нет — сразу предлагаем выбрать
          if (b.dataset.vk === 'bg' && (b.dataset.vv === 'image' || b.dataset.vv === 'video')) {
            const key = b.dataset.vv === 'video' ? 'vizVideo' : 'vizImage';
            if (!Custom.media[key]) await Custom.pickMedia(key, b.dataset.vv === 'video' ? 'video' : 'image');
          }
        } else if (b.dataset.vfile) {
          await Custom.pickMedia(b.dataset.vfile, b.dataset.vfile === 'vizVideo' ? 'video' : 'image');
        } else if (b.dataset.vclear) {
          await Custom.clearMedia(b.dataset.vclear);
        } else if (b.dataset.vtoggle) {
          s[b.dataset.vtoggle] = !s[b.dataset.vtoggle];
        }
        save();
        renderMedia();
        renderPanel();
      });
      panel.addEventListener('input', (e) => {
        const r = e.target.closest('[data-vr]');
        if (!r) return;
        const s = settings();
        s[r.dataset.vr] = parseFloat(r.value);
        updateRangeFill(r);
        if (r.dataset.vr === 'sensitivity') handle.set({ sensitivity: s.sensitivity });
        if (r.dataset.vr === 'dim') shade.style.background = `rgba(0,0,0,${(s.dim / 100).toFixed(2)})`;
        save();
      });

      renderMedia();
      return {
        setTrack() {
          const bg = settings().bg;
          if (kind === 'tab' && (bg === 'cover' || bg === 'clip')) renderMedia();
          else if (kind === 'tab' && !media.innerHTML) renderMedia();
        },
        destroy() {
          handle.stop();
          offClip();
          if (clip) clip.detach();
          clip = null;
          document.removeEventListener('mousedown', outside);
          gear.remove();
          panel.remove();
          layer.querySelectorAll('.vz-media, .vz-shade, .vz-canvas').forEach((x) => x.remove());
        },
      };
    },
  };

  window.VizScene = VizScene;
})();
