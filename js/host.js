// Host logic. Drives the whole game from playlist import to final podium.
//
// Flow:
//   login → import playlist (Spotify metadata)
//         → enrich with iTunes previews (per-track progress)
//         → create room (Firestore) → push playable tracks
//         → lobby (watch players join)
//         → for each round: play audio, watch answers, reveal, advance
//         → finished: show podium.

import { ensureAnonAuth } from './firebase.js';
import {
  loginWithSpotify, handleSpotifyCallback, isLoggedIn, logout,
  getCurrentSpotifyUser, parseSpotifyPlaylistUrl,
  fetchPlaylist, extractPlaylistTracks, playlistTrackTotal,
} from './spotify.js';
import { enrichTracksWithPreviews } from './previews.js';
import {
  createRoom, getRoom, addTracksToRoom, fetchRoomTracks,
  startRound, lockRound, revealRound, endGame,
  scoreRound, fetchAnswersForRound,
  listenPlayers, listenAnswers, listenRoom, deleteRoom,
} from './room.js';
import {
  escapeHtml, formatArtists, safeImageUrl, safeExternalUrl, shuffled,
  requestWakeLock, releaseWakeLock, keepWakeLockOnVisibility,
  setClockOffset, serverNow,
} from './utils.js';
import { appConfig, spotifyConfig } from './config.js';

const $ = id => document.getElementById(id);

// Enveloppe un handler asynchrone pour qu'un deuxième clic pendant l'attente
// ne fasse rien. Sans ça, deux clics rapides sur "Round suivant" incrémentent
// state.roundIndex deux fois avant que le premier round n'ait démarré : le
// morceau intermédiaire est purement sauté et le compteur ne correspond plus
// à ce que les joueurs ont entendu.
function once(btn, handler) {
  btn.addEventListener('click', async (ev) => {
    if (btn.disabled) return;
    btn.disabled = true;
    try { await handler(ev); }
    finally { btn.disabled = false; }
  });
}

// === Diagnostic (?debug=1) ===
// Mesure les deux instants qui comptent au démarrage d'un round : quand le
// clic a eu lieu, et quand Firestore a confirmé l'écriture. La différence
// entre les deux, comparée au délai de propagation côté joueur, dit de quel
// côté se situe une éventuelle lenteur.
const DEBUG = new URLSearchParams(window.location.search).has('debug');
const journal = [];

function noteDebug(libelle, ms) {
  if (!DEBUG) return;
  journal.unshift(`${libelle} : ${(ms / 1000).toFixed(2)} s`);
  journal.length = Math.min(journal.length, 6);
  let el = document.getElementById('debug-panel');
  if (!el) {
    el = document.createElement('div');
    el.id = 'debug-panel';
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;' +
      'background:rgba(10,1,24,.94);color:#8CBEDE;font:12px/1.6 ui-monospace,monospace;' +
      'padding:.5rem .8rem;border-top:1px solid #35617F;white-space:pre;max-height:9rem;overflow:auto';
    document.body.appendChild(el);
  }
  el.textContent = journal.join('\n');
}

// === Step routing ===
const steps = ['login', 'import', 'lobby', 'playing', 'reveal', 'finished'];
function showStep(name) {
  const change = name !== state.step;
  steps.forEach(s => $(`step-${s}`).classList.toggle('hidden', s !== name));
  $('mini-score').classList.toggle('hidden', !['playing', 'reveal'].includes(name));
  state.step = name;
  // Le focus suit l'écran affiché — sans ça il restait sur le bouton cliqué,
  // dans une section devenue invisible.
  if (change) {
    const section = $(`step-${name}`);
    const cible = section?.querySelector('h2, h3');
    if (cible) {
      if (!cible.hasAttribute('tabindex')) cible.setAttribute('tabindex', '-1');
      // preventScroll : le focus sert à l'annonce, pas à la navigation —
      // il ne doit pas faire sauter la page sous le doigt.
      cible.focus({ preventScroll: true });
    }
  }
}

// === State ===
const state = {
  step: null,            // current showStep() name — used by listeners pour
                         // choisir entre renderLiveAnswers / renderRevealAnswers
  hostId: null,
  roomId: null,
  enriched: [],          // results from enrichTracksWithPreviews (incl. ignored)
  tracks: [],            // playable tracks fetched back from Firestore
  roundIndex: 0,
  currentTrack: null,
  timerInterval: null,
  audio: null,
  unsubPlayers: null,
  unsubAnswers: null,
  unsubRoom: null,
  players: [],
  answers: [],
  // Instant local de démarrage du round, le temps que le serveur renvoie son
  // propre horodatage et qu'on puisse caler les deux horloges.
  roundAnchorMs: null,
  roundClicMs: null,
  // Début du round dans le référentiel serveur. Estimé au lancement, puis
  // remplacé par la valeur exacte que renvoie le serveur.
  roundStartServerMs: null,
  // Réglages écrits dans le doc room à sa création. Le host les relit d'ici
  // plutôt que de retomber sur appConfig : sinon, le jour où la durée devient
  // réglable dans l'UI, l'horloge du host et celle des joueurs divergent.
  settings: null,
  qrCode: null,          // instance qr-code-styling (sert à getRawData pour la copie PNG)
  joinUrl: '',           // URL d'invitation, utilisée par les boutons "Copier le lien"
};

