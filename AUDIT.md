# Audit Blindie — 30 août 2026

Revue complète des 3 466 lignes de l'app : règles Firestore, flux de partie, moteur de
score, accessibilité, coût, déploiement. Périmètre : les 12 fichiers source,
`firestore.rules`, `netlify.toml`, `manifest.webmanifest`. Base : `main` à `b4c663b`.

Les ratios de contraste, les cas de score et le modèle de coût Firestore ont été **calculés
en exécutant le code du dépôt**, pas estimés.

**Bilan : 2 critiques · 9 majeurs · 23 mineurs · 6 défenses vérifiées comme solides.**

---

## Verdict

Le socle de sécurité est bon et le modèle anti-triche tient : un joueur ne peut pas
s'écrire de points, ni répondre après le verrou, ni créer deux réponses. Règles Firestore,
PKCE et CSP sont faits sérieusement — j'ai essayé de les prendre en défaut sans y arriver.

Les deux problèmes qui comptent sont des problèmes de **jeu** : si l'hôte ferme son onglet,
la partie est définitivement perdue pour tout le monde ; et le moteur de score distribue
des points sur des réponses fausses, de façon reproductible.

---

## Critiques

### 1. L'hôte ferme son onglet : la partie est morte, sans recours
`js/host.js:83, 108`

La reprise de session hôte s'appuie sur `sessionStorage.getItem('blindie.host.roomId')`.
`sessionStorage` survit à un rechargement mais est effacé à la fermeture de l'onglet.
L'hôte n'a alors plus aucun moyen de retrouver sa room : le code n'est nulle part, et
`allow list: if false` sur `rooms` interdit de la retrouver.

Côté joueurs, la room reste bloquée en `playing` pour toujours. Leur timer atteint 0 et
s'arrête, mais rien ne verrouille jamais le round. Ils peuvent même continuer à envoyer
des réponses, puisque les règles n'acceptent les écritures que sur `status == 'playing'`
— précisément l'état figé.

**Correctif** — Passer `HOST_SESSION_KEY` en `localStorage` (une ligne), avec purge sur
`finished`/annulation. En complément : si un joueur voit `playing` depuis plus de
`roundDuration + 60 s` sans changement, afficher « l'hôte semble déconnecté ».

### 2. Le moteur de score accorde des points sur des réponses fausses
`js/utils.js:18, 40, 45` — seuil d'acceptation `0.75` (`js/room.js:257`)

Sortie de l'exécution du code réel :

```
titre attendu          réponse du joueur   score   verdict
──────────────────────────────────────────────────────────────
With or Without You    "live"              1.000   POINT ACCORDÉ
With or Without You    "mix"               1.000   POINT ACCORDÉ
With or Without You    "(nawak)"           1.000   POINT ACCORDÉ
Live Forever           "Forever"           1.000   POINT ACCORDÉ
Live Forever           "forever young"     0.900   POINT ACCORDÉ
Thriller               "thrill"            0.900   POINT ACCORDÉ
Imagine                "imagine dragons"   0.900   POINT ACCORDÉ
Numb                   "number one"        0.900   POINT ACCORDÉ
Africa                 "afric"             0.900   POINT ACCORDÉ
```

Trois défauts se cumulent :

1. **La regex de nettoyage détruit de vrais titres.** `normalizeText` supprime `live`,
   `mix`, `edit`, `version`, et coupe tout ce qui suit `with`. Résultat : `"Live"` → `""`,
   `"Mix"` → `""`, `"With or Without You"` → `""` (le titre commence par « With », donc
   *tout* disparaît), `"Live Forever"` → `"forever"`.
2. **Deux chaînes vides valent un match parfait.** `scoreMatch` commence par
   `if (!a && !b) return 1`. Dès qu'un titre se normalise en vide, n'importe quelle
   réponse qui se normalise aussi en vide rapporte le point plein. Même piège sur le champ
   artiste : *Live* est un vrai groupe, et `scoreMatch("Live", "mix")` renvoie `1.000`.
3. **La règle « sous-chaîne → 0,9 » est trop généreuse.** Quatre caractères communs
   suffisent à dépasser 0,75.

**Correctif** — (a) N'appliquer la suppression des qualificatifs qu'en *fin* de titre et
après un séparateur (`-`, `(`), jamais sur un mot isolé en tête. (b) Remplacer
`if (!a && !b) return 1` par un repli sur la comparaison des chaînes **brutes**.
(c) Conditionner le bonus sous-chaîne à un ratio de longueur
`Math.min(a.length,b.length) / Math.max(...) >= 0.8`. À écrire avec un jeu de tests : c'est
de l'arithmétique de points, ça se régresse vite.

---

## Majeurs

