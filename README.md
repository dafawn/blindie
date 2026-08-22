# BLINDIE

Web app privée de blind test entre potes (parties à distance via Discord). **Stack 100 % statique** (HTML/CSS/JS vanilla, ES modules) hébergée sur Netlify. **Aucun serveur backend.**

- Le **host** se connecte à Spotify pour importer une **playlist** (uniquement les métadonnées : titre, artiste, pochette).
- L'app cherche un **extrait audio de 30 s sur iTunes** (Apple Search API) pour chaque morceau. Aucune dépendance à Spotify Premium ou au Web Playback SDK.
- Les joueurs rejoignent via un **code à 6 caractères** (généré crypto) ou une URL `?code=ABC123` depuis leur téléphone.
- L'**audio joue sur le host ET sur chaque joueur** (parties à distance Discord). Un seul clic "Activer le son" est requis dans le lobby pour débloquer la lecture sur mobile.
- Le **scoring est calculé côté host** au moment du reveal (matching fuzzy : accents, ponctuation, "feat. / remastered" tolérés). Les joueurs n'écrivent jamais de score.
- Le **temps réel** passe par **Firebase Firestore** (+ Auth anonyme).
- Le **timer verrouille** automatiquement les réponses à 0 s : la room passe en status `locked`, les inputs joueurs se ferment, le host clique "Révéler" pour scorer et afficher la bonne réponse.

---

## Sommaire