// === Spotify status chip ===
async function refreshSpotifyChip() {
  const chip = $('spotify-status');
  if (isLoggedIn()) {
    try {
      const me = await getCurrentSpotifyUser();
      chip.textContent = `🎧 ${me.display_name || me.id}`;
      chip.style.background = 'rgba(29, 185, 84, 0.25)';
      chip.style.color = '#39ff14';
      chip.style.cursor = 'pointer';
      chip.title = "Cliquer pour se déconnecter";
      chip.onclick = () => { logout(); window.location.reload(); };
    } catch {
      logout();
      chip.textContent = '⏺ Spotify';
    }
  } else {
    chip.textContent = '⏺ Spotify';
    chip.style.cursor = 'default';
  }
}

// Écoute le document room. L'hôte pilotait jusqu'ici depuis son seul état
// local, sans jamais relire la vérité serveur : une écriture qui échouait
// passait inaperçue, et deux onglets ouverts sur la même room pilotaient deux
// parties concurrentes sur les mêmes données.
//
// On ne reconstruit PAS l'UI depuis ce listener — le flux reste piloté par les
// clics de l'hôte. Il sert à détecter une divergence et à le prévenir.
function watchRoom(roomId) {
  if (state.unsubRoom) state.unsubRoom();
  state.unsubRoom = listenRoom(roomId, room => {
    if (!room) {
      showError('round-error', "La room a été supprimée.");
      return;
    }
    state.settings = room.settings || state.settings;

    // Cale l'horloge du host sur celle du serveur. `roundAnchorMs` est
    // l'instant local juste après la confirmation de startRound ; le
    // currentRoundStartedAt que le serveur renvoie désigne le même moment.
    // Sans ça, host et joueurs comptent sur deux horloges différentes.
    const serveur = room.currentRoundStartedAt?.toMillis?.();
    if (serveur && room.currentRoundIndex === state.roundIndex) {
      if (state.roundAnchorMs) {
        setClockOffset(serveur, state.roundAnchorMs);
        state.roundAnchorMs = null;   // une seule mesure par round suffit
      }
      // Valeur exacte : le décompte s'y recale au tick suivant.
      state.roundStartServerMs = serveur;
      noteDebug(`round ${room.currentRoundIndex + 1} — snapshot revenu au host en`,
                Date.now() - (state.roundClicMs || Date.now()));
    }

    // Un autre onglet a repris la main : lui seul fait autorité désormais.
    if (room.currentRoundIndex > state.roundIndex && state.step !== 'lobby') {
      showError('round-error',
        `Cette partie est pilotée depuis un autre onglet (elle en est au round ` +
        `${room.currentRoundIndex + 1}). Ferme celui-ci pour éviter de jouer deux ` +
        `parties en parallèle sur la même room.`);
      return;
    }
    // Le serveur ne reflète pas l'état local : une écriture a échoué.
    if (state.step === 'playing' && room.currentRoundIndex !== state.roundIndex) {
      showError('round-error',
        "L'état de la partie n'a pas été enregistré côté serveur — les joueurs ne " +
        "voient pas le même round que toi. Recharge la page pour te resynchroniser.");
    }
  }, onListenerError);
}

// Durée d'un round : celle inscrite dans la room, pas la valeur par défaut.
function roundDuration() {
  return state.settings?.roundDurationSeconds
      ?? appConfig.defaultRoundDurationSeconds;
}

// Barème : idem — on lit la room, qui fait foi pour toute la partie.
function roundPoints() {
  return {
    pointsTitle:  state.settings?.pointsTitle  ?? appConfig.pointsTitle,
    pointsArtist: state.settings?.pointsArtist ?? appConfig.pointsArtist,
  };
}

// === Session persistence ===
// Permet au host de récupérer sa room après un refresh OU une fermeture
// d'onglet pendant une partie. On stocke uniquement le roomId — l'identité
// Auth (state.hostId) est restaurée via ensureAnonAuth (uid Firebase stable
// dans le navigateur).
//
// localStorage et pas sessionStorage : sessionStorage est effacé à la
// fermeture de l'onglet. Un hôte qui ferme sa fenêtre par erreur perdait sa
// room définitivement — le code n'est nulle part ailleurs, et les règles
// Firestore interdisent de lister les rooms pour la retrouver. Pendant ce
// temps les joueurs restaient bloqués en statut "playing", pour toujours.
const HOST_SESSION_KEY = 'blindie.host.roomId';
const hostSession = {
  get:   () => localStorage.getItem(HOST_SESSION_KEY),
  set:   (id) => localStorage.setItem(HOST_SESSION_KEY, id),
  clear: () => localStorage.removeItem(HOST_SESSION_KEY),
};

