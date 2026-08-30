// Player logic — runs on the phone. Lit l'état de la room, soumet des
// réponses, et joue l'audio iTunes localement (Blindie est conçu pour les
// parties à distance via Discord — tout le monde a besoin du son).
// Le scoring est calculé côté host au reveal, le joueur n'écrit jamais
// de score.

import { ensureAnonAuth } from './firebase.js';
import {
  joinRoom, leaveRoom, listenRoom, listenPlayers,
  submitAnswer, roomExists, fetchTrackByOrder, measureClockOffset,
} from './room.js';
import { doc, getDoc } from
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from './firebase.js';
import {
  escapeHtml, formatArtists, safeImageUrl, safeExternalUrl,
  requestWakeLock, releaseWakeLock, keepWakeLockOnVisibility,
  setClockOffset, serverNow, clockOffsetMs, clockIsCalibrated,
} from './utils.js';
import { appConfig } from './config.js';

const MAX_NAME = appConfig.maxNameLength;
// Durée d'un extrait iTunes. Au-delà, il n'y a plus rien à jouer.
const PREVIEW_SECONDS = 30;

const $ = id => document.getElementById(id);

const states = ['join', 'lobby', 'playing', 'reveal', 'finished'];
let etatCourant = null;

function showState(name) {
  const change = name !== etatCourant;
  states.forEach(s => $(`state-${s}`).classList.toggle('hidden', s !== name));
  etatCourant = name;
  // Au changement d'écran, le focus restait où il était : un lecteur d'écran
  // continuait d'annoncer l'ancien contenu, et la navigation au clavier
  // repartait du mauvais endroit.
  if (change) deplacerFocus($(`state-${name}`));
}

function deplacerFocus(section) {
  const cible = section?.querySelector('h2, h3, [autofocus]');
  if (!cible) return;
  if (!cible.hasAttribute('tabindex')) cible.setAttribute('tabindex', '-1');
  // preventScroll : le focus sert à l'annonce, pas à la navigation —
  // il ne doit pas faire sauter la page sous le doigt.
  cible.focus({ preventScroll: true });
}

// === State ===
const state = {
  uid: null,
  roomId: null,
  name: null,
  currentRoundIndex: -1,
  hasSubmittedThisRound: false,
  // Copie locale du track courant. Sert à jouer l'audio (previewUrl) en
  // synchro avec le host. Le scoring est fait côté host au reveal, donc
  // les champs title/artists ne sont pas utilisés pour le scoring côté
  // joueur — mais ils sont visibles via Firestore (assumé, parties privées).
  currentTrackPublic: null,
  timerInterval: null,
  // Audio joué localement par le joueur — toujours actif (Blindie est conçu
  // pour des parties à distance via Discord). Un seul déblocage manuel est
  // requis dans le lobby (limitation navigateur, on ne peut pas auto-play
  // un son sans un premier clic user).
  localAudio: null,
  audioUnlocked: false,
  roundStartedAtMs: null,
  roundDurationMs: null,
};

// === Init ===
(async function init() {
  const user = await ensureAnonAuth();
  state.uid = user.uid;

  // Recover session if any
  const urlParams = new URLSearchParams(window.location.search);
  const roomFromUrl = urlParams.get('code');
  const roomFromSession = sessionStorage.getItem('blindie.roomCode');
  const nameFromSession = sessionStorage.getItem('blindie.playerName');

  if (roomFromUrl && (!roomFromSession || roomFromSession !== roomFromUrl)) {
    // Came through a fresh shared URL: ask for pseudo
    return askForJoin(roomFromUrl);
  }
  if (!roomFromSession || !nameFromSession) {
    return askForJoin(roomFromUrl);
  }

  state.roomId = roomFromSession;
  state.name = nameFromSession;
  $('room-tag').textContent = state.roomId;
  $('me-name').textContent = state.name;
  await attachListeners();
})();

