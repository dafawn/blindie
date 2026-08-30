// Spotify OAuth 2.0 — Authorization Code with PKCE.
// We only use Spotify to read playlist metadata (title, artists, album, image).
// Audio playback goes through iTunes (see previews.js), so we DO NOT touch
// preview_url here and we DO NOT need any Premium / Web Playback SDK.

import { spotifyConfig } from './config.js';

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';

const VERIFIER_KEY = 'blindie.spotify.verifier';
const STATE_KEY    = 'blindie.spotify.state';
const TOKEN_KEY    = 'blindie.spotify.token';

// ===================================================================
// PKCE helpers
// ===================================================================

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sha256(str) {
  const data = new TextEncoder().encode(str);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

export function generateCodeVerifier(len = 96) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return base64url(bytes).slice(0, len);
}

export async function generateCodeChallenge(verifier) {
  return base64url(await sha256(verifier));
}

// ===================================================================
// Login flow
// ===================================================================

export async function loginWithSpotify() {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  // Le `state` protège contre les CSRF sur le callback OAuth : Spotify nous
  // le renvoie tel quel, on vérifie qu'il match avant d'échanger le code.
  const state = generateCodeVerifier(32);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: spotifyConfig.clientId,
    scope: spotifyConfig.scopes,
    redirect_uri: spotifyConfig.redirectUri,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
  });
  window.location.href = `${AUTH_URL}?${params.toString()}`;
}

// Called on the redirect_uri page — completes the PKCE exchange if there is
// a ?code= in the URL. Returns true if a token was obtained, false if there
// was nothing to do. Throws on Spotify errors.
export async function handleSpotifyCallback() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const stateParam = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  if (error) throw new Error(`Spotify a refusé : ${error}`);
  if (!code) return false;

  // CSRF check : le state reçu doit correspondre à celui qu'on a généré
  // avant la redirection.
  const expectedState = sessionStorage.getItem(STATE_KEY);
  if (!expectedState || expectedState !== stateParam) {
    sessionStorage.removeItem(STATE_KEY);
    sessionStorage.removeItem(VERIFIER_KEY);
    throw new Error("State OAuth invalide — relance le login.");
  }
  sessionStorage.removeItem(STATE_KEY);

  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) throw new Error("Code verifier perdu — relance le login.");

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: spotifyConfig.redirectUri,
    client_id: spotifyConfig.clientId,
    code_verifier: verifier,
  });
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error(`Token exchange failed (${r.status})`);
  const data = await r.json();
  storeToken(data);
  sessionStorage.removeItem(VERIFIER_KEY);

  // Clean the URL so refresh doesn't re-use the code (codes are one-shot).
  url.searchParams.delete('code');
  url.searchParams.delete('state');
  window.history.replaceState({}, document.title, url.toString());
  return true;
}

// ===================================================================
// Token storage / refresh
// ===================================================================

function storeToken(data) {
  const expiresAt = Date.now() + (data.expires_in - 60) * 1000;
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
  }));
}

function readToken() {
  const raw = sessionStorage.getItem(TOKEN_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function refreshAccessToken(tok) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tok.refreshToken,
    client_id: spotifyConfig.clientId,
  });
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) {
    // Le jeton est mort : on le jette, sinon isLoggedIn() continue de répondre
    // "connecté" alors que chaque appel échouera.
    logout();
    throw new Error("Session Spotify expirée — reconnecte-toi.");
  }
  const data = await r.json();
  if (!data.refresh_token) data.refresh_token = tok.refreshToken;
  storeToken(data);
  return data.access_token;
}

export async function getSpotifyAccessToken() {
  const tok = readToken();
  if (!tok) return null;
  if (Date.now() < tok.expiresAt) return tok.accessToken;
  if (!tok.refreshToken) { logout(); return null; }
  return await refreshAccessToken(tok);
}

export function isLoggedIn() {
  return !!readToken();
}

export function logout() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
}

// ===================================================================
// API calls
// ===================================================================