// === Init ===
(async function init() {
  try { await handleSpotifyCallback(); }
  catch (e) { showError('import-error', e.message); }

  // Make sure we have a Firebase Auth uid (used as hostId).
  const user = await ensureAnonAuth();
  state.hostId = user.uid;

  await refreshSpotifyChip();

  // Si on a une room hôte sauvegardée et que le uid match, on saute
  // directement à l'étape correspondante au lieu de re-passer par l'import.
  if (await tryRehydrateHostSession()) return;

  if (!isLoggedIn()) {
    showStep('login');
    if (spotifyConfig.isDeployPreview) {
      showError('login-error',
        "Cette adresse est une preview de déploiement Netlify : son URL est " +
        "aléatoire et ne peut pas être déclarée dans le dashboard Spotify, donc " +
        "la connexion échouera. Utilise le domaine de production, ou " +
        "127.0.0.1:5500 en local.");
    }
    $('btn-spotify-login').addEventListener('click', () => loginWithSpotify());
    return;
  }
  showStep('import');
})();

async function tryRehydrateHostSession() {
  const savedRoomId = hostSession.get();
  if (!savedRoomId) return false;

  let room;
  try { room = await getRoom(savedRoomId); }
  catch { hostSession.clear(); return false; }

  if (!room || room.hostId !== state.hostId) {
    hostSession.clear();
    return false;
  }

  state.roomId = savedRoomId;
  state.settings = room.settings || null;
  try { state.tracks = await fetchRoomTracks(savedRoomId); }
  catch (e) {
    console.warn('Rehydration: fetchRoomTracks failed', e);
    hostSession.clear();
    return false;
  }

  $('room-code').textContent = savedRoomId;
  const rehydratedJoinUrl = `${appConfig.baseUrl}/index.html?code=${savedRoomId}`;
  $('join-url').textContent = rehydratedJoinUrl;
  renderJoinQR(rehydratedJoinUrl);

  watchRoom(savedRoomId);
  state.unsubPlayers = listenPlayers(savedRoomId, players => {
    state.players = players.filter(p => p.id !== state.hostId);
    renderLobbyPlayers();
    renderLiveScoreboard();
    if (state.step === 'finished') renderPodium();
  }, onListenerError);

  switch (room.status) {
    case 'lobby':    showStep('lobby'); break;
    case 'playing':
    case 'locked':   await resumeRound(room); break;
    case 'reveal':   await resumeReveal(room); break;
    case 'finished': showStep('finished'); break;  // podium peint au 1er snapshot
    default:         showStep('lobby');
  }
  return true;
}

async function resumeRound(room) {
  state.roundIndex = room.currentRoundIndex;
  const track = state.tracks[state.roundIndex];
  if (!track) { showStep('lobby'); return; }
  state.currentTrack = track;

  showStep('playing');
  $('round-num').textContent = state.roundIndex + 1;
  $('round-total').textContent = state.tracks.length;
  const art = $('album-art');
  art.className = 'album-art mystery';
  art.innerHTML = '';
  $('answers').innerHTML = '<p class="muted">En attente des buzz…</p>';
  $('answer-count').textContent = '0';

  const startedAtMs = room.currentRoundStartedAt?.toMillis?.() || null;
  const durationSec = room.settings?.roundDurationSeconds
                      || appConfig.defaultRoundDurationSeconds;
  const elapsedSec = startedAtMs ? (serverNow() - startedAtMs) / 1000 : 0;
  const remainingSec = Math.max(0, durationSec - elapsedSec);

  if (room.status === 'playing' && remainingSec > 0) {
    state.audio = new Audio(track.previewUrl);
    state.audio.volume = 1;
    try {
      // iTunes preview = 30 s. Seek à l'avancement actuel pour rester
      // synchro avec les joueurs (qui font pareil dans player.js).
      state.audio.currentTime = Math.min(29.5, Math.max(0, elapsedSec));
      await state.audio.play();
    } catch (err) {
      // Autoplay refusé après refresh : tant pis, le host peut cliquer Rejouer.
      console.warn('Resume audio bloqué', err);
    }
    $('btn-stop-audio').textContent = '⏹ Stop & révéler';
    $('btn-stop-audio').disabled = false;
    // startedAtMs peut être null si le timestamp serveur n'est pas encore
    // résolu côté client — on retombe sur l'instant courant.
    state.roundStartServerMs = startedAtMs ?? serverNow();
    startTimer(durationSec);
  } else {
    // status == 'locked' OU 'playing' mais timer écoulé pendant qu'on était
    // refresh (personne pour auto-lock). On lock pour rattraper l'état.
    if (room.status === 'playing') {
      try { await lockRound(state.roomId); }
      catch (e) { console.warn('Catch-up lock failed', e); }
    }
    $('btn-stop-audio').textContent = '🎯 Révéler';
    $('btn-stop-audio').disabled = false;
    $('timer').textContent = '0';
    $('timer').classList.add('danger');
  }

  if (state.unsubAnswers) state.unsubAnswers();
  state.unsubAnswers = listenAnswers(state.roomId, state.roundIndex, answers => {
    state.answers = answers;
    if (state.step === 'reveal') renderRevealAnswers();
    else renderLiveAnswers();
  }, onListenerError);
}