function askForJoin(prefillCode) {
  showState('join');
  if (prefillCode) $('join-code-in').value = prefillCode.toUpperCase().slice(0, 6);
  $('join-name-in').value = localStorage.getItem('blindie.lastName') || '';

  $('join-code-in').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  $('btn-join').addEventListener('click', async () => {
    const code = $('join-code-in').value.trim();
    const name = $('join-name-in').value.trim();
    if (code.length !== 6) return showJoinError("Code à 6 caractères.");
    if (!name) return showJoinError("Pseudo manquant.");
    if (name.length > MAX_NAME) return showJoinError(`Pseudo trop long (${MAX_NAME} max).`);
    const btn = $('btn-join');
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const ok = await roomExists(code);
      if (!ok) return showJoinError("Aucune partie avec ce code.");
      await joinRoom(code, state.uid, name);
      state.roomId = code;
      state.name = name;
      sessionStorage.setItem('blindie.roomCode', code);
      sessionStorage.setItem('blindie.playerName', name);
      localStorage.setItem('blindie.lastName', name);
      $('room-tag').textContent = code;
      $('me-name').textContent = name;
      await attachListeners();
    } catch (e) {
      console.error(e);
      showJoinError(e.message || "Erreur de connexion.");
    } finally {
      btn.disabled = false;
    }
  });
}

