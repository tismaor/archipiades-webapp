/**
 * Photos.gs — Proxy des photos d'identité et indexation des liens Drive.
 *
 * Les fichiers Drive restent PRIVÉS. Aucun passage en « accessible à toute
 * personne disposant du lien » : ce serait exposer des photos d'identité de
 * participants sur des URL devinables et indexables. Le script les lit avec
 * ses propres droits et renvoie l'image encodée.
 */

/**
 * GET ?action=photo&id=<numero>&key=<k>
 * Renvoie la miniature en base64. La Web App la reconstruit en Blob et la
 * conserve dans IndexedDB : chaque photo n'est donc téléchargée qu'une fois.
 */
function traiterPhoto(params) {
  const numero = String(params.id || '').trim();
  if (!numero) return reponseErreur_('Numéro de participant manquant', 'PARAMETRE_MANQUANT');

  const fichier = trouverFichierPhoto_(numero);
  if (!fichier) return reponseErreur_('Photo introuvable pour ' + numero, 'PHOTO_INTROUVABLE');

  try {
    const blob = fichier.getBlob();
    return reponseJson_({
      ok: true,
      numero: numero,
      mime: blob.getContentType(),
      taille: blob.getBytes().length,
      data_base64: Utilities.base64Encode(blob.getBytes())
    });
  } catch (erreur) {
    return reponseErreur_('Lecture impossible : ' + erreur, 'LECTURE_IMPOSSIBLE');
  }
}

/**
 * Cherche la miniature d'un participant, d'abord dans le dossier `Miniatures/`
 * (rendu généré une seule fois par prepare_sd.py), puis à défaut sur la photo
 * d'origine du Drive.
 */
function trouverFichierPhoto_(numero) {
  const proprietes = PropertiesService.getScriptProperties();
  const dossierId = proprietes.getProperty(PROP.DOSSIER_MINIATURES);

  if (dossierId) {
    try {
      const fichiers = DriveApp.getFolderById(dossierId).getFilesByName(numero + '.jpg');
      if (fichiers.hasNext()) return fichiers.next();
    } catch (erreur) {
      console.warn('Dossier Miniatures inaccessible : ' + erreur);
    }
  }

  // Repli : la photo d'origine, plus lourde, mais mieux que rien.
  const identifiant = lireChampParticipant_(numero, 'photo_file_id') ||
                      extraireIdDrive_(lireChampParticipant_(numero, 'photo'));
  if (!identifiant) return null;
  try {
    return DriveApp.getFileById(identifiant);
  } catch (erreur) {
    return null;
  }
}

/** Lit un champ d'un participant identifié par son numéro. */
function lireChampParticipant_(numero, champ) {
  const feuille = onglet_(SHEETS.PARTICIPANTS);
  const colonnes = resoudreColonnes_(feuille, COLS_PARTICIPANTS);
  if (colonnes.numero < 0 || colonnes[champ] < 0) return '';
  const bloc = lireBloc_(feuille);
  for (let i = 0; i < bloc.lignes.length; i++) {
    if (String(bloc.lignes[i][colonnes.numero]).trim() === numero) {
      return String(bloc.lignes[i][colonnes[champ]] || '').trim();
    }
  }
  return '';
}

/**
 * Extrait l'identifiant Drive d'un lien, quelle que soit sa forme.
 * Google en produit au moins quatre variantes selon la façon dont le lien a
 * été copié, et une seule expression régulière ne les couvre pas toutes.
 */
function extraireIdDrive_(lien) {
  const texte = String(lien || '').trim();
  if (!texte) return '';

  // Un identifiant nu a déjà la bonne forme.
  if (/^[A-Za-z0-9_-]{20,}$/.test(texte)) return texte;

  const motifs = [
    /\/file\/d\/([A-Za-z0-9_-]{20,})/,     // .../file/d/<id>/view
    /[?&]id=([A-Za-z0-9_-]{20,})/,          // .../open?id=<id>
    /\/d\/([A-Za-z0-9_-]{20,})/,            // .../d/<id>
    /googleusercontent\.com\/d\/([A-Za-z0-9_-]{20,})/
  ];
  for (let i = 0; i < motifs.length; i++) {
    const trouve = texte.match(motifs[i]);
    if (trouve) return trouve[1];
  }
  return '';
}

/**
 * « 🖼 Indexer les photos » — remplit `_photo_file_id` à partir des liens Drive.
 *
 * À lancer avant prepare_sd.py : le script Python travaille ensuite sur des
 * identifiants propres, sans avoir à interpréter les formats d'URL de Google.
 */
function menuIndexerPhotos() {
  const resultat = avecVerrou_(function () {
    const feuille = onglet_(SHEETS.PARTICIPANTS);
    const colonnes = resoudreColonnes_(feuille, COLS_PARTICIPANTS);
    if (colonnes.photo < 0 || colonnes.photo_file_id < 0) {
      throw new Error('Colonnes photo absentes : lancez « Initialiser / mettre à jour la base ».');
    }

    const bloc = lireBloc_(feuille);
    if (!bloc.lignes.length) return { total: 0, indexees: 0, echecs: 0 };

    const identifiants = [];
    let indexees = 0;
    let echecs = 0;

    for (let i = 0; i < bloc.lignes.length; i++) {
      const ligne = bloc.lignes[i];
      const numero = String(ligne[colonnes.numero] || '').trim();
      if (!numero) { identifiants.push([ligne[colonnes.photo_file_id] || '']); continue; }

      const dejaIndexe = String(ligne[colonnes.photo_file_id] || '').trim();
      if (dejaIndexe) { identifiants.push([dejaIndexe]); indexees++; continue; }

      const extrait = extraireIdDrive_(ligne[colonnes.photo]);
      identifiants.push([extrait]);
      if (extrait) indexees++;
      else if (String(ligne[colonnes.photo] || '').trim()) echecs++;
    }

    feuille.getRange(2, colonnes.photo_file_id + 1, identifiants.length, 1).setValues(identifiants);
    return { total: bloc.lignes.length, indexees: indexees, echecs: echecs };
  }, 60000);

  SpreadsheetApp.getUi().alert(
    'Indexation des photos',
    resultat.total + ' ligne(s) parcourue(s).\n' +
    resultat.indexees + ' photo(s) identifiée(s).\n' +
    resultat.echecs + ' lien(s) non reconnu(s).\n\n' +
    (resultat.echecs
      ? 'Les liens non reconnus sont probablement des URL raccourcies ou des ' +
        'copier-coller partiels : vérifiez-les à la main dans la colonne Photo.'
      : 'Vous pouvez lancer tools/prepare_sd.py.'),
    SpreadsheetApp.getUi().ButtonSet.OK);
}

/** Enregistre l'identifiant du dossier Drive contenant les miniatures. */
function definirDossierMiniatures(dossierId) {
  if (!dossierId) throw new Error('Usage : definirDossierMiniatures("<id du dossier Drive>")');
  DriveApp.getFolderById(dossierId);   // lève une erreur si inaccessible
  PropertiesService.getScriptProperties().setProperty(PROP.DOSSIER_MINIATURES, dossierId);
  return 'Dossier des miniatures enregistré.';
}
