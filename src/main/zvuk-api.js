'use strict';
/**
 * Клиент неофициального API Zvuk (zvuk.com).
 * Использует тот же GraphQL-эндпоинт, что и веб-плеер, и пару REST-методов «tiny».
 * Работает в чистом Node.js (fetch), поэтому одинаково запускается в Electron и в тестах.
 */

const GRAPHQL_URL = 'https://zvuk.com/api/v1/graphql';
const TINY_URL = 'https://zvuk.com/api/tiny';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

// ---------- Фрагменты полей ----------
const IMG = 'image { src palette }';
const ARTIST_SHORT = `id title ${IMG}`;
const RELEASE_SHORT = `id title date type explicit ${IMG} artists { id title }`;
const TRACK = `id title duration explicit hasFlac lyrics availability
  artists { id title ${IMG} }
  release { id title date type ${IMG} }`;
const PLAYLIST_SHORT = `id title description duration isPublic userId image { src palette } coverV1 { src }`;

// ID «Плейлистов для вас» (синтезированные под пользователя), стабильны для аккаунта.
const SYNTHESIS_PLAYLIST_IDS = ['3', '4', '6', '11', '12', '13', '14', '15'];

class ZvukError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'ZvukError';
    this.code = code || 'ERROR';
    this.details = details;
  }
}

/** Zvuk иногда присылает null внутри списков (например, среди релизов) — вычищаем их везде. */
function dropNulls(v) {
  if (Array.isArray(v)) {
    const out = [];
    for (const x of v) if (x !== null && x !== undefined) out.push(dropNulls(x));
    return out;
  }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) v[k] = dropNulls(v[k]);
  }
  return v;
}

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

class ZvukClient {
  constructor({ token = null, cookies = [] } = {}) {
    this.token = token;
    this.jar = new Map();
    for (const c of cookies) this.jar.set(c.name, c.value);
  }

  setToken(token) {
    this.token = token || null;
  }

  setCookies(cookies) {
    for (const c of cookies || []) this.jar.set(c.name, c.value);
  }

