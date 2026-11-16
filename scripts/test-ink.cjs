'use strict';
// Числовые проверки адаптивного цвета без окна, аккаунта и сети.
const assert = require('node:assert/strict');
const path = require('node:path');
global.window = {};
require(path.join(__dirname, '../src/renderer/ink.js'));
const T = global.window.Ink._test;
const W = T.width;
const H = T.height;
const gx = (x) => Math.round(x * (W - 1) / 95);
const gy = (y) => Math.round(y * (H - 1) / 13);
const at = (x, y) => gy(y) * W + gx(x);
const box = { left: 12, right: 52, top: 14, bottom: 38, width: 40, height: 24 };
const frame = (pixel) => ({
  w: 64,
  h: 64,
  px: Uint8Array.from({ length: 64 * 64 }, (_, i) => pixel(i % 64, Math.floor(i / 64))),
});
const report = { grid: `${W}x${H}` };

const flat = T.waterField(frame(() => 128), box, 64, 64);
report.flat = [...flat.field].every((l) => Math.abs(l - 128 / 255) < 0.002);
assert.ok(report.flat, 'Однородный фон должен оставаться однородным');

const vertical = T.waterField(frame((x) => x < 32 ? 235 : 18), box, 64, 64);
report.verticalLeft = vertical.field[at(5, 6)];
report.verticalRight = vertical.field[at(90, 6)];
assert.ok(report.verticalLeft > 0.86 && report.verticalRight < 0.14, 'Вертикальная граница засвета должна сохранять стороны');

const horizontal = T.waterField(frame((_, y) => y < 26 ? 235 : 18), box, 64, 64);
report.horizontalTop = horizontal.field[at(48, 2)];
report.horizontalBottom = horizontal.field[at(48, 11)];
assert.ok(report.horizontalTop > 0.86 && report.horizontalBottom < 0.14, 'Горизонтальная граница засвета должна сохранять стороны');

report.bounded = [...vertical.field, ...horizontal.field].every((l) => l >= 0 && l <= 1);
assert.ok(report.bounded, 'Карта яркости не должна выходить за диапазон');

// Вне строки светлый фон, а в промежутках между буквами — тёмная одежда персонажа.
const inner = T.waterField(frame((x, y) => x >= 12 && x < 52 && y >= 14 && y < 38 ? 18 : 235), box, 64, 64);
const glyphMask = new Uint8Array(W * H).fill(255);
for (let y = 0; y < H; y++) for (let x = gx(20); x <= gx(76); x++) glyphMask[y * W + x] = 0;
const masked = T.waterField(frame((x, y) => x >= 12 && x < 52 && y >= 14 && y < 38 ? 18 : 235), box, 64, 64, glyphMask);
report.innerWithoutMask = inner.field[at(48, 7)];
report.innerThroughGap = masked.field[at(48, 7)];
assert.ok(report.innerWithoutMask > 0.5, 'Контроль: без маски светлые края должны доминировать');
assert.ok(report.innerThroughGap < 0.12, 'Маска должна видеть тёмный фон в промежутках между буквами');

const edgeMask = new Uint8Array(W * H).fill(255);
for (let y = 0; y < H; y++) for (const x of [gx(10), gx(90)]) edgeMask[y * W + x] = 0;
const maskedEdge = T.waterField(frame((x) => x < 32 ? 235 : 18), box, 64, 64, edgeMask);
report.maskedEdgeLeft = maskedEdge.field[at(40, 7)];
report.maskedEdgeRight = maskedEdge.field[at(70, 7)];
assert.ok(report.maskedEdgeLeft > 0.82 && report.maskedEdgeRight < 0.12, 'Промежутки не должны размывать резкую границу через всю букву');

const verticalMask = new Uint8Array(W * H).fill(255);
verticalMask[at(48, 3)] = 0;
verticalMask[at(48, 10)] = 0;
const verticalGap = T.waterField(frame((x, y) => x >= 12 && x < 52 && y >= 14 && y < 38 ? 18 : 235), box, 64, 64, verticalMask);
report.innerThroughVerticalGap = verticalGap.field[at(48, 7)];
assert.ok(report.innerThroughVerticalGap < 0.12, `Широкий штрих должен уточняться по фону выше и ниже: ${report.innerThroughVerticalGap}`);

// Если внешние края ошибочно обещают засвет, ближний тёмный промежуток всё равно должен
// вернуть светлый штрих, не перенося этот тёмный фон через всю строку.
const nearMask = new Uint8Array(W * H).fill(255);
const nearIndex = at(40, 7);
nearMask[nearIndex] = 0;
const nearGap = T.waterField(frame((x, y) => x >= 20 && x < 40 && y >= 20 && y < 32 ? 18 : 235), box, 64, 64, nearMask);
report.falseBrightCoons = nearGap.field[nearIndex + 1];
report.distantBrightCoons = nearGap.field[at(70, 7)];
assert.ok(report.falseBrightCoons < 0.3, `Ближний тёмный промежуток должен вернуть штриху светлый цвет: ${report.falseBrightCoons}`);
assert.ok(report.distantBrightCoons > 0.82, 'Локальная поправка не должна затемнять далёкий засвет');

report.shades = [0.5, 0.55, 0.65, 0.85, 0.98].map((l) => {
  const rgb = T.darkRGB(l);
  const luma = (rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722) / 255;
  return { l, rgb, contrast: T.contrast(l, luma) };
});
assert.ok(report.shades.every((s, i, a) => !i || s.rgb.every((v, c) => v <= a[i - 1].rgb[c])), 'Тёмный оттенок должен темнеть вместе с засветом');
assert.ok(report.shades.every((s) => s.contrast >= 4.5), 'Полный тёмный цвет должен иметь контраст не ниже 4.5:1, включая средний фон');
assert.ok(report.shades[0].rgb[0] - report.shades[4].rgb[0] >= 14, 'Графитовый и глубокий чёрный оттенки должны различаться');
report.lightUnchanged = [0, 0.25, 0.48].every((l) => T.inkRGB(l).every((v, i) => Math.abs(v - [243, 247, 255][i]) < 0.001));
assert.ok(report.lightUnchanged, 'Светлый текст на тёмном фоне не должен меняться');
report.midtoneDark = T.inkRGB(0.51).every((v, i) => Math.abs(v - T.darkRGB(0.51)[i]) < 0.001);
assert.ok(report.midtoneDark, 'На среднем засвете цвет должен полностью перейти к контрастному графиту');
console.log(JSON.stringify({ pass: true, ...report }, null, 2));
