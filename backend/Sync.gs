/**
 * Sync.gs — Synchronisation différentielle et réindexation.
 *
 * Le contrat est simple : un terminal envoie le plus grand `_updated_at` qu'il
 * connaît, le serveur renvoie ce qui a changé depuis. Deux garde-fous rendent
 * la cadence de 15 s soutenable :
 *  - un court-circuit qui répond « rien de neuf » sans lire le classeur ;
 *  - une pagination par clé composite, robuste aux horodatages identiques
 *    produits par un collage de masse.
 */

/**
 * GET ?action=sync&since=<ms>&terminal=<id>&key=<k>[&apres=<numero>][&limite=n][&refs=<version>]
 */
function traiterSync(params) {
  const terminal = chargerTerminal_(params.terminal);
  if (!terminal) return reponseErreur_('Terminal inconnu : ' + params.terminal, 'TERMINAL_INCONNU');
  if (!terminal.actif) return reponseErreur_('Terminal désactivé', 'TERMINAL_DESACTIVE');

  const since = versEntier_(params.since, 0);
  const apres = String(params.apres || '');
  const limite = Math.min(versEntier_(params.limite, SYNC_LIMITE_DEFAUT), 2000);
  const config = lireConfig_();
  const horodatageServeur = maintenant_();

  // Cadence : accélérée si une supervision est en cours sur ce terminal.
  const supervisionJusqua = versEntier_(terminal.supervision_jusqua, 0);
  const enSupervision = supervisionJusqua > horodatageServeur;
  const cadence = enSupervision
    ? versEntier_(config.sync_interval_supervision_s, 3)
    : versEntier_(terminal.sync_interval_s, versEntier_(config.sync_interval_defaut_s, 180));

  const reponse = {
    ok: true,
    server_time: horodatageServeur,
    terminal_id: terminal.terminal_id,
    point_controle: terminal.point_controle,
    profil_donnees: terminal.profil_donnees,
    sync_interval_s: cadence,
    supervision_active: enSupervision,
    participants: [],
    bracelets: [],
    commandes: [],
    suite: false
  };

  // Court-circuit : si rien n'a bougé depuis la dernière fois, on ne lit même
  // pas le classeur. C'est ce qui rend une scrutation toutes les 15 secondes
  // pratiquement gratuite, puisque la plupart des cycles ne changent rien.
  const maxConnu = lireMaxUpdatedAt_();
  const rienDeNeuf = since > 0 && maxConnu > 0 && since >= maxConnu && !apres;

  if (!rienDeNeuf) {
    const delta = construireDeltaParticipants_(terminal, since, apres, limite);
    reponse.participants = delta.lignes;
    reponse.suite = delta.suite;
    if (delta.suite) {
      reponse.since_suivant = delta.dernier_updated_at;
      reponse.apres_suivant = delta.dernier_numero;
    }
    reponse.bracelets = construireDeltaBracelets_(since);
  }

  // Tables de référence : petites, mais inutiles à renvoyer si elles n'ont pas
  // changé. Le terminal renvoie la version qu'il détient, on ne réémet qu'en
  // cas d'écart.
  const refs = construireReferences_(config);
  if (String(params.refs || '') !== refs.version) {
    reponse.refs = refs.contenu;
  }
  reponse.refs_version = refs.version;

  reponse.cartes = construireCartes_();
  reponse.commandes = commandesEnAttente_(terminal.terminal_id);

  marquerTerminalVu_(terminal, horodatageServeur, since);
  return reponseJson_(reponse);
}

/**
 * Construit le delta des participants, projeté selon le profil du terminal.
 *
 * Pagination par clé composite (_updated_at, numéro) : un collage de 500 lignes
 * leur donne le même horodatage à la milliseconde près, et une pagination sur
 * le seul horodatage sauterait des lignes ou boucplerait indéfiniment.
 */
