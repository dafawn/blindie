// Generic helpers: text normalization, fuzzy matching, scoring, formatting.
import { appConfig } from './config.js';

// === Text normalization ===
// Compare deux chaînes musicales avec tolérance : accents, casse, ponctuation,
// et les qualificatifs de version que Spotify colle aux titres
// ("- Remastered 2011", "(Live)", "feat. X").
//
// Principe : on ne cherche PAS à réduire un titre à une forme canonique unique.
// Une normalisation trop agressive détruit de vrais titres — "Live Forever",
// "With or Without You", "Mix Tape" — et, quand elle vide complètement la
// chaîne, elle fait matcher n'importe quoi avec n'importe quoi.
// On produit donc plusieurs FORMES comparables d'un même titre et on retient
// la meilleure paire (cf. scoreMatch). Une forme vide n'est jamais retenue.

// Qualificatifs de version. Uniquement retirés quand ils sont isolés en fin de
// titre — après un tiret séparateur, ou entre parenthèses/crochets. Jamais au
// milieu d'un titre : "Live and Let Die" garde son "Live".
const VERSION_WORDS =
  'remaster(?:ed)?|radio\\s+edit|extended(?:\\s+mix)?|live|version|edit|mix|' +
  'mono|stereo|deluxe|bonus\\s+track|acoustic|instrumental|demo|' +
  'single\\s+version|album\\s+version|original\\s+mix';

// "(Remastered 2011)", "[Live]", "{Acoustic}" en fin de chaîne
const TRAILING_BRACKET = new RegExp(
  `\\s*[\\(\\[\\{][^\\)\\]\\}]*\\b(?:${VERSION_WORDS})\\b[^\\)\\]\\}]*[\\)\\]\\}]\\s*$`,
  'i',
);
// " - Remastered 2011", " – Live at Wembley" en fin de chaîne
const TRAILING_DASH = new RegExp(
  `\\s+[-–—]\\s*[^-–—]*\\b(?:${VERSION_WORDS})\\b[^-–—]*$`,
  'i',
);
// "feat. X", "ft X", "featuring X" — mais PAS "with", beaucoup trop fréquent
// dans de vrais titres ("With or Without You", "Dancing With Myself").
const FEATURING = /\s*[\(\[]?\s*\b(?:feat\.?|ft\.?|featuring)\b.*$/i;

// Casse, accents, ponctuation, espaces. Ne retire aucun mot.
function plain(str) {
  return String(str ?? '')
    .toLowerCase()
    // Strip diacritics (à → a, é → e…) — U+0300–U+036F are combining marks
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['’`"“”.,;:!?\-–—_\/\\&]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Forme principale : celle qu'on affiche/compare par défaut.
// Conservée pour compatibilité — utilisée par previews.js et les tests.
export function normalizeText(str) {
  if (str == null) return '';
  const stripped = String(str)
    .replace(FEATURING, ' ')
    .replace(TRAILING_BRACKET, ' ')
    .replace(TRAILING_DASH, ' ');
  // Si le nettoyage a tout mangé (titre qui n'est QUE "Live", "(Reprise)"…),
  // on retombe sur la chaîne d'origine plutôt que de renvoyer du vide.
  return plain(stripped) || plain(str);
}

// Toutes les formes comparables d'un titre, sans doublon ni chaîne vide.
// L'ordre n'a pas d'importance : scoreMatch prend le meilleur score.
function comparableForms(str) {
  if (str == null) return [];
  const raw = String(str);
  const forms = [
    normalizeText(raw),
    // Sans le contenu entre parenthèses, où qu'il soit :
    // "(I Can't Get No) Satisfaction" → "satisfaction"
    plain(raw.replace(/[\(\[\{][^\)\]\}]*[\)\]\}]/g, ' ')),
    // Chaîne brute, sans aucun retrait de mot
    plain(raw),
    // Sans les espaces : rattrape les segmentations différentes
    // ("Papa Outai" vs "Papaoutai")
    plain(raw).replace(/\s+/g, ''),
  ];
  return [...new Set(forms.filter(Boolean))];
}

// Tokenize on whitespace.
function tokens(str) {
  return str.split(' ').filter(Boolean);
}

// === String similarity ===
// Renvoie un nombre dans [0, 1]. Compare toutes les formes de `expected` à
// toutes celles de `candidate` et retient la meilleure paire.
//
// Contrairement à la version précédente, deux chaînes vides ne valent PAS un
// match parfait : une chaîne vide ne matche jamais rien.
export function scoreMatch(expected, candidate) {
  const A = comparableForms(expected);
  const B = comparableForms(candidate);
  if (!A.length || !B.length) return 0;

  let best = 0;
  for (const a of A) {
    for (const b of B) {
      const s = pairScore(a, b);
      if (s > best) best = s;
      if (best === 1) return 1;
    }
  }
  return best;
}

// Score d'une paire de formes déjà normalisées.
function pairScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (isNearSubstring(a, b)) return 0.9;

  const ta = tokens(a);
  const tb = tokens(b);
  const jaccard = tokenOverlap(ta, tb);
  const dice = bigramDice(a, b);

  // Weighted blend — bigram dice catches typos, jaccard catches order/extras.
  return 0.6 * dice + 0.4 * jaccard;
}

