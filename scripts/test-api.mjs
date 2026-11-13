// Проверка клиента API Zvuk.
// Без аргументов — на анонимном токене (только публичные методы).
// С токеном — `ZVUK_TOKEN=... npm run test:api` проверит и коллекцию.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ZvukClient } = require('../src/main/zvuk-api.js');

const client = new ZvukClient();
const token = process.env.ZVUK_TOKEN || (await client.getAnonymousToken());
client.setToken(token);
const authorized = Boolean(process.env.ZVUK_TOKEN);

let failed = 0;
async function check(name, fn, summarize) {
  const t0 = Date.now();
  try {
    const r = await fn();
    console.log(`OK   ${name} (${Date.now() - t0} ms): ${summarize ? summarize(r) : JSON.stringify(r).slice(0, 160)}`);
    return r;
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: [${e.code}] ${e.message}`);
    return null;
  }
}
const len = (a) => `${a.length} шт.` + (a[0] ? ` первый: ${a[0].title || a[0].name || a[0].id}` : '');

const profile = await check('profile', () => client.getProfile(), (p) => `id=${p.id} anon=${p.isAnonymous}`);
await check('subscription', () => client.getSubscription(), (s) => JSON.stringify(s));
await check('autocomplete', () => client.autocomplete('нирв'), (a) => a.join(', '));
await check('quickSearch', () => client.quickSearch('кино'), (r) => r.map((x) => x.__typename + ':' + (x.title || x.id)).join(', ').slice(0, 200));
const s = await check('search', () => client.search('Земфира', 10), (r) => Object.entries(r).map(([k, v]) => `${k}=${v.length}`).join(' '));
const track = s?.tracks?.[0];
const artist = s?.artists?.[0];
const release = s?.releases?.[0];
const playlist = s?.playlists?.[0];
if (track) {
  console.log('     пример трека:', JSON.stringify(track).slice(0, 400));
  await check('getTracks', () => client.getTracks([track.id]), len);
  const st = await check('getStream', () => client.getStream(track.id, 'flac'), (r) => `${r.quality} preview=${r.preview} ${r.url.slice(0, 70)}`);
  if (st) {
    await check('stream CDN (Range)', async () => {
      const res = await fetch(st.url, { headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(15000) });
      return `HTTP ${res.status} type=${res.headers.get('content-type')} len=${res.headers.get('content-length')} acao=${res.headers.get('access-control-allow-origin')}`;
    }, (x) => x);
  }
  await check('lyrics', () => client.getLyrics(track.id), (l) => (l ? `${l.type}: ${l.text.slice(0, 60).replace(/\n/g, ' | ')}` : 'нет'));
  await check('relatedTracks', () => client.getRelatedTracks(track.id, 5), len);
  await check('radio TRACK', () => client.radio('TRACK', track.id), (r) => `cursor=${r.cursor} ${len(r.tracks)}`);
}
if (artist) {
  await check('getArtist', () => client.getArtist(artist.id), (a) => `${a.title}: popular=${a.popularTracks?.length} releases=${a.releases?.length} related=${a.relatedArtists?.length}`);
  await check('radio ARTIST', () => client.radio('ARTIST', artist.id), (r) => `cursor=${r.cursor} ${len(r.tracks)}`);
}
if (release) await check('getRelease', () => client.getRelease(release.id), (r) => `${r.title}: tracks=${r.tracks?.length} related=${r.related?.length}`);
if (playlist) await check('getPlaylist', () => client.getPlaylist(playlist.id), (p) => `${p.title}: ${p.tracks.length} треков, img=${p.image?.src?.slice(0, 50)} cover=${p.coverV1?.src?.slice(0, 50)}`);
await check('personalWave', () => client.personalWave(5), len);
await check('personalWave mood', () => client.personalWave(5, { energy: 0.9, fun: 0.8, genres: ['rock'], language: 'russian' }), len);
await check('getWaves', () => client.getWaves(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']), (w) => w.map((x) => `${x.id}:${x.title}`).join(', '));
await check('waveContent 1', () => client.waveContent('1'), len);
await check('synthesisPlaylists', () => client.synthesisPlaylists(), (r) => r.map((x) => x.title).join(', '));
if (authorized) {
  // Рекомендации доступны только зарегистрированным пользователям
  await check('recommendations', () => client.recommendations(), (r) => r.map((x) => x.__typename[0] + ':' + x.title).slice(0, 8).join(', '));
  await check('collectionIds', () => client.getCollectionIds(), (c) => Object.entries(c).map(([k, v]) => `${k}=${v.length}`).join(' '));
  await check('likedTrackIds', () => client.getLikedTrackIds(), (a) => `${a.length} шт.`);
  await check('history', () => client.listeningHistory(10), len);
  await check('recentlyPlayed', () => client.recentlyPlayed(10), len);
}
console.log(failed ? `\nОшибок: ${failed}` : '\nВсе проверки прошли');
process.exit(failed ? 1 : 0);