function construireDeltaParticipants_(terminal, since, apres, limite) {
  const feuille = onglet_(SHEETS.PARTICIPANTS);
  const colonnes = resoudreColonnes_(feuille, COLS_PARTICIPANTS);
  const bloc = lireBloc_(feuille);

  const champsAutorises = PROFILS_DONNEES[terminal.profil_donnees] || PROFILS_DONNEES[PROFIL_PAR_DEFAUT];

  const candidats = [];
  for (let i = 0; i < bloc.lignes.length; i++) {
    const ligne = bloc.lignes[i];
    const numero = colonnes.numero >= 0 ? String(ligne[colonnes.numero]).trim() : '';
    if (!numero) continue;

    const majLigne = colonnes.updated_at >= 0 ? versEntier_(ligne[colonnes.updated_at], 0) : 0;
    const posterieur = majLigne > since || (majLigne === since && apres && numero > apres);
    if (!posterieur) continue;

    candidats.push({ numero: numero, maj: majLigne, ligne: ligne });
  }

  candidats.sort(function (a, b) {
    if (a.maj !== b.maj) return a.maj - b.maj;
    return a.numero < b.numero ? -1 : (a.numero > b.numero ? 1 : 0);
  });

  const suite = candidats.length > limite;
  const retenus = suite ? candidats.slice(0, limite) : candidats;

  const lignes = retenus.map(function (candidat) {
    const objet = { numero: candidat.numero, maj: candidat.maj };
    champsAutorises.forEach(function (champ) {
      if (champ === 'numero') return;
      const position = colonnes[champ];
      objet[champ] = position >= 0 ? normaliserValeur_(candidat.ligne[position]) : '';
    });
    // L'état actif/suspendu est nécessaire à toute décision, quel que soit le profil.
    objet.actif = colonnes.statut_part < 0
      || normaliserLibelle_(candidat.ligne[colonnes.statut_part]) !== 'suspendu';
    objet.photo = colonnes.photo_prete >= 0 ? versBooleen_(candidat.ligne[colonnes.photo_prete]) : false;
    return objet;
  });

  const dernier = retenus.length ? retenus[retenus.length - 1] : null;
  return {
    lignes: lignes,
    suite: suite,
    dernier_updated_at: dernier ? dernier.maj : since,
    dernier_numero: dernier ? dernier.numero : apres
  };
}

/** Delta des bracelets : petite table, aucune projection nécessaire. */
function construireDeltaBracelets_(since) {
  const feuille = onglet_(SHEETS.BRACELETS, false);
  if (!feuille) return [];
  const bloc = lireBloc_(feuille);
  const index = {};
  bloc.entetes.forEach(function (e, i) { index[String(e).trim()] = i; });
  if (index.uid === undefined) return [];

  const resultat = [];
  for (let i = 0; i < bloc.lignes.length; i++) {
    const ligne = bloc.lignes[i];
    const uid = normaliserUid_(ligne[index.uid]);
    if (!uid) continue;
    const maj = index._updated_at !== undefined ? versEntier_(ligne[index._updated_at], 0) : 0;
    if (maj <= since) continue;
    resultat.push({
      uid: uid,
      numero: String(ligne[index.numero_participant] || '').trim(),
      statut: String(ligne[index.statut] || STATUT_BRACELET.ACTIF).trim().toUpperCase(),
      maj: maj
    });
  }
  return resultat;
}

/**
 * Tables de référence : droits, formules, services et paramètres.
 *
 * La version est une empreinte du contenu, pour éviter de les réémettre à
 * chaque cycle. Le tout est mémorisé 60 s : ces trois onglets sont minuscules
 * mais leur lecture coûtait à elle seule près de deux secondes par sync, sur
 * un budget de quinze.
 *
 * Le cache est invalidé immédiatement dès qu'un de ces onglets est édité
 * (voir `surEdition`), les 60 s ne sont qu'un filet de sécurité pour les
 * modifications qu'`onEdit` ne voit pas.
 */
function construireReferences_(config) {
  return enCache_(CACHE.REFERENCES, 60, function () {
    return calculerReferences_(config);
  });
}

function calculerReferences_(config) {
  const droits = {};
  lireObjets_(SHEETS.DROITS).forEach(function (ligne) {
    const statut = String(ligne.statut || '').trim();
    if (!statut) return;
    const points = {};
    Object.keys(ligne).forEach(function (cle) {
      if (cle === 'statut') return;
      points[cle] = normaliserLibelle_(ligne[cle]) === 'oui';
    });
    droits[statut] = points;
  });

  const formules = {};
  lireObjets_(SHEETS.FORMULES).forEach(function (ligne) {
    const nom = String(ligne.formule || '').trim();
    if (!nom) return;
    formules[nom] = String(ligne.repas_autorises || '')
      .split(',')
      .map(function (v) { return versEntier_(v, 0); })
      .filter(function (v) { return v > 0; });
  });

  const services = lireObjets_(SHEETS.SERVICES).map(function (ligne) {
    return {
      numero: versEntier_(ligne.numero_service, 0),
      libelle: String(ligne.libelle || ''),
      debut: versMinutes_(ligne.debut),
      fin: versMinutes_(ligne.fin)
    };
  }).filter(function (s) { return s.numero > 0; });

  const contenu = {
    droits: droits,
    formules: formules,
    services: services,
    config: {
      antipassback_secondes: versEntier_(config.antipassback_secondes, 120),
      passback_expiration_s: versEntier_(config.passback_expiration_s, 60),
      http_timeout_ms: versEntier_(config.http_timeout_ms, 8000),
      session_inactivite_s: versEntier_(config.session_inactivite_s, 180),
      photo_ttl_s: versEntier_(config.photo_ttl_s, 8),
      version_schema: versEntier_(config.version_schema, 1)
    }
  };

  return { contenu: contenu, version: hashLigne_([JSON.stringify(contenu)]) };
}

