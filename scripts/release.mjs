#!/usr/bin/env node
/*
 * Выпуск новой версии: поднимает номер, собирает установщик (Tauri) и публикует его в GitHub Releases.
 * Установленные копии приложения (на любом вашем ПК) увидят релиз и обновятся сами.
 *
 * Номер растёт на число изменений в выпуске: каждая цифра 0–9, с переносом в следующий разряд.
 *   npm run release              → +1: 2.2.1 → 2.2.2
 *   npm run release -- 3         → +3: 2.2.1 → 2.2.4
 *   npm run release -- 9         → +9: 2.2.1 → 2.3.0
 *   npm run release -- 2.4.2     → ровно эта версия
 *   npm run release -- current   → выпустить текущую версию без изменения номера
 *   добавьте --notes "что нового" — текст появится в описании релиза и в приложении
 *
 * Нужно: Rust, Node.js, GitHub CLI с входом (gh auth login --web) и ключ подписи обновлений
 * %USERPROFILE%\.tauri\zvuk-glass.key (без него установленные копии не примут обновление).
 * Токен GitHub берётся из `gh auth token` и передаётся только дочерним процессам — нигде не печатается.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(root, 'package.json');
const cargoPath = join(root, 'src-tauri', 'Cargo.toml');
const keyPath = join(homedir(), '.tauri', 'zvuk-glass.key');
const OWNER = 'GhostOFFantasy';
const REPO = 'zvuk-glass';

const args = process.argv.slice(2);
const notesAt = args.indexOf('--notes');
const notesArg = notesAt >= 0 ? args.splice(notesAt, 2)[1] || '' : '';
const bump = args[0] || '1';

const fail = (msg) => {
  console.error('\n✖ ' + msg);
  process.exit(1);
};
const run = (cmd, a, opts = {}) => execFileSync(cmd, a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const step = (msg) => console.log('\n▸ ' + msg);
const withPath = (env) => {
  const extra = [join(homedir(), '.cargo', 'bin'), dirname(process.execPath)];
  return { ...env, PATH: [...extra, env.PATH || env.Path || ''].join(';') };
};

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
if (!existsSync(keyPath)) fail(`Нет ключа подписи обновлений: ${keyPath}. Без него установленные копии не примут новую версию.`);
if (run('git', ['status', '--porcelain'])) fail('Есть незакоммиченные изменения — сначала сделайте коммит.');
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
const ghEnv = { env: { ...process.env, GH_TOKEN: token } };
const R = ['-R', `${OWNER}/${REPO}`];

// ---------- Номер версии ----------
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const cur = pkg.version;
let next = cur;
if (bump !== 'current') {
  if (/^\+?\d+$/.test(bump)) {
    // версия как трёхзначное число: 2.2.1 → 221, +9 → 230 → 2.3.0
    const [ma, mi, pa] = cur.split('.').map(Number);
    const n = ma * 100 + Math.min(mi, 9) * 10 + Math.min(pa, 9) + Number(bump);
    next = `${Math.floor(n / 100)}.${Math.floor(n / 10) % 10}.${n % 10}`;
  } else if (/^\d+\.\d+\.\d+$/.test(bump)) next = bump;
  else fail(`Непонятная версия «${bump}». Укажите число изменений, current или x.y.z`);
}
// Описание выпуска — из src/renderer/changelog.js (тот же текст приложение покажет плашкой «Что нового»)
const changelog = (() => {
  const win = {};
  try {
    new Function('window', readFileSync(join(root, 'src', 'renderer', 'changelog.js'), 'utf8'))(win);
  } catch {}
  return win.ZG_CHANGELOG || [];
})();
const entry = changelog.find((e) => e.version === next);
if (!notesArg && !entry) fail(`В src/renderer/changelog.js нет описания версии ${next}. Добавьте его — плашка «Что нового» и описание релиза берут текст оттуда.`);
const changelogNotes = entry ? entry.items.map((i) => `• ${i.title}. ${i.text}`).join('\n') : '';

const tag = 'v' + next;
// тег уже есть: если он на текущем коммите — это повтор после неудачной публикации, продолжаем
const tagExists = Boolean(run('git', ['tag', '--list', tag]));
if (tagExists && run('git', ['rev-list', '-n', '1', tag]) !== run('git', ['rev-parse', 'HEAD']))
  fail(`Тег ${tag} уже существует — эта версия уже выпускалась. Выберите другой номер.`);

if (next !== cur) {
  step(`Версия ${cur} → ${next}`);
  pkg.version = next;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  const cargo = readFileSync(cargoPath, 'utf8').replace(/^version = "[^"]+"/m, `version = "${next}"`);
  writeFileSync(cargoPath, cargo);
  // обновить номер в Cargo.lock без сети
  spawnSync('cargo', ['update', '--workspace', '--offline'], { cwd: join(root, 'src-tauri'), stdio: 'ignore', env: withPath(process.env), shell: false });
  run('git', ['add', 'package.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']);
  run('git', ['commit', '-m', `Версия ${next}`]);
} else step(`Выпускаем текущую версию ${cur}`);

step('Отправляем код на GitHub');
if (!tagExists) run('git', ['tag', tag]);
for (const ref of [branch, tag]) {
  if (spawnSync('git', ['push', 'origin', ref], { cwd: root, stdio: 'inherit' }).status !== 0) fail(`Не удалось отправить ${ref} на GitHub`);
}

// Релиз создаём черновиком: приложения его не видят, пока все файлы не загружены и не проверены
let existing = null;
try {
  existing = JSON.parse(run(GH, ['release', 'view', tag, ...R, '--json', 'isDraft'], ghEnv));
} catch {}
if (existing && !existing.isDraft) fail(`Релиз ${tag} уже опубликован на GitHub. Выберите другой номер версии.`);
const notes = notesArg || changelogNotes || `Zvuk Glass ${next}`;
if (!existing) run(GH, ['release', 'create', tag, ...R, '--draft', '--verify-tag', '--title', `Zvuk Glass ${next}`, '--notes', notes], ghEnv);

step('Собираем приложение и установщик (несколько минут)');
const cli = join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const b = spawnSync(process.execPath, [cli, 'build'], {
  cwd: root,
  stdio: 'inherit',
  env: withPath({ ...process.env, TAURI_SIGNING_PRIVATE_KEY: keyPath, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' }),
});
if (b.status !== 0) fail('Сборка не удалась (см. вывод выше). Черновик релиза остался — после исправления запустите: npm run release -- current');

// ---------- Файлы релиза ----------
const nsisDir = join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const built = join(nsisDir, `Zvuk Glass_${next}_x64-setup.exe`);
if (!existsSync(built) || !existsSync(built + '.sig')) fail(`Не найден собранный установщик: ${built}`);
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const setupName = `Zvuk-Glass-Setup-${next}.exe`;
const setup = join(dist, setupName);
copyFileSync(built, setup);
const signature = readFileSync(built + '.sig', 'utf8').trim();
const url = `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/${setupName}`;
const pubDate = new Date().toISOString();

// Описание обновления с подписью (Tauri). Версии с 2.2.2 читают update.json.
const platform = { signature, url };
const platforms = { 'windows-x86_64': platform, 'windows-x86_64-nsis': platform };
writeFileSync(join(dist, 'update.json'), JSON.stringify({ version: next, notes, pub_date: pubDate, platforms }, null, 2));
// Мостик для копий до 2.3.0 включительно (они читают latest.json): после перехода на нумерацию 2.2.x
// их номер выше нового, поэтому здесь объявляем 2.3.1 — они ставят текущую версию и дальше читают update.json.
const num = (v) => v.split('.').map(Number).reduce((s, x) => s * 1000 + x, 0);
const bridgeVersion = num(next) > num('2.3.0') ? next : '2.3.1';
const bridgeNotes = bridgeVersion === next ? notes : `Переход на новую нумерацию версий: после установки будет версия ${next}.\n\n${notes}`;
writeFileSync(join(dist, 'latest.json'), JSON.stringify({ version: bridgeVersion, notes: bridgeNotes, pub_date: pubDate, platforms }, null, 2));
// для копий 1.x на Electron: они читают latest.yml и сами переходят на новую версию
const sha512 = createHash('sha512').update(readFileSync(setup)).digest('base64');
const size = statSync(setup).size;
writeFileSync(
  join(dist, 'latest.yml'),
  `version: ${next}\nfiles:\n  - url: ${setupName}\n    sha512: ${sha512}\n    size: ${size}\npath: ${setupName}\nsha512: ${sha512}\nreleaseDate: '${pubDate}'\n`
);

step('Загружаем файлы в релиз');
const files = [setup, join(dist, 'update.json'), join(dist, 'latest.json'), join(dist, 'latest.yml')];
if (spawnSync(GH, ['release', 'upload', tag, ...R, '--clobber', ...files], { cwd: root, stdio: 'inherit', ...ghEnv }).status !== 0)
  fail('Не удалось загрузить файлы. Черновик остался — запустите: npm run release -- current');
const assets = JSON.parse(run(GH, ['release', 'view', tag, ...R, '--json', 'assets'], ghEnv)).assets.map((a) => a.name);
for (const need of [setupName, 'update.json', 'latest.json', 'latest.yml']) if (!assets.includes(need)) fail(`В черновике ${tag} нет файла ${need}`);

step('Публикуем релиз');
run(GH, ['release', 'edit', tag, ...R, '--draft=false', '--latest', '--notes', notes], ghEnv);

console.log(`\n✔ Готово: ${tag} опубликован — https://github.com/${OWNER}/${REPO}/releases/tag/${tag}`);
console.log('  Установленные копии скачают обновление в течение нескольких часов (или сразу — «Настройки → О программе → Проверить обновления»).');