async function resumeReveal(room) {
  state.roundIndex = room.currentRoundIndex;
  const track = state.tracks[state.roundIndex];
  if (!track) { showStep('lobby'); return; }
  state.currentTrack = track;

  if (state.unsubAnswers) state.unsubAnswers();
  state.unsubAnswers = listenAnswers(state.roomId, state.roundIndex, answers => {
    state.answers = answers;
    if (state.step === 'reveal') renderRevealAnswers();
  }, onListenerError);

  state.answers = await fetchAnswersForRound(state.roomId, state.roundIndex);
  doReveal();
}

// === STEP 2 : Import playlist ===
$('btn-load-playlist').addEventListener('click', async () => {
  hideError('import-error');
  $('btn-create-room').classList.add('hidden');
  const raw = $('playlist-url').value.trim();
  if (!raw) return showError('import-error', "Colle une URL de playlist Spotify.");

  $('btn-load-playlist').disabled = true;
  try {
    const id = parseSpotifyPlaylistUrl(raw);

    // Un seul appel réseau : le même document sert l'aperçu et la liste des
    // morceaux.
    const meta = await fetchPlaylist(id);
    if (meta) {
      $('playlist-meta-block').classList.remove('hidden');
      $('playlist-meta').innerHTML = `
        ${(() => {
          const u = safeImageUrl(meta.images?.[0]?.url);
          return u ? `<img src="${u}" alt="">` : '';
        })()}
        <div class="meta-info">
          <strong>${escapeHtml(meta.name)}</strong><br>
          <small>par ${escapeHtml(meta.owner?.display_name || '?')} · ${playlistTrackTotal(meta) ?? '?'} morceaux</small>
        </div>
      `;
    }

    const spotifyTracks = await extractPlaylistTracks(meta);
    if (spotifyTracks.length === 0) throw new Error("Playlist vide.");

    // Mélange AVANT l'écrêtage. Sans ça, une playlist de 200 titres ne fait
    // jamais jouer que ses 20 premiers, toujours dans le même ordre : la
    // deuxième partie sur la même playlist est identique à la première.
    // Cap to maxRoundsPerGame * 2 (we'll drop the unmatched ones during enrich).
    const candidates = shuffled(spotifyTracks).slice(0, appConfig.maxRoundsPerGame * 2);

    // Render placeholder rows
    $('enrich-block').classList.remove('hidden');
    state.enriched = [];
    $('track-list').innerHTML = candidates.map((t, i) => `
      <div class="track-row status-pending" data-idx="${i}">
        <div class="idx">${i + 1}</div>
        <div class="meta">
          <div class="title">${escapeHtml(t.name)}</div>
          <div class="artist">${escapeHtml(formatArtists(t.artists))}</div>
        </div>
        <span class="status-pill">…</span>
      </div>
    `).join('');

    let okN = 0, missingN = 0;
    state.enriched = await enrichTracksWithPreviews(candidates, (track, done, total, idx) => {
      // idx = position originale dans candidates (les résultats arrivent
      // dans le désordre car les workers tournent en parallèle).
      const row = $(`track-list`).querySelector(`[data-idx="${idx}"]`);
      if (row) {
        row.classList.remove('status-pending');
        if (track.playable) {
          row.classList.add('status-ok');
          row.querySelector('.status-pill').textContent = '✓ preview';
          okN++;
        } else {
          row.classList.add('status-missing');
          row.querySelector('.status-pill').textContent = '✗ pas de preview';
          missingN++;
        }
      }
      $('count-ok').textContent = okN;
      $('count-missing').textContent = missingN;
      $('count-ignored').textContent = '0';
      $('progress-bar').style.width = `${(done / total) * 100}%`;
    });

    // Cap to maxRoundsPerGame playable tracks for this game
    const playable = state.enriched.filter(t => t.playable);
    if (playable.length < 3) {
      throw new Error(
        `Seulement ${playable.length} morceaux ont une preview iTunes. ` +
        `Essaie une autre playlist (en général mainstream marche mieux).`
      );
    }
    if (playable.length > appConfig.maxRoundsPerGame) {
      const drop = playable.length - appConfig.maxRoundsPerGame;
      // Mark the extras as "ignored" in UI
      let dropped = 0;
      for (let i = state.enriched.length - 1; i >= 0 && dropped < drop; i--) {
        if (state.enriched[i].playable) {
          state.enriched[i].playable = false;
          state.enriched[i]._ignored = true;
          dropped++;
          const row = $('track-list').querySelector(`[data-idx="${i}"]`);
          if (row) {
            row.classList.remove('status-ok');
            row.classList.add('status-ignored');
            row.querySelector('.status-pill').textContent = '↘ ignoré (>max)';
          }
        }
      }
      $('count-ok').textContent = appConfig.maxRoundsPerGame;
      $('count-ignored').textContent = drop;
    }

    $('btn-create-room').classList.remove('hidden');
  } catch (e) {
    console.error(e);
    showError('import-error', e.message);
  } finally {
    $('btn-load-playlist').disabled = false;
  }
});

