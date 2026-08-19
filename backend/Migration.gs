/**
 * Migration.gs — Enrichit le classeur EXISTANT sans rien détruire.
 *
 * Principe : la migration est idempotente. On peut la relancer autant de fois
 * qu'on veut, elle ne crée que ce qui manque et ne touche jamais aux données
 * métier déjà saisies. Aucune colonne existante n'est renommée ni déplacée.
 */

/**
 * Point d'entrée appelé par le menu « ARCHIPIADES ».
 */
function initialiserBase() {
  const rapport = [];

  rapport.push(migrerParticipants_());
  rapport.push(creerOngletSiAbsent_(SHEETS.BRACELETS, ENTETES.BRACELETS));
  rapport.push(creerOngletDroits_());
  rapport.push(creerOngletFormules_());
  rapport.push(creerOngletServices_());
  rapport.push(creerOngletSiAbsent_(SHEETS.SCANS, ENTETES.SCANS));
  rapport.push(creerOngletTerminaux_());
  rapport.push(creerOngletConfig_());
  rapport.push(creerOngletSiAbsent_(SHEETS.COMPTES, ENTETES.COMPTES));
  rapport.push(creerOngletSiAbsent_(SHEETS.COMMANDES, ENTETES.COMMANDES));
  rapport.push(creerOngletSiAbsent_(SHEETS.ADMIN_LOG, ENTETES.ADMIN_LOG));
  rapport.push(installerDeclencheurs_());
  rapport.push(genererCleApiSiAbsente_());

  // Première indexation : calcule les hash sans provoquer de re-sync inutile.
  const indexation = forcerReindexation();
  rapport.push('Indexation initiale : ' + indexation.lignes_modifiees + ' ligne(s) horodatée(s).');

  const message = rapport.filter(String).join('\n');
  SpreadsheetApp.getUi().alert('Initialisation terminée', message, SpreadsheetApp.getUi().ButtonSet.OK);
  return message;
}

/**
 * Ajoute les colonnes techniques à droite de l'onglet Participants.
 * Les colonnes métier existantes ne sont ni déplacées ni renommées.
 */
function migrerParticipants_() {
  const feuille = onglet_(SHEETS.PARTICIPANTS);
  const index = indexEntetes_(feuille);
  const ajoutees = [];

  COLS_TECHNIQUES.forEach(function (nom) {
    if (index[normaliserLibelle_(nom)] === undefined) {
      const colonne = feuille.getLastColumn() + 1;
      feuille.getRange(1, colonne).setValue(nom);
      ajoutees.push(nom);
      index[normaliserLibelle_(nom)] = colonne - 1;
    }
  });

  // Les deux colonnes de commentaires sont métier, pas techniques : on les crée
  // seulement si elles manquent, pour ne pas imposer une saisie qui existe déjà.
  [['Commentaire Participant', COLS_PARTICIPANTS.commentaire],
   ['Note de sécurité', COLS_PARTICIPANTS.note_secu]].forEach(function (paire) {
    const trouve = paire[1].some(function (v) { return index[normaliserLibelle_(v)] !== undefined; });
    if (!trouve) {
      const colonne = feuille.getLastColumn() + 1;
      feuille.getRange(1, colonne).setValue(paire[0]);
      ajoutees.push(paire[0]);
      index[normaliserLibelle_(paire[0])] = colonne - 1;
    }
  });

  // _statut_participant par défaut à ACTIF sur les lignes déjà remplies.
  const colonnes = resoudreColonnes_(feuille, COLS_PARTICIPANTS);
  const derniereLigne = feuille.getLastRow();
  if (colonnes.statut_part >= 0 && derniereLigne >= 2) {
    const plage = feuille.getRange(2, colonnes.statut_part + 1, derniereLigne - 1, 1);
    const valeurs = plage.getValues();
    let vides = 0;
    for (let i = 0; i < valeurs.length; i++) {
      if (String(valeurs[i][0]).trim() === '') { valeurs[i][0] = 'ACTIF'; vides++; }
    }
    if (vides) plage.setValues(valeurs);
  }

  // Mise en forme : les colonnes techniques sont grisées pour signaler
  // clairement qu'elles ne se saisissent pas à la main.
  COLS_TECHNIQUES.forEach(function (nom) {
    const position = index[normaliserLibelle_(nom)];
    if (position !== undefined) {
      feuille.getRange(1, position + 1).setBackground('#d9d9d9').setFontColor('#666666');
    }
  });

  feuille.setFrozenRows(1);
  return ajoutees.length
    ? 'Participants : colonnes ajoutées → ' + ajoutees.join(', ')
    : 'Participants : aucune colonne à ajouter.';
}

