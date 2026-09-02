// Room + game logic on top of Firestore.
// All multi-device sync happens here: rooms, tracks, players, answers.

import {
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, query, where, orderBy, limit, getDocs,
  onSnapshot, writeBatch, increment, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db, ensureAnonAuth, Timestamp } from './firebase.js';
import { generateJoinCode, calculateScore } from './utils.js';
import { appConfig } from './config.js';

// ===================================================================
// Path helpers
// ===================================================================
const roomDoc = (roomId) => doc(db, 'rooms', roomId);
const tracksCol = (roomId) => collection(db, 'rooms', roomId, 'tracks');
const trackDoc = (roomId, trackId) => doc(db, 'rooms', roomId, 'tracks', trackId);
const playersCol = (roomId) => collection(db, 'rooms', roomId, 'players');
const playerDoc = (roomId, playerId) => doc(db, 'rooms', roomId, 'players', playerId);
const answersCol = (roomId) => collection(db, 'rooms', roomId, 'answers');
// Answer doc ID == playerId : 1 seul doc actif par joueur, remplacé à chaque
// round. Empêche un joueur malicieux de multiplier ses answers (et donc son
// score) via plusieurs addDoc(). Côté règles, on impose answerId == auth.uid.
const answerDoc = (roomId, playerId) => doc(db, 'rooms', roomId, 'answers', playerId);

// ===================================================================
// Room creation / lookup
// ===================================================================

// Durée de vie d'une room avant purge automatique par le TTL Firestore.
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

// Creates a new room owned by hostId. Picks a 6-char joinCode (cryptographic
// random) that is also used as the document ID (collisions are retried).
//
// Statuts possibles d'une room :
//   - "lobby"    : en attente des joueurs
//   - "playing"  : round en cours, les joueurs peuvent répondre
//   - "locked"   : round terminé (timer écoulé ou stop manuel), réponses fermées
//   - "reveal"   : le host a révélé la réponse, les scores sont affichés
//   - "finished" : partie terminée, podium
export async function createRoom(hostId) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateJoinCode(6);
    const ref = roomDoc(code);
    const snap = await getDoc(ref);
    if (snap.exists()) continue;
    const settings = {
      roundDurationSeconds: appConfig.defaultRoundDurationSeconds,
      pointsTitle: appConfig.pointsTitle,
      pointsArtist: appConfig.pointsArtist,
    };
    await setDoc(ref, {
      roomId: code,
      joinCode: code,
      hostId,
      status: 'lobby',
      currentRoundIndex: -1,
      currentRoundStartedAt: null,
      revealedTrackId: null,
      createdAt: serverTimestamp(),
      // Échéance de purge : passée cette date, l'hôte supprime la partie au
      // chargement suivant (registre localStorage + deleteRoom, cf. README §5).
      // Sans ça, chaque partie laisse derrière elle son doc room, ses tracks,
      // ses players et leurs réponses — pour toujours. Le champ sert aussi de
      // point d'appui à une politique TTL Firestore, si elle est configurée.
      expiresAt: Timestamp.fromMillis(Date.now() + ROOM_TTL_MS),
      settings,
    });
    return { roomId: code, joinCode: code, settings };
  }
  throw new Error("Impossible de générer un code unique, réessaie.");
}

export async function getRoom(roomId) {
  const snap = await getDoc(roomDoc(roomId));
  return snap.exists() ? snap.data() : null;
}

export async function roomExists(roomId) {
  const snap = await getDoc(roomDoc(roomId));
  return snap.exists();
}

// ===================================================================
// Tracks
// ===================================================================

// Add the enriched tracks (from previews.enrichTracksWithPreviews) to the
// room's tracks subcollection. Only `playable: true` tracks are added —
// the rest are dropped so the round flow stays simple.
export async function addTracksToRoom(roomId, tracks) {
  const playable = tracks.filter(t => t.playable);
  const batch = writeBatch(db);
  playable.forEach((t, idx) => {
    const ref = doc(tracksCol(roomId));
    batch.set(ref, { ...t, order: idx });
  });
  // Also record the total count on the room doc for convenience.
  batch.update(roomDoc(roomId), { totalRounds: playable.length });
  await batch.commit();
  return playable.length;
}

// Fetch all tracks ordered by `order` (host-side use only — players never
// query this collection so they don't see the previewUrl).
export async function fetchRoomTracks(roomId) {
  const q = query(tracksCol(roomId), orderBy('order', 'asc'));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function fetchTrackByOrder(roomId, order) {
  const q = query(tracksCol(roomId), where('order', '==', order), limit(1));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() };
}

