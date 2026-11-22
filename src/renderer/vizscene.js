'use strict';
/* Сцена визуализатора: фон (обложка / своя картинка / своё видео), мягкая визуализация под ритм и панель настроек.
   Используется во вкладке «Визуализатор» и внутри полноэкранного плеера. */
(function () {
  const STYLES = [
    { id: 'waves', name: 'Волны', icon: 'wave', desc: 'Мягкие линии по краю кадра' },
    { id: 'bars', name: 'Спектр', icon: 'viz', desc: 'Частоты вдоль нижней линии' },
    { id: 'particles', name: 'Звёздная пыль', icon: 'sparkle', desc: 'Частицы от центра кадра' },
    { id: 'impact', name: 'Пульс кадра', icon: 'pulse', desc: 'Чувствительная пульсация обложки или клипа под музыку' },
    { id: 'off', name: 'Без эффектов', icon: 'close', desc: 'Только выбранный фон' },
  ];
  const BGS = [
    { id: 'cover', name: 'Обложка', icon: 'album' },
    { id: 'image', name: 'Картинка', icon: 'image' },
    { id: 'video', name: 'Видео', icon: 'video' },
    { id: 'clip', name: 'Клип', icon: 'film' },
  ];
  const RESPONSE_PRESETS = [
    { value: 0.65, name: 'Спокойно' },
    { value: 1, name: 'Баланс' },
    { value: 1.55, name: 'Эффектно' },
  ];
  const OLD = { mirror: 'bars', wave: 'waves', aura: 'particles', orbit: 'particles', ring: 'particles' };
  let panelSeq = 0;

  function settings() {
    const v = App.settings.viz || (App.settings.viz = {});
    if (OLD[v.style]) v.style = OLD[v.style];
    if (!STYLES.some((s) => s.id === v.style)) v.style = 'waves';
    if (!v.bg) v.bg = Custom.media.vizVideo ? 'video' : 'cover';
    if (v.dim == null) v.dim = 35;
    if (v.sensitivity == null) v.sensitivity = 1;
    const sensitivity = Number(v.sensitivity);
    v.sensitivity = Number.isFinite(sensitivity) ? Math.min(2.2, Math.max(0.4, sensitivity)) : 1;
    if (v.pulse == null) v.pulse = true;
    return v;
  }
  const save = debounce(() => window.zvuk.settings.set({ viz: App.settings.viz }), 300);
  const formatResponse = (value) => `${Number(value).toFixed(2).replace('.', ',')}×`;

  function vizOpts(v, centerFn) {
    const common = { soft: true, idle: true, maxDpr: 1, sensitivity: v.sensitivity, glow: false };
    if (v.style === 'waves') return { ...common, style: 'waves' };
    if (v.style === 'bars') return { ...common, style: 'bars', bars: 64 };
    if (v.style === 'particles') return { ...common, style: 'particles' };
    if (v.style === 'impact') return { ...common, style: 'impact' };
    return { ...common, style: 'none', idle: false };
  }

  /** Небольшие статичные схемы показывают характер каждого стиля без лишних canvas и анимаций. */
  function stylePreview(id) {
    const open = '<svg viewBox="0 0 120 48" aria-hidden="true" focusable="false">';
    if (id === 'waves') return `${open}
      <path d="M0 35 C18 17 30 43 49 25 S82 12 120 30 V48 H0Z" fill="currentColor" opacity=".12"/>
      <path d="M0 31 C18 13 30 39 49 21 S82 8 120 26" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
      <path d="M0 39 C22 25 36 44 57 31 S93 22 120 36" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".45"/>
    </svg>`;
    if (id === 'particles') return `${open}
      <ellipse cx="60" cy="24" rx="44" ry="16" transform="rotate(-12 60 24)" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".28"/>
      <ellipse cx="60" cy="24" rx="29" ry="10" transform="rotate(18 60 24)" fill="none" stroke="currentColor" stroke-width="1" opacity=".2"/>
      <circle cx="60" cy="24" r="4" fill="currentColor" opacity=".9"/>
      <circle cx="24" cy="17" r="2.4" fill="currentColor" opacity=".7"/><circle cx="94" cy="33" r="2" fill="currentColor" opacity=".55"/>
      <circle cx="82" cy="10" r="1.5" fill="currentColor"/><circle cx="38" cy="39" r="1.7" fill="currentColor" opacity=".6"/>
      <path d="M60 12V16 M60 32V36 M48 24H52 M68 24H72" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".45"/>
    </svg>`;
    if (id === 'bars') {
      const heights = [10, 19, 28, 16, 35, 24, 31, 14, 22, 11];
      return `${open}${heights.map((height, i) => `<rect x="${10 + i * 10.5}" y="${43 - height}" width="6" height="${height}" rx="3" fill="currentColor" opacity="${0.45 + (i % 3) * 0.2}"/>`).join('')}</svg>`;
    }
    if (id === 'impact') return `${open}
      <rect x="13" y="6" width="94" height="36" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".42"/>
      <circle cx="60" cy="24" r="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".85"/>
      <circle cx="60" cy="24" r="15" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".35"/>
      <path d="M13 19H24 M96 19H107 M13 29H24 M96 29H107" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <circle cx="60" cy="24" r="3" fill="currentColor"/>
    </svg>`;
    return `${open}
      <path d="M12 24H108" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".38"/>
      <circle cx="60" cy="24" r="10" fill="none" stroke="currentColor" stroke-width="1.8"/>
      <path d="M53 17L67 31" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>`;
  }

  /** Автосинхронизация по звуку: переключатель и состояние. */
  function autoBlock() {
    // на телефоне звук устройства слушать нельзя — подстройка по звуку есть только в Windows-версии
    if (window.ZG_MOBILE) return '';
    const on = Clip.auto;
    const s = Clip.sync;
    const a = Clip.autoInfo;
    const mode = Clip.syncMode;
    let line = '';
    if (on) {
      if (s.state === 'run') line = `<div class="vz-sync run"><i></i>${esc(s.message)}</div>`;
      else if (s.state === 'fail') line = `<div class="vz-sync err">${esc(s.message)}</div>`;
      else if (s.state === 'wait') line = `<div class="vz-sync">${esc(s.message)}</div>`;
      else if (a && mode === 'locked') line = `<div class="vz-sync ok">${icon('check')}Ручная поправка сохранена · автоматические коррекции выключены</div>`;
      else if (a) line = `<div class="vz-sync ok">${icon('check')}Подтверждено на ${a.shots || 2} фрагментах · уверенность ${Math.round((a.confidence || 0) * 100)}%${a.rate && a.rate !== 1 ? ` · темп ${a.rate.toFixed(3)}×` : ''}</div>`;
      else line = '<div class="vz-sync">Нажмите ↻: приложение сравнит несколько фрагментов по звуку. Если версия клипа отличается, случайный сдвиг не применяется.</div>';
    }
    const busy = s.state === 'run';
    return `<div class="vz-auto">
      <div class="vz-auto-row"><button type="button" class="switch${on ? ' on' : ''}" data-vclip="auto" title="${busy ? 'Остановить подстройку' : 'Автосинхронизация'}" aria-label="Автосинхронизация" aria-pressed="${on}"></button>
        <span>Автосинхронизация<small>сопоставление музыки, без микрофона</small></span>
        ${on && !busy ? `<button type="button" class="btn small" data-vclip="recal" title="${a ? 'Измерить заново' : 'Подстроить'}" aria-label="${a ? 'Измерить заново' : 'Подстроить'}">${icon('refresh')}</button>` : ''}</div>
      <div class="vz-q-opts vz-sync-modes" aria-label="Режим синхронизации">
        ${[['auto', 'Авто'], ['locked', 'Фиксация'], ['manual', 'Вручную']].map(([id, name]) => `<button type="button" class="vz-qb${mode === id ? ' on' : ''}" data-vclip="mode-${id}" aria-pressed="${mode === id}"${id === 'locked' && !a ? ' disabled' : ''}>${name}</button>`).join('')}
      </div>
      ${line}
      <div class="vz-prefs">
        <label class="vz-check"><button type="button" class="switch${Clip.pref('clipRestart') ? ' on' : ''}" data-vpref="clipRestart" aria-label="В начало после синхронизации" aria-pressed="${Clip.pref('clipRestart')}"></button><span>В начало после синхронизации</span></label>
        <label class="vz-check"><button type="button" class="switch${Clip.pref('clipKeepPaused') ? ' on' : ''}" data-vpref="clipKeepPaused" aria-label="Оставлять клип на экране при паузе" aria-pressed="${Clip.pref('clipKeepPaused')}"></button><span>Оставлять клип на экране при паузе</span></label>
        <label class="vz-check"><button type="button" class="switch${Clip.pref('inkEnabled') ? ' on' : ''}" data-vpref="inkEnabled" aria-label="Контрастный контур текста" aria-pressed="${Clip.pref('inkEnabled')}"></button><span>Контрастный контур текста</span></label>
      </div>
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
    else if (st === 'none') line = '<span>Официальный клип не найден. Попробуйте искать снова или вставьте ссылку.</span>';
    else if (st === 'error') line = `<span class="err">${esc(Clip.message)}</span>`;
    else line = '<span>Клип появится, когда заиграет трек</span>';
    const hasMore = Clip.entry && Clip.entry.cands && Clip.entry.cands.length > 1;
    return `<div class="vz-clip"><div class="vz-clip-meta">${line}</div>
      <div class="vz-clip-btns">
        ${hasMore ? `<button type="button" class="btn small" data-vclip="next">${icon('refresh')}Другой</button>` : ''}
        ${st === 'none' || st === 'error' ? `<button type="button" class="btn small" data-vclip="research">${icon('search')}Искать снова</button>` : ''}
        <button type="button" class="btn small" data-vclip="link">${icon('link')}Ссылка</button>
        ${st === 'ok' && info ? `<button type="button" class="btn small" data-vclip="open" title="Открыть на YouTube" aria-label="Открыть клип на YouTube">${icon('external')}</button>` : ''}
        ${st === 'nokey' ? `<button type="button" class="btn small primary" data-vclip="settings">${icon('settings')}Ключ</button>` : ''}
      </div>
      ${st === 'ok' ? autoBlock() : ''}
      ${st === 'ok' ? `<div class="vz-offset" title="При автоматическом режиме ручная поправка сохраняется и блокирует коррекции"><span>Сдвиг</span>
        <button type="button" class="btn small" data-vclip="minus" aria-label="Уменьшить сдвиг на 0,5 секунды">−0,5 с</button><b>${off > 0 ? '+' : ''}${off.toFixed(Clip.auto && Clip.autoInfo ? 2 : 1)} с</b><button type="button" class="btn small" data-vclip="plus" aria-label="Увеличить сдвиг на 0,5 секунды">+0,5 с</button></div>` : ''}
      <div class="vz-q">
        <div class="vz-q-head"><span>Качество клипа</span><small title="Запрошенное и фактически полученное от YouTube качество">запрошено ${esc(Clip.QLIST.find(([id]) => id === Clip.quality)?.[1] || 'Авто')}${Clip.actualQuality ? ` · сейчас ${esc(Clip.actualQuality)}` : ''}</small></div>
        <div class="vz-q-opts">${Clip.QLIST.map(([id, label]) => `<button type="button" class="vz-qb${Clip.quality === id ? ' on' : ''}" data-vclipq="${id}" aria-pressed="${Clip.quality === id}">${label}</button>`).join('')}</div>
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
      const panelId = `vz-controls-${++panelSeq}`;
      const gear = document.createElement('button');
      gear.type = 'button';
      gear.className = 'icon-btn glass-btn vz-gear';
      gear.title = 'Настройки визуализатора';
      gear.setAttribute('aria-label', 'Настройки визуализатора');
      gear.setAttribute('aria-controls', panelId);
      gear.setAttribute('aria-expanded', 'false');
      gear.innerHTML = icon('eq');
      const panel = document.createElement('div');
      panel.id = panelId;
      panel.className = 'vz-panel vz-controls glass-menu hidden';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'Настройки визуализатора');
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

      function syncResponse(value) {
        const formatted = formatResponse(value);
        const output = panel.querySelector('[data-vvalue="sensitivity"]');
        if (output) {
          output.value = formatted;
          output.textContent = formatted;
        }
        const range = panel.querySelector('[data-vr="sensitivity"]');
        if (range) {
          range.value = String(value);
          range.setAttribute('aria-valuetext', formatted);
          updateRangeFill(range);
        }
        panel.querySelectorAll('[data-vresponse]').forEach((button) => {
          const on = Math.abs(Number(button.dataset.vresponse) - Number(value)) < 0.026;
          button.classList.toggle('on', on);
          button.setAttribute('aria-pressed', String(on));
        });
      }

      const renderPanel = () => {
        const s = settings();
        const mediaKey = s.bg === 'video' ? 'vizVideo' : s.bg === 'image' ? 'vizImage' : null;
        const has = mediaKey && Custom.media[mediaKey];
        const responseDisabled = s.style === 'off';
        panel.innerHTML = `
          <header class="vz-controls-head">
            <div><h2>Настройки сцены</h2><p>Стиль, фон и реакция на музыку</p></div>
            <button type="button" class="icon-btn vz-panel-close" data-vclose aria-label="Закрыть настройки">${icon('close')}</button>
          </header>
          <div class="vz-controls-body">
            <section class="vz-section" aria-label="Фон сцены">
              <div class="vz-section-head"><div><h3>Фон</h3><p>Что находится за визуализацией</p></div></div>
              <div class="vz-bg-grid" role="group" aria-label="Тип фона">
                ${BGS.map((o) => `<button type="button" class="vz-bg-option${s.bg === o.id ? ' on' : ''}" data-vk="bg" data-vv="${o.id}" aria-pressed="${s.bg === o.id}">${icon(o.icon)}<span>${o.name}</span></button>`).join('')}
              </div>
              ${mediaKey ? `<div class="vz-file">
                <button type="button" class="btn small${has ? '' : ' primary'}" data-vfile="${mediaKey}">${icon('upload')}${has ? 'Заменить' : s.bg === 'video' ? 'Выбрать видео' : 'Выбрать картинку'}</button>
                ${has ? `<button type="button" class="btn small" data-vclear="${mediaKey}" aria-label="Удалить выбранный файл">${icon('trash')}</button>` : ''}</div>` : ''}
              ${s.bg === 'video' && has ? `<label class="vz-check vz-video-pulse"><button type="button" class="switch${s.pulse ? ' on' : ''}" data-vtoggle="pulse" aria-label="Пульсировать в такт" aria-pressed="${s.pulse}"></button><span>Пульсировать в такт</span></label>` : ''}
              <div class="vz-dim">
                <div class="vz-control-head"><label for="${panelId}-dim">Затемнение фона</label><output class="vz-control-value" data-vvalue="dim" for="${panelId}-dim">${s.dim}%</output></div>
                <div class="vz-range"><input id="${panelId}-dim" type="range" class="range" data-vr="dim" min="0" max="85" step="1" value="${s.dim}" aria-label="Затемнение фона"></div>
              </div>
            </section>
            ${s.bg === 'clip' ? `<section class="vz-section vz-clip-section" aria-label="Официальный клип"><div class="vz-section-head"><div><h3>Официальный клип</h3><p>Поиск, синхронизация и качество</p></div></div>${clipBlock()}</section>` : ''}
            <section class="vz-section" aria-label="Стиль визуализации">
              <div class="vz-section-head"><div><h3>Стиль</h3><p>Как музыка выглядит на экране</p></div></div>
              <div class="vz-style-grid" role="group" aria-label="Стиль визуализации">
                ${STYLES.map((o) => `<button type="button" class="vz-style-card vz-style-${o.id}${s.style === o.id ? ' on' : ''}" data-vk="style" data-vv="${o.id}" aria-pressed="${s.style === o.id}">
                  <span class="vz-style-preview">${stylePreview(o.id)}</span>
                  <span class="vz-style-copy"><b>${o.name}</b><small>${o.desc}</small></span>
                  <span class="vz-card-check" aria-hidden="true">${icon('check')}</span>
                </button>`).join('')}
              </div>
            </section>
            <section class="vz-section vz-response${responseDisabled ? ' is-disabled' : ''}" aria-label="Отклик на музыку">
              <div class="vz-section-head"><div><h3>Отклик на музыку</h3><p>Насколько заметно стиль реагирует на звук</p></div><output class="vz-control-value" data-vvalue="sensitivity" for="${panelId}-response">${formatResponse(s.sensitivity)}</output></div>
              <div class="vz-response-presets" role="group" aria-label="Предустановки отклика">
                ${RESPONSE_PRESETS.map((p) => `<button type="button" class="vz-response-preset${Math.abs(s.sensitivity - p.value) < 0.026 ? ' on' : ''}" data-vresponse="${p.value}" aria-pressed="${Math.abs(s.sensitivity - p.value) < 0.026}"${responseDisabled ? ' disabled' : ''}>${p.name}</button>`).join('')}
              </div>
              <div class="vz-range vz-response-range"><input id="${panelId}-response" type="range" class="range" data-vr="sensitivity" min="0.4" max="2.2" step="0.05" value="${s.sensitivity}" aria-label="Отклик на музыку" aria-valuetext="${formatResponse(s.sensitivity)}"${responseDisabled ? ' disabled' : ''}>
                <div class="vz-range-scale" aria-hidden="true"><span>0,40×</span><span>2,20×</span></div>
              </div>
              ${responseDisabled ? '<p class="vz-control-note">Выберите стиль, чтобы настроить отклик.</p>' : ''}
            </section>
          </div>`;
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

      const setPanelOpen = (open, returnFocus = false) => {
        panel.classList.toggle('hidden', !open);
        gear.setAttribute('aria-expanded', String(open));
        if (open) renderPanel();
        else if (returnFocus) gear.focus();
      };
      gear.addEventListener('click', (e) => {
        e.stopPropagation();
        setPanelOpen(panel.classList.contains('hidden'));
      });
      const outside = (e) => {
        if (!panel.isConnected) return document.removeEventListener('mousedown', outside);
        if (!panel.classList.contains('hidden') && !panel.contains(e.target) && e.target !== gear && !gear.contains(e.target)) setPanelOpen(false);
      };
      const onKeydown = (e) => {
        if (e.key === 'Escape' && !panel.classList.contains('hidden')) {
          e.stopPropagation();
          setPanelOpen(false, true);
        }
      };
      document.addEventListener('mousedown', outside);
      document.addEventListener('keydown', onKeydown);

      // статус клипа меняется сам (поиск, ошибки) — обновляем открытую панель
      const offClip = Clip.onChange(() => panel.isConnected && !panel.classList.contains('hidden') && settings().bg === 'clip' && renderPanel());

      panel.addEventListener('click', async (e) => {
        const close = e.target.closest('[data-vclose]');
        if (close) {
          setPanelOpen(false, true);
          return;
        }
        const s = settings();
        const pref = e.target.closest('[data-vpref]');
        if (pref) {
          Clip.setPreference(pref.dataset.vpref, !Clip.pref(pref.dataset.vpref));
          renderPanel();
          return;
        }
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
            if (Clip.auto && Player.current) {
              // включили — сразу подстраиваем текущий трек (если для него ещё нет замера)
              Clip.requestSync(Player.current.id);
              if (!Clip.autoInfo) toast(`Автосинхронизация: звук ненадолго пойдёт из клипа${Clip.pref('clipRestart') ? ', потом трек начнётся сначала' : ', позиция трека сохранится'}`, { iconName: 'sparkle', ms: 3200 });
            }
          } else if (a.startsWith('mode-')) await Clip.setSyncMode(a.slice(5));
          else if (a === 'recal') Clip.calibrate(true);
          else if (a === 'next') await Clip.next();
          else if (a === 'research') await Clip.resolve(true);
          else if (a === 'minus') await Clip.shift(-0.5);
          else if (a === 'plus') await Clip.shift(0.5);
          else if (a === 'open' && Clip.info) window.zvuk.openZvuk(`https://www.youtube.com/watch?v=${Clip.info.id}`);
          else if (a === 'settings') App.navigate('settings');
          else if (a === 'link') {
            const url = await modal({ title: 'Ссылка на клип', text: 'Вставьте ссылку на ролик YouTube для этого трека — приложение запомнит её.', input: '', okText: 'Показать' });
            if (url) await Clip.setLink(url);
          }
          renderPanel();
          return;
        }
        const response = e.target.closest('[data-vresponse]');
        if (response && !response.disabled) {
          s.sensitivity = Number(response.dataset.vresponse);
          handle.set({ sensitivity: s.sensitivity });
          syncResponse(s.sensitivity);
          save();
          return;
        }
        const b = e.target.closest('[data-vk], [data-vfile], [data-vclear], [data-vtoggle]');
        if (!b) return;
        if (b.dataset.vk) {
          s[b.dataset.vk] = b.dataset.vv;
          if (b.dataset.vk === 'style') handle.set(vizOpts(s, centerFn));
          // выбрали «Картинку»/«Видео», а файла ещё нет — сразу предлагаем выбрать
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
        const value = parseFloat(r.value);
        if (!Number.isFinite(value)) return;
        s[r.dataset.vr] = value;
        updateRangeFill(r);
        if (r.dataset.vr === 'sensitivity') {
          handle.set({ sensitivity: value });
          syncResponse(value);
        }
        if (r.dataset.vr === 'dim') {
          shade.style.background = `rgba(0,0,0,${(value / 100).toFixed(2)})`;
          const output = panel.querySelector('[data-vvalue="dim"]');
          if (output) {
            output.value = `${value}%`;
            output.textContent = `${value}%`;
          }
        }
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
          document.removeEventListener('keydown', onKeydown);
          gear.remove();
          panel.remove();
          layer.querySelectorAll('.vz-media, .vz-shade, .vz-canvas').forEach((x) => x.remove());
        },
      };
    },
  };

  window.VizScene = VizScene;
})();
