// Banc de test du moteur de score. Aucune dépendance : `node tools/test-scoring.mjs`.
//
// Le scoring est l'endroit où un bug coûte le plus cher : un faux positif vole
// un point, un faux négatif en refuse un mérité, et personne ne s'en aperçoit
// pendant la partie. Chaque cas ci-dessous a été trouvé en cassant la version
// précédente du moteur — ne pas les supprimer à la légère.

import { normalizeText, scoreMatch, scoreArtistMatch, calculateScore } from '../js/utils.js';
import { appConfig } from '../js/config.js';

const SEUIL = appConfig.matchThreshold;

let ok = 0;
const echecs = [];

// attendu / réponse du joueur / doit-on accorder le point / pourquoi ce cas existe
function cas(attendu, reponse, doitPasser, note) {
  const score = scoreMatch(attendu, reponse);
  const passe = score >= SEUIL;
  if (passe === doitPasser) { ok++; return; }
  echecs.push({ attendu, reponse, score, passe, doitPasser, note });
}

// ---------------------------------------------------------------------------
// Bonnes réponses : doivent marquer
// ---------------------------------------------------------------------------
cas('Bohemian Rhapsody', 'bohemian rhapsody', true, 'identique');
cas('Bohemian Rhapsody', 'Bohémian Rhapsodie', true, 'accent + faute légère');
cas('Bohemian Rhapsody - Remastered 2011', 'bohemian rhapsody', true, 'suffixe remaster');
cas('Bohemian Rhapsody (Remastered 2011)', 'bohemian rhapsody', true, 'remaster entre parenthèses');
cas('Hotel California - Live', 'hotel california', true, 'suffixe live après tiret');
cas('Smells Like Teen Spirit [Live]', 'smells like teen spirit', true, 'suffixe live entre crochets');
cas('Shape of You (feat. Zion & Lennox)', 'shape of you', true, 'featuring');
cas("(I Can't Get No) Satisfaction", 'satisfaction', true, 'parenthèses en tête');
cas('Papa Outai', 'papaoutai', true, 'segmentation différente, mêmes lettres');
cas('The Final Countdown', 'final countdown', true, 'article omis');

// ---------------------------------------------------------------------------
// Titres que l'ancienne normalisation détruisait
// (elle retirait live/mix/edit/version partout, et coupait tout après "with")
// ---------------------------------------------------------------------------
cas('With or Without You', 'with or without you', true, 'titre commençant par "with"');
cas('Dancing With Myself', 'dancing with myself', true, '"with" au milieu');
cas('Live and Let Die', 'live and let die', true, '"live" en tête');
cas('Live Forever', 'live forever', true, '"live" en tête');
cas('Mix Tape', 'mix tape', true, '"mix" en tête');
cas('Live', 'live', true, 'titre entièrement composé d\'un qualificatif');
cas('The Final Countdown', 'the final countdown', true, 'témoin neutre');

// ---------------------------------------------------------------------------
// Réponses fausses : ne doivent PAS marquer
// ---------------------------------------------------------------------------
// Régression n°1 : une chaîne vide valait un match parfait (if (!a && !b) return 1)
cas('With or Without You', 'live', false, 'réponse hors-sujet, ancien score 1.000');
cas('With or Without You', 'mix', false, 'réponse hors-sujet, ancien score 1.000');
cas('With or Without You', '(nawak)', false, 'réponse hors-sujet, ancien score 1.000');
cas('Live', 'edit', false, 'deux qualificatifs différents, ancien score 1.000');
cas('Mix', 'remastered', false, 'deux qualificatifs différents, ancien score 1.000');
cas('Live', 'mix', false, 'artiste "Live" (vrai groupe) vs réponse quelconque');

// Régression n°2 : la règle sous-chaîne accordait 0.9 dès 4 caractères communs
cas('Thriller', 'thrill', false, 'préfixe, ancien score 0.900');
cas('Imagine', 'imagine dragons', false, 'titre ⊂ réponse, ancien score 0.900');
cas('Numb', 'number one', false, 'titre ⊂ réponse, ancien score 0.900');
cas('Creep', 'creepy', false, 'titre ⊂ réponse, ancien score 0.900');
cas('Live Forever', 'Forever', false, 'collision entre deux morceaux, ancien score 1.000');
cas('Live Forever', 'forever young', false, 'collision entre deux morceaux, ancien score 0.900');

