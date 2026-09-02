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

// Transport Firestore : long-polling forcé, requêtes de 5 secondes.
//
// Le flux temps réel de Firestore est une requête HTTP longue que le serveur
// tient ouverte et dans laquelle il pousse les mises à jour au fil de l'eau.
// Certains intermédiaires — proxy d'entreprise, antivirus qui inspecte le
// trafic, VPN, réseau mobile — TAMPONNENT la réponse : ils n'en livrent le
// contenu au navigateur qu'une fois la requête terminée. Or le serveur ne la
// termine qu'à l'expiration de son timeout de long-polling, qui vaut 30 s par
// défaut. Résultat observé chez nous : un round démarré par l'hôte s'affiche
// chez le joueur 30 s plus tard, une simple lecture reste suspendue 30 s, et
// « tout est lent » — toujours du même ordre de grandeur.
//
// La détection automatique du SDK (active par défaut) est censée repérer ce
// cas ; elle ne l'a pas fait ici. On force donc le long-polling et on ramène
// la durée de chaque requête à 5 s, le minimum accepté : un intermédiaire qui
// tamponne ne peut plus retenir une mise à jour au-delà de 5 s. Le coût est
// quelques requêtes HTTP de plus par minute — négligeable pour une partie
// entre amis.
//
// Force et auto-détection s'excluent : le SDK refuse qu'on passe les deux.
// Le tout est protégé : si ce build ne connaît pas ces options ou les
// rejette, on retombe sur la configuration par défaut plutôt que de casser
// le chargement de l'application.
export const db = (() => {
  try {
    if (typeof fs.initializeFirestore === 'function') {
      return fs.initializeFirestore(app, {
        experimentalForceLongPolling: true,
        experimentalLongPollingOptions: { timeoutSeconds: 5 },
      });
    }
  } catch (e) {
    console.warn('Réglage du transport Firestore refusé, configuration par défaut', e);
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