/**
 * Cartes privilégiées actives, diffusées aux terminaux.
 *
 * Permet à un terminal de reconnaître HORS LIGNE qu'une carte est STAFF ou
 * ADMIN — nécessaire pour déverrouiller les réglages de la Web App sans exiger
 * de phrase de passe, et pour ouvrir la saisie sur les mallettes.
 *
 * ON NE TRANSMET JAMAIS `hash_mdp` NI `sel`. La reconnaissance de carte sert à
 * OUVRIR une saisie ou un écran de confort ; toute opération privilégiée réelle
 * reste vérifiée côté serveur par `autoriser_()`, avec jeton de session.
 *
 * Conséquence assumée : la liste des UID de cartes se trouve sur chaque
 * terminal. Un téléphone perdu révèle donc quels UID ouvrent les réglages —
 * mais un UID NTAG n'a jamais été un secret, il se lit avec n'importe quel
 * téléphone en approchant la carte.
 */
function construireCartes_() {
  return enCache_('CARTES_V1', 60, function () {
    return lireObjets_(SHEETS.COMPTES)
      .filter(function (compte) { return versBooleen_(compte.actif); })
      .map(function (compte) {
        return {
          uid: normaliserUid_(compte.uid_carte),
          nom: String(compte.nom || ''),
          role: String(compte.role || ROLES.STAFF).trim().toUpperCase()
        };
      })
      .filter(function (carte) { return carte.uid !== ''; });
  });
}

