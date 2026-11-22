'use strict';
// Числовые проверки актуального контрастного контура без окна, аккаунта и сети.
const assert = require('node:assert/strict');
const path = require('node:path');
global.window = {};
require(path.join(__dirname, '../src/renderer/ink.js'));
const T = global.window.Ink._test;
const LIGHT = [241, 246, 255];
const report = { fadeMs: T.fade, cooldownMs: T.cooldown, history: T.history };

// После отказа от «наливания» тёмное состояние — чистый чёрный без белой подсветки.
report.pureBlack = [0, 0.25, 0.5, 0.75, 1].every((l) => T.darkRGB(l).every((v) => v === 0));
assert.ok(report.pureBlack, 'Тёмное состояние должно быть полностью чёрным при любой яркости');

report.darkBackground = [0, 0.1, 0.25].every((l) => T.inkRGB(l).every((v, i) => v === LIGHT[i]));
assert.ok(report.darkBackground, 'На тёмном фоне сохраняется светлая заливка');
report.lightBackground = [0.65, 0.8, 1].every((l) => T.inkRGB(l).every((v) => v === 0));
assert.ok(report.lightBackground, 'На светлом фоне включается чёрная заливка');

// Гистерезис не позволяет цвету мигать на каждом светлом кадре клипа.
report.lightToDark = T.desiredInk(0.8, 0) === 1;
report.darkToLight = T.desiredInk(0.1, 1) === 0;
report.brightHold = T.desiredInk(0.8, 1) === 1;
report.midHold = T.desiredInk(0.5, 1) === 1 && T.desiredInk(0.4, 0) === 0;
assert.ok(report.lightToDark && report.darkToLight, 'Пороги должны переключать цвет при реальной потере контраста');
assert.ok(report.brightHold && report.midHold, 'Гистерезис должен удерживать текущий цвет между порогами');

report.darkContrast = T.contrast(0, 0) === 1 && T.contrast(0, 1) > 15;
report.lightLuma = T.rgbLuma(LIGHT) > 0.9;
report.safeTiming = T.fade >= 500 && T.cooldown >= 1000 && T.history >= 3;
assert.ok(report.darkContrast, 'Функция контраста должна различать чёрный и белый');
assert.ok(report.lightLuma, 'Светлый цвет интерфейса изменился неожиданно');
assert.ok(report.safeTiming, 'Плавность и пауза между переключениями должны сохраняться');

console.log(JSON.stringify({ pass: true, ...report }, null, 2));
