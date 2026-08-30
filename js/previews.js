// Find a 30s preview URL for a track using public, no-auth sources.
// Primary: iTunes Search API (returns m4a previews, hotlinkable).
// Fallback: Deezer (currently a stub — see findPreviewDeezer below).
//
// Why not Spotify preview_url ? Because it is increasingly null in many
// regions/markets since 2024 and Spotify discourages relying on it.

import { scoreMatch } from './utils.js';
import { appConfig } from './config.js';

// ===================================================================
// Public API
// ===================================================================

// Find a preview for { trackName, artistName }.
// Returns:
//   { previewUrl, source, matchedTrackName, matchedArtistName, confidence }
// or null if no acceptable match was found.
export async function findPreview(trackName, artistName) {
  try {
    const itunes = await findPreviewITunes(trackName, artistName);
    if (itunes) return itunes;
  } catch (e) {
    console.warn('iTunes search failed', e);
  }
  try {
    const deezer = await findPreviewDeezer(trackName, artistName);
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

export async function findPreviewITunes(trackName, artistName) {
  if (!trackName) return null;

  // Build a query — artist + title gives better hits than title alone.
  const query = [artistName, trackName].filter(Boolean).join(' ');
  const params = new URLSearchParams({
    term: query,
    media: 'music',
    entity: 'song',
    limit: '12',
  });
  // iTunes Search supports JSONP but CORS is open for plain JSON too.
  const url = `${ITUNES_ENDPOINT}?${params.toString()}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`iTunes ${r.status}`);
  const data = await r.json();
  if (!data?.results?.length) return null;

  // Score every result and pick the best one that actually has a previewUrl.
  let best = null;
  for (const it of data.results) {
    if (!it.previewUrl) continue;
    const titleScore = scoreMatch(trackName, it.trackName || '');
    const artistScore = artistName
      ? scoreMatch(artistName, it.artistName || '')
      : 0.5; // unknown artist: neutral
    // Weighted: title matters more than artist (artists often differ in
    // formatting — "Jay-Z" vs "JAY Z", "Beyoncé" vs "Beyonce").
    const confidence = 0.65 * titleScore + 0.35 * artistScore;
    if (!best || confidence > best.confidence) {
      best = {
        previewUrl: it.previewUrl,
        trackViewUrl: it.trackViewUrl || null,  // link to Apple Music / iTunes Store
        source: 'itunes',
        matchedTrackName: it.trackName,
        matchedArtistName: it.artistName,
        confidence,
      };
    }
  }
  if (!best) return null;
  if (best.confidence < appConfig.previewMatchThreshold) {
    // Soft fallback: if the title alone is strongly matching, accept it.
    // Helps with foreign-language artists transliterated differently.
    const onlyTitle = scoreMatch(trackName, best.matchedTrackName || '');
    if (onlyTitle >= 0.8) return best;
    return null;
  }
  return best;
}

// ===================================================================
// Deezer fallback (stub) — wired but disabled by default.
// ===================================================================
// Deezer has a public search API at https://api.deezer.com/search but it
// blocks CORS from browser origins. To use it, you'd need either a tiny
// proxy or the JSONP variant. Left here as a placeholder so the call site
// stays clean; returns null until you wire a working source.
export async function findPreviewDeezer(_trackName, _artistName) {
  // Example skeleton — disabled because of CORS.
  //
  // const query = encodeURIComponent(`${_artistName ?? ''} ${_trackName}`.trim());
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
// Batch helper
// ===================================================================

// Find previews for an array of { id, name, artists } Spotify tracks.
// Pool de workers concurrents (CONCURRENCY) pour éviter d'attendre 40 fetch
// iTunes en séquence. onProgress reçoit (enriched, done, total, originalIndex)
// — originalIndex sert au caller pour cibler la bonne ligne UI puisque les
// résultats n'arrivent plus dans l'ordre.
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
      const primaryArtist = Array.isArray(t.artists) ? t.artists[0] : t.artists;
      const preview = await findPreview(t.name, primaryArtist);
      // Ne sont conservés que les champs réellement consommés en aval.
      // spotifyId, album, source, confidence, matchedTrackName,
      // matchedArtistName, normalizedTitle et normalizedArtists étaient écrits
      // dans chaque document Firestore sans qu'aucun code ne les relise —
      // le scoring renormalise à la volée depuis `title`.
      const enriched = {
        order: i,
        title: t.name,
        artists: Array.isArray(t.artists) ? t.artists : [t.artists].filter(Boolean),
        imageUrl: t.image || null,
        previewUrl: preview?.previewUrl || null,
        trackViewUrl: preview?.trackViewUrl || null,
        playable: !!preview?.previewUrl,
      };
      out[i] = enriched;
      done++;
      if (onProgress) onProgress(enriched, done, spotifyTracks.length, i);
    }
  };

  await Promise.all(Array.from({ length: ENRICH_CONCURRENCY }, worker));
  return out;
}