### 3. Aucun listener Firestore n'a de gestionnaire d'erreur
`js/room.js:188, 195, 202` — Les trois `onSnapshot()` n'ont qu'un callback de succès. Sur
`permission-denied`, room supprimée ou quota atteint, le listener meurt en silence et
l'écran du joueur se fige sans message. Ajouter le second callback et remonter à l'UI.

### 4. Un battement de cœur consomme 77 % du budget Firestore, pour un champ jamais lu
`js/player.js:129` — Chaque joueur écrit `lastSeen` toutes les 25 s ; chaque écriture
réveille le listener `listenPlayers` de tous les autres joueurs + celui de l'hôte (coût
quadratique). `lastSeen` n'est lu, affiché ou testé **nulle part** dans les 12 fichiers.

| Partie | Lectures | Écritures | Dont heartbeat | Parties/jour (offre gratuite) |
|---|---:|---:|---:|---:|
| 4 joueurs · 20 min | 2 125 | 519 | 45 % | 23 |
| 8 joueurs · 25 min | 7 301 | 1 051 | 59 % | 6 |
| 8 joueurs · 1 h | 13 349 | 1 723 | **77 %** | **3** |

Modèle dérivé du code (quota gratuit : 50 000 lectures / 20 000 écritures par jour).
Minoré : les `get()`/`exists()` des règles sont eux aussi facturés.

**Correctif** — Supprimer le `setInterval`. Si la présence devient utile, l'implémenter via
Realtime Database (`onDisconnect`), qui est fait pour ça. On passe de 3 à ~13 parties/jour.

### 5. Le timer de l'hôte dérive dès que son onglet passe en arrière-plan
`js/host.js:550` — `startTimer()` décrémente un compteur dans `setInterval(…, 1000)`, bridé
par le navigateur en onglet inactif. Les joueurs, eux, calculent depuis
`currentRoundStartedAt`, horodatage serveur (`js/player.js:311`). Les deux horloges
divergent. **Correctif** : aligner l'hôte sur la méthode déjà écrite dans `player.js`,
remontée dans un helper partagé.

### 6. Un double-clic sur « Round suivant » saute un morceau
`js/host.js:698` — `state.roundIndex++` puis `await playRound()`, sans jamais désactiver le
bouton. Deux clics rapides incrémentent deux fois. Même exposition sur `btn-start-game`
(`js/host.js:384`). **Correctif** : `disabled = true` en entrée, réactivation en `finally`
— le motif déjà appliqué correctement sur `btn-stop-audio`.

### 7. Le bouton principal échoue au contraste minimum
`css/styles.css:189`

| Élément | Couleurs | Ratio | Exigé | |
|---|---|---:|---:|---|
| Bouton principal | `#fff` / `#ff2e9a` | 3,44:1 | 4,5:1 | échec |
| Bouton principal (fin de dégradé) | `#fff` / `#b14aed` | 4,14:1 | 4,5:1 | échec |
| Bouton Spotify | `#fff` / `#1db954` | 2,59:1 | 4,5:1 | échec |
| Placeholders (= les seuls libellés) | `rgba(184,168,212,.5)` | 2,94:1 | 4,5:1 | échec |
| Puces `.tag` | `#b14aed` / violet 25 % | 3,41:1 | 4,5:1 | échec |
| Pied de page + son lien | `rgba(184,168,212,.45)` | 2,62:1 | 4,5:1 | échec |
| Texte `.muted` | `#b8a8d4` / `#0a0118` | 10,1:1 | 4,5:1 | OK |
| Code de room | `#00f0ff` / `#0a0118` | 14,6:1 | 4,5:1 | OK |

Le néon tient globalement : ce sont les surfaces **colorées avec texte blanc** qui
décrochent, pas le texte sur fond sombre. **Correctif** : assombrir les fonds
(`#d1177c` → `#8a2fd0` donne 5,1:1 avec du blanc) ou passer le texte sur encre sombre,
comme le fait déjà `.btn-secondary`.

### 8. Aucun champ du site n'a de libellé
`index.html:52`, `player.html:43`, `host.html:53` — Pas un seul `<label>` ni `aria-label`
dans les trois pages. Les six champs n'ont qu'un `placeholder` : un lecteur d'écran annonce
« zone d'édition » sans dire laquelle ; le libellé disparaît à la première frappe ; et il
s'affiche à 2,94:1. Par ailleurs, sur `host.html` et `player.html` le seul `<h1>` est
enfermé dans la section « podium », masquée pendant toute la partie.

### 9. Le timer tremble en boucle et rien ne respecte `prefers-reduced-motion`
`css/styles.css:436` — `shake 0.3s linear infinite` pendant les 5 dernières secondes de
chaque round, 20 fois par partie. Plus quatre autres animations infinies (`logoPulse`,
`mysteryFloat`, `buzzerPulse`, `spin`). Aucun bloc `@media (prefers-reduced-motion: reduce)`
dans la feuille. **Correctif** : cinq lignes en fin de feuille, et remplacer le tremblement
par un changement de couleur.