  // ---------- HTTP ----------
  _storeCookies(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  async _fetch(url, opts = {}, depth = 0) {
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      Referer: 'https://zvuk.com/',
      Origin: 'https://zvuk.com',
      ...(opts.headers || {}),
    };
    if (this.token) headers['X-Auth-Token'] = this.token;
    if (this.jar.size) headers.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');

    let res;
    try {
      res = await fetch(url, {
        method: opts.method || 'GET',
        headers,
        body: opts.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeout || 20000),
      });
    } catch (e) {
      throw new ZvukError(`Нет связи с Zvuk: ${e.message}`, 'NETWORK');
    }
    this._storeCookies(res);
    // Защита сайта ставит cookie и перенаправляет на тот же адрес — просто повторяем запрос с cookie.
    if ([301, 302, 303, 307, 308].includes(res.status) && depth < 5) {
      const loc = new URL(res.headers.get('location'), url).toString();
      return this._fetch(loc, opts, depth + 1);
    }
    return res;
  }

  async _json(res) {
    const text = await res.text();
    if (res.status === 418 || /^\s*<!doctype html|^\s*<html/i.test(text)) {
      throw new ZvukError('Zvuk временно ограничил доступ (защита от ботов). Попробуйте позже.', 'BLOCKED');
    }
    if (res.status === 401 || res.status === 403) {
      throw new ZvukError('Сессия Zvuk недействительна — войдите заново.', 'UNAUTHORIZED');
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ZvukError(`Неожиданный ответ Zvuk (HTTP ${res.status})`, 'BAD_RESPONSE', text.slice(0, 300));
    }
    if (res.status >= 400 && !data.errors) {
      throw new ZvukError(data.message || `Ошибка Zvuk (HTTP ${res.status})`, 'HTTP_' + res.status, data);
    }
    return data;
  }

  async gql(operationName, query, variables = {}) {
    const res = await this._fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationName, query, variables }),
    });
    const data = await this._json(res);
    if (data.errors && data.errors.length) {
      const msg = data.errors.map((e) => e.message).join('; ');
      const unauth = data.errors.some((e) => /unauth|forbidden|not authorized|auth/i.test(e.message || '') || e.extensions?.code === 'UNAUTHENTICATED');
      if (!data.data || unauth) throw new ZvukError(msg, unauth ? 'UNAUTHORIZED' : 'GRAPHQL', data.errors);
    }
    return dropNulls(data.data || {});
  }

  async tiny(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const res = await this._fetch(`${TINY_URL}${path}${qs ? '?' + qs : ''}`);
    const data = await this._json(res);
    return data.result !== undefined ? data.result : data;
  }

  // ---------- Профиль и подписка ----------
  async getAnonymousToken() {
    const saved = this.token;
    this.token = null;
    try {
      const r = await this.tiny('/profile');
      return r.token || r.profile?.token;
    } finally {
      this.token = saved;
    }
  }

  async getProfile() {
    const r = await this.tiny('/profile');
    const p = r.profile || r;
    return {
      id: String(p.id ?? r.id ?? ''),
      name: p.name || p.username || null,
      image: p.image?.src || p.image || null,
      isAnonymous: Boolean(r.is_anonymous ?? p.is_anonymous ?? false),
      token: r.token || p.token || null,
      raw: r,
    };
  }

  async getSubscription() {
    try {
      const d = await this.gql(
        'getSubscriptions',
        `query getSubscriptions { subscriptions { mainSubscription { id name status expirationDate isTrial } } }`
      );
      return d.subscriptions?.mainSubscription || null;
    } catch {
      return null;
    }
  }

  // ---------- Поиск ----------
  async quickSearch(query, limit = 10) {
    const d = await this.gql(
      'quickSearch',
      `query quickSearch($query: String, $limit: Int) {
        quickSearch(query: $query, limit: $limit) {
          content { __typename
            ... on Track { ${TRACK} }
            ... on Artist { ${ARTIST_SHORT} }
            ... on Release { ${RELEASE_SHORT} }
            ... on Playlist { ${PLAYLIST_SHORT} }
          }
        }
      }`,
      { query, limit }
    );
    return (d.quickSearch?.content || []).filter((x) => ['Track', 'Artist', 'Release', 'Playlist'].includes(x.__typename));
  }

  async search(query, limit = 30) {
    const d = await this.gql(
      'search',
      `query search($query: String, $limit: Int) {
        search(query: $query) {
          tracks(limit: $limit) { items { ${TRACK} } }
          artists(limit: $limit) { items { ${ARTIST_SHORT} } }
          releases(limit: $limit) { items { ${RELEASE_SHORT} } }
          playlists(limit: $limit) { items { ${PLAYLIST_SHORT} } }
        }
      }`,
      { query, limit }
    );
    const s = d.search || {};
    return {
      tracks: s.tracks?.items || [],
      artists: s.artists?.items || [],
      releases: s.releases?.items || [],
      playlists: s.playlists?.items || [],
    };
  }

  async autocomplete(query) {
    const d = await this.gql(
      'getSearchAutocomplete',
      `query getSearchAutocomplete($query: String!, $limit: Int = 6) { searchAutocomplete(limit: $limit, query: $query) { content } }`,
      { query }
    );
    return d.searchAutocomplete?.content || [];
  }

  // ---------- Треки ----------
  async getTracks(ids) {
    const list = (ids || []).map(String).filter(Boolean);
    if (!list.length) return [];
    const parts = await Promise.all(
      chunk(list, 100).map((part) =>
        this.gql('getTracks', `query getTracks($ids: [ID!]!) { getTracks(ids: $ids) { ${TRACK} } }`, { ids: part })
      )
    );
    const byId = new Map();
    for (const p of parts) for (const t of p.getTracks || []) if (t) byId.set(String(t.id), t);
    return list.map((id) => byId.get(id)).filter(Boolean);
  }

  /** Ссылка на поток. quality: 'flac' | 'high' | 'mid'. Возвращает лучшее доступное не выше запрошенного. */
  async getStream(trackId, quality = 'high') {
    const d = await this.gql(
      'getStream',
      `query getStream($ids: [ID!]!) { mediaContents(ids: $ids) { __typename ... on Track { stream { expire flac high mid } } } }`,
      { ids: [String(trackId)] }
    );
    const st = d.mediaContents?.[0]?.stream;
    if (!st) throw new ZvukError('Трек недоступен для воспроизведения', 'NO_STREAM');
    const order = quality === 'flac' ? ['flac', 'high', 'mid'] : quality === 'high' ? ['high', 'mid'] : ['mid'];
    for (const q of order) {
      if (st[q]) {
        const preview = /\/preview(\?|$)/.test(st[q]);
        return { url: st[q], quality: q, expire: st.expire, preview };
      }
    }
    throw new ZvukError('Для этого трека нет доступного потока', 'NO_STREAM');
  }

  async getLyrics(trackId) {
    try {
      const r = await this.tiny('/lyrics', { track_id: String(trackId) });
      if (!r || !r.lyrics) return null;
      return { type: r.type || null, text: r.lyrics, translation: r.translation || null };
    } catch (e) {
      if (e.code === 'HTTP_404') return null;
      throw e;
    }
  }

  async getRelatedTracks(trackId, limit = 30) {
    const d = await this.gql(
      'getRelatedTracks',
      `query getRelatedTracks($id: ID!, $limit: Int) { relatedTracks(track_id: $id, limit: $limit) { ${TRACK} } }`,
      { id: String(trackId), limit }
    );
    return d.relatedTracks || [];
  }

  // ---------- Релизы и исполнители ----------
  async getRelease(id) {
    const d = await this.gql(
      'getReleases',
      `query getReleases($ids: [ID!]!) { getReleases(ids: $ids) {
        ${RELEASE_SHORT}
        genres { id name }
        label { id title }
        tracks { ${TRACK} }
        related(limit: 12) { ${RELEASE_SHORT} }
      } }`,
      { ids: [String(id)] }
    );
    return d.getReleases?.[0] || null;
  }

  async getArtist(id) {
    const d = await this.gql(
      'getArtists',
      `query getArtists($ids: [ID!]!) { getArtists(ids: $ids) {
        ${ARTIST_SHORT}
        secondImage { src }
        description
        collectionItemData { likesCount }
        popularTracks(limit: 20) { ${TRACK} }
        releases(limit: 100) { ${RELEASE_SHORT} }
        relatedArtists(limit: 14) { ${ARTIST_SHORT} }
      } }`,
      { ids: [String(id)] }
    );
    return d.getArtists?.[0] || null;
  }

  async getReleasesShort(ids) {
    const list = (ids || []).map(String);
    if (!list.length) return [];
    const parts = await Promise.all(
      chunk(list, 100).map((part) =>
        this.gql('getReleases', `query getReleases($ids: [ID!]!) { getReleases(ids: $ids) { ${RELEASE_SHORT} } }`, { ids: part })
      )
    );
    const byId = new Map();
    for (const p of parts) for (const r of p.getReleases || []) if (r) byId.set(String(r.id), r);
    return list.map((x) => byId.get(x)).filter(Boolean);
  }

  async getArtistsShort(ids) {
    const list = (ids || []).map(String);
    if (!list.length) return [];
    const parts = await Promise.all(
      chunk(list, 100).map((part) =>
        this.gql('getArtists', `query getArtists($ids: [ID!]!) { getArtists(ids: $ids) { ${ARTIST_SHORT} } }`, { ids: part })
      )
    );
    const byId = new Map();
    for (const p of parts) for (const r of p.getArtists || []) if (r) byId.set(String(r.id), r);
    return list.map((x) => byId.get(x)).filter(Boolean);
  }

  // ---------- Плейлисты ----------
  async getPlaylistsShort(ids) {
    const list = (ids || []).map(String);
    if (!list.length) return [];
    const parts = await Promise.all(
      chunk(list, 50).map((part) =>
        this.gql(
          'getPlaylists',
          `query getPlaylists($ids: [ID!]!) { getPlaylists(ids: $ids) { ${PLAYLIST_SHORT} tracks { id } } }`,
          { ids: part }
        )
      )
    );
    const byId = new Map();
    const need = new Map(); // плейлист без обложки → id первых треков
    for (const p of parts)
      for (const r of p.getPlaylists || []) {
        if (!r) continue;
        const ids = (r.tracks || []).map((t) => String(t.id));
        byId.set(String(r.id), { ...r, trackCount: ids.length, tracks: undefined });
        if (!r.coverV1?.src && ids.length) need.set(String(r.id), ids.slice(0, 8));
      }
    // Обложка-мозаика из альбомов первых треков (у своих плейлистов Zvuk обложку не хранит)
    if (need.size) {
      try {
        const tracks = await this.getTracks([...new Set([].concat(...need.values()))]);
        const tById = new Map(tracks.map((t) => [String(t.id), t]));
        for (const [pid, ids] of need) {
          const srcs = [];
          for (const id of ids) {
            const s = tById.get(id)?.release?.image?.src;
            if (s && !srcs.includes(s)) srcs.push(s);
            if (srcs.length === 4) break;
          }
          byId.get(pid).mosaic = srcs;
        }
      } catch {}
    }
    return list.map((x) => byId.get(x)).filter(Boolean);
  }

  async getPlaylist(id) {
    const d = await this.gql(
      'getPlaylists',
      `query getPlaylists($ids: [ID!]!) { getPlaylists(ids: $ids) { ${PLAYLIST_SHORT} updated tracks { id } } }`,
      { ids: [String(id)] }
    );
    const pl = d.getPlaylists?.[0];
    if (!pl) return null;
    const ids = (pl.tracks || []).map((t) => String(t.id));
    const tracks = await this.getTracks(ids);
    const mosaic = [];
    for (const t of tracks) {
      const s = t.release?.image?.src;
      if (s && !mosaic.includes(s)) mosaic.push(s);
      if (mosaic.length === 4) break;
    }
    return { ...pl, trackIds: ids, tracks, mosaic };
  }

  async createPlaylist(name, trackIds = []) {
    const items = trackIds.map((id) => ({ type: 'track', item_id: String(id) }));
    const d = await this.gql(
      'createPlayList',
      `mutation createPlayList($items: [PlaylistItem!]!, $name: String!) { playlist { create(items: $items, name: $name) } }`,
      { name, items }
    );
    return String(d.playlist?.create ?? '');
  }

  async addTracksToPlaylist(playlistId, trackIds) {
    const items = trackIds.map((id) => ({ type: 'track', item_id: String(id) }));
    await this.gql(
      'addTracksToPlaylist',
      `mutation addTracksToPlaylist($id: ID!, $items: [PlaylistItem!]!) { playlist { addItems(id: $id, items: $items) } }`,
      { id: String(playlistId), items }
    );
    return true;
  }

  /** Перезаписывает состав плейлиста (используется для удаления треков). */
  async updatePlaylist(playlistId, { name, isPublic, trackIds }) {
    const items = trackIds.map((id) => ({ type: 'track', item_id: String(id) }));
    await this.gql(
      'updataPlaylist',
      `mutation updataPlaylist($id: ID!, $items: [PlaylistItem!]!, $isPublic: Boolean!, $name: String!) {
        playlist { update(id: $id, items: $items, isPublic: $isPublic, name: $name) } }`,
      { id: String(playlistId), items, isPublic: Boolean(isPublic), name }
    );
    return true;
  }

  async renamePlaylist(playlistId, name) {
    await this.gql(
      'renamePlaylist',
      `mutation renamePlaylist($id: ID!, $name: String!) { playlist { rename(id: $id, name: $name) } }`,
      { id: String(playlistId), name }
    );
    return true;
  }

  async deletePlaylist(playlistId) {
    await this.gql('deletePlaylist', `mutation deletePlaylist($id: ID!) { playlist { delete(id: $id) } }`, {
      id: String(playlistId),
    });
    return true;
  }

  // ---------- Коллекция («Любимое») ----------
  async getCollectionIds() {
    const d = await this.gql(
      'userCollection',
      `query userCollection { collection {
        tracks { id } releases { id } artists { id } playlists { id }
      } }`
    );
    const c = d.collection || {};
    const ids = (k) => (c[k] || []).map((x) => String(x.id));
    return { tracks: ids('tracks'), releases: ids('releases'), artists: ids('artists'), playlists: ids('playlists') };
  }

  async getLikedTrackIds() {
    const d = await this.gql(
      'userTracks',
      `query userTracks($orderBy: TrackOrderByType, $orderDirection: OrderDirectionType) {
        collection { tracks(orderBy: $orderBy, orderDirection: $orderDirection) { id } } }`,
      { orderBy: 'dateAdded', orderDirection: 'desc' }
    );
    return (d.collection?.tracks || []).map((t) => String(t.id));
  }

  async like(type, id) {
    await this.gql(
      'addItemToCollection',
      `mutation addItemToCollection($id: ID, $type: CollectionItemType) { collection { addItem(id: $id, type: $type) } }`,
      { id: String(id), type }
    );
    return true;
  }

  async unlike(type, id) {
    await this.gql(
      'removeItemFromCollection',
      `mutation removeItemFromCollection($id: ID, $type: CollectionItemType) { collection { removeItem(id: $id, type: $type) } }`,
      { id: String(id), type }
    );
    return true;
  }

  async hideTrack(id) {
    await this.gql(
      'addItemToHidden',
      `mutation addItemToHidden($id: ID!, $type: CollectionItemType!) { hidden_collection { addItem(id: $id, type: $type) } }`,
      { id: String(id), type: 'track' }
    );
    return true;
  }

  // ---------- Рекомендации, волны, радио ----------
  /**
   * «Моя волна». options: { energy, fun (0..1), genres: [..], language: 'russian'|'foreign', instrumental, popularity: 0|1 }
   */
  async personalWave(count = 10, opts = {}) {
    const options = {};
    if (opts.energy != null || opts.fun != null) {
      options.mood = `energy:${opts.energy ?? 0.5},fun:${opts.fun ?? 0.5}`;
    }
    if (opts.genres && opts.genres.length) options.genre = opts.genres.map((name) => ({ name, type: 'LVL1' }));
    if (opts.popularity != null) options.popular = opts.popularity;
    if (opts.instrumental) options.vocal = 0;
    else if (opts.language) {
      options.language = opts.language;
      options.vocal = 1;
    }
    const d = await this.gql(
      'getPersonalWave',
      `query getPersonalWave($first: PositiveInt!, $options: PersonalWaveOptions, $waveSrc: MagicSource) {
        personalWaveContent(first: $first, options: $options, waveSrc: $waveSrc) { ${TRACK} } }`,
      { first: count, options, waveSrc: 'AMAZME' }
    );
    return d.personalWaveContent || [];
  }

  async getWaves(ids) {
    const d = await this.gql(
      'getWavesShortInfo',
      `query getWavesShortInfo($ids: [ID!]!) { wave { waves(ids: $ids) { id title description image { src } } } }`,
      { ids: ids.map(String) }
    );
    return (d.wave?.waves || []).filter(Boolean);
  }

  async waveContent(waveId) {
    const d = await this.gql(
      'waveContent',
      `query waveContent($contentInput: WaveContentInput!) { wave { waveContent(contentInput: $contentInput) {
        itemId itemType content { __typename ... on Track { ${TRACK} } } } } }`,
      { contentInput: { waveId: String(waveId), localtime: new Date().toISOString() } }
    );
    return (d.wave?.waveContent || []).map((x) => x.content).filter((x) => x && x.__typename === 'Track');
  }

  /** Радио по сущности: type = 'ARTIST' | 'TRACK' | 'RELEASE' */
  async radio(type, id, cursor = 0, limit = 25) {
    const d = await this.gql(
      'getRadioByEntity',
      `query getRadioByEntity($id: ID!, $type: RecommenderRadioEntityType!, $limit: NonNegativeInt!, $cursor: NonNegativeInt) {
        recommenderRadio(onEntity: { id: $id, type: $type }, first: $limit, cursor: $cursor) { cursor tracks { ${TRACK} } } }`,
      { id: String(id), type, limit, cursor }
    );
    return { cursor: d.recommenderRadio?.cursor ?? 0, tracks: d.recommenderRadio?.tracks || [] };
  }

  async recommendations(pages = [1]) {
    const d = await this.gql(
      'getMusicRecommendations',
      `query getMusicRecommendations($contentType: DynamicBlockContentType!, $itemType: [DynamicBlockItemType!], $pages: [Int!]!) {
        dynamicBlock(contentType: $contentType, itemType: $itemType, pages: $pages) {
          totalPages
          pages { page items {
            ... on Artist { __typename ${ARTIST_SHORT} }
            ... on Release { __typename ${RELEASE_SHORT} }
            ... on Playlist { __typename id title duration trackCount image { src palette } coverV1 { src } }
          } }
        } }`,
      { contentType: 'Music', itemType: ['Artist', 'Release', 'Playlist'], pages }
    );
    const items = [];
    for (const p of d.dynamicBlock?.pages || []) for (const it of p.items || []) if (it && it.__typename) items.push(it);
    return items;
  }

  async synthesisPlaylists() {
    try {
      return await this.getPlaylistsShort(SYNTHESIS_PLAYLIST_IDS);
    } catch {
      return [];
    }
  }

  async listeningHistory(limit = 50) {
    const d = await this.gql(
      'listeningHistory',
      `query listeningHistory($limit: Int, $offset: Int) { listeningHistory(limit: $limit, offset: $offset) {
        lastListeningDttm mediaContent { __typename ... on Track { ${TRACK} } } } }`,
      { limit, offset: 0 }
    );
    return (d.listeningHistory || [])
      .map((x) => x.mediaContent)
      .filter((x) => x && x.__typename === 'Track');
  }

  async recentlyPlayed(limit = 20) {
    const d = await this.gql(
      'getListeningRecent',
      `query getListeningRecent($limit: Int, $offset: Int, $itemType: [RecentItemType!]) {
        listeningRecentV1(limit: $limit, offset: $offset, itemType: $itemType) {
          mediaContent { __typename
            ... on Artist { ${ARTIST_SHORT} }
            ... on Release { ${RELEASE_SHORT} }
            ... on Playlist { id title description image { src palette } coverV1 { src } }
          } } }`,
      { limit, offset: 0, itemType: ['Artist', 'Release', 'Playlist'] }
    );
    return (d.listeningRecentV1 || []).map((x) => x.mediaContent).filter((x) => x && x.__typename && x.id);
  }
}

module.exports = { ZvukClient, ZvukError, SYNTHESIS_PLAYLIST_IDS };