// === STEP 2 → 3 : Create room ===
$('btn-create-room').addEventListener('click', async () => {
  $('btn-create-room').disabled = true;
  try {
    const { roomId, settings } = await createRoom(state.hostId);
    state.roomId = roomId;
    state.settings = settings;
    hostSession.set(roomId);
    await addTracksToRoom(roomId, state.enriched);
    state.tracks = await fetchRoomTracks(roomId);

    $('room-code').textContent = roomId;
    const joinUrl = `${appConfig.baseUrl}/index.html?code=${roomId}`;
    $('join-url').textContent = joinUrl;
    renderJoinQR(joinUrl);

    watchRoom(roomId);
    state.unsubPlayers = listenPlayers(roomId, players => {
      // Drop the host from the player list (host is signed in anonymously
      // but does not create a player doc, so this is just defensive).
      state.players = players.filter(p => p.id !== state.hostId);
      renderLobbyPlayers();
      renderLiveScoreboard();
      if (state.step === 'finished') renderPodium();
    }, onListenerError);

    showStep('lobby');
  } catch (e) {
    console.error(e);
    showError('import-error', e.message);
    $('btn-create-room').disabled = false;
  }
});

function renderLobbyPlayers() {
  const list = $('player-list');
  $('player-count').textContent = state.players.length;
  if (state.players.length === 0) {
    list.innerHTML = '<p class="muted">En attente des potes…</p>';
    $('btn-start-game').disabled = true;
    return;
  }
  list.innerHTML = state.players.map(p => `
    <div class="player-chip">
      <span class="name">${escapeHtml(p.name)}</span>
      <span style="color: var(--neon-green);">🟢</span>
    </div>
  `).join('');
  $('btn-start-game').disabled = false;
}

// === STEP 3 → 4 : start game ===
once($('btn-start-game'), async () => {
  state.roundClicMs = Date.now();
  // playRound() appelle déjà startRound(roomId, 0) en interne — pas besoin
  // d'un startGame() séparé qui écrirait un currentRoundStartedAt en double
  // (ce qui désynchronisait l'audio des joueurs sur le round 0).
  state.roundIndex = 0;
  requestWakeLock();
  keepWakeLockOnVisibility();
  await playRound();
});

once($('btn-cancel-room'), async () => {
  if (!confirm("Annuler et supprimer la room ?")) return;
  if (state.unsubPlayers) state.unsubPlayers();
  if (state.unsubRoom) state.unsubRoom();
  hostSession.clear();
  await deleteRoom(state.roomId);
  window.location.href = './index.html';
});

// === QR code "Rejoindre" ===
// Lazy load qr-code-styling (~40 KB) — seulement quand le host arrive
// dans le lobby. Si le CDN est down, on dégrade silencieusement (juste
// pas de QR ; le code numérique et l'URL restent affichés).
let _QRCodeStylingPromise = null;
function loadQRCodeStyling() {
  if (!_QRCodeStylingPromise) {
    _QRCodeStylingPromise = import('https://cdn.jsdelivr.net/npm/qr-code-styling@1.9.0/+esm')
      .then(m => m.default || m)
      .catch(err => { console.warn('QR lib failed to load', err); return null; });
  }
  return _QRCodeStylingPromise;
}

async function renderJoinQR(url) {
  const container = $('join-qr');
  if (!container) return;
  state.joinUrl = url;
  const QRCodeStyling = await loadQRCodeStyling();
  if (!QRCodeStyling) { container.style.display = 'none'; return; }
  container.innerHTML = '';
  state.qrCode = new QRCodeStyling({
    width: 220,
    height: 220,
    type: 'svg',
    data: url,
    image: 'favicon.svg',
    margin: 4,
    qrOptions: { errorCorrectionLevel: 'H' },  // permet ~30% de pixels cachés (logo central)
    imageOptions: { hideBackgroundDots: true, imageSize: 0.28, margin: 4 },
    dotsOptions: {
      type: 'rounded',
      gradient: {
        type: 'linear',
        rotation: Math.PI / 4,
        colorStops: [
          { offset: 0, color: '#ff2e9a' },   // rose néon
          { offset: 1, color: '#6b1fb3' },   // violet profond (gardé sombre pour rester scannable)
        ],
      },
    },
    backgroundOptions: { color: 'transparent' },
    cornersSquareOptions: { type: 'extra-rounded', color: '#ff2e9a' },
    cornersDotOptions: { type: 'dot', color: '#b14aed' },
  });
  state.qrCode.append(container);
}

function flashButton(btn, label, ms = 1400) {
  const prev = btn.dataset.prevLabel || btn.textContent;
  btn.dataset.prevLabel = prev;
  btn.textContent = label;
  btn.classList.add('success-flash');
  clearTimeout(btn._flashTimer);
  btn._flashTimer = setTimeout(() => {
    btn.textContent = prev;
    btn.classList.remove('success-flash');
    btn.dataset.prevLabel = '';
  }, ms);
}

