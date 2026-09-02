// Banc de test du choix d'extrait iTunes. Aucune dépendance, aucun réseau :
// `node tools/test-previews.mjs`.
//
// Un extrait qui n'est pas le bon morceau est le bug le plus visible du jeu :
// le joueur entend une chanson et on lui en révèle une autre. Les cas
// ci-dessous rejouent des réponses iTunes typiques (original, karaoké,
// « tribute », homonyme d'un autre artiste, version live…) et vérifient ce
// que la sélection retient — ou refuse.

import {
  pickBestITunesResult, findPreviewITunes, itunesCountries,
} from '../js/previews.js';

let ok = 0;
const echecs = [];
function cas(nom, condition, detail = '') {
  if (condition) { ok++; return; }
  echecs.push({ nom, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
}

// Résultat iTunes minimal. previewUrl: null simule un morceau sans aperçu.
let seq = 0;
function song(trackName, artistName, extra = {}) {
  const { previewUrl, ...rest } = extra;
  return {
    kind: 'song',
    trackName,
    artistName,
    collectionName: `${trackName} - Single`,
    previewUrl: previewUrl === null ? undefined : `https://audio-ssl.itunes.apple.com/${++seq}.m4a`,
    trackViewUrl: 'https://music.apple.com/x',
    ...rest,
  };
}
const nom = (r) => r ? `${r.matchedTrackName} — ${r.matchedArtistName}` : 'null';

// ---------------------------------------------------------------------------
// L'original doit gagner face aux reprises et aux homonymes
// ---------------------------------------------------------------------------
{
  const r = pickBestITunesResult([
    song('Africa (Karaoke Version)', 'Karaoke Hits', { collectionName: 'Karaoke Hits Vol. 3' }),
    song('Africa', 'Weezer'),
    song('Africa (Live)', 'Toto', { collectionName: 'Live in Amsterdam' }),
    song('Africa', 'Toto', { collectionName: 'Toto IV' }),
    song('Africa (Originally Performed by Toto)', 'The Hit Crew'),
  ], 'Africa', ['Toto']);
  cas('original retenu parmi karaoké, homonyme, live et tribute',
      r && r.matchedArtistName === 'Toto' && r.matchedTrackName === 'Africa', nom(r));
}

// ---------------------------------------------------------------------------
// Sans l'original, on préfère ne rien jouer
// ---------------------------------------------------------------------------
cas('karaoké et tributes seuls → aucun extrait',
    pickBestITunesResult([
      song('Africa (Karaoke Version)', 'Karaoke Hits'),
      song('Africa (In the Style of Toto)', 'Ameritz Karaoke Band'),
      song('Africa (Originally Performed by Toto)', 'The Hit Crew'),
      song('Africa (Tribute to Toto)', 'Rock Tribute Stars'),
    ], 'Africa', ['Toto']) === null);

// Régression : même titre chez un autre artiste passait le seuil pondéré
// (0.65 × 1 + 0.35 × 0 = 0.65) et le repli « titre seul ≥ 0.8 ».
cas('même titre, autre artiste → aucun extrait',
    pickBestITunesResult([song('Africa', 'Weezer')], 'Africa', ['Toto']) === null);

cas('homonyme partiel de l\'artiste → aucun extrait',
    pickBestITunesResult([song('Africa', 'Toto Cutugno')], 'Africa', ['Toto']) === null);

cas('autre morceau du bon artiste → aucun extrait',
    pickBestITunesResult([song('Africa', 'Toto')], 'Hold the Line', ['Toto']) === null);

// Les versions accélérées / instrumentales sont souvent créditées à l'artiste
// original : le marqueur doit suffire à les écarter.
cas('version « sped up » créditée à l\'artiste → écartée',
    pickBestITunesResult([song('Africa (Sped Up)', 'Toto')], 'Africa', ['Toto']) === null);
cas('version instrumentale créditée à l\'artiste → écartée',
    pickBestITunesResult([song('Africa (Instrumental)', 'Toto')], 'Africa', ['Toto']) === null);
cas('album de berceuses → écarté',
    pickBestITunesResult([
      song("Friday I'm in Love", 'Rockabye Baby!', { collectionName: 'Lullaby Renditions of The Cure' }),
    ], "Friday I'm in Love", ['The Cure']) === null);

cas('résultat sans previewUrl ignoré, même s\'il est le bon',
    pickBestITunesResult([
      song('Africa', 'Toto', { previewUrl: null }),
      song('Africa (Karaoke Version)', 'Karaoke Hits'),
    ], 'Africa', ['Toto']) === null);

cas('résultat qui n\'est pas une chanson ignoré',
    pickBestITunesResult([song('Africa', 'Toto', { kind: 'music-video' })], 'Africa', ['Toto']) === null);

// ---------------------------------------------------------------------------
// Les marqueurs ne s'appliquent pas quand le morceau les porte lui-même
// ---------------------------------------------------------------------------
cas('« Cover Me » reste jouable',
    pickBestITunesResult([song('Cover Me', 'Bruce Springsteen')], 'Cover Me', ['Bruce Springsteen']) !== null);
cas('« Lullaby » des Cure reste jouable',
    pickBestITunesResult([song('Lullaby', 'The Cure')], 'Lullaby', ['The Cure']) !== null);
cas('une playlist de karaoké reste jouable',
    pickBestITunesResult([song('Africa (Karaoke Version)', 'Karaoke Hits')],
                         'Africa (Karaoke Version)', ['Karaoke Hits']) !== null);

// ---------------------------------------------------------------------------
// Variantes de forme qui doivent passer
// ---------------------------------------------------------------------------
cas('collaboration « A & B » vaut l\'un des deux artistes Spotify',
    pickBestITunesResult([song('One Kiss', 'Calvin Harris & Dua Lipa')],
                         'One Kiss', ['Calvin Harris', 'Dua Lipa']) !== null);
cas('second artiste Spotify suffit',
    pickBestITunesResult([song('One Kiss', 'Dua Lipa')],
                         'One Kiss', ['Calvin Harris', 'Dua Lipa']) !== null);
cas('article et virgule en moins',
    pickBestITunesResult([song('Paint It Black', 'Rolling Stones')],
                         'Paint It, Black', ['The Rolling Stones']) !== null);
cas('featuring identique des deux côtés',
    pickBestITunesResult([song('Get Lucky (feat. Pharrell Williams & Nile Rodgers)', 'Daft Punk')],
                         'Get Lucky (feat. Pharrell Williams & Nile Rodgers)',
                         ['Daft Punk', 'Pharrell Williams', 'Nile Rodgers']) !== null);
cas('remaster écrit différemment',
    pickBestITunesResult([song('Bohemian Rhapsody (2011 Remaster)', 'Queen')],
                         'Bohemian Rhapsody - Remastered 2011', ['Queen']) !== null);
cas('casse et accents',
    pickBestITunesResult([song('Alors On Danse', 'Stromae')], 'Alors on danse', ['Stromae']) !== null);
cas('artiste inconnu : le titre suffit',
    pickBestITunesResult([song('Africa', 'Toto')], 'Africa', []) !== null);
cas('artiste passé en chaîne plutôt qu\'en tableau',
    pickBestITunesResult([song('Africa', 'Toto')], 'Africa', 'Toto') !== null);

// ---------------------------------------------------------------------------
// Entre plusieurs versions du bon morceau
// ---------------------------------------------------------------------------
{
  const r = pickBestITunesResult([song('Africa (Live)', 'Toto'), song('Africa', 'Toto')], 'Africa', ['Toto']);
  cas('studio préféré au live', r?.matchedTrackName === 'Africa', nom(r));
}
{
  const r = pickBestITunesResult([song('Africa', 'Toto'), song('Africa (Live)', 'Toto')], 'Africa - Live', ['Toto']);
  cas('live préféré si la playlist contient le live', r?.matchedTrackName === 'Africa (Live)', nom(r));
}
{
  const r = pickBestITunesResult([song('Africa (Live)', 'Toto')], 'Africa', ['Toto']);
  cas('live accepté faute de mieux', r !== null, nom(r));
}
{
  const r = pickBestITunesResult([song('Africa (Radio Edit)', 'Toto'), song('Africa', 'Toto')], 'Africa', ['Toto']);
  cas('titre identique au caractère près départage deux versions équivalentes',
      r?.matchedTrackName === 'Africa', nom(r));
}

// ---------------------------------------------------------------------------
// Magasin iTunes : celui de l'appareil, puis le magasin américain
// ---------------------------------------------------------------------------
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
cas('fr-BE → BE puis US', eq(itunesCountries('fr-BE'), ['BE', 'US']), itunesCountries('fr-BE'));
cas('en_GB → GB puis US', eq(itunesCountries('en_GB'), ['GB', 'US']), itunesCountries('en_GB'));
cas('en-US → US seul', eq(itunesCountries('en-US'), ['US']), itunesCountries('en-US'));
cas('langue sans région → US', eq(itunesCountries('fr'), ['US']), itunesCountries('fr'));
cas('première locale régionalisée de la liste',
    eq(itunesCountries(['fr', 'fr-FR', 'en-US']), ['FR', 'US']), itunesCountries(['fr', 'fr-FR', 'en-US']));
cas('rien → US', eq(itunesCountries(''), ['US']) && eq(itunesCountries([]), ['US']));

// findPreviewITunes avec un fetch simulé
function fauxFetch(parMagasin) {
  const appels = [];
  const fetchImpl = async (url) => {
    appels.push(url);
    const country = new URL(url).searchParams.get('country');
    const rep = parMagasin[country];
    if (rep === 'panne') return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ resultCount: rep.length, results: rep }) };
  };
  return { appels, fetchImpl };
}

