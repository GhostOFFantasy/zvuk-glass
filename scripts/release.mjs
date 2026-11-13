#!/usr/bin/env node
/*
 * Выпуск новой версии: поднимает номер, собирает установщик и публикует его в GitHub Releases.
 * Установленные копии приложения (на любом вашем ПК) увидят релиз и обновятся сами.
 *
 *   npm run release              → 1.0.0 → 1.0.1
 *   npm run release -- minor     → 1.0.0 → 1.1.0
 *   npm run release -- major     → 1.0.0 → 2.0.0
 *   npm run release -- 1.4.2     → ровно эта версия
 *   npm run release -- current   → выпустить текущую версию без изменения номера
 *   добавьте --notes "что нового" — текст появится в описании релиза
 *
 * Перед выпуском все изменения должны быть закоммичены. Токен GitHub берётся из `gh auth token`
 * и передаётся сборщику через переменную окружения — нигде не печатается и не сохраняется.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(root, 'package.json');
const args = process.argv.slice(2);
const notesAt = args.indexOf('--notes');
const notes = notesAt >= 0 ? args.splice(notesAt, 2)[1] || '' : '';
const bump = args[0] || 'patch';

const fail = (msg) => {
  console.error('\n✖ ' + msg);
  process.exit(1);
};
const run = (cmd, a, opts = {}) => execFileSync(cmd, a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const step = (msg) => console.log('\n▸ ' + msg);

const GH = (() => {
  const local = 'C:\\Program Files\\GitHub CLI\\gh.exe';
  try {
    run('gh', ['--version']);
    return 'gh';
  } catch {
    if (existsSync(local)) return local;
  }
  fail('Не найден GitHub CLI (gh). Установите: winget install GitHub.cli');
})();

// ---------- Проверки ----------
let token = '';
try {
  token = run(GH, ['auth', 'token']);
} catch {
  fail('Нет входа в GitHub. Выполните: gh auth login --web');
}
if (run('git', ['status', '--porcelain'])) fail('Есть незакоммиченные изменения — сначала сделайте коммит.');
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);

// ---------- Номер версии ----------
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const cur = pkg.version;
let next = cur;
if (bump !== 'current') {
  const [ma, mi, pa] = cur.split('.').map(Number);
  if (bump === 'patch') next = `${ma}.${mi}.${pa + 1}`;
  else if (bump === 'minor') next = `${ma}.${mi + 1}.0`;
  else if (bump === 'major') next = `${ma + 1}.0.0`;
  else if (/^\d+\.\d+\.\d+$/.test(bump)) next = bump;
  else fail(`Непонятная версия «${bump}». Используйте patch, minor, major, current или x.y.z`);
}
const tag = 'v' + next;
// тег уже есть: если он на текущем коммите — это повтор после неудачной публикации, продолжаем
const tagExists = Boolean(run('git', ['tag', '--list', tag]));
if (tagExists && run('git', ['rev-list', '-n', '1', tag]) !== run('git', ['rev-parse', 'HEAD']))
  fail(`Тег ${tag} уже существует — эта версия уже выпускалась. Выберите другой номер.`);

if (next !== cur) {
  step(`Версия ${cur} → ${next}`);
  pkg.version = next;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  const lockPath = join(root, 'package-lock.json');
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    lock.version = next;
    if (lock.packages && lock.packages['']) lock.packages[''].version = next;
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  }
  run('git', ['add', 'package.json', ...(existsSync(lockPath) ? ['package-lock.json'] : [])]);
  run('git', ['commit', '-m', `Версия ${next}`]);
} else step(`Выпускаем текущую версию ${cur}`);

step('Отправляем код на GitHub');
if (!tagExists) run('git', ['tag', tag]);
for (const ref of [branch, tag]) {
  if (spawnSync('git', ['push', 'origin', ref], { cwd: root, stdio: 'inherit' }).status !== 0) fail(`Не удалось отправить ${ref} на GitHub`);
}

// Релиз создаём заранее черновиком: иначе сборщик загружает файлы параллельно
// и может создать два релиза на один тег. Черновик не виден приложениям, пока не опубликован.
const repo = pkg.build.publish[0];
const R = ['-R', `${repo.owner}/${repo.repo}`];
const ghEnv = { env: { ...process.env, GH_TOKEN: token } };
let existing = null;
try {
  existing = JSON.parse(run(GH, ['release', 'view', tag, ...R, '--json', 'isDraft'], ghEnv));
} catch {}
if (existing && !existing.isDraft) fail(`Релиз ${tag} уже опубликован на GitHub. Выберите другой номер версии.`);
if (!existing) run(GH, ['release', 'create', tag, ...R, '--draft', '--verify-tag', '--title', tag, '--notes', notes || `Zvuk Glass ${next}`], ghEnv);

step('Собираем установщик и загружаем его в релиз (пара минут)');
const cli = join(root, 'node_modules', 'electron-builder', 'cli.js');
const r = spawnSync(process.execPath, [cli, '--win', '--publish', 'always'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, GH_TOKEN: token },
});
if (r.status !== 0) fail('Сборка или загрузка не удалась (см. вывод выше). Черновик релиза остался — после исправления запустите: npm run release -- current');

const assets = JSON.parse(run(GH, ['release', 'view', tag, ...R, '--json', 'assets'], ghEnv)).assets.map((a) => a.name);
if (!assets.includes('latest.yml') || !assets.some((n) => n.endsWith('.exe'))) fail(`В черновике ${tag} не хватает файлов: ${assets.join(', ') || 'пусто'}`);

step('Публикуем релиз');
run(GH, ['release', 'edit', tag, ...R, '--draft=false', '--latest', ...(notes ? ['--notes', notes] : [])], ghEnv);

console.log(`\n✔ Готово: ${tag} опубликован — https://github.com/${repo.owner}/${repo.repo}/releases/tag/${tag}`);
console.log('  Установленные копии приложения скачают обновление в течение нескольких часов (или сразу — «Настройки → О программе → Проверить обновления»).');