// ===================================================================
// Players
// ===================================================================

// A joining player creates (or refreshes) their own player doc.
// Les règles Firestore interdisent au joueur :
//   - de modifier `joinedAt` après création
//   - de toucher au champ `score`
// Donc on distingue 1ère arrivée vs re-join :
//   - 1ère arrivée : setDoc avec name + joinedAt + lastSeen
//   - re-join    : updateDoc qui ne touche que name + lastSeen
export async function joinRoom(roomId, playerId, playerName) {
  const ref = playerDoc(roomId, playerId);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    await updateDoc(ref, {
      name: playerName,
      lastSeen: serverTimestamp(),
    });
  } else {
    await setDoc(ref, {
      name: playerName,
      joinedAt: serverTimestamp(),
      lastSeen: serverTimestamp(),
    });
  }
}

// Écart entre l'horloge de l'appareil et celle du serveur, en millisecondes.
//
// On écrit `lastSeen` avec un serverTimestamp() puis on le relit : la valeur
// obtenue est l'heure du serveur au moment de l'écriture, qu'on compare au
// milieu de la fenêtre locale encadrant l'aller-retour. Une lecture et une
// écriture par session — sans commune mesure avec le battement de cœur qu'on
// a supprimé, et c'est ce qui empêche un téléphone mal réglé de désynchroniser
// le joueur de plusieurs dizaines de secondes.
//
// Renvoie null si la mesure échoue : l'appelant garde alors l'horloge locale.
export async function measureClockOffset(roomId, playerId) {
  try {
    const ref = playerDoc(roomId, playerId);
    const avant = Date.now();
    await updateDoc(ref, { lastSeen: serverTimestamp() });
    const snap = await getDoc(ref);
    const apres = Date.now();
    const serveur = snap.data()?.lastSeen?.toMillis?.();
    if (!serveur) return null;
    return { serverMs: serveur, localMs: (avant + apres) / 2 };
  } catch (e) {
    console.warn('Mesure de l\'écart d\'horloge impossible', e);
    return null;
  }
}

// Quitter une room. Pour ne PAS casser le scoring/scoreboard pendant une
// partie active, on conserve le doc player pendant les statuts "playing",
// "locked" et "reveal" — les règles Firestore refusent d'ailleurs un
// self-delete dans ces statuts. Delete OK uniquement en "lobby" (partie
// pas encore lancée) ou "finished" (partie terminée).
export async function leaveRoom(roomId, playerId) {
  let room;
  try {
    room = await getRoom(roomId);
  } catch (e) {
    console.warn('leaveRoom: getRoom failed', e);
    return;  // safer to not attempt anything than to risk a failed write
  }
  if (!room) return;

  if (room.status === 'lobby' || room.status === 'finished') {
    await deleteDoc(playerDoc(roomId, playerId)).catch(() => {});
  } else {
    // playing / locked / reveal : best-effort touch et on garde le doc
    await updateDoc(playerDoc(roomId, playerId), {
      lastSeen: serverTimestamp(),
    }).catch(() => {});
  }
}

// ===================================================================
// Listeners
// ===================================================================

// Les trois listeners prennent un `onError` OBLIGATOIRE en pratique : sans
// lui, une erreur Firestore (permission-denied après un kick, room supprimée,
// quota atteint) tue le listener en silence et l'écran reste figé sur le
// dernier état reçu. C'est la panne la plus déroutante possible, parce que
// l'app a l'air de fonctionner.
function onSnapshotError(quoi, onError) {
  return (err) => {
    console.error(`Firestore listener "${quoi}" interrompu`, err);
    if (onError) onError(err, quoi);
  };
}

export function listenRoom(roomId, callback, onError) {
  return onSnapshot(roomDoc(roomId), snap => {
    callback(snap.exists() ? snap.data() : null);
  }, onSnapshotError('room', onError));
}

export function listenPlayers(roomId, callback, onError) {
  const q = query(playersCol(roomId), orderBy('joinedAt', 'asc'));
  return onSnapshot(q, snap => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  }, onSnapshotError('players', onError));
}

export function listenAnswers(roomId, roundIndex, callback, onError) {
  const q = query(answersCol(roomId), where('roundIndex', '==', roundIndex));
  return onSnapshot(q, snap => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  }, onSnapshotError('answers', onError));
}