function showJoinError(msg) {
  const el = $('join-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// Message persistant en haut de l'écran, pour tout ce qui n'est pas lié au
// formulaire de connexion (listener mort, hôte disparu).
function banner(msg, isError) {
  const el = $('player-banner');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  el.classList.remove('hidden');
}

// === Diagnostic (?debug=1) ===
// Sur un téléphone il n'y a pas de console : sans ce panneau, un décalage
// d'horloge ou un snapshot en retard est invisible et indiscernable d'une
// "app lente".
const DEBUG = new URLSearchParams(window.location.search).has('debug');
let dernierSnapshotMs = null;
let dernierStatut = '—';

function majDebug() {
  if (!DEBUG) return;
  let el = $('debug-panel');
  if (!el) {
    el = document.createElement('div');
    el.id = 'debug-panel';
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;' +
      'background:rgba(10,1,24,.94);color:#8CBEDE;font:11px/1.5 ui-monospace,monospace;' +
      'padding:.5rem .7rem;border-top:1px solid #35617F;white-space:pre;overflow-x:auto';
    document.body.appendChild(el);
  }
  // L'écart n'est mesuré qu'une fois la partie rejointe : afficher "+0.0 s"
  // avant laisserait croire à une horloge vérifiée alors qu'elle ne l'est pas.
  const ecart = clockOffsetMs();
  const ecartTexte = clockIsCalibrated()
    ? `${ecart >= 0 ? '+' : ''}${(ecart / 1000).toFixed(1)} s`
    : 'NON MESURÉ — rejoins la partie';
  const depuis = dernierSnapshotMs ? Math.round((Date.now() - dernierSnapshotMs) / 100) / 10 : null;
  el.textContent =
    `écart horloge : ${ecartTexte}` +
    `   ·   statut : ${dernierStatut}` +
    `   ·   dernier snapshot : ${depuis === null ? '—' : depuis + ' s'}` +
    `\nround ${state.currentRoundIndex}   ·   son ${state.audioUnlocked ? 'débloqué' : 'BLOQUÉ'}` +
    `   ·   piste ${state.currentTrackPublic ? 'chargée' : '—'}`;
}
if (DEBUG) setInterval(majDebug, 500);

// === Listeners ===
// Un seul appel par chargement de page — le garde évite qu'un double-clic sur
// "Rejoindre" n'installe deux jeux de listeners.
let listenersAttaches = false;

async function attachListeners() {
  if (listenersAttaches) return;
  listenersAttaches = true;

  // Cale l'horloge AVANT d'écouter : le premier snapshot peut déjà être un
  // round en cours, et son timing dépend de cette mesure.
  const mesure = await measureClockOffset(state.roomId, state.uid);
  if (mesure) setClockOffset(mesure.serverMs, mesure.localMs);
  majDebug();

  listenRoom(state.roomId, async room => {
    if (!room) {
      alert("La partie a été fermée.");
      sessionStorage.clear();
      window.location.href = './index.html';
      return;
    }
    noteRoomActivity();
    dernierSnapshotMs = Date.now();
    dernierStatut = room.status;
    majDebug();
    await handleRoomUpdate(room);
  }, showConnectionError);

  listenPlayers(state.roomId, players => {
    renderLobbyPlayers(players);
    renderScoreboard(players);
  }, showConnectionError);
}

// Un listener qui meurt laisse l'écran figé sur son dernier état, sans rien
// dire. On le dit.
function showConnectionError(err) {
  const msg = err?.code === 'permission-denied'
    ? "Tu n'es plus dans cette partie. Reviens à l'accueil pour la rejoindre."
    : "Connexion perdue avec la partie. Vérifie ton réseau et recharge la page.";
  banner(msg, true);
}

// === Détection d'un host qui a fermé son onglet ===
// Si l'hôte disparaît en plein round, la room reste bloquée en "playing" pour
// toujours : le timer des joueurs tombe à 0 mais rien ne verrouille jamais.
// Sans ce garde-fou, l'écran reste vivant et ment.
let dernierSignalRoom = Date.now();
let veilleHost = null;

function noteRoomActivity() {
  dernierSignalRoom = Date.now();
}

function surveillerHost(room) {
  clearTimeout(veilleHost);
  if (room.status !== 'playing' && room.status !== 'locked') return;
  const duree = (room.settings?.roundDurationSeconds
                 || appConfig.defaultRoundDurationSeconds) * 1000;
  const echeance = dernierSignalRoom + duree + HOST_GRACE_MS - Date.now();
  veilleHost = setTimeout(() => {
    banner("L'hôte semble déconnecté — la partie ne repart pas toute seule.", true);
  }, Math.max(1000, echeance));
}

// Marge après la fin du timer avant de conclure que l'hôte a disparu. Large :
// un hôte qui réfléchit avant de révéler ne doit pas déclencher l'alerte.
const HOST_GRACE_MS = 60_000;

async function handleRoomUpdate(room) {
  surveillerHost(room);
  switch (room.status) {
    case 'lobby':
      stopTimer();
      stopLocalAudio();
      showState('lobby');
      break;

    case 'playing':
      showState('playing');
      // Si on a rejoint la partie en cours sans avoir débloqué le son dans
      // le lobby, on affiche un bouton fallback de déblocage.
      $('btn-unlock-audio-late').classList.toggle('hidden', state.audioUnlocked);
      // Cache timing info so the local audio button can sync to host
      state.roundStartedAtMs = room.currentRoundStartedAt?.toMillis?.() || null;
      state.roundDurationMs = (room.settings?.roundDurationSeconds
                               || appConfig.defaultRoundDurationSeconds) * 1000;
      if (room.currentRoundIndex !== state.currentRoundIndex) {
        state.currentRoundIndex = room.currentRoundIndex;
        state.hasSubmittedThisRound = false;
        state.currentTrackPublic = null;
        resetAnswerForm();
        stopLocalAudio();
        // Fetch the current track. previewUrl is included so we can play
        // the audio on each player's device — Blindie est conçu pour des
        // parties à distance, donc tout le monde a besoin du son.
        state.currentTrackPublic = await fetchCurrentTrackPublic(room);
        playLocalAudio();
        startPlayerTimer(room);
      } else {
        startPlayerTimer(room);
      }
      $('play-round').textContent = room.currentRoundIndex + 1;
      if (room.totalRounds) $('play-round-total').textContent = room.totalRounds;
      break;

    case 'locked':
      // Timer expiré côté host. Audio coupé, formulaire désactivé,
      // bandeau visuel pour signaler l'attente du reveal.
      stopTimer();
      stopLocalAudio();
      showState('playing');
      $('play-round').textContent = room.currentRoundIndex + 1;
      if (room.totalRounds) $('play-round-total').textContent = room.totalRounds;
      $('play-timer').textContent = '🔒';
      $('play-timer').classList.add('danger');
      $('answer-title').disabled = true;
      $('answer-artist').disabled = true;
      $('btn-submit').disabled = true;
      $('btn-submit').textContent = '🔒 Verrouillé';
      $('submit-feedback').classList.remove('hidden');
      $('submit-feedback').textContent = '⏳ Temps écoulé — en attente du reveal…';
      break;

    case 'reveal':
      stopTimer();
      stopLocalAudio();
      showState('reveal');
      await renderReveal(room);
      break;

    case 'finished':
      stopTimer();
      stopLocalAudio();
      releaseWakeLock();
      showState('finished');
      $('final-scoreboard').innerHTML = $('scoreboard').innerHTML;
      break;
  }
}

// Le track du round courant. Le previewUrl est récupéré pour jouer l'audio en
// local (synchronisé avec le host). Le title/artists/imageUrl sont aussi
// présents mais non affichés avant le reveal — le scoring est fait côté host,
// le joueur n'en a pas besoin.
async function fetchCurrentTrackPublic(room) {
  if (room.currentRoundIndex == null) return null;
  return fetchTrackByOrder(state.roomId, room.currentRoundIndex);
}

// === Lobby render ===
function renderLobbyPlayers(players) {
  const others = players.filter(p => p.id !== state.uid);
  $('player-count').textContent = players.length;
  $('lobby-players').innerHTML = others.length
    ? others.map(p => `<div class="player-chip"><span class="name">${escapeHtml(p.name)}</span></div>`).join('')
    : '<p class="muted">Encore personne d\'autre…</p>';
}

// === Scoreboard render ===
function renderScoreboard(players) {
  const sorted = [...players].sort((a, b) => (b.score || 0) - (a.score || 0));
  $('scoreboard').innerHTML = sorted.map((p, i) => `
    <div class="score-row rank-${i + 1}">
      <span class="rank">${medal(i)}</span>
      <span class="name">${escapeHtml(p.name)}${p.id === state.uid ? ' (toi)' : ''}</span>
      <span class="pts">${p.score || 0}</span>
    </div>
  `).join('');
}

function medal(i) { return i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`; }

// === Submit answer ===
$('btn-submit').addEventListener('click', async () => {
  const title = $('answer-title').value.trim();
  const artist = $('answer-artist').value.trim();
  if (!title && !artist) {
    flashFeedback("Au moins un des deux champs.", true);
    return;
  }
  $('btn-submit').disabled = true;
  $('btn-submit').textContent = '✓ Envoyé !';
  try {
    // On ne passe PLUS le track : le scoring est fait par le host au reveal.
    // Le client n'écrit que la réponse brute. Si la room n'est plus en
    // "playing" (timer expiré -> locked), submitAnswer côté room.js refuse
    // et Firestore rules refuse aussi.
    await submitAnswer(
      state.roomId, state.uid, state.name,
      state.currentRoundIndex,
      { titleAnswer: title, artistAnswer: artist }
    );
    state.hasSubmittedThisRound = true;
    $('submit-feedback').classList.remove('hidden');
    $('submit-feedback').textContent = '✓ Réponse envoyée — tu peux modifier jusqu\'à la révélation';
    // Allow re-submission
    setTimeout(() => {
      $('btn-submit').disabled = false;
      $('btn-submit').textContent = '↻ Modifier ma réponse';
    }, 800);
  } catch (e) {
    console.error(e);
    flashFeedback(e.message, true);
    $('btn-submit').disabled = false;
  }
});

['answer-title', 'answer-artist'].forEach(id => {
  $(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); $('btn-submit').click(); }
  });
});

function flashFeedback(msg, isError) {
  const el = $('submit-feedback');
  el.textContent = msg;
  el.style.background = isError ? 'rgba(255,51,85,0.15)' : '';
  el.style.borderColor = isError ? 'var(--danger)' : '';
  el.style.color = isError ? '#ffb3c0' : '';
  el.classList.remove('hidden');
}

function resetAnswerForm() {
  $('answer-title').value = '';
  $('answer-artist').value = '';
  $('answer-title').disabled = false;
  $('answer-artist').disabled = false;
  $('submit-feedback').classList.add('hidden');
  $('btn-submit').disabled = false;
  $('btn-submit').textContent = '🚨 ENVOYER';
  // Reset timer cosmetics au cas où on revient de "locked"
  $('play-timer').classList.remove('danger');
}

// === Timer (synced from server timestamp) ===
function startPlayerTimer(room) {
  stopTimer();
  const startedAt = room.currentRoundStartedAt?.toMillis?.();
  if (!startedAt) return;
  const duration = (room.settings?.roundDurationSeconds || appConfig.defaultRoundDurationSeconds) * 1000;
  const update = () => {
    const remaining = Math.max(0, Math.round((startedAt + duration - serverNow()) / 1000));
    $('play-timer').textContent = remaining;
    $('play-timer').classList.toggle('danger', remaining <= 5 && remaining > 0);
    if (remaining <= 0) stopTimer();
  };
  update();
  state.timerInterval = setInterval(update, 500);
}
function stopTimer() {
  clearInterval(state.timerInterval);
  state.timerInterval = null;
}

// === Reveal ===
async function renderReveal(room) {
  let track = state.currentTrackPublic;
  if (!track || track.id !== room.revealedTrackId) {
    if (room.revealedTrackId) {
      const ref = doc(db, 'rooms', state.roomId, 'tracks', room.revealedTrackId);
      const snap = await getDoc(ref);
      if (snap.exists()) track = { id: snap.id, ...snap.data() };
    }
  }
  if (!track) return;

  $('reveal-title').textContent = track.title;
  $('reveal-artist').textContent = formatArtists(track.artists);
  const art = $('reveal-art');
  const safeImg = safeImageUrl(track.imageUrl);
  art.innerHTML = safeImg ? `<img src="${safeImg}" alt="">` : '🎵';

  // My result this round
  const myAnsRef = await findMyAnswerForRound(room.currentRoundIndex);
  const result = $('my-points');
  if (myAnsRef) {
    const pts = myAnsRef.totalScore || 0;
    if (pts >= 2) {
      result.textContent = `✓✓ +${pts} pts`;
      result.style.background = 'rgba(57,255,20,0.25)';
      result.style.color = 'var(--neon-green)';
    } else if (pts === 1) {
      result.textContent = `± +1 pt`;
      result.style.background = 'rgba(255,214,10,0.25)';
      result.style.color = 'var(--neon-yellow)';
    } else {
      result.textContent = '✗ Raté';
      result.style.background = 'rgba(255,51,85,0.25)';
      result.style.color = 'var(--danger)';
    }
  } else {
    result.textContent = '— Pas de réponse —';
    result.style.background = 'rgba(184,168,212,0.15)';
    result.style.color = 'var(--text-dim)';
  }

  // Apple Music link
  const appleLink = $('reveal-apple-link');
  const appleUrl = safeExternalUrl(track.trackViewUrl);
  if (appleUrl) {
    appleLink.href = appleUrl;
    appleLink.classList.remove('hidden');
    appleLink.style.display = '';
  } else {
    appleLink.classList.add('hidden');
    appleLink.style.display = 'none';
  }
}

// Le doc answer a pour identifiant l'uid du joueur (1 seul answer actif par
// joueur, remplacé à chaque round) : une lecture directe suffit, pas besoin
// d'une requête à deux filtres.
async function findMyAnswerForRound(roundIndex) {
  const snap = await getDoc(doc(db, 'rooms', state.roomId, 'answers', state.uid));
  if (!snap.exists()) return null;
  const data = snap.data();
  return data.roundIndex === roundIndex ? data : null;
}

// === Leave ===
$('btn-leave').addEventListener('click', async () => {
  if (!confirm("Quitter la partie ?")) return;
  await leaveRoom(state.roomId, state.uid).catch(() => {});
  sessionStorage.clear();
  window.location.href = './index.html';
});

$('btn-back-home-player').addEventListener('click', () => {
  sessionStorage.clear();
  window.location.href = './index.html';
});

// === Local audio (auto-play on each round once unlocked) ===
// L'audio joué localement utilise le previewUrl iTunes stocké dans Firestore.
// Sync au mieux avec le host en seekant à partir de `currentRoundStartedAt`
// (timestamp serveur).
//
// Limitation navigateur : on ne peut pas démarrer un son sans un premier
// clic user. D'où le bouton "Activer le son" dans le lobby.

$('btn-unlock-audio').addEventListener('click', () => unlockAudio());
$('btn-unlock-audio-late').addEventListener('click', () => unlockAudio());

function unlockAudio() {
  if (!state.localAudio) state.localAudio = $('local-audio');
  // Joue un son muet pour débloquer la lecture audio dans la session.
  // C'est le pattern standard pour iOS/Android.
  state.localAudio.src = 'silence.wav';
  state.localAudio.muted = true;
  state.localAudio.play().then(() => {
    state.localAudio.pause();
    state.localAudio.muted = false;
    state.audioUnlocked = true;
    // Le son est débloqué : le joueur va écouter, l'écran ne doit pas s'éteindre.
    requestWakeLock();
    keepWakeLockOnVisibility();
    // Bouton lobby : transformation visuelle
    const btn = $('btn-unlock-audio');
    btn.textContent = '🔊 Son activé ✓';
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-success');
    btn.disabled = true;
    $('audio-status').textContent = "Tu es prêt(e), bonne chance !";
    // Bouton fallback playing : on le cache
    $('btn-unlock-audio-late').classList.add('hidden');
    // Si on est déjà au milieu d'un round (late join), démarre l'audio
    if (state.currentRoundIndex >= 0 && state.currentTrackPublic) {
      playLocalAudio();
    }
  }).catch(err => {
    console.warn('Déblocage audio échoué :', err);
    $('audio-status').textContent = "⚠ Le navigateur bloque le son. Réessaie ou vérifie tes permissions.";
  });
}

function playLocalAudio() {
  const track = state.currentTrackPublic;
  if (!track?.previewUrl) return;
  if (!state.audioUnlocked) return;  // pas encore débloqué — silence

  if (!state.localAudio) state.localAudio = $('local-audio');
  state.localAudio.src = track.previewUrl;
  state.localAudio.volume = 1;

  // Seek à partir du début du round host, sur l'heure SERVEUR : comparer un
  // horodatage serveur à l'horloge du téléphone décalait la lecture d'autant
  // que le téléphone était mal réglé.
  const brut = state.roundStartedAtMs
    ? (serverNow() - state.roundStartedAtMs) / 1000
    : 0;
  // Une valeur aberrante (horloge non calée, snapshot d'un round ancien) ne
  // doit pas se traduire par un silence : on repart du début.
  const elapsed = (brut < 0 || brut > PREVIEW_SECONDS) ? 0 : brut;
  state.localAudio.currentTime = Math.min(PREVIEW_SECONDS - 0.5, Math.max(0, elapsed));
  state.localAudio.play().catch(err => {
    console.warn('Audio bloqué :', err);
  });
}

function stopLocalAudio() {
  if (state.localAudio) {
    state.localAudio.pause();
    state.localAudio.currentTime = 0;
  }
}
