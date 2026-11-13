'use strict';
/* Телефон: отступы под системные панели и клавиатуру, системная кнопка «Назад» и жесты.
   На компьютере модуль ничего не делает.

   Жесты:
   - полноэкранный плеер: смахнуть вниз — свернуть; влево / вправо по обложке — следующий / предыдущий трек;
   - мини-плеер: вверх — открыть плеер; влево / вправо — следующий / предыдущий;
   - очередь и текст (лист снизу): потянуть за шапку вниз — закрыть;
   - долгое нажатие на трек — меню трека (как «⋯»). */
(function () {
  if (!window.ZG_MOBILE) return;
  const root = document.documentElement;
  // подписи для телефона вместо компьютерных («Ctrl+A», «на этом компьютере»)
  document.querySelectorAll('[data-m]').forEach((el) => (el.textContent = el.dataset.m));

  // ---------- Отступы: строка состояния, полоса жестов, вырез камеры, клавиатура ----------
  window.ZG_insets = (o) => {
    if (!o) return;
    root.style.setProperty('--sa-top', `${Math.round(o.top || 0)}px`);
    root.style.setProperty('--sa-bottom', `${Math.round(o.bottom || 0)}px`);
    root.style.setProperty('--sa-left', `${Math.round(o.left || 0)}px`);
    root.style.setProperty('--sa-right', `${Math.round(o.right || 0)}px`);
    const kb = Math.round(o.ime || 0);
    root.style.setProperty('--kb', `${kb}px`);
    document.body.classList.toggle('kbd-open', kb > 80);
  };
  window.zvuk.mobile?.insets().then(window.ZG_insets);

  // ---------- Приложение свёрнуто / экран погашен: ничего не рисуем, клип стоит, музыка играет ----------
  document.addEventListener('visibilitychange', () => {
    const hidden = document.hidden;
    document.body.classList.toggle('win-hidden', hidden);
    window.Viz && Viz.setHidden(hidden);
    if (window.Clip) Clip.hidden = hidden;
  });

  // ---------- «Назад»: сначала закрываем открытое, потом идём назад по страницам ----------
  // true — обработано внутри приложения; false — оболочка свернёт приложение (музыка играет дальше)
  window.ZG_back = () => {
    try {
      if ($('#menuLayer').children.length) return closeMenu(), true;
      const modal = $('#modalLayer [data-x]');
      if (modal) return modal.click(), true;
      if (window.NP && NP.eqOpen) return NP.closeEq(), true;
      const vz = document.querySelector('.vz-panel:not(.hidden)');
      if (vz && vz.offsetParent) return vz.classList.add('hidden'), true;
      if (App.panel) return App.closePanel(), true;
      const input = $('#searchInput');
      if (document.activeElement === input) return input.blur(), App.hideSuggest(), true;
      if (window.NP && NP.isOpen) return App.closeNowPlaying(), true;
      if (App.history && App.history.length) return App.goBack(), true;
      // со страницы без истории — на главную, а с главной «Назад» уже сворачивает приложение
      if (App.route && App.route.view !== 'home') {
        App.history.length = 0;
        App.navigate('home', {}, { replace: true });
        return true;
      }
    } catch (e) {
      console.warn('back', e);
    }
    return false;
  };

  // ---------- Общий помощник жестов (Pointer Events: и палец, и мышь в проверочном режиме) ----------
  let suppressUntil = 0;
  // после жеста не даём сработать «клику», который браузер пришлёт следом
  window.addEventListener(
    'click',
    (e) => {
      if (performance.now() < suppressUntil) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
  const swallowClick = () => (suppressUntil = performance.now() + 400);

  /**
   * drag(el, { allow(e) → bool, axis: 'x' | 'y' | 'xy', move(dx, dy, axis), end(dx, dy, vx, vy, axis) → bool })
   * Жест начинается, когда палец ушёл на 10 px; направление определяется по первому движению.
   */
  function drag(el, o) {
    let st = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (o.allow && !o.allow(e)) return;
      st = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), axis: null, lx: e.clientX, ly: e.clientY, lt: performance.now(), vx: 0, vy: 0 };
    });
    el.addEventListener('pointermove', (e) => {
      if (!st || e.pointerId !== st.id) return;
      const dx = e.clientX - st.x;
      const dy = e.clientY - st.y;
      if (!st.axis) {
        if (Math.hypot(dx, dy) < 10) return;
        const ax = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (!o.axis.includes(ax)) {
          st = null;
          return;
        }
        st.axis = ax;
        try {
          el.setPointerCapture(e.pointerId);
        } catch {}
      }
      const now = performance.now();
      const dt = Math.max(1, now - st.lt);
      st.vx = st.vx * 0.5 + ((e.clientX - st.lx) / dt) * 0.5;
      st.vy = st.vy * 0.5 + ((e.clientY - st.ly) / dt) * 0.5;
      st.lx = e.clientX;
      st.ly = e.clientY;
      st.lt = now;
      o.move(dx, dy, st.axis);
    });
    const finish = (e, cancel) => {
      if (!st || e.pointerId !== st.id) return;
      const s = st;
      st = null;
      if (!s.axis) return;
      swallowClick();
      o.end(cancel ? 0 : e.clientX - s.x, cancel ? 0 : e.clientY - s.y, s.vx, s.vy, s.axis);
    };
    el.addEventListener('pointerup', (e) => finish(e, false));
    el.addEventListener('pointercancel', (e) => finish(e, true));
  }

  const spring = 'transform 0.38s cubic-bezier(.2,.9,.25,1.1), opacity 0.3s ease';

  // ---------- Полноэкранный плеер ----------
  const np = $('#nowPlaying');
  const flow = $('#npFlow');
  const noGesture = 'button, a, input, .slider, .np-lyrics, .np-lyr-src, .np-eq, .vz-panel, .vz-gear, .lnk';
  drag(np, {
    axis: 'xy',
    allow: (e) => !e.target.closest(noGesture),
    move(dx, dy, axis) {
      if (axis === 'y') {
        const d = Math.max(0, dy);
        np.style.transition = 'none';
        np.style.transform = `translateY(${d}px)`;
        np.style.opacity = String(Math.max(0.35, 1 - d / 700));
      } else if (!np.classList.contains('lyrics-on')) {
        flow.style.transition = 'none';
        flow.style.transform = `translateX(${dx * 0.55}px)`;
      }
    },
    end(dx, dy, vx, vy, axis) {
      if (axis === 'y') {
        if (dy > 120 || (vy > 0.7 && dy > 30)) {
          np.style.transition = spring;
          np.style.transform = 'translateY(100%)';
          np.style.opacity = '0';
          setTimeout(() => {
            App.closeNowPlaying();
            setTimeout(() => {
              np.style.transition = np.style.transform = np.style.opacity = '';
            }, 420);
          }, 220);
        } else {
          np.style.transition = spring;
          np.style.transform = '';
          np.style.opacity = '';
        }
        return;
      }
      flow.style.transition = spring;
      flow.style.transform = '';
      const go = Math.abs(dx) > 70 || (Math.abs(vx) > 0.5 && Math.abs(dx) > 25);
      if (go) dx < 0 ? Player.next() : Player.prev();
    },
  });

  // ---------- Мини-плеер ----------
  const bar = $('#player');
  const barLeft = bar.querySelector('.pl-left');
  drag(bar, {
    axis: 'xy',
    move(dx, dy, axis) {
      if (axis === 'x') {
        barLeft.style.transition = 'none';
        barLeft.style.transform = `translateX(${dx * 0.6}px)`;
        barLeft.style.opacity = String(Math.max(0.3, 1 - Math.abs(dx) / 260));
      } else {
        bar.style.transition = 'none';
        bar.style.transform = `translateY(${Math.min(0, dy) * 0.4}px)`;
      }
    },
    end(dx, dy, vx, vy, axis) {
      barLeft.style.transition = bar.style.transition = spring;
      barLeft.style.transform = barLeft.style.opacity = bar.style.transform = '';
      if (axis === 'x') {
        if (Math.abs(dx) > 60 || (Math.abs(vx) > 0.5 && Math.abs(dx) > 20)) dx < 0 ? Player.next() : Player.prev();
      } else if (dy < -30 || vy < -0.5) App.openNowPlaying();
    },
  });

  // ---------- Лист «Очередь / Текст»: потянуть шапку вниз — закрыть ----------
  const sheet = $('#sidePanel');
  drag(sheet.querySelector('.sp-tabs'), {
    axis: 'y',
    allow: (e) => !e.target.closest('button'),
    move(dx, dy) {
      sheet.style.transition = 'none';
      sheet.style.transform = `translateY(${Math.max(0, dy)}px)`;
    },
    end(dx, dy, vx, vy) {
      sheet.style.transition = '';
      sheet.style.transform = '';
      if (dy > 110 || (vy > 0.6 && dy > 30)) App.closePanel();
    },
  });

  // ---------- Долгое нажатие на трек — его меню ----------
  let press = null;
  document.addEventListener(
    'pointerdown',
    (e) => {
      const row = e.target.closest('.tr');
      if (!row || e.target.closest('button') || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const x = e.clientX;
      const y = e.clientY;
      row.classList.add('pressing');
      press = {
        row,
        x,
        y,
        timer: setTimeout(() => {
          row.classList.remove('pressing');
          press = null;
          swallowClick();
          App.rowMenu(row, Math.min(x, innerWidth - 250), y);
        }, 480),
      };
    },
    true,
  );
  const cancelPress = (e) => {
    if (!press) return;
    if (e && e.type === 'pointermove' && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 10) return;
    clearTimeout(press.timer);
    press.row.classList.remove('pressing');
    press = null;
  };
  ['pointermove', 'pointerup', 'pointercancel'].forEach((t) => document.addEventListener(t, cancelPress, true));
  document.addEventListener('scroll', () => cancelPress(), true);
  // своё меню вместо системного (выделение текста, «копировать»)
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('input, textarea')) e.preventDefault();
  });
})();