// Lecture ponctuelle (one-shot) des réponses d'un round. Utilisé par le host
// au moment du reveal pour scorer la liste FRAÎCHE de Firestore et pas
// state.answers (qui peut être en retard si une réponse vient d'arriver
// juste avant le lock).
export async function fetchAnswersForRound(roomId, roundIndex) {
  const q = query(answersCol(roomId), where('roundIndex', '==', roundIndex));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ===================================================================
// Game flow
// ===================================================================

export async function startRound(roomId, roundIndex) {
  await updateDoc(roomDoc(roomId), {
    status: 'playing',
    currentRoundIndex: roundIndex,
    currentRoundStartedAt: serverTimestamp(),
    revealedTrackId: null,
  });
}

// Verrouille le round : plus aucune réponse n'est acceptée (côté règles
// Firestore comme côté UI), mais le host peut encore révéler.
export async function lockRound(roomId) {
  await updateDoc(roomDoc(roomId), { status: 'locked' });
}

export async function revealRound(roomId, trackId) {
  await updateDoc(roomDoc(roomId), {
    status: 'reveal',
    revealedTrackId: trackId,
  });
}

export async function endGame(roomId) {
  await updateDoc(roomDoc(roomId), { status: 'finished' });
}

// ===================================================================
// Answers + scoring
// ===================================================================

// Submit a player's answer for the current round.
// Le joueur n'écrit QUE sa réponse brute — pas de score. Le scoring est
// effectué côté host au moment du reveal (cf. scoreRound).
//
// Doc ID déterministe = playerId : un seul answer actif par joueur, remplacé
// à chaque round. Pas d'historique en Firestore, mais surtout pas de
// possibilité de créer plusieurs answers pour gonfler le score.
export async function submitAnswer(roomId, playerId, playerName, roundIndex, answer) {
  const room = await getRoom(roomId);
  if (!room) throw new Error("Room introuvable.");
  if (room.status !== 'playing') throw new Error("Round verrouillé, réponses fermées.");
  if (room.currentRoundIndex !== roundIndex) throw new Error("Round désynchronisé.");

  const payload = {
    playerId,
    playerName,
    roundIndex,
    titleAnswer: (answer.titleAnswer || '').trim(),
    artistAnswer: (answer.artistAnswer || '').trim(),
    submittedAt: serverTimestamp(),
  };
  await setDoc(answerDoc(roomId, playerId), payload, { merge: false });
}

// Score tous les answers d'un round et met à jour les scores cumulés des
// joueurs. Appelée par le host lors du reveal. Idempotente :
//   - on (re)calcule chaque answer
//   - on ajuste le score cumulé par DELTA : nouveauScore - ancienScore
//     (qui sera 0 si déjà scoré, donc pas de double comptage)
//
// `answers` doit être la liste actuelle des docs Firestore du round
// (depuis listenAnswers). Retourne la liste enrichie des answers scorés,
// que le host peut afficher immédiatement sans attendre le re-snapshot
// du listener.
//
// Toutes les writes passent dans un seul writeBatch : soit tout commit,
// soit rien — pas de scoreboard à moitié à jour si la connexion drop.
export async function scoreRound(roomId, roundIndex, track, answers, settings) {
  const scored = [];
  const batch = writeBatch(db);
  for (const ans of answers) {
    const newScores = calculateScore(
      { titleAnswer: ans.titleAnswer, artistAnswer: ans.artistAnswer },
      track,
      settings,
    );
    const previousTotal = ans.totalScore || 0;
    const delta = newScores.totalScore - previousTotal;

    batch.update(doc(answersCol(roomId), ans.id), {
      scoreTitle: newScores.scoreTitle,
      scoreArtist: newScores.scoreArtist,
      totalScore: newScores.totalScore,
    });

    if (delta !== 0) {
      // setDoc(merge:true) plutôt qu'update : tolère un player doc supprimé
      // entre-temps (départ, kick) — on recrée un stub avec juste le score.
      batch.set(playerDoc(roomId, ans.playerId), {
        score: increment(delta),
      }, { merge: true });
    }

    scored.push({ ...ans, ...newScores });
  }
  await batch.commit();
  return scored;
}

// ===================================================================
// Cleanup
// ===================================================================

// Delete a room and all its subcollections (tracks, players, answers).
// Used when the host bails out. Best-effort.
export async function deleteRoom(roomId) {
  const subs = ['tracks', 'players', 'answers'];
  for (const sub of subs) {
    const snap = await getDocs(collection(db, 'rooms', roomId, sub));
    const batch = writeBatch(db);
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit().catch(() => {});
  }
  await deleteDoc(roomDoc(roomId)).catch(() => {});
}

// Re-export for convenience
export { ensureAnonAuth };
// calculateScore vit dans utils.js (fonction pure, testable hors navigateur)
// mais reste exposée ici : c'est l'API que le host connaît.
export { calculateScore };