1. [Configuration Firebase](#1-configuration-firebase)
2. [Configuration Spotify Developer](#2-configuration-spotify-developer)
3. [Déploiement Netlify](#3-déploiement-netlify)
4. [Exemple `js/config.js`](#4-exemple-jsconfigjs)
5. [Règles Firestore (production)](#5-règles-firestore-production)
6. [Lancer en local](#6-lancer-en-local)
7. [Architecture des fichiers](#7-architecture-des-fichiers)
8. [Modèle Firestore](#8-modèle-firestore)
9. [Modèle de sécurité](#9-modèle-de-sécurité)
10. [Limites connues](#10-limites-connues)
11. [Plan d'amélioration](#11-plan-damélioration)

---

## 1. Configuration Firebase

1. Va sur https://console.firebase.google.com → **Add project** → nom : `Blindie`.
2. **Build → Firestore Database → Create database** :
   - Édition : **Standard**
   - Location : `eur3 (europe-west)` ou plus proche
   - Démarre en **Production mode** — on déploiera nos propres règles (cf. §5).
3. **Build → Authentication → Sign-in method → Anonymous → Enable**.
4. **Project Settings → Your apps → Web (`</>`)** → enregistre l'app "Blindie Web" → copie l'objet `firebaseConfig`.
5. Colle-le dans [`js/config.js`](js/config.js) (bloc `firebaseConfig`).
6. Pousse les règles Firestore versionnées (cf. §5) :
   - Soit via **Firebase Console → Firestore → Rules** : copier-coller le contenu de [`firestore.rules`](firestore.rules) puis **Publier**.
   - Soit via Firebase CLI : `firebase deploy --only firestore:rules`.

> Les clés Firebase web sont **publiques** par nature — la sécurité repose entièrement sur les règles Firestore + Auth anonyme.

---

## 2. Configuration Spotify Developer

1. Va sur https://developer.spotify.com/dashboard.
2. **Create app** :
   - Name : `Blindie`
   - **APIs used** : cocher **Web API** uniquement (ne PAS cocher Web Playback SDK).
   - **Redirect URIs** (ajouter les deux) :
     - `http://127.0.0.1:5500/host.html` (dev local)
     - `https://blindie.christophe.online/host.html` (prod) — remplace par ta propre URL Netlify
3. Save → copie le **Client ID** (pas besoin du secret, on utilise PKCE + state).
4. Colle le Client ID dans [`js/config.js`](js/config.js) (`spotifyConfig.clientId`) et adapte `redirectUri` à ton URL Netlify.

> **Mode "Development"** : par défaut ton app Spotify est privée. Ajoute ton Spotify user dans **User Management** du dashboard (le développeur lui-même n'est pas auto-enrolled selon les comptes). Voir aussi §10 sur les comportements connus de l'API en dev mode.

---

## 3. Déploiement Netlify

GitHub Pages ne supporte pas les repos privés en plan free → on utilise Netlify.

1. https://app.netlify.com → **Add new project → Import an existing project → Deploy with GitHub**.
2. Sélectionne le repo `Adviseo/blindie`.
3. Build settings :
   - **Branch to deploy** : `main`
   - **Build command** : *(vide)*
   - **Publish directory** : `.` (laisse la valeur par défaut, repris depuis [`netlify.toml`](netlify.toml))
4. **Deploy site**.
5. (Optionnel) **Site settings → Change site name** → mets un slug stable (ex. `blindie-app`).

Le fichier [`netlify.toml`](netlify.toml) configure les **headers de sécurité** appliqués automatiquement :

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy` désactive caméra/micro/géoloc et opt-out FLoC/Topics.
- **CSP** restrictive : autorise uniquement les domaines nécessaires (gstatic Firebase, accounts/api Spotify, iTunes, fonts Google, CDN d'images Spotify/iTunes).

> Pour debug une CSP qui casse en prod, bascule temporairement la directive en `Content-Security-Policy-Report-Only` dans [`netlify.toml`](netlify.toml).

---

## 4. Exemple `js/config.js`

```js
export const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "blindie-app.firebaseapp.com",
  projectId: "blindie-app",
  storageBucket: "blindie-app.firebasestorage.app",
  messagingSenderId: "...",
  appId: "..."
};

export const spotifyConfig = {
  clientId: "<ton client id>",
  redirectUri: "https://blindie.christophe.online/host.html",
  scopes: [
    "playlist-read-private",
    "playlist-read-collaborative",
  ].join(" "),
};

export const appConfig = {
  baseUrl: "https://blindie.christophe.online",
  defaultRoundDurationSeconds: 30,
  pointsTitle: 1,
  pointsArtist: 1,
  maxRoundsPerGame: 20,
  previewMatchThreshold: 0.65,
};
```

> Quand l'app détecte un hostname `127.0.0.1`/`localhost`, elle bascule automatiquement `redirectUri` + `baseUrl` sur l'URL locale — pas besoin de toucher `config.js` pour tester.

---

## 5. Règles Firestore (production)

Les règles sont versionnées dans [`firestore.rules`](firestore.rules). Résumé :

- **Auth anonyme obligatoire** sur tout.
- **Lectures séparées en `get` et `list`** : aucune collection n'est listable globalement. `list` est restreint au host de la room ou aux participants (utilisateurs qui ont un doc dans `rooms/{roomId}/players`).
- **`rooms/{roomId}`** :
  - `get` : tout utilisateur authentifié (nécessaire pour `roomExists(code)` avant join, et pour les listeners).
  - `list` : **interdit** — personne ne peut énumérer toutes les rooms existantes.
  - `create` : exige `hostId == request.auth.uid` et `status == "lobby"`.
  - `update` / `delete` : host de la room seul.
- **`rooms/{roomId}/tracks/{trackId}`** :
  - `get` / `list` : host ou participant de cette room (nécessaire pour player.js qui query `where('order', '==', N)`).
  - Écriture (`create`/`update`/`delete`) : host seul.
- **`rooms/{roomId}/players/{playerId}`** :
  - `playerId` doit être l'`uid` Auth du joueur.
  - `get` / `list` : host ou participant de la room.
  - À la création, le joueur écrit `name`, `joinedAt`, `lastSeen`.
  - En update, le joueur ne peut modifier QUE `name` et `lastSeen` (via `diff().affectedKeys().hasOnly(...)`) — donc `joinedAt` est figé après création et `score` reste **interdit** au joueur.
  - Le host peut créer/modifier (utile pour `updatePlayerScore` qui tolère un doc supprimé en recréant un stub).
  - **Self-delete** : autorisé uniquement quand `status == "lobby"` ou `"finished"`. Pendant un round (`playing`/`locked`/`reveal`), le delete est refusé pour préserver le scoring/scoreboard. Le host garde toujours le droit de delete (kick).
- **`rooms/{roomId}/answers/{answerId}`** :
  - `answerId` DOIT être l'`uid` Auth du joueur → **un seul doc answer actif par joueur**, remplacé à chaque round (empêche les doublons qui gonfleraient le score).
  - `get` / `list` : host ou participant de la room.
  - Pas d'historique des réponses passées en Firestore.
  - Le joueur écrit uniquement `playerId, playerName, roundIndex, titleAnswer, artistAnswer, submittedAt`, et **uniquement** quand `room.status == "playing"` et que `roundIndex == currentRoundIndex`.
  - Les champs `scoreTitle, scoreArtist, totalScore` sont écrits **par le host** au reveal à partir d'un re-fetch frais de Firestore (pas du listener qui peut être en retard).

---

## 6. Lancer en local

Spotify exige une redirect URI en `https://...` **ou** sur `127.0.0.1`. On utilise un serveur statique sur le port `5500`.

**Option A — VS Code Live Server**
1. Installe l'extension "Live Server" (Ritwick Dey).
2. Ouvre `D:\Claude\Blindie` dans VS Code.
3. Clic droit sur `index.html` → **Open with Live Server**.
4. L'app s'ouvre sur `http://127.0.0.1:5500/`.

**Option B — Python**
```bash
python -m http.server 5500 --bind 127.0.0.1
```

**Option C — npx**
```bash
npx serve -l 5500
```

---

## 7. Architecture des fichiers

```
/index.html              Landing (Créer / Rejoindre)
/host.html               Vue host (PC/TV)
/player.html             Vue joueur (téléphone)
/css/styles.css          Design néon sombre
/firestore.rules         Règles Firestore versionnées (cf. §5)
/netlify.toml            Build config + headers sécurité
/js/config.js            ⚠ À REMPLIR (Firebase, Spotify, app)
/js/firebase.js          Init Firebase + Auth anonyme
/js/spotify.js           OAuth PKCE + state CSRF + lecture playlist
/js/previews.js          iTunes Search API (+ stub Deezer)
/js/room.js              Logique room/game sur Firestore
/js/utils.js             Normalisation, fuzzy match, safeImageUrl, codes 6c
/js/host.js              Logique host (flow complet, scoring au reveal)
/js/player.js            Logique joueur (téléphone)
/README.md               Ce fichier
/.gitignore
```

## 8. Modèle Firestore

```
rooms/{roomId}
  roomId, joinCode, hostId,
  status: "lobby" | "playing" | "locked" | "reveal" | "finished",
  currentRoundIndex, currentRoundStartedAt, revealedTrackId,
  createdAt, totalRounds,
  settings: { roundDurationSeconds, pointsTitle, pointsArtist }

rooms/{roomId}/tracks/{trackId}
  order, spotifyId, title, artists[], album, imageUrl,
  previewUrl, source: "itunes", playable,
  normalizedTitle, normalizedArtists[]

rooms/{roomId}/players/{playerId}   (playerId == uid Auth)
  name, joinedAt, lastSeen, score (écrit par le host uniquement)

rooms/{roomId}/answers/{answerId}   (answerId == uid Auth ; 1 doc/joueur)
  playerId, playerName, roundIndex,
  titleAnswer, artistAnswer, submittedAt,
  scoreTitle, scoreArtist, totalScore  (écrits par le host au reveal)
```

---

## 9. Modèle de sécurité

Ce qui est défendu :

- **Manipulation du score côté joueur** : règles Firestore restreignent les champs écrivables par le joueur (`score` interdit sur `players`, champs `score*` interdits sur `answers`).
- **Doublons d'answers** : `answerId == uid` impose 1 seul doc actif par joueur — impossible de spammer plusieurs answers pour gonfler le score.
- **Réponse après expiration du timer** : transition automatique vers status `locked` à 0 s. Toute écriture d'answer est rejetée côté règles (status check) ET côté code (`submitAnswer` vérifie aussi).
- **Sabotage du scoreboard** : `delete` du player doc par le joueur autorisé uniquement en `lobby`/`finished` — refusé pendant un round actif (le doc reste, son score est préservé).
- **Énumération de la base** : `list` désactivé sur `rooms` (personne ne peut découvrir les rooms existantes) ; `list` des sous-collections restreint aux participants/host de la room concernée.
- **Détournement OAuth Spotify** : flow PKCE + paramètre `state` aléatoire vérifié au callback.
- **Injection XSS via URL externe** : toutes les images injectées via `innerHTML` passent par `safeImageUrl()` qui exige une URL `https://` parsable. `javascript:`, `data:`, `blob:`, `http:` sont rejetés.
- **Headers sécurité** : nosniff, no-frame, CSP restrictive, permissions-policy.

Ce qui n'est PAS défendu (compromis assumés vu le contexte privé) :

- Les `previewUrl` iTunes sont stockés dans Firestore : un participant légitime peut inspecter le DOM/Firestore et voir l'URL ou les titres/artistes. Pas d'anti-triche compétitif — Blindie est un jeu entre potes.
- Un participant peut lire toutes les réponses/players de SA room (utile pour le scoreboard, mais pas une preuve d'identité forte).

---

## 10. Limites connues

- **Spotify Web API en Development mode** (nov. 2024) : la réponse de `/playlists/{id}` est partiellement strippée — les clés `tracks` et `track` sont renommées en `items` et `item`. Le code gère les deux. `/playlists/{id}/tracks` renvoie un 403 et est contourné via l'embedding.
- **Playlists éditoriales Spotify** (préfixe `37i9dQZF1...`) inaccessibles aux apps en Development mode depuis nov. 2024. Utilise une playlist user-créée.
- **iTunes ≠ Spotify** : l'extrait joué peut être une version (live/remaster) du même morceau. Imperceptible 95 % du temps.
- **Previews iTunes manquantes** : certains morceaux n'ont pas d'aperçu Apple — ils sont marqués "pas de preview" et exclus du jeu.
- **Autoplay audio mobile** : iOS/Android bloquent l'audio sans interaction. Un bouton "Activer le son" dans le lobby (et fallback en cas de late-join) débloque la session.
- **CORS Deezer** : le fallback Deezer reste un stub (CORS bloque les appels directs). Brancher via un proxy serverless si besoin.

---

## 11. Plan d'amélioration

- [ ] Tests d'intégration Firestore via émulateur (`firebase emulators:start`)
- [ ] CSP avec nonces au lieu de `'unsafe-inline'`
- [ ] Bonus de rapidité au premier à trouver
- [ ] Choix de la durée du round dans l'UI host
- [ ] Reveal automatique X secondes après la fin du timer
- [ ] PWA installable (manifest + service worker)
- [ ] Deezer fallback via Cloudflare Worker
- [ ] Animation de confettis sur bonne réponse
- [ ] Sound effects host (countdown, reveal)
- [ ] Rate-limit côté Firestore via Cloud Functions si l'app s'ouvre au public