// Celui-ci passe (0.78) et c'est voulu : 3 mots sur 4, c'est un vrai
// recouvrement, pas l'artefact de normalisation qui lui donnait 1.000 avant
// (le titre se réduisait à "and let die", donc la réponse était un match exact).
cas('Live and Let Die', 'And Let Die', true, '3 mots sur 4 : recouvrement réel');

// Faux négatifs classiques qui doivent le rester
cas('Californication', 'california', false, 'mot proche mais autre morceau');
cas('Hey Jude', 'hey', false, 'un seul mot commun');
cas('Stairway to Heaven', 'way', false, 'fragment');
cas('Yesterday', 'yes', false, 'préfixe court');
cas('Bohemian Rhapsody', '', false, 'réponse vide');
cas('', 'bohemian rhapsody', false, 'attendu vide');
cas('', '', false, 'les deux vides ne valent pas un match');

// ---------------------------------------------------------------------------
// La règle d'orthographe : « écrit comme ça se prononce » passe, tout ce qui
// change le son est refusé. Sur un mot unique, c'est la SEULE frontière qui
// distingue une faute (« afrika ») d'une autre réponse (« creepy »), et elle
// s'explique en une phrase à un joueur.
// ---------------------------------------------------------------------------
cas('Africa', 'afrika', true, 'même son, autre orthographe');
cas('Papaoutai', 'papa ou t es', true, 'le jeu de mots du titre, écrit comme il se prononce');
cas('Emma', 'ema', true, 'consonne doublée oubliée');
cas('Emma', 'emmah', true, 'h muet ajouté');
cas('Barbie', 'barby', true, 'y pour ie');
cas('Barbie', 'barbi', true, 'e final oublié');
cas('Bohemian Rhapsody', 'bohemian rapsody', true, 'h muet oublié');
cas('Toto', 'totto', true, 'consonne doublée en trop');
cas('Alors on danse', 'alor on dance', true, 's muet oublié, c pour s');
cas('Emma', 'emmy', false, 'autre son, autre prénom');
cas('Emma', 'ama', false, 'voyelle différente');
cas('Emma', 'emmanuelle', false, 'autre prénom');
cas('Barbie', 'barbe', false, 'autre son, autre mot');
cas('Live', 'life', false, 'v et f ne se confondent pas');
cas('Creep', 'creepy', false, 'syllabe en plus : un autre mot (répété ici pour la frontière)');

// ---------------------------------------------------------------------------
// normalizeText ne doit jamais renvoyer une chaîne vide pour un titre non vide
// ---------------------------------------------------------------------------
for (const t of ['Live', 'Mix', 'Version', '(Reprise)', '[Live]', 'Remastered', 'Edit']) {
  const n = normalizeText(t);
  if (n) { ok++; }
  else echecs.push({ attendu: t, reponse: '—', score: NaN, passe: null, doitPasser: null,
                     note: `normalizeText("${t}") renvoie une chaîne vide` });
}

// ---------------------------------------------------------------------------
// calculateScore : attribution des points au reveal
// ---------------------------------------------------------------------------
const settings = { pointsTitle: 1, pointsArtist: 1 };
function pts(titleAnswer, artistAnswer, track, attendu, note) {
  const r = calculateScore({ titleAnswer, artistAnswer }, track, settings);
  if (r.totalScore === attendu) { ok++; return; }
  echecs.push({ attendu: `${attendu} pt`, reponse: `${titleAnswer} / ${artistAnswer}`,
                score: r.totalScore, passe: null, doitPasser: null, note });
}

const u2 = { title: 'With or Without You', artists: ['U2'] };
pts('with or without you', 'u2', u2, 2, 'titre + artiste corrects');
pts('with or without you', '', u2, 1, 'titre seul');
pts('', 'U2', u2, 1, 'artiste seul');
pts('live', 'mix', u2, 0, 'deux réponses hors-sujet ne rapportent rien');
pts('nawak', 'nawak', u2, 0, 'deux réponses fausses');