// Recouvrement des mots, dans [0, 1].
//
// Quand les DEUX côtés font au moins deux mots, un mot compte comme trouvé
// s'il est proche d'un mot de l'autre côté, pas seulement s'il est identique :
// "Bohemian Rhapsodie" retrouve ainsi "Bohemian Rhapsody".
// Quand l'un des côtés n'a qu'un seul mot, on exige l'égalité stricte. Sinon
// "california" vaudrait "Californication" et "creepy" vaudrait "Creep" : sur un
// mot unique, une faute de frappe et une mauvaise réponse sont indiscernables.
const TOKEN_NEAR = 0.8;

function tokenOverlap(ta, tb) {
  if (!ta.length || !tb.length) return 0;
  const flou = ta.length > 1 && tb.length > 1;
  const libres = [...tb];
  let inter = 0;
  for (const t of ta) {
    const i = libres.findIndex(u => u === t || (flou && bigramDice(t, u) >= TOKEN_NEAR));
    if (i !== -1) { inter++; libres.splice(i, 1); }
  }
  const union = ta.length + tb.length - inter;
  return union === 0 ? 0 : inter / union;
}

// Une chaîne contenue dans l'autre ne vaut le bonus que si les deux sont de
// longueur quasi identique. Sans ce garde-fou, "thrill" valait "Thriller",
// "imagine dragons" valait "Imagine", "number one" valait "Numb" et "creepy"
// valait "Creep" — tous à 0.9, donc tous au-dessus du seuil.
const SUBSTRING_LENGTH_RATIO = 0.9;

function isNearSubstring(a, b) {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 4) return false;
  if (!long.includes(short)) return false;
  return short.length / long.length >= SUBSTRING_LENGTH_RATIO;
}

function bigramDice(a, b) {
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.size === 0 || bb.size === 0) return 0;
  let inter = 0;
  for (const g of ba) if (bb.has(g)) inter++;
  return (2 * inter) / (ba.size + bb.size);
}

function bigrams(str) {
  const s = new Set();
  const t = str.replace(/\s+/g, ' ');
  for (let i = 0; i < t.length - 1; i++) s.add(t.slice(i, i + 2));
  return s;
}

// Convenience: does this candidate "match" the expected value at threshold?
export function isMatch(expected, candidate, threshold = 0.75) {
  return scoreMatch(expected, candidate) >= threshold;
}

// === Scoring d'une réponse ===
// Fonction pure, sans I/O — elle vit ici (et pas dans room.js) pour rester
// testable hors navigateur : voir tools/test-scoring.mjs.
// Utilisée côté host uniquement (scoreRound). Le joueur n'écrit JAMAIS de
// score — c'est interdit par les règles Firestore.
export function calculateScore(answer, track, settings) {
  const pointsTitle = settings?.pointsTitle ?? appConfig.pointsTitle;
  const pointsArtist = settings?.pointsArtist ?? appConfig.pointsArtist;
  const threshold = settings?.matchThreshold ?? appConfig.matchThreshold;

  let scoreTitle = 0;
  if (answer.titleAnswer && scoreMatch(track.title, answer.titleAnswer) >= threshold) {
    scoreTitle = pointsTitle;
  }

  let scoreArtist = 0;
  if (answer.artistAnswer && (track.artists || []).length) {
    // Take the best score across all artists (groups often have several).
    const best = Math.max(
      ...track.artists.map(a => scoreMatch(a, answer.artistAnswer))
    );
    if (best >= threshold) scoreArtist = pointsArtist;
  }
  return { scoreTitle, scoreArtist, totalScore: scoreTitle + scoreArtist };
}

