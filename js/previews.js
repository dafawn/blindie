// Trouve un extrait de 30 s pour un morceau, via des sources publiques sans
// authentification. Source principale : l'API iTunes Search (aperçus m4a,
// hotlinkables). Repli : Deezer (stub, cf. findPreviewDeezer).
//
// Pourquoi pas le preview_url Spotify ? Parce qu'il est de plus en plus
// souvent null selon les régions depuis 2024, et Spotify déconseille de s'y
// appuyer.
//
// Le piège de cette recherche, c'est qu'iTunes renvoie aussi les reprises :
// karaokés, « tribute bands », versions « in the style of »… Un extrait qui
// n'est pas le bon morceau est pire qu'aucun extrait : le joueur entend une
// chanson et on lui en révèle une autre. D'où les trois garde-fous de
// pickBestITunesResult : rejet des marqueurs de reprise, artiste obligatoire,
// et préférence pour la version studio.

import { scoreMatch, plain } from './utils.js';
import { appConfig } from './config.js';

// ===================================================================
// API publique
// ===================================================================

// Cherche un extrait pour (titre, artistes). `artists` : tableau de noms
// (tous les artistes Spotify) ou chaîne unique.
// Renvoie { previewUrl, trackViewUrl, source, matchedTrackName,
//           matchedArtistName, confidence, country } ou null.
export async function findPreview(trackName, artists, options = {}) {
  try {
    const itunes = await findPreviewITunes(trackName, artists, options);
    if (itunes) return itunes;
  } catch (e) {
    console.warn('iTunes search failed', e);
  }
  try {
    const deezer = await findPreviewDeezer(trackName, artists);
    if (deezer) return deezer;
  } catch (e) {
    console.warn('Deezer search failed', e);
  }
  return null;
}

// ===================================================================
// iTunes Search API
// ===================================================================

const ITUNES_ENDPOINT = 'https://itunes.apple.com/search';
// 12 résultats ne suffisaient pas toujours à contenir l'original quand la
// requête ramenait d'abord une rangée de karaokés.
const ITUNES_LIMIT = 25;

// Magasins iTunes interrogés, dans l'ordre. Sans paramètre `country`, l'API
// répond depuis le magasin américain, où une partie du catalogue francophone
// n'existe qu'en karaoké ou en reprise. On interroge d'abord le magasin du
// pays de l'appareil, puis le magasin américain (le plus large pour le
// répertoire anglophone) si le premier n'a rien de fiable.
export function itunesCountries(locales = deviceLocales()) {
  const list = Array.isArray(locales) ? locales : [locales];
  for (const loc of list) {
    const m = /^[a-z]{2,3}[-_]([a-z]{2})\b/i.exec(String(loc || '').trim());
    if (m) {
      const country = m[1].toUpperCase();
      return country === 'US' ? ['US'] : [country, 'US'];
    }
  }
  return ['US'];
}

