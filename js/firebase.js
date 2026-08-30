// Firebase init: Firestore + Anonymous Auth.
// We use the modular SDK loaded from gstatic so the app stays build-free.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
// Import de NAMESPACE et non d'exports nommés : un nom absent ferait échouer
// le module entier au chargement, et donc toute l'application. Ici, un nom
// manquant se lit à l'exécution et se contourne.
import * as fs from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
const { serverTimestamp, Timestamp } = fs;
import {
  getAuth, signInAnonymously, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig } from './config.js';

export const app = initializeApp(firebaseConfig);

// Firestore ouvre par défaut un flux WebChannel. Derrière certains réseaux —
// proxy d'entreprise, VPN, antivirus qui inspecte le trafic, réseau mobile
// filtrant — ce flux s'établit mais ne délivre rien : les écritures partent,
// les snapshots n'arrivent qu'après une bascule tardive en long-polling. Vu
// de l'utilisateur, l'app est simplement "lente", et un round peut mettre
// une demi-minute à s'afficher chez un joueur.
//
// La détection automatique est demandée explicitement, et on lui laisse un
// délai court pour trancher plutôt que d'attendre l'expiration du flux.
export const db = (() => {
  try {
    if (typeof fs.initializeFirestore === 'function') {
      return fs.initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
    }
  } catch (e) {
    console.warn('initializeFirestore indisponible, repli sur getFirestore', e);
  }
  return fs.getFirestore(app);
})();
export const auth = getAuth(app);

// Re-export the few Firestore helpers everyone needs, so other modules
// don't have to remember the long gstatic URL.
export { serverTimestamp, Timestamp };

// === Anonymous auth ===
// Resolves with the Firebase user object (with a stable uid). Used as
// hostId / playerId in the Firestore data model.
let _authPromise = null;
export function ensureAnonAuth() {
  if (_authPromise) return _authPromise;
  _authPromise = new Promise((resolve, reject) => {
    onAuthStateChanged(auth, user => {
      if (user) return resolve(user);
      signInAnonymously(auth).catch(reject);
    });
  });
  return _authPromise;
}

export function currentUid() {
  return auth.currentUser?.uid || null;
}
