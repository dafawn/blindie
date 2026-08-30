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
7. **Active la purge automatique des rooms** — sinon chaque partie laisse
   derrière elle son doc room, ses tracks et ses players, pour toujours :
   **Firestore Database → Time-to-live → Create policy**
   - Collection group : `rooms`
   - Timestamp field : `expiresAt`

   Le champ `expiresAt` est écrit à la création de la room (createdAt + 24 h,
   cf. `ROOM_TTL_MS` dans [`js/room.js`](js/room.js)). Firestore supprime le
   document dans les 24 h qui suivent l'échéance. Les sous-collections
   (`tracks`, `players`, `answers`) ne sont PAS supprimées par le TTL : le
   bouton « Annuler » du lobby appelle `deleteRoom()` qui, lui, fait le ménage
   complet.

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
2. Sélectionne le repo `dafawn/blindie`.
3. Build settings :
   - **Branch to deploy** : `main`
   - **Build command** : *(vide)*
   - **Publish directory** : `.` (laisse la valeur par défaut, repris depuis [`netlify.toml`](netlify.toml))
4. **Deploy site**.
5. (Optionnel) **Site settings → Change site name** → mets un slug stable (ex. `blindie-app`).

Le fichier [`netlify.toml`](netlify.toml) configure les **headers de sécurité** appliqués automatiquement :

- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
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
  maxNameLength: 16,
  previewMatchThreshold: 0.65,   // seuil d'acceptation d'un match iTunes
  matchThreshold: 0.75,          // seuil au-dessus duquel une réponse est juste
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
/firebase.json           Déclare firestore.rules pour `firebase deploy`
/.firebaserc             Projet Firebase par défaut (blindie-app)
/netlify.toml            Build config + headers sécurité
/manifest.webmanifest    Manifest PWA (icônes, couleurs, display)
/js/config.js            Config Firebase, Spotify, app (clés publiques)
/js/firebase.js          Init Firebase + Auth anonyme
/js/spotify.js           OAuth PKCE + state CSRF + lecture playlist
/js/previews.js          iTunes Search API (+ stub Deezer)
/js/room.js              Logique room/game sur Firestore
/js/utils.js             Normalisation, scoring, mélange, safeImageUrl, codes 6c
/js/host.js              Logique host (flow complet, scoring au reveal)
/js/player.js            Logique joueur (téléphone)
/tools/test-scoring.mjs  Banc de test du moteur de score (`node tools/test-scoring.mjs`)
/tools/generate-icons.mjs  icon.svg → PNG + favicon.ico (nécessite sharp)
/icon.svg /favicon.svg   Sources des icônes
/favicon.ico /icon-192.png /icon-512.png /apple-touch-icon.png
/og-image.jpg            Image de partage (1200×630)
/silence.wav             Fichier muet servant à débloquer l'audio sur mobile
/AUDIT.md                Rapport d'audit (août 2026) et suites données
/README.md               Ce fichier
/.gitignore
```

### Lancer les tests

Le moteur de score est la seule partie du code couverte par des tests — c'est
aussi la seule où un bug est invisible pendant la partie et fausse le
classement. Aucune dépendance à installer :

```bash
node tools/test-scoring.mjs
```

## 8. Modèle Firestore

```
rooms/{roomId}
  roomId, joinCode, hostId,
  status: "lobby" | "playing" | "locked" | "reveal" | "finished",
  currentRoundIndex, currentRoundStartedAt, revealedTrackId,
  createdAt, expiresAt (purge TTL, cf. §1.7), totalRounds,
  settings: { roundDurationSeconds, pointsTitle, pointsArtist }
  → le host lit la durée et le barème DANS settings, pas dans appConfig :
    sinon son horloge et celle des joueurs divergent.

rooms/{roomId}/tracks/{trackId}
  order, title, artists[], imageUrl, previewUrl, trackViewUrl, playable
  → uniquement les champs réellement relus. Les champs de diagnostic de la
    recherche iTunes (confidence, matchedTrackName…) restent en mémoire côté
    host et ne sont plus écrits.

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
- **Fautes de frappe sur un mot unique** : le scoring refuse « afrika » pour
  *Africa*, parce qu'il ne peut pas le distinguer de « creepy » pour *Creep*.
  Sur un titre d'un seul mot, une faute et une mauvaise réponse sont à la même
  distance ; on préfère refuser les deux (un point volé fausse le classement,
  un point refusé se conteste à voix haute). Cas figés dans
  `tools/test-scoring.mjs`.
- **Previews de déploiement Netlify** : l'URL d'une preview est aléatoire et ne
  peut pas être déclarée dans le dashboard Spotify. La connexion Spotify y
  échouera. Utilise `127.0.0.1:5500` en local ou le domaine de production.

---

## 11. Plan d'amélioration

Fait (audit d'août 2026, cf. [`AUDIT.md`](AUDIT.md)) :

- [x] Session host en `localStorage` — fermer l'onglet ne perd plus la partie
- [x] Mélange de la playlist avant l'écrêtage — deux parties ne sont plus identiques
- [x] Moteur de score repris, avec un banc de test (`tools/test-scoring.mjs`)
- [x] Gestionnaires d'erreur sur tous les listeners Firestore
- [x] Timer host ancré sur une date, plus de dérive en onglet inactif
- [x] Suppression du heartbeat `lastSeen` (77 % des lectures Firestore, champ jamais lu)
- [x] Purge automatique des rooms via TTL Firestore (cf. §1.7)
- [x] Libellés de formulaire, contrastes WCAG AA, `prefers-reduced-motion`
- [x] Manifest PWA (icônes `any` + `maskable` séparées)

Reste à faire :

- [ ] Tests d'intégration Firestore via émulateur (`firebase emulators:start`)
- [ ] CSP avec nonces au lieu de `'unsafe-inline'`
- [ ] Service worker (le manifest existe, mais l'app n'est pas installable hors ligne)
- [ ] Wake Lock pendant les rounds — l'écran du téléphone s'éteint pendant l'écoute
- [ ] Le host n'écoute pas le doc room : deux onglets host pilotent deux parties
- [ ] Bornes de taille sur `name` / `titleAnswer` / `artistAnswer` dans les règles
- [ ] Bonus de rapidité au premier à trouver
- [ ] Choix de la durée du round dans l'UI host
- [ ] Reveal automatique X secondes après la fin du timer
- [ ] Deezer fallback via Cloudflare Worker
- [ ] Animation de confettis sur bonne réponse
- [ ] Sound effects host (countdown, reveal)
- [ ] Rate-limit côté Firestore via Cloud Functions si l'app s'ouvre au public