// === Random codes ===
// Code de 6 caractères, alphabet sans caractères ambigus (no 0/O, 1/I, etc.).
// Génération via crypto.getRandomValues — pas Math.random — pour éviter les
// collisions/devinabilité avec un PRNG faible.
export function generateJoinCode(len = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) {
    // Mod 32 = parfaitement uniforme car 256 % 32 == 0.
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

// === Mélange ===
// Fisher-Yates avec la même source d'aléa que generateJoinCode : Math.random
// n'a aucune garantie d'uniformité et, sur une playlist, un biais se voit
// (les mêmes morceaux reviennent trop souvent en tête).
// Renvoie un NOUVEAU tableau — l'appelant garde le sien intact.
export function shuffled(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Entier uniforme dans [0, n). Rejection sampling : on jette les tirages qui
// tomberaient dans la tranche incomplète, sinon les petits indices sortiraient
// plus souvent (biais du modulo).
function randomBelow(n) {
  if (n <= 1) return 0;
  const limite = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  let v;
  do { crypto.getRandomValues(buf); v = buf[0]; } while (v >= limite);
  return v % n;
}

// === URL safety ===
// Renvoie l'URL si c'est une https:// well-formed, sinon null.
// À utiliser avant d'injecter une URL externe dans innerHTML (<img src=...>).
// Bloque javascript:, data:, blob:, http:, etc.
export function safeImageUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

// URL externe destinée à un href. Même exigence que safeImageUrl : https
// uniquement, ce qui écarte javascript:, data:, blob: et le protocole-relatif.
export function safeExternalUrl(url) {
  return safeImageUrl(url);
}

// === Horloge serveur ===
// Le déroulement d'un round est piloté par un horodatage SERVEUR
// (currentRoundStartedAt). Le comparer à Date.now() revient à faire confiance
// à l'horloge de l'appareil — or un téléphone qui avance de 30 s suffisait à
// faire croire au joueur que le round était déjà écoulé : timer à 0, et audio
// jamais lancé (le garde `elapsed >= 30` se déclenchait immédiatement).
//
// On mesure donc une fois l'écart entre l'horloge locale et celle du serveur,
// et tout le code de timing passe par serverNow().
let _clockOffsetMs = 0;
let _clockMeasured = false;

// serverMs : valeur d'un serverTimestamp() résolu.
// localMs   : instant local correspondant à cette écriture.
export function setClockOffset(serverMs, localMs) {
  if (!serverMs || !localMs) return;
  const offset = serverMs - localMs;
  // Un écart de plus d'une journée est plus vraisemblablement une donnée
  // aberrante qu'une horloge réellement décalée : on l'ignore.
  if (Math.abs(offset) > 24 * 60 * 60 * 1000) return;
  _clockOffsetMs = offset;
  _clockMeasured = true;
}

// L'heure courante exprimée dans le référentiel du serveur.
export function serverNow() {
  return Date.now() + _clockOffsetMs;
}

export function clockOffsetMs() {
  return _clockOffsetMs;
}

export function clockIsCalibrated() {
  return _clockMeasured;
}

// === Wake Lock ===
// L'écran du téléphone s'éteint pendant les 30 s d'écoute, obligeant le joueur
// à le rallumer à chaque round. L'API n'existe pas partout (Safari iOS < 16.4,
// Firefox) et le verrou saute dès que l'onglet passe en arrière-plan : d'où la
// reprise sur visibilitychange.
let _wakeLock = null;

export async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return false;
  try {
    _wakeLock = await navigator.wakeLock.request('screen');
    _wakeLock.addEventListener('release', () => { _wakeLock = null; });
    return true;
  } catch {
    // Refus courant : onglet non visible, batterie faible. Sans gravité.
    return false;
  }
}

export function releaseWakeLock() {
  try { _wakeLock?.release(); } catch {}
  _wakeLock = null;
}

// À appeler une fois : réacquiert le verrou au retour au premier plan.
export function keepWakeLockOnVisibility() {
  if (!('wakeLock' in navigator)) return;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && _wakeLock === null) requestWakeLock();
  });
}

// === Misc ===
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export function formatArtists(artists) {
  if (!artists) return '';
  if (Array.isArray(artists)) return artists.join(', ');
  return String(artists);
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
