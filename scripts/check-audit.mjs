// Проверка результата полного прохода по экранам; секреты и содержимое API здесь не обрабатываются.
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
if (!file) throw new Error('Укажите fullaudit.out');
const text = fs.readFileSync(file, 'utf8');
const matches = [...text.matchAll(/^.*SELFTEST fullaudit: (\{.*\})\s*$/gm)];
if (!matches.length) throw new Error('Нет итогового результата SELFTEST fullaudit');
const report = JSON.parse(matches.at(-1)[1]);
const summary = {
  pass: report.pass,
  pages: report.pages.map(({ page, pass, error, perf }) => ({ page, pass, error, perf })),
  checks: report.checks,
  faults: report.faults,
  calls: report.calls,
};
const output = process.argv[3];
if (output) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(summary, null, 2) + '\n');
}
console.log(JSON.stringify(summary, null, 2));
if (!report.pass) process.exitCode = 1;