/** Crée un onglet avec ses en-têtes s'il n'existe pas déjà. */
function creerOngletSiAbsent_(nom, entetes) {
  const existant = classeur_().getSheetByName(nom);
  if (existant) return '';
  const feuille = classeur_().insertSheet(nom);
  feuille.getRange(1, 1, 1, entetes.length).setValues([entetes]).setFontWeight('bold');
  feuille.setFrozenRows(1);
  return 'Onglet créé : ' + nom;
}

/**
 * Droits : matrice Statut × Point de contrôle.
 * Pré-remplie avec une proposition de départ, à ajuster par l'organisation.
 */
function creerOngletDroits_() {
  if (classeur_().getSheetByName(SHEETS.DROITS)) return '';
  const feuille = classeur_().insertSheet(SHEETS.DROITS);
  const donnees = [
    ['statut',    'ENTREE', 'TERRAIN', 'VIP',   'REPAS', 'CAMPING'],
    ['Staff',     'OUI',    'OUI',     'OUI',   'OUI',   'OUI'],
    ['Sportif',   'OUI',    'OUI',     'NON',   'OUI',   'OUI'],
    ['Bénévole',  'OUI',    'OUI',     'NON',   'OUI',   'OUI'],
    ['Supporter', 'OUI',    'NON',     'NON',   'OUI',   'NON'],
    ['VIP',       'OUI',    'OUI',     'OUI',   'OUI',   'NON']
  ];
  feuille.getRange(1, 1, donnees.length, donnees[0].length).setValues(donnees);
  feuille.getRange(1, 1, 1, donnees[0].length).setFontWeight('bold');
  feuille.setFrozenRows(1);
  feuille.setFrozenColumns(1);
  feuille.getRange(2, 2, donnees.length - 1, donnees[0].length - 1)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['OUI', 'NON'], true).build());
  return 'Onglet créé : Droits (matrice de départ à ajuster).';
}

/** Formules : quelle formule donne droit à quels services. */
function creerOngletFormules_() {
  if (classeur_().getSheetByName(SHEETS.FORMULES)) return '';
  const feuille = classeur_().insertSheet(SHEETS.FORMULES);
  const donnees = [
    ENTETES.FORMULES,
    ['Pension complète', '1,2,3,4', 'Tous les repas'],
    ['Demi-pension',     '2,4',     'Déjeuners uniquement'],
    ['Repas à l\'unité',  '',        'Repas achetés au cas par cas, à saisir manuellement'],
    ['Sans repas',       '',        'Aucun repas inclus']
  ];
  feuille.getRange(1, 1, donnees.length, donnees[0].length).setValues(donnees);
  feuille.getRange(1, 1, 1, donnees[0].length).setFontWeight('bold');
  feuille.setFrozenRows(1);
  return 'Onglet créé : Formules (exemples à ajuster).';
}

/** Services : quelle plage horaire correspond à quel numéro de repas. */
function creerOngletServices_() {
  if (classeur_().getSheetByName(SHEETS.SERVICES)) return '';
  const feuille = classeur_().insertSheet(SHEETS.SERVICES);
  const donnees = [
    ENTETES.SERVICES,
    [1, 'Dîner samedi',    '19:00', '22:00'],
    [2, 'Déjeuner dimanche', '11:30', '14:30'],
    [3, 'Dîner dimanche',  '19:00', '22:00'],
    [4, 'Déjeuner lundi',  '11:30', '14:30']
  ];
  feuille.getRange(1, 1, donnees.length, donnees[0].length).setValues(donnees);
  feuille.getRange(1, 1, 1, donnees[0].length).setFontWeight('bold');
  feuille.getRange(2, 3, donnees.length - 1, 2).setNumberFormat('@');  // horaires en texte
  feuille.setFrozenRows(1);
  return 'Onglet créé : Services (plages horaires à ajuster).';
}

