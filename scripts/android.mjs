// Сборка Android-версии (APK).
//
//   node scripts/android.mjs              проверочная сборка для телефонов (ARM64), файл …-test.apk
//   node scripts/android.mjs --release    выпускная: ARM64 + ARMv7
// Обе — оптимизированные (отладочная Rust-библиотека весит 200+ МБ).
//
// Tauri собирает Rust-часть и готовит Android-проект, но на последнем шаге создаёт символическую ссылку
// на библиотеку — в Windows без «режима разработчика» это запрещено. Поэтому библиотеку копируем сами
// и запускаем Gradle напрямую. Результат — dist/android/Zvuk-Glass-<версия>[-test].apk.
// Подпись — ключом из %USERPROFILE%\.tauri\zvuk-glass-android.properties (см. app/build.gradle.kts).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = process.argv.includes('--release');
const profile = 'release';
const Profile = 'Release';

const TARGETS = {
  aarch64: { triple: 'aarch64-linux-android', abi: 'arm64-v8a', arch: 'arm64' },
  armv7: { triple: 'armv7-linux-androideabi', abi: 'armeabi-v7a', arch: 'arm' },
  x86_64: { triple: 'x86_64-linux-android', abi: 'x86_64', arch: 'x86_64' },
};
const want = (process.argv.find((a) => a.startsWith('--targets=')) || '').slice(10).split(',').filter(Boolean);
const targets = want.length ? want : release ? ['aarch64', 'armv7'] : ['aarch64'];

// окружение: Java, Android SDK и NDK (можно переопределить переменными)
const env = { ...process.env };
env.JAVA_HOME ||= 'C:\\Program Files\\Microsoft\\jdk-21.0.13.21-hotspot';
env.ANDROID_HOME ||= 'D:\\Android\\Sdk';
if (!env.NDK_HOME) {
  const ndkDir = path.join(env.ANDROID_HOME, 'ndk');
  const v = fs.existsSync(ndkDir) ? fs.readdirSync(ndkDir).sort().pop() : null;
  if (v) env.NDK_HOME = path.join(ndkDir, v);
}
env.PATH = [path.join(process.env.USERPROFILE || '', '.cargo', 'bin'), path.dirname(process.execPath), env.PATH].join(path.delimiter);

const step = (s) => console.log(`\n▸ ${s}`);
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: root, env, shell: true, encoding: 'utf8', maxBuffer: 1 << 28, ...opts });

const android = path.join(root, 'src-tauri', 'gen', 'android');
const jniLibs = path.join(android, 'app', 'src', 'main', 'jniLibs');

for (const t of targets) {
  const T = TARGETS[t];
  if (!T) throw new Error(`Неизвестная архитектура: ${t}`);
  step(`Rust-часть для ${t} (${profile})`);
  const r = run('npx', ['tauri', 'android', 'build', '--apk', '--target', t]);
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const symlinkOnly = /symbolic link|SymlinkNotAllowed/i.test(out);
  if (r.status !== 0 && !symlinkOnly) {
    console.error(out.split('\n').slice(-40).join('\n'));
    process.exit(1);
  }
  // библиотеку кладём на место ссылки, которую Tauri не смог создать
  const so = path.join(root, 'src-tauri', 'target', T.triple, profile, 'libzvuk_glass_lib.so');
  if (!fs.existsSync(so)) throw new Error(`Нет собранной библиотеки: ${so}`);
  const dst = path.join(jniLibs, T.abi);
  fs.mkdirSync(dst, { recursive: true });
  const lib = path.join(dst, 'libzvuk_glass_lib.so');
  try {
    fs.rmSync(lib, { force: true });
  } catch {}
  fs.copyFileSync(so, lib);
  console.log(`  ${path.relative(root, lib)} — ${(fs.statSync(lib).size / 1048576).toFixed(1)} МБ`);
}
// библиотеки архитектур, которые в эту сборку не входят, не должны попасть в APK
for (const [t, T] of Object.entries(TARGETS)) if (!targets.includes(t)) fs.rmSync(path.join(jniLibs, T.abi), { recursive: true, force: true });

step('Сборка APK (Gradle)');
const abis = targets.map((t) => TARGETS[t]);
const flavor = targets.length === 1 ? abis[0].arch : 'universal';
const Flavor = flavor[0].toUpperCase() + flavor.slice(1);
// Rust уже собран — задачи Gradle, которые позвали бы Tauri снова, пропускаем (есть только для выбранных архитектур)
const skip = ['Universal', ...abis.map((T) => T.arch[0].toUpperCase() + T.arch.slice(1))].flatMap((a) => ['-x', `rustBuild${a}${Profile}`]);
const props = [`-PabiList=${abis.map((a) => a.abi).join(',')}`, `-ParchList=${abis.map((a) => a.arch).join(',')}`, `-PtargetList=${targets.join(',')}`];
const g = run(JSON.stringify(path.join(android, 'gradlew.bat')), [`assemble${Flavor}${Profile}`, ...skip, ...props, '--console=plain'], { cwd: android, stdio: 'inherit' });
if (g.status !== 0) process.exit(g.status || 1);

const apkDir = path.join(android, 'app', 'build', 'outputs', 'apk', flavor, profile);
const apk = fs.readdirSync(apkDir).find((f) => f.endsWith('.apk'));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const outDir = path.join(root, 'dist', 'android');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `Zvuk-Glass-${version}${release ? '' : '-test'}.apk`);
fs.copyFileSync(path.join(apkDir, apk), out);
console.log(`\n✔ ${path.relative(root, out)} — ${(fs.statSync(out).size / 1048576).toFixed(1)} МБ`);