const groupeLive = { title: 'Lightning Crashes', artists: ['Live'] };
pts('lightning crashes', 'live', groupeLive, 2, 'artiste nommé "Live"');
pts('lightning crashes', 'mix', groupeLive, 1, 'artiste "Live" ne matche pas "mix"');

const franck = { title: 'Quelque chose de Tennessee', artists: ['Franck Lénar'] };
pts('', 'franck', franck, 1, 'un mot du nom de l\'artiste suffit');
pts('', 'franck dubosc', franck, 0, 'un mot du nom + un mot étranger : refusé');
pts('tennessee', 'lenar', franck, 1, 'nom de famille seul (le titre est incomplet)');

// ---------------------------------------------------------------------------
// Règle artiste : un mot entier du nom suffit, à la prononciation près.
// Un mot-outil ou un chiffre ne compte pas. Un mot étranger au nom disqualifie.
// ---------------------------------------------------------------------------
function art(attendu, reponse, doitPasser, note) {
  const score = scoreArtistMatch(attendu, reponse);
  const passe = score >= SEUIL;
  if (passe === doitPasser) { ok++; return; }
  echecs.push({ attendu, reponse, score, passe, doitPasser, note: `[artiste] ${note}` });
}
art('Franck Lénar', 'franck', true, 'prénom seul');
art('Franck Lénar', 'lenar', true, 'nom seul');
art('Franck Lénar', 'frank', true, 'prénom seul, orthographe phonétique');
art('Franck Lénar', 'franck lenard', true, 'd final muet');
art('Franck Lénar', 'lenar franck', true, 'ordre inversé');
art('Franck Lénar', 'franck dubosc', false, 'un mot du nom, un mot d\'un autre');
art('Franck Lénar', 'francky', false, 'autre son');
art('The Rolling Stones', 'stones', true, 'mot principal du groupe');
art('The Rolling Stones', 'les stones', true, 'article français ignoré');
art('The Rolling Stones', 'the', false, 'mot-outil seul');
art('Aya Nakamura', 'aya', true, 'prénom court mais entier');
art('Aya Nakamura', 'nakamoura', true, 'ou pour u');
art('Lil Nas X', 'x', false, 'une lettre');
art('Lil Nas X', 'lil', false, 'préfixe de scène, pas un nom');
art('Maroon 5', '5', false, 'chiffre seul');
art('Maroon 5', 'maroon', true, 'le mot du nom');
art('Daft Punk', 'punk', true, 'conséquence assumée : c\'est un mot du nom');
art('Michael Jackson', 'michael', true, 'conséquence assumée : prénom seul');
art('Chris Brown', 'kris', true, '« chr » dur, k pour ch');
// Limite assumée : « ch » se lit ici « k » (Michael → Mikaël), mais « ch » se lit
// « ch » dans presque tous les autres mots (Michel, Charles). Le moteur ne peut
// pas le savoir ; il refuse. Figé ici pour le voir si ça change.
art('Michael Jackson', 'mickael', false, 'limite connue : ch dur imprévisible');
art('Michael Jackson', 'jackson five', false, 'mot étranger au nom');
art('Stromae', 'stroma', true, 'e final');
art('Stromae', 'strauss', false, 'autre artiste');
// Les titres n'ont PAS cette règle
cas('Live Forever', 'forever', false, 'titre : un mot du titre ne suffit pas (rappel)');

// ---------------------------------------------------------------------------
// Rapport
// ---------------------------------------------------------------------------
const total = ok + echecs.length;
if (echecs.length === 0) {
  console.log(`✓ ${total}/${total} cas passent (seuil ${SEUIL})`);
  process.exit(0);
}
console.error(`✗ ${echecs.length} échec(s) sur ${total} (seuil ${SEUIL})\n`);
for (const e of echecs) {
  const verdict = e.doitPasser === null
    ? `obtenu ${e.score}, attendu ${e.attendu}`
    : `score ${Number(e.score).toFixed(3)} → ${e.passe ? 'accordé' : 'refusé'}, ` +
      `attendu ${e.doitPasser ? 'accordé' : 'refusé'}`;
  console.error(`  "${e.attendu}" ← "${e.reponse}"`);
  console.error(`      ${verdict}  (${e.note})`);
}
process.exit(1);