async function api(path) {
  const token = await getSpotifyAccessToken();
  if (!token) throw new Error("Pas connecté à Spotify.");
  const r = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    // 403 sur une playlist : presque toujours une playlist éditoriale Spotify
    // (préfixe 37i9dQZF1...) bloquée pour les apps en Development mode
    // depuis novembre 2024. On donne un message explicite.
    if (r.status === 403 && /\/playlists\/37i9dQZF1/.test(path)) {
      throw new Error(
        "Spotify bloque les playlists éditoriales (Today's Top Hits, Daily Mix…) " +
        "pour les apps en Development mode depuis nov. 2024. " +
        "Utilise une playlist créée par un user (la tienne ou celle d'un pote)."
      );
    }
    if (r.status === 403) {
      throw new Error(
        "Spotify a refusé (403). Vérifie que tu es dans User Management du " +
        "dashboard Spotify, ou utilise une autre playlist."
      );
    }
    const msg = await r.text();
    throw new Error(`Spotify API ${r.status}: ${msg.slice(0, 200)}`);
  }
  return r.json();
}

export async function getCurrentSpotifyUser() {
  return api('/me');
}

// Accepts:
//   - https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=...
//   - spotify:playlist:37i9dQZF1DXcBWIGoYBM5M
//   - 37i9dQZF1DXcBWIGoYBM5M (raw)
// Returns the playlist ID.
export function parseSpotifyPlaylistUrl(input) {
  if (!input) throw new Error("URL ou ID manquant.");
  const s = String(input).trim();

  const urlMatch = s.match(/playlist[\/:]([a-zA-Z0-9]+)/);
  if (urlMatch) return urlMatch[1];

  if (/^[a-zA-Z0-9]{20,30}$/.test(s)) return s;

  throw new Error("URL ou ID de playlist invalide.");
}

// Le document brut d'une playlist. Un seul appel réseau, réutilisé pour
// l'aperçu (nom, pochette, propriétaire) ET pour la liste des morceaux :
// les deux étaient demandés séparément, donc deux fois la même ressource et
// deux fois le quota Spotify consommé.
export async function fetchPlaylist(playlistId) {
  return api(`/playlists/${playlistId}`);
}

// Tous les morceaux d'une playlist déjà récupérée (auto-pagination).
// Returns an array of normalized track objects:
//   { id, name, artists: string[], album, image, durationMs }
export async function extractPlaylistTracks(playlist) {
  // Spotify a deux comportements pour /playlists/{id} :
  //   - Apps avec Extended Access : renvoie { tracks: { items: [...], next, ... } }
  //   - Apps en Development mode (nov. 2024) : renvoie { items: { items: [...], next, ... } }
  //     (la clé `tracks` est strippée, remplacée par `items` au niveau racine)
  // On gère les deux cas pour être robuste.
  const container = playlist?.tracks || playlist?.items;
  const all = [];

  // Spotify a aussi renommé `track` → `item` à l'intérieur de chaque entrée
  // de la playlist pour les apps en dev mode (changement nov. 2024 non
  // documenté). On lit les deux pour rester compatible.
  const collect = (items) => {
    for (const wrapper of items || []) {
      const t = wrapper.track || wrapper.item;
      if (!t || !t.id) continue;
      if (t.type && t.type !== 'track') continue;
      all.push(normalizeSpotifyTrack(t));
    }
  };

  collect(container?.items);

  // Pagination best-effort si la playlist a plus de 100 morceaux.
  let next = container?.next;
  while (next) {
    try {
      const u = new URL(next);
      const data = await api(u.pathname.replace('/v1', '') + u.search);
      collect(data.items);
      next = data.next;
    } catch (e) {
      console.warn('Pagination Spotify échouée, on garde les morceaux récupérés.', e);
      break;
    }
  }
  return all;
}

export function normalizeSpotifyTrack(t) {
  return {
    id: t.id,
    name: t.name,
    artists: (t.artists || []).map(a => a.name),
    album: t.album?.name || null,
    image: t.album?.images?.[0]?.url || null,
    durationMs: t.duration_ms || null,
  };
}

// Nombre total de morceaux annoncé par Spotify, quelle que soit la forme de
// la réponse (Extended Access ou Development mode).
export function playlistTrackTotal(playlist) {
  return playlist?.tracks?.total ?? playlist?.items?.total ?? null;
}
