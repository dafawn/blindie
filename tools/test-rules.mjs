// Tests des règles Firestore, contre l'émulateur.
//
//   npx firebase-tools emulators:exec --only firestore \
//     "node --experimental-vm-modules tools/test-rules.mjs"
//
// Nécessite une fois : npm i --no-save @firebase/rules-unit-testing firebase
//
// Ce que ces tests protègent, c'est le modèle anti-triche : un joueur ne doit
// jamais pouvoir s'écrire de points, répondre après le verrou, ni dépasser les
// bornes de taille. Ce sont des invariants de règles — invisibles depuis le
// code client, et silencieusement cassables à la prochaine retouche.

import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, setDoc, updateDoc, deleteDoc, getDoc, getDocs, collection, serverTimestamp,
} from 'firebase/firestore';

const HOST = 'host-uid';
const ALICE = 'alice-uid';
const BOB = 'bob-uid';
const ROOM = 'ABC123';

const env = await initializeTestEnvironment({
  projectId: 'blindie-test',
  firestore: {
    rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'),
    host: '127.0.0.1',
    port: 8080,
  },
});

let ok = 0;
const echecs = [];

async function cas(nom, fn) {
  try { await fn(); ok++; }
  catch (e) { echecs.push({ nom, err: e.message.split('\n')[0] }); }
}

const db = (uid) => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();

// État de départ : une room appartenant à HOST, Alice et Bob inscrits.
async function seed(status = 'lobby', currentRoundIndex = 0) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, 'rooms', ROOM), {
      roomId: ROOM, joinCode: ROOM, hostId: HOST, status,
      currentRoundIndex, currentRoundStartedAt: null, revealedTrackId: null,
      totalRounds: 3, settings: { roundDurationSeconds: 30, pointsTitle: 1, pointsArtist: 1 },
    });
    await setDoc(doc(d, 'rooms', ROOM, 'players', ALICE), { name: 'Alice', score: 5 });
    await setDoc(doc(d, 'rooms', ROOM, 'players', BOB), { name: 'Bob', score: 2 });
    await setDoc(doc(d, 'rooms', ROOM, 'tracks', 't1'), { order: 0, title: 'Africa', artists: ['Toto'] });
  });
}

const reponse = (extra = {}) => ({
  playerId: ALICE, playerName: 'Alice', roundIndex: 0,
  titleAnswer: 'Africa', artistAnswer: 'Toto', submittedAt: serverTimestamp(), ...extra,
});

// ---------------------------------------------------------------------------
// Le cœur du modèle : un joueur ne s'écrit jamais de points
// ---------------------------------------------------------------------------
await seed('playing');
await cas("un joueur ne peut pas s'attribuer un score", () =>
  assertFails(updateDoc(doc(db(ALICE), 'rooms', ROOM, 'players', ALICE), { score: 999 })));

await cas("un joueur ne peut pas modifier le score d'un autre", () =>
  assertFails(updateDoc(doc(db(ALICE), 'rooms', ROOM, 'players', BOB), { score: 0 })));

await cas("un joueur ne peut pas écrire un champ score dans sa réponse", () =>
  assertFails(setDoc(doc(db(ALICE), 'rooms', ROOM, 'answers', ALICE),
    reponse({ totalScore: 2, scoreTitle: 1, scoreArtist: 1 }))));

await cas("un joueur ne peut pas écrire la réponse d'un autre", () =>
  assertFails(setDoc(doc(db(ALICE), 'rooms', ROOM, 'answers', BOB), reponse({ playerId: BOB }))));

await cas("un joueur ne peut pas se déclarer host", () =>
  assertFails(updateDoc(doc(db(ALICE), 'rooms', ROOM), { hostId: ALICE })));

await cas("un joueur ne peut pas changer le statut de la room", () =>
  assertFails(updateDoc(doc(db(ALICE), 'rooms', ROOM), { status: 'reveal' })));

await cas("un joueur ne peut pas écrire dans tracks", () =>
  assertFails(setDoc(doc(db(ALICE), 'rooms', ROOM, 'tracks', 't2'), { order: 1, title: 'x' })));

await cas("le host peut écrire le score d'un joueur", () =>
  assertSucceeds(setDoc(doc(db(HOST), 'rooms', ROOM, 'players', ALICE),
    { score: 7 }, { merge: true })));

// ---------------------------------------------------------------------------
// Fenêtre de réponse
// ---------------------------------------------------------------------------
await cas("un joueur peut répondre pendant 'playing'", () =>
  assertSucceeds(setDoc(doc(db(ALICE), 'rooms', ROOM, 'answers', ALICE), reponse())));

await cas("un joueur ne peut pas répondre pour un autre round", () =>
  assertFails(setDoc(doc(db(ALICE), 'rooms', ROOM, 'answers', ALICE), reponse({ roundIndex: 1 }))));