/** Convertit une cellule en valeur transmissible en JSON. */
function normaliserValeur_(valeur) {
  if (valeur instanceof Date) return Utilities.formatDate(valeur, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  if (typeof valeur === 'boolean') return valeur;
  return String(valeur == null ? '' : valeur).trim();
}

/**
 * Charge la configuration d'un terminal depuis l'onglet Terminaux.
 *
 * Mémorisé 30 s. Les réglages qui doivent réagir immédiatement — bascule en
 * supervision, changement de point de contrôle — invalident explicitement
 * cette entrée via `ecrireChampTerminal_()`, la durée de vie ne concerne donc
 * que les modifications faites à la main dans le classeur.
 */
function chargerTerminal_(terminalId) {
  if (!terminalId) return null;
  const cible = String(terminalId).trim();
  const terminal = enCache_(CACHE.terminal(cible), 30, function () {
    // On lit le BLOC BRUT, pas lireObjets_() : celui-ci écarte les lignes
    // vides, si bien que son index ne correspond plus au numéro de ligne réel
    // du classeur. Une seule ligne vide au-dessus suffisait à faire écrire
    // `last_seen` sur la ligne d'un AUTRE terminal — le tableau de bord de la
    // flotte se serait mis à mentir sans que rien ne le signale.
    const feuille = onglet_(SHEETS.TERMINAUX);
    const index = indexEntetes_(feuille);
    const bloc = lireBloc_(feuille);
    if (index['terminal_id'] === undefined) return { _absent: true };

    for (let i = 0; i < bloc.lignes.length; i++) {
      if (String(bloc.lignes[i][index['terminal_id']]).trim() !== cible) continue;

      const trouve = {};
      bloc.entetes.forEach(function (entete, colonne) {
        const nom = String(entete).trim();
        if (nom) trouve[nom] = bloc.lignes[i][colonne];
      });
      trouve._ligne = i + 2;   // +1 en-tête, +1 index base 1 : ligne RÉELLE
      trouve.actif = versBooleen_(trouve.actif) || String(trouve.actif).trim() === '';
      if (!PROFILS_DONNEES[trouve.profil_donnees]) trouve.profil_donnees = PROFIL_PAR_DEFAUT;
      return trouve;
    }
    return { _absent: true };
  });
  return terminal && terminal._absent ? null : terminal;
}

/**
 * Met à jour last_seen et la version de base connue du terminal.
 *
 * Les deux colonnes sont adjacentes dans ENTETES.TERMINAUX : une seule
 * écriture suffit donc. Chaque appel à setValue déclenche une synchronisation
 * du classeur, les grouper divise le coût par deux.
 *
 * Aucun verrou : cette ligne n'a qu'un seul écrivain, le terminal lui-même.
 */
function marquerTerminalVu_(terminal, horodatage, since) {
  try {
    const feuille = onglet_(SHEETS.TERMINAUX);
    const index = indexEntetes_(feuille);
    const colVu = index['last_seen'];
    const colVersion = index['derniere_version_base'];

    if (colVu !== undefined && colVersion === colVu + 1) {
      feuille.getRange(terminal._ligne, colVu + 1, 1, 2).setValues([[horodatage, since]]);
      return;
    }
    // Repli si l'ordre des colonnes a été modifié à la main.
    if (colVu !== undefined) feuille.getRange(terminal._ligne, colVu + 1).setValue(horodatage);
    if (colVersion !== undefined) feuille.getRange(terminal._ligne, colVersion + 1).setValue(since);
  } catch (erreur) {
    console.error('marquerTerminalVu_ : ' + erreur);
  }
}

/**
 * « 🔄 Forcer la réindexation » — le vrai filet de sécurité derrière onEdit.
 *
 * RÈGLE IMPÉRATIVE : on ne réécrit PAS `_updated_at` en masse. Seules les
 * lignes dont l'empreinte a réellement changé sont réhorodatées. Une
 * réindexation aveugle provoquerait un re-sync intégral des 5 000 lignes sur
 * chaque mallette, en pleine exploitation.
 */
function forcerReindexation() {
  return avecVerrou_(function () {
    const feuille = onglet_(SHEETS.PARTICIPANTS);
    const colonnes = resoudreColonnes_(feuille, COLS_PARTICIPANTS);
    if (colonnes.row_hash < 0 || colonnes.updated_at < 0) {
      throw new Error('Colonnes techniques absentes : lancez d\'abord « Initialiser / mettre à jour la base ».');
    }

    const bloc = lireBloc_(feuille);
    if (!bloc.lignes.length) return { lignes: 0, lignes_modifiees: 0 };

    const horodatage = maintenant_();
    const hashs = [];
    const majs = [];
    let modifiees = 0;

    for (let i = 0; i < bloc.lignes.length; i++) {
      const ligne = bloc.lignes[i];
      const numero = colonnes.numero >= 0 ? String(ligne[colonnes.numero]).trim() : '';

      if (!numero) {
        // Ligne vide : on préserve l'existant plutôt que d'écrire du bruit.
        hashs.push([ligne[colonnes.row_hash]]);
        majs.push([ligne[colonnes.updated_at]]);
        continue;
      }

      const hashCalcule = hashLigne_(CHAMPS_HASHES.map(function (champ) {
        const position = colonnes[champ];
        return position >= 0 ? ligne[position] : '';
      }));
      const hashStocke = String(ligne[colonnes.row_hash] || '').trim();
      const majStockee = versEntier_(ligne[colonnes.updated_at], 0);

      if (hashCalcule === hashStocke && majStockee > 0) {
        hashs.push([hashStocke]);
        majs.push([majStockee]);
      } else {
        hashs.push([hashCalcule]);
        majs.push([horodatage]);
        modifiees++;
      }
    }

    feuille.getRange(2, colonnes.row_hash + 1, hashs.length, 1).setValues(hashs);
    feuille.getRange(2, colonnes.updated_at + 1, majs.length, 1).setValues(majs);

    if (modifiees > 0) majMaxUpdatedAt_(horodatage);
    PropertiesService.getScriptProperties().setProperty('DERNIERE_REINDEXATION', String(horodatage));

    return { lignes: bloc.lignes.length, lignes_modifiees: modifiees };
  }, 60000);
}

/** Version appelée par le menu, avec retour visuel. */
function menuForcerReindexation() {
  const resultat = forcerReindexation();
  SpreadsheetApp.getUi().alert(
    'Réindexation terminée',
    resultat.lignes + ' ligne(s) analysée(s).\n' +
    resultat.lignes_modifiees + ' ligne(s) réellement modifiée(s), donc renvoyée(s) aux terminaux.\n\n' +
    (resultat.lignes_modifiees === 0
      ? 'Aucun écart détecté : les terminaux sont déjà à jour.'
      : 'Ces lignes seront diffusées à la prochaine synchronisation.'),
    SpreadsheetApp.getUi().ButtonSet.OK);
}
