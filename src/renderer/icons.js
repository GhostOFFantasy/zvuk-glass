'use strict';
/* Набор иконок (24×24). Контурные — stroke, медиа-кнопки — заливка. */
(function () {
  const S = (d, extra = '') =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
  const F = (d) => `<svg viewBox="0 0 24 24" fill="currentColor">${d}</svg>`;

  const ICONS = {
    home: S('<path d="M3.5 10.5 12 3.8l8.5 6.7V19a1.8 1.8 0 0 1-1.8 1.8H15v-6h-6v6H5.3A1.8 1.8 0 0 1 3.5 19z"/>'),
    wave: S('<path pathLength="100" d="M2.5 12c1.6 0 1.6-5 3.2-5s1.6 10 3.2 10 1.6-14 3.1-14 1.6 18 3.2 18 1.6-10 3.2-10 1.6 1 3.1 1"/>'),
    viz: S('<rect class="vb" x="3" y="10" width="3" height="10" rx="1.2"/><rect class="vb" x="8.5" y="5" width="3" height="15" rx="1.2"/><rect class="vb" x="14" y="8" width="3" height="12" rx="1.2"/><rect class="vb" x="19.5" y="12" width="2.5" height="8" rx="1.2"/>'),
    eq: S('<path d="M6 4v16M12 4v16M18 4v16"/><circle class="k1" cx="6" cy="14" r="2.2" fill="currentColor"/><circle class="k2" cx="12" cy="8" r="2.2" fill="currentColor"/><circle class="k3" cx="18" cy="12" r="2.2" fill="currentColor"/>'),
    image: S('<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="m20.5 16-4.5-4.5L7 19.5"/>'),
    video: S('<rect x="3" y="6" width="13" height="12" rx="3"/><path d="m16 10.5 5-3v9l-5-3z"/>'),
    palette: S('<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.9 1.4-2a1.6 1.6 0 0 1 1.5-2.2h2A3.6 3.6 0 0 0 20.5 12 8.5 8.5 0 0 0 12 3.5z"/><circle cx="7.8" cy="11" r="1.1" fill="currentColor"/><circle cx="10.5" cy="7.6" r="1.1" fill="currentColor"/><circle cx="14.6" cy="7.8" r="1.1" fill="currentColor"/>'),
    upload: S('<path d="M12 15.5V4M7.5 8.5 12 4l4.5 4.5M4.5 15v2.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15"/>'),
    fullscreen: S('<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>'),
    refresh: S('<path d="M20 11.5A8 8 0 0 0 5.6 6.7L4 8.5M4 4v4.5h4.5M4 12.5a8 8 0 0 0 14.4 4.8l1.6-1.8M20 20v-4.5h-4.5"/>'),
    film: S('<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M7.5 4.5v15M16.5 4.5v15M3.5 9.5h4M3.5 14.5h4M16.5 9.5h4M16.5 14.5h4"/>'),
    chevronsLeft: S('<path d="m11 7-5 5 5 5M18 7l-5 5 5 5"/>'),
    bolt: S('<path d="M13.5 2.5 5 13.5h6l-1 8 8.5-11h-6z"/>'),
    sun: S('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>'),
    moon: S('<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>'),
    cloud: S('<path d="M7 16.5h10a4 4 0 0 0 .4-8 5.5 5.5 0 0 0-10.6 1.5A3.3 3.3 0 0 0 7 16.5z"/><path d="M8.5 19.5l-.8 1.6M12.5 19.5l-.8 1.6M16.5 19.5l-.8 1.6"/>'),
    globe: S('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.5 3.5 5.3 3.5 8.5s-1.1 6-3.5 8.5c-2.4-2.5-3.5-5.3-3.5-8.5s1.1-6 3.5-8.5z"/>'),
    fire: S('<path d="M12 21c-3.9 0-6.5-2.6-6.5-6.2 0-3.4 2.6-5.4 3.6-8.3.5 1.6 1.4 2.6 2.4 3.1C12 6.6 13.2 4.3 15.5 3c-.4 2.9.9 4.6 2 6.2 1 1.4 1.5 2.8 1.5 4.7 0 4.2-3 7.1-7 7.1z"/><path d="M12 21c-1.6 0-2.8-1.2-2.8-2.8 0-1.9 1.6-2.7 2.3-4.4.9 1 2 1.6 2.6 2.8.8 1.9-.3 4.4-2.1 4.4z"/>'),
    compass: S('<circle cx="12" cy="12" r="8.5"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>'),
    infinity: S('<path d="M12 12c-1.8-2.2-3-3.5-5-3.5a3.5 3.5 0 0 0 0 7c2 0 3.2-1.3 5-3.5zm0 0c1.8 2.2 3 3.5 5 3.5a3.5 3.5 0 0 0 0-7c-2 0-3.2 1.3-5 3.5z"/>'),
    layout: S('<rect x="3.5" y="4" width="17" height="16" rx="3"/><path d="M9.5 4v16"/>'),
    type: S('<path d="M5 7V5h14v2M12 5v14M9 19h6"/>'),
    search: S('<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.6-4.6"/>'),
    heart: S('<path d="M12 20.3S3.5 15.2 3.5 9.1A4.6 4.6 0 0 1 8.1 4.5c1.7 0 3 .9 3.9 2.2.9-1.3 2.2-2.2 3.9-2.2a4.6 4.6 0 0 1 4.6 4.6c0 6.1-8.5 11.2-8.5 11.2z"/>'),
    heartFill: F('<path d="M12 21s-9.2-5.4-9.2-12A5.1 5.1 0 0 1 7.9 3.9c1.7 0 3.2.8 4.1 2.1.9-1.3 2.4-2.1 4.1-2.1a5.1 5.1 0 0 1 5.1 5.1C21.2 15.6 12 21 12 21z"/>'),
    album: S('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.6"/><path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5" opacity=".5"/>'),
    mic: S('<rect x="8.5" y="3" width="7" height="11" rx="3.5"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>'),
    playlist: S('<path class="l1" d="M4 6h11"/><path class="l2" d="M4 11h11"/><path class="l3" d="M4 16h6"/><g class="note"><path d="M18 18.5V8.5l3-1"/><circle cx="16" cy="18.5" r="2"/></g>'),
    clock: S('<circle cx="12" cy="12" r="8.5"/><path class="hands" d="M12 7.5V12l3 2"/>'),
    settings: S('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    plus: S('<path d="M12 5v14M5 12h14"/>'),
    play: F('<path d="M8 5.6v12.8c0 .9 1 1.4 1.7.9l9.6-6.4a1.1 1.1 0 0 0 0-1.8L9.7 4.7C9 4.2 8 4.7 8 5.6z"/>'),
    pause: F('<rect x="6.5" y="5" width="4" height="14" rx="1.4"/><rect x="13.5" y="5" width="4" height="14" rx="1.4"/>'),
    next: F('<path d="M5 6.3v11.4c0 .8.9 1.3 1.6.8l8.2-5.7a1 1 0 0 0 0-1.6L6.6 5.5C5.9 5 5 5.5 5 6.3z"/><rect x="16.5" y="5" width="2.8" height="14" rx="1.3"/>'),
    prev: F('<path d="M19 6.3v11.4c0 .8-.9 1.3-1.6.8l-8.2-5.7a1 1 0 0 1 0-1.6l8.2-5.7c.7-.5 1.6 0 1.6.8z"/><rect x="4.7" y="5" width="2.8" height="14" rx="1.3"/>'),
    shuffle: S('<path d="M16 4h4v4M4 19.5 20 4M20 16v4h-4M14.5 14.5 20 20M4 4.5l5 5"/>'),
    repeat: S('<path d="M17 2.5 20.5 6 17 9.5"/><path d="M3.5 11.5V10A4 4 0 0 1 7.5 6h13M7 21.5 3.5 18 7 14.5"/><path d="M20.5 12.5V14a4 4 0 0 1-4 4h-13"/>'),
    repeatOne: S('<path d="M17 2.5 20.5 6 17 9.5"/><path d="M3.5 11.5V10A4 4 0 0 1 7.5 6h13M7 21.5 3.5 18 7 14.5"/><path d="M20.5 12.5V14a4 4 0 0 1-4 4h-13"/><path d="M11.2 10.2 12.6 9.4v5.2" stroke-width="1.6"/>'),
    vol0: S('<path d="M11 5 6.5 9H3.5v6h3L11 19z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>'),
    vol1: S('<path d="M11 5 6.5 9H3.5v6h3L11 19z"/><path d="M15.5 9.5a3.6 3.6 0 0 1 0 5"/>'),
    vol2: S('<path d="M11 5 6.5 9H3.5v6h3L11 19z"/><path d="M15.5 9.5a3.6 3.6 0 0 1 0 5M18.5 6.5a7.8 7.8 0 0 1 0 11"/>'),
    lyrics: S('<path d="M4 5.5h16M4 10h10M4 14.5h7"/><path d="M16.5 19.5v-6.5l4-1.2"/><circle cx="14.8" cy="19.5" r="1.8"/>'),
    queue: S('<path d="M3.5 6h12M3.5 11h12M3.5 16h7"/><path d="M15 14.5v6l5-3z" fill="currentColor"/>'),
    expand: S('<path d="M14.5 3.5h6v6M9.5 20.5h-6v-6M20.5 3.5l-7 7M3.5 20.5l7-7"/>'),
    chevronDown: S('<path d="m6 9 6 6 6-6"/>'),
    chevronLeft: S('<path d="m15 6-6 6 6 6"/>'),
    chevronRight: S('<path d="m9 6 6 6-6 6"/>'),
    more: F('<circle cx="5.5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="18.5" cy="12" r="1.8"/>'),
    close: S('<path d="M6 6l12 12M18 6 6 18"/>'),
    radio: S('<circle cx="12" cy="12" r="2"/><path d="M8.2 15.8a5.4 5.4 0 0 1 0-7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.3 18.7a9.5 9.5 0 0 1 0-13.4M18.7 5.3a9.5 9.5 0 0 1 0 13.4"/>'),
    trash: S('<path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12.2A2 2 0 0 0 8.5 21h7a2 2 0 0 0 2-1.8L18.5 7M9 7V4.8A1.3 1.3 0 0 1 10.3 3.5h3.4A1.3 1.3 0 0 1 15 4.8V7"/>'),
    edit: S('<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>'),
    link: S('<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>'),
    logout: S('<path d="M14.5 4.5h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3M9.5 16.5 5 12l4.5-4.5M5 12h11"/>'),
    check: S('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
    note: S('<path d="M9 18V5.5l11-2v12.5"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>'),
    sparkle: S('<path d="M12 3.5c.6 4.2 2.3 5.9 6.5 6.5-4.2.6-5.9 2.3-6.5 6.5-.6-4.2-2.3-5.9-6.5-6.5 4.2-.6 5.9-2.3 6.5-6.5z"/><path d="M19 15.5c.3 1.8 1 2.5 2.5 2.8-1.5.3-2.2 1-2.5 2.7-.3-1.7-1-2.4-2.5-2.7 1.5-.3 2.2-1 2.5-2.8z"/>'),
    user: S('<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>'),
    playNext: S('<path d="M3.5 6h10M3.5 11h10M3.5 16h6"/><path d="M17.5 12v8M13.5 16h8"/>'),
    addQueue: S('<path d="M3.5 6h12M3.5 11h12M3.5 16h7"/><path d="M17.5 13.5v7M14 17h7"/>'),
    addList: S('<path d="M4 6h11M4 11h11M4 16h6"/><path d="M17.5 13v7M14 16.5h7"/>'),
    hide: S('<path d="M3 3l18 18M10.6 5.1A9.8 9.8 0 0 1 12 5c5.5 0 9 7 9 7a16 16 0 0 1-2.6 3.4M6.6 6.6C4.3 8.1 3 12 3 12s3.5 7 9 7a9.3 9.3 0 0 0 4.4-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
    external: S('<path d="M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>'),
    flac: S('<path d="M3.5 8.5v7M3.5 8.5h3M3.5 12h2.5M9 8.5v7h3M15 15.5l1.8-7h.4l1.8 7M15.6 13.5h3"/>'),
  };

  window.ICONS = ICONS;
  window.icon = (name, cls = '') => `<span class="i ${cls}">${ICONS[name] || ''}</span>`;
  window.hydrateIcons = (root = document) => {
    root.querySelectorAll('[data-icon]').forEach((el) => {
      const n = el.getAttribute('data-icon');
      if (ICONS[n] && el.dataset.iconDone !== n) {
        el.innerHTML = ICONS[n];
        el.dataset.iconDone = n;
      }
    });
  };
})();