$('btn-copy-url').addEventListener('click', async () => {
  if (!state.joinUrl) return;
  try {
    await navigator.clipboard.writeText(state.joinUrl);
    flashButton($('btn-copy-url'), '✓ Lien copié !');
  } catch (err) {
    console.warn('Copy URL failed', err);
    flashButton($('btn-copy-url'), '✗ Échec — copie manuelle');
  }
});

// Copie le QR en PNG dans le presse-papier. Pratique pour le coller
// directement dans Discord (Discord détecte l'image et l'affiche inline).
// Fallback : si l'API ClipboardItem image/png n'est pas dispo (Safari ancien,
// Firefox <127), on télécharge le PNG à la place.
$('btn-copy-qr').addEventListener('click', async () => {
  const btn = $('btn-copy-qr');
  if (!state.qrCode) {
    flashButton(btn, '✗ QR pas prêt');
    return;
  }
  try {
    const blob = await state.qrCode.getRawData('png');
    if (window.ClipboardItem && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      flashButton(btn, '✓ QR copié !');
    } else {
      // Fallback : déclenche un download
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `blindie-${state.roomId || 'qr'}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      flashButton(btn, '↓ QR téléchargé');
    }
  } catch (err) {
    console.warn('Copy QR failed', err);
    flashButton(btn, '✗ Échec');
  }
});

// === STEP 4 : playing ===
async function playRound() {
  const track = state.tracks[state.roundIndex];
  if (!track) return finishGame();
  state.currentTrack = track;

  const avantEcriture = Date.now();
  await startRound(state.roomId, state.roundIndex);
  noteDebug(`round ${state.roundIndex + 1} — écriture confirmée en`, Date.now() - avantEcriture);
  // Ancre du décompte, prise juste après la confirmation de startRound : c'est
  // ce qui colle au mieux au currentRoundStartedAt que les joueurs vont lire.
  state.roundAnchorMs = Date.now();
  if (!state.roundClicMs) state.roundClicMs = Date.now();
  state.roundStartServerMs = serverNow();   // estimation, affinée au snapshot
  showStep('playing');

  $('round-num').textContent = state.roundIndex + 1;
  $('round-total').textContent = state.tracks.length;
  const art = $('album-art');
  art.className = 'album-art mystery';
  art.innerHTML = '';
  $('answers').innerHTML = '<p class="muted">En attente des buzz…</p>';
  $('answer-count').textContent = '0';
  hideError('round-error');
  // Reset le bouton de fin de round à son libellé initial
  $('btn-stop-audio').textContent = '⏹ Stop & révéler';
  $('btn-stop-audio').disabled = false;

  // Audio host : joue la piste pour le présentateur. Chaque joueur a aussi
  // son propre audio synchronisé côté player.js — Blindie est conçu pour
  // les parties à distance via Discord.
  if (state.audio) { state.audio.pause(); state.audio = null; }
  state.audio = new Audio(track.previewUrl);
  state.audio.volume = 1;
  try { await state.audio.play(); }
  catch (err) { console.warn('Audio autoplay refusé', err); }

  startTimer(roundDuration());

  if (state.unsubAnswers) state.unsubAnswers();
  state.unsubAnswers = listenAnswers(state.roomId, state.roundIndex, answers => {
    state.answers = answers;
    // En reveal on a déjà rendu state.answers avec les scores retournés par
    // scoreRound — on rerend pour propager les éventuels updates Firestore
    // (par ex. score corrigé via une seconde passe).
    if (state.step === 'reveal') renderRevealAnswers();
    else renderLiveAnswers();
  }, onListenerError);

  state.audio.onended = () => {
    // Don't auto-reveal — host clicks "Stop & révéler".
  };
}

// Décompte ancré sur une DATE, pas sur un compteur décrémenté.
//
// Un setInterval qui fait `remaining--` dérive dès que l'onglet passe en
// arrière-plan : les navigateurs bridant les timers inactifs (jusqu'à un tick
// par minute), le host qui bascule sur Discord voyait son décompte ralentir
// pendant que les joueurs, eux, calculaient depuis currentRoundStartedAt.
// Les deux horloges divergeaient : les joueurs voyaient 0 et se faisaient
// verrouiller plusieurs secondes plus tard, quand le host rattrapait.
//
// `startedAtMs` est l'ancre commune. Au démarrage d'un round c'est l'instant
// local où startRound() a été confirmé ; à la reprise après refresh c'est le
// currentRoundStartedAt du serveur, comme côté joueur.
// Le décompte relit son ancre à CHAQUE tick, dans le référentiel serveur.
// C'est ce qui lui permet de se corriger tout seul : au démarrage d'un round
// l'ancre n'est qu'une estimation locale, et elle est remplacée par la valeur
// exacte du serveur dès que le snapshot du doc room arrive.
function startTimer(durationSeconds) {
  clearInterval(state.timerInterval);
  let verrouille = false;

  const tick = async () => {
    const debut = state.roundStartServerMs;
    if (debut == null) return;
    const remaining = Math.max(0, Math.ceil((debut + durationSeconds * 1000 - serverNow()) / 1000));
    $('timer').textContent = remaining;
    $('timer').classList.toggle('danger', remaining <= 5);
    if (remaining > 0 || verrouille) return;

    verrouille = true;
    clearInterval(state.timerInterval);
    if (state.audio) state.audio.pause();
    // Verrouille automatiquement la room : les joueurs ne peuvent plus
    // répondre. Le host clique ensuite sur "Révéler" pour scorer + reveal.
    try {
      await lockRound(state.roomId);
    } catch (e) {
      console.error('Lock failed', e);
      showError('round-error',
        "Impossible de verrouiller le round — les joueurs peuvent encore répondre. " +
        "Vérifie ta connexion, puis clique sur Révéler.");
    }
    // Le bouton change de libellé pour refléter l'état "locked"
    $('btn-stop-audio').textContent = '🎯 Révéler';
  };

  // L'intervalle est armé AVANT le premier tick : si le round est déjà écoulé
  // (reprise après refresh), tick() doit pouvoir annuler l'intervalle qu'il
  // vient de créer, sinon celui-ci tourne indéfiniment dans le vide.
  state.timerInterval = setInterval(tick, 500);
  tick();
}

$('btn-replay').addEventListener('click', async () => {
  if (!state.currentTrack?.previewUrl) return;
  // Recrée l'élément audio plutôt que seek+play : après que `ended` ait
  // été émis (preview iTunes = 30 s, souvent finie quand le host clique),
  // Chrome ne relance pas la lecture proprement via un simple
  // currentTime=0 + play().
  if (state.audio) state.audio.pause();
  state.audio = new Audio(state.currentTrack.previewUrl);
  state.audio.volume = 1;
  try { await state.audio.play(); }
  catch (err) { console.warn('Replay refusé', err); }
});

$('btn-stop-audio').addEventListener('click', async () => {
  // Flow unifié : que ce soit un stop anticipé ("playing") ou un click
  // après que le timer ait expiré ("locked"), on lock + score + reveal.
  if (state.audio) state.audio.pause();
  clearInterval(state.timerInterval);
  $('btn-stop-audio').disabled = true;
  try {
    // Lock si pas déjà fait (stop anticipé). Idempotent : si la room est
    // déjà "locked", c'est un no-op côté Firestore.
    await lockRound(state.roomId);
    // On re-fetch les réponses fraîchement présentes en Firestore plutôt
    // que de relire state.answers : si une réponse a été acceptée juste
    // avant le lock mais que le snapshot listener n'a pas encore propagé,
    // elle serait absente de state.answers et ne serait jamais scorée.
    const latestAnswers = await fetchAnswersForRound(
      state.roomId, state.roundIndex,
    );
    // scoreRound retourne les answers enrichis avec leurs scores : on
    // écrase state.answers pour rendre l'UI immédiatement sans attendre
    // que le listener Firestore propage l'update.
    const scored = await scoreRound(
      state.roomId,
      state.roundIndex,
      state.currentTrack,
      latestAnswers,
      roundPoints(),
    );
    state.answers = scored;
    await revealRound(state.roomId, state.currentTrack.id);
    doReveal();
  } catch (e) {
    console.error(e);
    alert("Erreur pendant le reveal : " + e.message);
  } finally {
    $('btn-stop-audio').disabled = false;
    $('btn-stop-audio').textContent = '⏹ Stop & révéler';
  }
});

// Le nom affiché à côté d'une réponse vient du document `players`, jamais du
// champ `playerName` de la réponse : ce dernier est écrit par le joueur, qui
// peut donc y mettre le pseudo d'un autre et brouiller la lecture de l'écran.
function nomDuJoueur(answer) {
  const p = state.players.find(p => p.id === answer.id || p.id === answer.playerId);
  return p?.name ?? answer.playerName ?? '?';
}

function renderLiveAnswers() {
  $('answer-count').textContent = state.answers.length;
  if (state.answers.length === 0) {
    $('answers').innerHTML = '<p class="muted">En attente des buzz…</p>';
    return;
  }
  $('answers').innerHTML = state.answers
    .sort((a, b) => (a.submittedAt?.seconds || 0) - (b.submittedAt?.seconds || 0))
    .map((a, i) => `
      <div class="answer-row">
        <div>
          <span class="who">#${i + 1} ${escapeHtml(nomDuJoueur(a))}</span><br>
          <span class="what">
            <small>Titre :</small> ${escapeHtml(a.titleAnswer) || '<em class="muted">—</em>'} ·
            <small>Artiste :</small> ${escapeHtml(a.artistAnswer) || '<em class="muted">—</em>'}
          </span>
        </div>
      </div>
    `).join('');
}

// === STEP 5 : reveal ===
function doReveal() {
  showStep('reveal');
  $('reveal-round-num').textContent = state.roundIndex + 1;
  $('reveal-title').textContent = state.currentTrack.title;
  $('reveal-artist').textContent = formatArtists(state.currentTrack.artists);
  const art = $('reveal-art');
  art.className = 'album-art';
  const revealImg = safeImageUrl(state.currentTrack.imageUrl);
  art.innerHTML = revealImg ? `<img src="${revealImg}" alt="">` : '🎵';

  // Apple Music link
  const appleLink = $('reveal-apple-link');
  const appleUrl = safeExternalUrl(state.currentTrack.trackViewUrl);
  if (appleUrl) {
    appleLink.href = appleUrl;
    appleLink.classList.remove('hidden');
  } else {
    appleLink.classList.add('hidden');
  }

  renderRevealAnswers();
}

function renderRevealAnswers() {
  if (state.answers.length === 0) {
    $('reveal-answers').innerHTML = '<p class="muted">Personne n\'a répondu sur ce round.</p>';
    return;
  }
  $('reveal-answers').innerHTML = state.answers
    .sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0))
    .map(a => {
      const cls = a.totalScore >= 2 ? 'correct' :
                  a.totalScore === 1 ? 'partial' : 'wrong';
      const detail = [
        a.scoreTitle > 0 ? `+${a.scoreTitle} titre` : null,
        a.scoreArtist > 0 ? `+${a.scoreArtist} artiste` : null,
      ].filter(Boolean).join(' · ') || '0 pt';
      return `
        <div class="answer-row ${cls}">
          <div>
            <span class="who">${escapeHtml(nomDuJoueur(a))}</span>
            <span class="tag" style="margin-left:0.5rem;">${detail}</span><br>
            <span class="what">
              <small>Titre :</small> ${escapeHtml(a.titleAnswer) || '<em class="muted">—</em>'} ·
              <small>Artiste :</small> ${escapeHtml(a.artistAnswer) || '<em class="muted">—</em>'}
            </span>
          </div>
        </div>
      `;
    }).join('');
}

once($('btn-next-round'), async () => {
  state.roundClicMs = Date.now();
  state.roundIndex++;
  if (state.roundIndex >= state.tracks.length) return finishGame();
  // playRound() appelle déjà startRound(roomId, roundIndex) qui écrit
  // currentRoundStartedAt. Un appel séparé à nextRound() écrirait un 2e
  // timestamp et désynchroniserait l'audio des joueurs.
  await playRound();
});

once($('btn-end-game'), () => finishGame());

// === STEP 6 : finished ===
async function finishGame() {
  clearInterval(state.timerInterval);
  if (state.audio) state.audio.pause();
  if (state.unsubAnswers) state.unsubAnswers();
  if (state.unsubRoom) { state.unsubRoom(); state.unsubRoom = null; }
  releaseWakeLock();
  await endGame(state.roomId);
  showStep('finished');
  renderPodium();
}

function renderPodium() {
  const sorted = [...state.players].sort((a, b) => (b.score || 0) - (a.score || 0));
  $('final-scoreboard').innerHTML = sorted.map((p, i) => `
    <div class="score-row rank-${i + 1}">
      <span class="rank">${medal(i)}</span>
      <span class="name">${escapeHtml(p.name)}</span>
      <span class="pts">${p.score || 0}</span>
    </div>
  `).join('');
}

function medal(i) { return i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`; }

// === Live scoreboard ===
function renderLiveScoreboard() {
  const sorted = [...state.players].sort((a, b) => (b.score || 0) - (a.score || 0));
  $('live-scoreboard').innerHTML = sorted.map((p, i) => `
    <div class="score-row rank-${i + 1}">
      <span class="rank">${medal(i)}</span>
      <span class="name">${escapeHtml(p.name)}</span>
      <span class="pts">${p.score || 0}</span>
    </div>
  `).join('');
}

// === Helpers ===
// Un listener Firestore qui meurt laisse l'écran du host figé sur son dernier
// état, sans rien dire — et les joueurs, eux, continuent d'attendre.
function onListenerError(err, quoi) {
  showError('round-error',
    `Connexion perdue avec la partie (${quoi}). Recharge la page : ta room est ` +
    `retrouvée automatiquement.`);
}

function showError(id, msg) {
  const el = $(id);
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideError(id) { $(id).classList.add('hidden'); }

$('btn-back-home-host').addEventListener('click', () => {
  hostSession.clear();
  window.location.href = './index.html';
});

// Click-to-copy on room code & join URL
// Copie au clic ET au clavier : ce sont des <div>/<code>, donc Entrée et
// Espace ne déclenchent rien tout seuls.
function copiableAuClic(id) {
  const el = $(id);
  const copier = () => {
    navigator.clipboard.writeText(el.textContent).catch(() => {});
    el.classList.add('success-flash');
    setTimeout(() => el.classList.remove('success-flash'), 600);
  };
  el.addEventListener('click', copier);
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copier(); }
  });
}
copiableAuClic('room-code');
copiableAuClic('join-url');