### 10. L'hôte n'écoute jamais le document room
`js/host.js:18–23` — `listenRoom` n'est pas importé. L'hôte pilote depuis son état local et
ne relit jamais la vérité serveur. Si `lockRound` échoue — son `catch` se contente d'un
`console.warn` (`js/host.js:566`) — son écran continue pendant que les joueurs restent
bloqués. Deux onglets hôte pilotent deux parties concurrentes sur les mêmes données.

### 11. Aucune room n'est jamais supprimée
`js/room.js:350` — `deleteRoom()` n'est appelé que depuis « Annuler » du lobby. Une partie
menée au podium, ou un hôte qui ferme son onglet, laissent le document room, jusqu'à 20
documents `tracks` et un document par joueur — définitivement. Ni TTL, ni ménage, ni moyen
de lister ce qui traîne. **Correctif** : politique TTL Firestore sur un champ `expiresAt`
(createdAt + 24 h) posé à la création — natif, gratuit, couvre aussi les rooms abandonnées.

### 12. Rejouer la même playlist donne exactement la même partie
`js/host.js:257, 304` — Aucun mélange nulle part. `candidates` prend les 40 premiers
morceaux, `addTracksToRoom` réassigne `order` dans l'ordre d'arrivée (`js/room.js:86`), et
l'écrêtage à 20 supprime les *derniers*. Une playlist de 200 titres ne fera jamais jouer
que ses 20 premiers, toujours dans le même ordre. **Correctif** : Fisher-Yates avec
`crypto.getRandomValues` avant l'écrêtage — trois lignes, et probablement l'amélioration de
jeu la plus rentable de la liste.

---

## Mineurs

### Accessibilité et interface
- **Couleur seule pour le résultat** (`css/styles.css:457`) : `.answer-row.correct/.partial/.wrong`
  ne diffèrent que par une bordure et une teinte. Ajouter une icône ou un mot.
- **Copie au clic inaccessible au clavier** (`js/host.js:758, 763`) : `#room-code` (`<div>`)
  et `#join-url` (`<code>`) portent un `click` sans `tabindex`, `role="button"` ni gestion
  d'<kbd>Entrée</kbd>.
- **Rien n'est annoncé aux lecteurs d'écran** : ni décompte, ni round suivant, ni reveal, ni
  erreurs n'ont d'`aria-live`. Bon dosage : `role="status"` sur les messages, et *pas* sur
  le timer.
- **Le focus ne bouge jamais** au passage lobby → round.
- **`min-height: 100vh` sans repli `dvh`** (`css/styles.css:38, 91`) : sur Safari iOS la
  barre d'URL rogne le bas.
- **Pas de Wake Lock** : l'écran s'éteint pendant les 30 s d'écoute.
- **`host.html:5` oublie `viewport-fit=cover`**, présent sur les deux autres pages.

### Robustesse et cas limites
- **Usurpation de nom dans la liste des réponses** (`firestore.rules:166`) : `playerName`
  est libre sur les `answers` et l'hôte l'affiche tel quel. Afficher le nom depuis le doc
  `players`, ou imposer l'égalité dans les règles.
- **Aucune borne de taille dans les règles** : `name`, `titleAnswer`, `artistAnswer` ni
  typés ni bornés — jusqu'à 1 Mio par document. Ajouter `is string && size() <= 100`.
- **Validation du pseudo divergente** : `index.html:106` refuse plus de 16 caractères,
  `js/player.js:87` ne vérifie que le vide.
- **Un refresh de jeton raté laisse la pastille « connecté »** (`js/spotify.js:160`) :
  `isLoggedIn()` ne teste que la présence en `sessionStorage`.
- **Deux appels identiques à `/playlists/{id}`** (`js/host.js:238` puis `253`).
- **Le lien Apple Music n'est pas validé** (`js/host.js:660`, `js/player.js:369`), alors
  que les images passent par `safeImageUrl`.

### Code mort et dérive documentaire
- **Sept champs écrits dans chaque `tracks`, jamais relus** : `normalizedTitle`,
  `normalizedArtists`, `spotifyId`, `album`, `confidence`, `matchedTrackName`,
  `matchedArtistName`.
- **CSS morte** : tout le bloc `.buzzer` + `@keyframes buzzerPulse` (~35 lignes),
  `.btn-danger`, `.answer-actions`, `.gap-sm`, `.player-chip .score`.
- **`<audio id="audio">` (`host.html:115`) jamais utilisé** : `host.js` crée `new Audio()`
  à chaque round. `player.html` fait l'inverse et réutilise son élément — le comportement
  correct pour iOS.