await seed('locked');
await cas("un joueur ne peut plus répondre une fois verrouillé", () =>
  assertFails(setDoc(doc(db(ALICE), 'rooms', ROOM, 'answers', ALICE), reponse())));

await seed('reveal');
await cas("un joueur ne peut pas répondre pendant le reveal", () =>
  assertFails(setDoc(doc(db(ALICE), 'rooms', ROOM, 'answers', ALICE), reponse())));

// ---------------------------------------------------------------------------
// Bornes de taille et de type (ajoutées à l'audit d'août 2026)
// ---------------------------------------------------------------------------
await seed('playing');
const long = 'x'.repeat(5000);

await cas("un pseudo démesuré est refusé", () =>
  assertFails(updateDoc(doc(db(ALICE), 'rooms', ROOM, 'players', ALICE), { name: long })));

await cas("un pseudo vide est refusé", () =>
  assertFails(updateDoc(doc(db(ALICE), 'rooms', ROOM, 'players', ALICE), { name: '' })));

await cas("un pseudo normal est accepté", () =>
  assertSucceeds(updateDoc(doc(db(ALICE), 'rooms', ROOM, 'players', ALICE), { name: 'Alicia' })));

await cas("une réponse démesurée est refusée", () =>
  assertFails(setDoc(doc(db(ALICE), 'rooms', ROOM, 'answers', ALICE),
    reponse({ titleAnswer: long }))));

await cas("un roundIndex non entier est refusé", () =>
  assertFails(setDoc(doc(db(ALICE), 'rooms', ROOM, 'answers', ALICE),
    reponse({ roundIndex: 'zéro' }))));

await cas("un roundIndex négatif est refusé", () =>
  assertFails(setDoc(doc(db(ALICE), 'rooms', ROOM, 'answers', ALICE),
    reponse({ roundIndex: -1 }))));

// ---------------------------------------------------------------------------
// Lecture, énumération, participation
// ---------------------------------------------------------------------------
await cas("personne ne peut lister les rooms", () =>
  assertFails(getDocs(collection(db(ALICE), 'rooms'))));

await cas("un non-authentifié ne lit rien", () =>
  assertFails(getDoc(doc(anon(), 'rooms', ROOM))));

await cas("un authentifié peut lire une room par son code", () =>
  assertSucceeds(getDoc(doc(db(ALICE), 'rooms', ROOM))));

await cas("un non-participant ne peut pas lister les joueurs", () =>
  assertFails(getDocs(collection(db('intrus-uid'), 'rooms', ROOM, 'players'))));

await cas("un non-participant ne peut pas écrire de réponse", () =>
  assertFails(setDoc(doc(db('intrus-uid'), 'rooms', ROOM, 'answers', 'intrus-uid'),
    reponse({ playerId: 'intrus-uid' }))));

await cas("un participant peut lister les joueurs de sa room", () =>
  assertSucceeds(getDocs(collection(db(ALICE), 'rooms', ROOM, 'players'))));

// ---------------------------------------------------------------------------
// Sabotage du scoreboard
// ---------------------------------------------------------------------------
await cas("un joueur ne peut pas se supprimer pendant un round", () =>
  assertFails(deleteDoc(doc(db(ALICE), 'rooms', ROOM, 'players', ALICE))));

await seed('lobby');
await cas("un joueur peut se supprimer dans le lobby", () =>
  assertSucceeds(deleteDoc(doc(db(ALICE), 'rooms', ROOM, 'players', ALICE))));

await seed('playing');
await cas("le host peut exclure un joueur pendant un round", () =>
  assertSucceeds(deleteDoc(doc(db(HOST), 'rooms', ROOM, 'players', ALICE))));

// ---------------------------------------------------------------------------
// Création de room
// ---------------------------------------------------------------------------
await env.clearFirestore();
await cas("on ne peut pas créer une room au nom d'un autre", () =>
  assertFails(setDoc(doc(db(ALICE), 'rooms', 'XYZ789'), {
    roomId: 'XYZ789', joinCode: 'XYZ789', hostId: HOST, status: 'lobby' })));

await cas("on ne peut pas créer une room déjà démarrée", () =>
  assertFails(setDoc(doc(db(ALICE), 'rooms', 'XYZ789'), {
    roomId: 'XYZ789', joinCode: 'XYZ789', hostId: ALICE, status: 'playing' })));

await cas("créer sa propre room en lobby fonctionne", () =>
  assertSucceeds(setDoc(doc(db(ALICE), 'rooms', 'XYZ789'), {
    roomId: 'XYZ789', joinCode: 'XYZ789', hostId: ALICE, status: 'lobby' })));

// ---------------------------------------------------------------------------
await env.cleanup();

const total = ok + echecs.length;
if (!echecs.length) {
  console.log(`✓ ${total}/${total} règles Firestore vérifiées`);
  process.exit(0);
}
console.error(`✗ ${echecs.length} échec(s) sur ${total}\n`);
for (const e of echecs) console.error(`  ${e.nom}\n      ${e.err}`);
process.exit(1);
