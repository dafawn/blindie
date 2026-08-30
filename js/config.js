// === BLINDIE — Configuration ===
// Toute la config statique se trouve dans CE fichier.
// Voir README.md pour le détail des étapes Firebase / Spotify / Netlify.

// --- Firebase (clés publiques, sécurisées par les règles Firestore) ---
export const firebaseConfig = {
  apiKey: "AIzaSyAs0SatWss5oimh4JcoVaW79jRLIkcq3Zs",
  authDomain: "blindie-app.firebaseapp.com",
  projectId: "blindie-app",
  storageBucket: "blindie-app.firebasestorage.app",
  messagingSenderId: "521213406532",
  appId: "1:521213406532:web:9a96a6173637ee96d53b11",
};

// --- Spotify (OAuth 2.0 PKCE — pas de client secret) ---
// Le redirectUri DOIT matcher EXACTEMENT celui enregistré dans le dashboard
// Spotify Developer (incluant le https, le chemin, l'absence ou présence de
// trailing slash).
export const spotifyConfig = {
  clientId: "27e33cf995d94c8480ffbaf09a019ce4",
  redirectUri: "https://blindie.christophe.online/host.html",
  scopes: [
    "playlist-read-private",
    "playlist-read-collaborative",
  ].join(" "),
};

// --- App ---
export const appConfig = {
  baseUrl: "https://blindie.christophe.online",
  defaultRoundDurationSeconds: 30,
  pointsTitle: 1,
  pointsArtist: 1,
  maxRoundsPerGame: 20,
  // Longueur maximale d'un pseudo. Appliquée aux DEUX portes d'entrée
  // (index.html et player.html) — elles divergeaient.
  maxNameLength: 16,
  // Seuil de confiance minimum pour accepter un match iTunes
  // (0..1). Au-dessus, on prend le previewUrl du résultat.
  previewMatchThreshold: 0.65,
  // Seuil au-dessus duquel la réponse d'un joueur est comptée juste (0..1).
  // Voir tools/test-scoring.mjs avant de le bouger : le jeu de tests est
  // calibré sur cette valeur.
  matchThreshold: 0.75,
};

// --- Adaptation automatique à l'adresse servie ---
// L'app répond sous plusieurs origines : le domaine personnalisé,
// l'adresse *.netlify.app, et localhost en développement. Le redirectUri
// et les liens d'invitation se déduisent donc de l'origine courante au
// lieu d'être écrits en dur.
//
// Sans ça, un hôte arrivé par une adresse est renvoyé par Spotify vers une
// AUTRE origine — or le verifier PKCE est rangé en sessionStorage, qui est
// cloisonné par origine. Il est donc introuvable au retour, et la connexion
// échoue sans message clair.
//
// ⚠️ Chaque origine doit être déclarée dans le dashboard Spotify Developer,
//    section Redirect URIs, sous la forme <origine>/host.html
if (typeof window !== 'undefined' && window.location.origin) {
  const origin = window.location.origin;
  spotifyConfig.redirectUri = `${origin}/host.html`;
  appConfig.baseUrl = origin;

  // Une preview de déploiement Netlify a un hostname aléatoire
  // (deploy-preview-42--monsite.netlify.app, branche--monsite.netlify.app).
  // Impossible de la déclarer à l'avance dans le dashboard Spotify : la
  // connexion y échouera forcément. On le signale plutôt que de laisser
  // l'hôte face à un "INVALID_CLIENT" sans explication.
  spotifyConfig.isDeployPreview = /--.*\.netlify\.app$/.test(window.location.hostname);
}