- **README §7** : l'arborescence omet `tools/`, les icônes, `silence.wav`, `og-image.jpg`,
  `firebase.json`, `.firebaserc`.
- **README §11** : le manifest existe mais il n'y a aucun service worker, donc pas
  d'installation hors ligne. `purpose: "any maskable"` est une syntaxe dépréciée : deux
  entrées distinctes sont nécessaires.
- **Divers** : `console.log("[BLINDIE] …")` en production (`js/spotify.js:249`) ;
  `apple-mobile-web-app-capable` déprécié au profit de `mobile-web-app-capable` ; pas
  d'en-tête `Strict-Transport-Security` dans `netlify.toml`.

### Incohérences de configuration
- **Deux sources pour la durée du round** : l'hôte utilise
  `appConfig.defaultRoundDurationSeconds` (`js/host.js:550`), le joueur
  `room.settings.roundDurationSeconds` (`js/player.js:309`). Identiques aujourd'hui ;
  divergents le jour où la durée devient réglable.
- **Idem pour les points** : `scoreRound` reçoit `appConfig.pointsTitle/pointsArtist`
  (`js/host.js:611`) au lieu de `room.settings`, que `createRoom` écrit pourtant.
- **Le seuil de match 0,75 est en dur** (`js/room.js:257`) alors qu'`appConfig` centralise
  déjà `previewMatchThreshold`.
- **Les previews de déploiement Netlify casseront Spotify** : `js/config.js:55` déduit le
  `redirectUri` de `window.location.origin`, mais chaque URL de preview est aléatoire et ne
  peut pas être déclarée dans le dashboard. Échec silencieux. À documenter, ou à figer sur
  le domaine de production hors `localhost`.

---

## Ce que j'ai essayé de casser sans y arriver

- **Le joueur ne peut pas s'écrire de points** — `affectedKeys().hasOnly(['name','lastSeen'])`
  en update, `hasOnly(['name','joinedAt','lastSeen'])` en create. Aucun chemin, y compris
  supprimer puis recréer son document, ne laisse passer `score`.
- **`safeImageUrl` résiste à l'évasion d'attribut** — testé avec guillemets, chevrons et
  gestionnaires d'événements : le sérialiseur d'`URL` les encode en `%22`/`%3C`.
  `javascript:`, `data:`, `blob:`, `http:` et le protocole-relatif sont tous rejetés.
- **Collision de code de room** — `createRoom` a une fenêtre entre `getDoc` et `setDoc`,
  mais l'écrasement est bloqué en aval par `allow update: if isHost()`. Le second hôte
  reçoit une erreur au lieu de détruire la partie du premier.
- **Le scoring est idempotent** — `scoreRound` ajuste par delta dans un `writeBatch` unique.
  Un double reveal ne double pas les points, un échec réseau ne laisse pas un tableau à
  moitié à jour.
- **OAuth PKCE** — `code_verifier` de 96 caractères tiré de `crypto.getRandomValues`,
  challenge S256, `state` vérifié et consommé, URL nettoyée après échange.
- **La CSP couvre ce que le code charge réellement** — vérifié origine par origine, y
  compris le `cdn.jsdelivr.net` de l'import dynamique du QR code, le piège classique.

---

## Dans quel ordre s'y prendre

Classé par rapport valeur/effort. Les quatre premiers points tiennent en une soirée et
couvrent tout ce qui casse réellement une partie.

1. **`sessionStorage` → `localStorage` pour la session hôte** — une ligne ; supprime le seul
   scénario où une partie est définitivement perdue.
2. **Mélanger la playlist avant l'écrêtage** — trois lignes ; rend l'app rejouable.
3. **Supprimer le heartbeat `lastSeen`** — une suppression ; divise le coût Firestore par
   quatre pour un champ que personne ne lit.
4. **Désactiver les boutons pendant leur `await`** — deux handlers ; supprime le saut de
   round au double-clic.
5. **Reprendre le moteur de score, avec des tests** — la demi-journée la plus rentable :
   c'est l'équité du jeu. Les cas de test sont déjà écrits plus haut.
6. **Gestionnaires d'erreur sur les `onSnapshot` + timer hôte sur horodatage serveur** —
   transforme les pannes silencieuses en messages et réaligne les deux horloges.
7. **Passe d'accessibilité** : libellés, `prefers-reduced-motion`, contrastes des boutons —
   une à deux heures, et l'app sort de l'échec WCAG AA sur ses commandes principales.
8. **TTL Firestore à 24 h sur les rooms** — configuration console, zéro code.
9. **Ménage** : champs et CSS morts, README, doublon d'appel Spotify — sans urgence, mais
   chaque ligne supprimée est une ligne qui ne dérivera pas.