/** Terminaux : un enregistrement par mallette et par téléphone. */
function creerOngletTerminaux_() {
  if (classeur_().getSheetByName(SHEETS.TERMINAUX)) return '';
  const feuille = classeur_().insertSheet(SHEETS.TERMINAUX);
  const donnees = [
    ENTETES.TERMINAUX,
    ['DECK-01', 'Entrée principale', 'ENTREE', 'DECK', 'ENTREE', 15,  '', '', true, '', ''],
    ['DECK-02', 'Point repas',       'REPAS',  'DECK', 'REPAS',  180, '', '', true, '', ''],
    ['WEB-01',  'Bénévole mobile 1', 'ENTREE', 'WEB',  'ENTREE', 30,  '', '', true, '', '']
  ];
  feuille.getRange(1, 1, donnees.length, donnees[0].length).setValues(donnees);
  feuille.getRange(1, 1, 1, donnees[0].length).setFontWeight('bold');
  feuille.setFrozenRows(1);

  const colProfil = ENTETES.TERMINAUX.indexOf('profil_donnees') + 1;
  feuille.getRange(2, colProfil, 200, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(Object.keys(PROFILS_DONNEES), true).build());

  const colType = ENTETES.TERMINAUX.indexOf('type') + 1;
  feuille.getRange(2, colType, 200, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['DECK', 'WEB'], true).build());

  return 'Onglet créé : Terminaux (exemples à ajuster).';
}

/** Config : paramètres d'exploitation modifiables sans toucher au code. */
function creerOngletConfig_() {
  let feuille = classeur_().getSheetByName(SHEETS.CONFIG);
  if (!feuille) {
    feuille = classeur_().insertSheet(SHEETS.CONFIG);
    feuille.getRange(1, 1, 1, ENTETES.CONFIG.length).setValues([ENTETES.CONFIG]).setFontWeight('bold');
    feuille.setFrozenRows(1);
  }
  // Complète les clés manquantes sans écraser les valeurs déjà réglées.
  const existantes = {};
  lireObjets_(SHEETS.CONFIG).forEach(function (l) { existantes[String(l.cle).trim()] = true; });
  const aAjouter = CONFIG_DEFAUTS.filter(function (d) { return !existantes[d[0]]; });
  if (aAjouter.length) ajouterLignes_(feuille, aAjouter);
  return aAjouter.length ? 'Config : ' + aAjouter.length + ' paramètre(s) ajouté(s).' : '';
}

/**
 * Installe les déclencheurs. On supprime d'abord les nôtres pour éviter
 * l'empilement silencieux à chaque relance de la migration.
 */