{
  const { appels, fetchImpl } = fauxFetch({
    BE: [song('Africa (Karaoke Version)', 'Karaoke Hits')],
    US: [song('Africa', 'Toto')],
  });
  const r = await findPreviewITunes('Africa', ['Toto'], { fetchImpl, countries: ['BE', 'US'] });
  cas('repli sur le magasin US quand le magasin local n\'a rien de fiable',
      r?.country === 'US' && appels.length === 2, { r: nom(r), appels });
  const u = appels[0] ? new URL(appels[0]) : null;
  cas('requête : artiste + titre, 25 résultats, magasin local d\'abord',
      u && u.searchParams.get('term') === 'Toto Africa' && u.searchParams.get('limit') === '25'
        && u.searchParams.get('country') === 'BE' && u.searchParams.get('entity') === 'song',
      appels[0]);
}
{
  const { appels, fetchImpl } = fauxFetch({ BE: [song('Africa', 'Toto')], US: [song('Africa', 'Toto')] });
  const r = await findPreviewITunes('Africa', ['Toto'], { fetchImpl, countries: ['BE', 'US'] });
  cas('un seul appel quand le magasin local suffit', r?.country === 'BE' && appels.length === 1, appels);
}
{
  const { fetchImpl } = fauxFetch({ BE: 'panne', US: [song('Africa', 'Toto')] });
  const r = await findPreviewITunes('Africa', ['Toto'], { fetchImpl, countries: ['BE', 'US'] });
  cas('un magasin en erreur ne prive pas du suivant', r?.country === 'US', nom(r));
}
{
  const { fetchImpl } = fauxFetch({ BE: 'panne', US: 'panne' });
  let erreur = null;
  try { await findPreviewITunes('Africa', ['Toto'], { fetchImpl, countries: ['BE', 'US'] }); }
  catch (e) { erreur = e; }
  cas('tous les magasins en erreur → exception (le caller la journalise)', erreur !== null);
}
{
  const { fetchImpl } = fauxFetch({ US: [song('Africa', 'Weezer')] });
  const r = await findPreviewITunes('Africa', ['Toto'], { fetchImpl, countries: ['US'] });
  cas('aucun magasin fiable → null, sans exception', r === null, nom(r));
}
cas('titre vide → null', (await findPreviewITunes('', ['Toto'], { fetchImpl: async () => { throw new Error('ne doit pas appeler'); } })) === null);

// ---------------------------------------------------------------------------
// Rapport
// ---------------------------------------------------------------------------
const total = ok + echecs.length;
if (echecs.length === 0) {
  console.log(`✓ ${total}/${total} cas passent`);
  process.exit(0);
}
console.error(`✗ ${echecs.length} échec(s) sur ${total}\n`);
for (const e of echecs) console.error(`  ${e.nom}\n      ${e.detail}`);
process.exit(1);