function deviceLocales() {
  const out = [];
  try {
    if (typeof navigator !== 'undefined') {
      if (navigator.language) out.push(navigator.language);
      if (Array.isArray(navigator.languages)) out.push(...navigator.languages);
    }
    out.push(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch { /* environnement sans navigator/Intl : magasin US */ }
  return out;
}

// options.fetchImpl et options.countries servent aux tests.
export async function findPreviewITunes(trackName, artists, options = {}) {
  if (!trackName) return null;
  const list = toArtistList(artists);
  const fetchImpl = options.fetchImpl || ((url) => fetch(url));
  const countries = options.countries || itunesCountries();

  // Artiste principal + titre : bien plus précis que le titre seul.
  const term = [list[0], trackName].filter(Boolean).join(' ');

  let lastError = null;
  for (const country of countries) {
    const params = new URLSearchParams({
      term, media: 'music', entity: 'song', limit: String(ITUNES_LIMIT), country,
    });
    try {
      const r = await fetchImpl(`${ITUNES_ENDPOINT}?${params.toString()}`);
      if (!r.ok) throw new Error(`iTunes ${r.status}`);
      const data = await r.json();
      const best = pickBestITunesResult(data?.results || [], trackName, list);
      if (best) return { ...best, country };
    } catch (e) {
      // Un magasin en erreur ne doit pas priver du suivant.
      lastError = e;
    }
  }
  if (lastError) throw lastError;
  return null;
}

// ---------------------------------------------------------------------------
// Sélection du bon résultat parmi ceux d'iTunes
// ---------------------------------------------------------------------------

// Un résultat qui porte l'un de ces marqueurs (dans son titre, son artiste ou
// son album) n'est pas le morceau demandé mais une reprise. Il est écarté —
// sauf si le morceau Spotify porte lui-même le marqueur : « Cover Me » de
// Springsteen ou « Lullaby » des Cure restent jouables.
const COVER_MARKERS = [
  'karaoke', 'tribute', 'covers?', 'instrumental', 'in the style of',
  '(?:as )?made famous by', 'originally (?:performed|recorded|by)',
  'backing track', 'sing along', '8 ?bit', 'lullab(?:y|ies)', 'music box',
  'sped up', 'slowed', 'nightcore', 'workout', 'fitness', 'piano version',
  'ringtone',
];
const COVER_RE = new RegExp(`\\b(?:${COVER_MARKERS.join('|')})\\b`, 'g');

// Qualificatifs d'une autre version du même morceau. Pas une reprise, mais
// un enregistrement qui sonne différemment : on le classe derrière la
// version studio quand celle-ci est disponible (et inversement si c'est la
// version live que la playlist contient).
const VARIANT_RE =
  /\b(?:live|acoustic|acoustique|unplugged|remix|demo|orchestral|a ?cappella|rehearsal|piano)\b/g;
const VARIANT_PENALTY = 0.15;

// Planchers d'acceptation. La confiance pondérée (appConfig.previewMatchThreshold)
// ne suffit pas : un titre identique chez un autre artiste la dépassait tout
// seul (0.65 × 1 + 0.35 × 0 = 0.65). D'où un plancher séparé sur chaque axe.
const TITLE_FLOOR = 0.75;
const ARTIST_FLOOR = 0.5;

// Pure : pas de réseau. Exportée pour tools/test-previews.mjs.
export function pickBestITunesResult(results, trackName, artists) {
  const list = toArtistList(artists);
  const wanted = markers(`${trackName} ${list.join(' ')}`, COVER_RE);
  const wantedVariants = markers(trackName, VARIANT_RE);
  const wantedKey = alnum(trackName);

  let best = null;
  for (const it of results || []) {
    if (!it || !it.previewUrl) continue;
    if (it.kind && it.kind !== 'song') continue;

    const haystack = `${it.trackName || ''} ${it.artistName || ''} ${it.collectionName || ''}`;
    const found = markers(haystack, COVER_RE);
    if ([...found].some(m => !wanted.has(m))) continue;

    let titleScore = scoreMatch(trackName, it.trackName || '');
    // Deux titres identiques au caractère près départagent les versions
    // (« Africa » plutôt que « Africa (Acoustic) », toutes deux à 1.0 après
    // normalisation).
    if (wantedKey && alnum(it.trackName) === wantedKey) titleScore += 0.05;
    const artistScore = artistSimilarity(list, it.artistName);

    const variants = markers(it.trackName || '', VARIANT_RE);
    let extra = 0;
    for (const v of variants) if (!wantedVariants.has(v)) extra++;
    for (const v of wantedVariants) if (!variants.has(v)) extra++;
    const penalty = Math.min(2 * VARIANT_PENALTY, extra * VARIANT_PENALTY);

    const confidence = 0.65 * titleScore + 0.35 * artistScore - penalty;
    if (titleScore < TITLE_FLOOR || artistScore < ARTIST_FLOOR) continue;
    if (confidence < appConfig.previewMatchThreshold) continue;

    if (!best || confidence > best.confidence) {
      best = {
        previewUrl: it.previewUrl,
        trackViewUrl: it.trackViewUrl || null,   // lien Apple Music / iTunes Store
        source: 'itunes',
        matchedTrackName: it.trackName,
        matchedArtistName: it.artistName,
        confidence,
      };
    }
  }
  return best;
}

// Meilleure similarité entre l'un des artistes Spotify et l'artiste iTunes —
// pris en entier ou découpé sur ses séparateurs (« Calvin Harris & Dua Lipa »
// vaut « Dua Lipa »). Sans artiste connu : 0.5, neutre.
function artistSimilarity(artists, itunesArtist) {
  if (!artists.length) return 0.5;
  if (!itunesArtist) return 0;
  const parts = [itunesArtist, ...splitArtists(itunesArtist)];
  let best = 0;
  for (const a of artists) {
    const ka = alnum(a);
    for (const p of parts) {
      const s = (ka && ka === alnum(p)) ? 1 : scoreMatch(a, p);
      if (s > best) best = s;
      if (best === 1) return 1;
    }
  }
  return best;
}

const ARTIST_SEPARATORS =
  /\s*(?:&|,|\/|\+|×|\bx\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\band\b|\bvs\.?)\s*/i;

function splitArtists(name) {
  return String(name).split(ARTIST_SEPARATORS).map(s => s.trim()).filter(Boolean);
}

function toArtistList(artists) {
  if (Array.isArray(artists)) return artists.filter(Boolean).map(String);
  return artists ? [String(artists)] : [];
}

function markers(text, re) {
  return new Set(plain(text).match(re) || []);
}

// Lettres et chiffres seulement : « Paint It, Black » = « Paint It Black ».
function alnum(s) {
  return plain(s).replace(/[^a-z0-9]/g, '');
}

// ===================================================================
// Repli Deezer (stub) — câblé mais désactivé par défaut.
// ===================================================================
// Deezer expose https://api.deezer.com/search mais bloque le CORS depuis un
// navigateur. Il faudrait un petit proxy ou la variante JSONP. Laissé ici
// pour garder le site d'appel propre ; renvoie null tant qu'aucune source
// n'est branchée.
export async function findPreviewDeezer(_trackName, _artists) {
  // Squelette — désactivé à cause du CORS.
  //
  // const query = encodeURIComponent(`${_artists?.[0] ?? ''} ${_trackName}`.trim());
  // const url = `https://api.deezer.com/search?q=${query}&limit=10&output=jsonp`;
  // const data = await jsonp(url);
  // const hit = data?.data?.find(d => d.preview);
  // if (!hit) return null;
  // return { previewUrl: hit.preview, source: 'deezer',
  //          matchedTrackName: hit.title, matchedArtistName: hit.artist?.name,
  //          confidence: 0.7 };
  return null;
}

// ===================================================================
// Traitement par lot
// ===================================================================

// Cherche un extrait pour chaque morceau Spotify { name, artists, image }.
// Pool de workers concurrents (CONCURRENCY) pour éviter d'attendre 40 fetch
// iTunes en séquence. onProgress reçoit (enriched, done, total, originalIndex,
// preview) — originalIndex sert au caller pour cibler la bonne ligne UI
// puisque les résultats n'arrivent plus dans l'ordre ; preview est le résultat
// iTunes retenu (ou null), pour l'afficher à l'hôte sans le persister.
const ENRICH_CONCURRENCY = 5;

export async function enrichTracksWithPreviews(spotifyTracks, onProgress) {
  const out = new Array(spotifyTracks.length);
  let cursor = 0;
  let done = 0;

  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= spotifyTracks.length) return;
      const t = spotifyTracks[i];
      const artists = Array.isArray(t.artists) ? t.artists : [t.artists].filter(Boolean);
      const preview = await findPreview(t.name, artists);
      // Ne sont conservés que les champs réellement consommés en aval.
      // spotifyId, album, source, confidence, matchedTrackName,
      // matchedArtistName, normalizedTitle et normalizedArtists étaient écrits
      // dans chaque document Firestore sans qu'aucun code ne les relise —
      // le scoring renormalise à la volée depuis `title`.
      const enriched = {
        order: i,
        title: t.name,
        artists,
        imageUrl: t.image || null,
        previewUrl: preview?.previewUrl || null,
        trackViewUrl: preview?.trackViewUrl || null,
        playable: !!preview?.previewUrl,
      };
      out[i] = enriched;
      done++;
      if (onProgress) onProgress(enriched, done, spotifyTracks.length, i, preview);
    }
  };

  await Promise.all(Array.from({ length: ENRICH_CONCURRENCY }, worker));
  return out;
}