function installerDeclencheurs_() {
  const cibles = ['surEdition', 'controleHoraire'];
  ScriptApp.getProjectTriggers().forEach(function (declencheur) {
    if (cibles.indexOf(declencheur.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(declencheur);
    }
  });

  ScriptApp.newTrigger('surEdition')
    .forSpreadsheet(classeur_())
    .onEdit()
    .create();

  ScriptApp.newTrigger('controleHoraire')
    .timeBased()
    .everyHours(1)
    .create();

  return 'Déclencheurs installés : onEdit + contrôle horaire.';
}

/** Génère la clé partagée de l'API si elle n'existe pas encore. */
function genererCleApiSiAbsente_() {
  const proprietes = PropertiesService.getScriptProperties();
  if (proprietes.getProperty(PROP.API_KEY)) return '';
  proprietes.setProperty(PROP.API_KEY, uuid_().replace(/-/g, ''));
  return 'Clé API générée (menu « Afficher la clé API » pour la lire).';
}

/**
 * Déclencheur installable onEdit : horodate la ou les lignes modifiées.
 *
 * Il couvre l'édition manuelle au fil de l'eau, y compris un collage sur
 * plusieurs lignes. Il ne couvre PAS les écritures faites par un autre script
 * ni certains imports — d'où « Forcer la réindexation », qui est le vrai filet.
 */
function surEdition(evenement) {
  try {
    const feuille = evenement.range.getSheet();
    const nom = feuille.getName();

    // Les tables de référence sont mémorisées pour tenir la cadence de 15 s :
    // une édition doit invalider ce cache immédiatement, sinon la modification
    // mettrait jusqu'à une minute à atteindre les terminaux.
    if (nom === SHEETS.DROITS || nom === SHEETS.FORMULES ||
        nom === SHEETS.SERVICES || nom === SHEETS.CONFIG) {
      viderCache_([CACHE.REFERENCES, CACHE.CONFIG]);
      return;
    }
    if (nom === SHEETS.TERMINAUX) {
      const index = indexEntetes_(feuille);
      const colonneId = index['terminal_id'];
      if (colonneId !== undefined) {
        const premiere = Math.max(2, evenement.range.getRow());
        const derniere = evenement.range.getLastRow();
        const cles = [];
        for (let ligne = premiere; ligne <= derniere; ligne++) {
          const identifiant = String(feuille.getRange(ligne, colonneId + 1).getValue()).trim();
          if (identifiant) cles.push(CACHE.terminal(identifiant));
        }
        if (cles.length) viderCache_(cles);
      }
      return;
    }

    if (nom === SHEETS.COMPTES) viderCache_(['CARTES_V1']);
    if (nom !== SHEETS.PARTICIPANTS && nom !== SHEETS.BRACELETS && nom !== SHEETS.COMPTES) return;

    const index = indexEntetes_(feuille);
    const colonneMaj = index['_updated_at'];
    if (colonneMaj === undefined) return;

    const premiere = Math.max(2, evenement.range.getRow());
    const derniere = evenement.range.getLastRow();
    if (derniere < 2) return;

    const nombre = derniere - premiere + 1;
    const horodatage = maintenant_();
    const valeurs = [];
    for (let i = 0; i < nombre; i++) valeurs.push([horodatage]);
    feuille.getRange(premiere, colonneMaj + 1, nombre, 1).setValues(valeurs);

    // Le hash suit, pour que la réindexation ne considère pas ces lignes comme
    // dérivantes au prochain passage.
    if (nom === SHEETS.PARTICIPANTS) {
      rafraichirHashLignes_(feuille, premiere, nombre);
    }
    majMaxUpdatedAt_(horodatage);
  } catch (erreur) {
    // Un déclencheur qui lève une exception est silencieux pour l'utilisateur :
    // on trace dans le journal d'exécution plutôt que de perdre l'information.
    console.error('surEdition : ' + erreur);
  }
}

/** Recalcule _row_hash sur une plage de lignes de Participants. */
function rafraichirHashLignes_(feuille, premiereLigne, nombre) {
  const colonnes = resoudreColonnes_(feuille, COLS_PARTICIPANTS);
  if (colonnes.row_hash < 0) return;
  const largeur = feuille.getLastColumn();
  const valeurs = feuille.getRange(premiereLigne, 1, nombre, largeur).getValues();
  const hashs = valeurs.map(function (ligne) {
    return [hashLigne_(CHAMPS_HASHES.map(function (champ) {
      const position = colonnes[champ];
      return position >= 0 ? ligne[position] : '';
    }))];
  });
  feuille.getRange(premiereLigne, colonnes.row_hash + 1, nombre, 1).setValues(hashs);
}

/**
 * Déclencheur horaire : troisième filet de sécurité.
 * Il compare les hash et répare les dérives sans intervention humaine.
 */
function controleHoraire() {
  const resultat = forcerReindexation();
  if (resultat.lignes_modifiees > 0) {
    console.warn('Contrôle horaire : ' + resultat.lignes_modifiees +
                 ' ligne(s) désynchronisée(s) réparée(s).');
  }
  PropertiesService.getScriptProperties()
    .setProperty('DERNIER_CONTROLE', String(maintenant_()));
}
