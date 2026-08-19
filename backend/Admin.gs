/**
 * Admin.gs — Supervision inter-decks, commandes et journal d'audit.
 *
 * Rappel de l'obstacle réseau qui commande toute cette mécanique : chaque
 * mallette est derrière son propre routeur 4G, donc derrière le CGNAT de
 * l'opérateur. Aucune connexion entrante n'est possible, un deck ne peut donc
 * PAS joindre un autre deck. Tout transite par ce backend, que les deux
 * interrogent déjà.
 */

/**
 * GET ?action=supervision&cible=<terminal>&jeton=<j>
 * Renvoie les derniers scans du deck visé, avec l'âge de la donnée.
 *
 * Aucun onglet d'état n'est nécessaire : on relit simplement le journal.
 */
function traiterSupervision(params, session) {
  const controle = autoriser_(session, 'superviser_deck');
  if (!controle.ok) return reponseErreur_(controle.erreur, controle.code);

  const cible = String(params.cible || '').trim();
  const terminalCible = chargerTerminal_(cible);
  if (!terminalCible) return reponseErreur_('Terminal inconnu : ' + cible, 'TERMINAL_INCONNU');

  const nombre = Math.min(versEntier_(params.nombre, 10), 50);
  const feuille = onglet_(SHEETS.SCANS);
  const bloc = lireBloc_(feuille);
  const index = {};
  bloc.entetes.forEach(function (e, i) { index[String(e).trim()] = i; });

  const scans = [];
  for (let i = bloc.lignes.length - 1; i >= 0 && scans.length < nombre; i--) {
    const ligne = bloc.lignes[i];
    if (String(ligne[index.terminal_id] || '').trim() !== cible) continue;
    scans.push({
      scan_id: String(ligne[index.scan_id] || ''),
      ts_terminal: versEntier_(ligne[index.ts_terminal], 0),
      uid: String(ligne[index.uid] || ''),
      numero: String(ligne[index.numero_participant] || ''),
      decision: String(ligne[index.decision] || ''),
      motif: String(ligne[index.motif] || ''),
      service: ligne[index.service] || ''
    });
  }

  // Bascule le deck cible en scrutation accélérée, pour un état frais et une
  // prise de commande quasi immédiate — le tout borné dans le temps.
  const config = lireConfig_();
  const duree = versEntier_(config.supervision_duree_s, 600);
  const expiration = maintenant_() + duree * 1000;
  ecrireChampTerminal_(terminalCible, 'supervision_jusqua', expiration);

  const derniereRemontee = versEntier_(terminalCible.last_seen, 0);
  journaliserAdmin_(session, 'superviser_deck', cible, 'ouverture supervision', 'OK');

  return reponseJson_({
    ok: true,
    cible: cible,
    libelle: terminalCible.libelle,
    point_controle: terminalCible.point_controle,
    derniere_remontee: derniereRemontee,
    // Cet âge est la donnée la plus importante de l'écran : il dit si l'on
    // regarde ce que l'agent a sous les yeux, ou son état d'il y a dix minutes.
    age_donnee_s: derniereRemontee ? Math.round((maintenant_() - derniereRemontee) / 1000) : null,
    supervision_jusqua: expiration,
    scans: scans,
    server_time: maintenant_()
  });
}

/**
 * GET ?action=flotte&jeton=<j>
 * Tableau de bord : tous les decks, leur retard de sync, leur état.
 */
function traiterFlotte(params, session) {
  const controle = autoriser_(session, 'superviser_deck');
  if (!controle.ok) return reponseErreur_(controle.erreur, controle.code);

  const horodatage = maintenant_();
  const config = lireConfig_();
  const terminaux = lireObjets_(SHEETS.TERMINAUX).map(function (t) {
    const vu = versEntier_(t.last_seen, 0);
    const cadence = versEntier_(t.sync_interval_s, versEntier_(config.sync_interval_defaut_s, 180));
    const retard = vu ? Math.round((horodatage - vu) / 1000) : null;
    return {
      terminal_id: String(t.terminal_id || ''),
      libelle: String(t.libelle || ''),
      point_controle: String(t.point_controle || ''),
      type: String(t.type || ''),
      actif: versBooleen_(t.actif),
      cadence_s: cadence,
      derniere_remontee: vu,
      retard_s: retard,
      // Un poste est « muet » s'il a manqué trois cycles : au-delà, ce n'est
      // plus un aléa réseau, c'est un problème à aller voir.
      muet: retard !== null && retard > cadence * 3
    };
  });

  return reponseJson_({ ok: true, terminaux: terminaux, server_time: horodatage });
}

/**
 * POST action=admin_command
 * Dépose une commande à destination d'un terminal, relevée à sa prochaine sync.
 */
function traiterAdminCommand(corps, session) {
  const type = String(corps.type || '').trim();
  const controle = autoriser_(session, type);
  if (!controle.ok) return reponseErreur_(controle.erreur, controle.code);

  const cible = String(corps.terminal_cible || '').trim();
  if (!cible) return reponseErreur_('terminal_cible manquant', 'CIBLE_MANQUANTE');
  if (!chargerTerminal_(cible)) return reponseErreur_('Terminal inconnu : ' + cible, 'TERMINAL_INCONNU');

  return avecVerrou_(function () {
    const feuille = onglet_(SHEETS.COMMANDES);
    const horodatage = maintenant_();
    const identifiant = uuid_();
    // Une commande non relevée dans les cinq minutes est périmée : mieux vaut
    // qu'elle expire que de voir un redémarrage surgir une heure plus tard.
    const expiration = horodatage + 300000;

    ajouterLignes_(feuille, [objetVersLigne_(feuille, {
      commande_id: identifiant,
      emise_par: session.nom + ' (' + session.role + ')',
      terminal_cible: cible,
      type: type,
      payload: JSON.stringify(corps.payload || {}),
      etat: 'EN_ATTENTE',
      ts_emission: horodatage,
      expire_le: expiration,
      ts_application: ''
    })]);

    // Lève le court-circuit de commandesEnAttente_ pour ce terminal.
    PropertiesService.getScriptProperties()
      .setProperty('CMD_' + cible, String(expiration));

    journaliserAdmin_(session, type, cible, JSON.stringify(corps.payload || {}).substring(0, 200), 'EMISE');
    return reponseJson_({ ok: true, commande_id: identifiant, expire_le: expiration });
  });
}

/**
 * Commandes en attente pour un terminal, jointes à sa réponse de sync.
 *
 * Court-circuit : `traiterAdminCommand` note dans les propriétés du script la
 * date d'expiration de la dernière commande émise pour chaque terminal. En
 * temps normal — c'est-à-dire presque toujours — aucune commande n'est en
 * vol, et on évite ainsi une lecture d'onglet à chaque cycle de 15 secondes.
 * Les commandes expirant en 5 minutes, le pire cas est une relecture inutile
 * pendant ce laps de temps.
 */
function commandesEnAttente_(terminalId) {
  const jalon = versEntier_(
    PropertiesService.getScriptProperties().getProperty('CMD_' + terminalId), 0);
  if (jalon < maintenant_()) return [];

  const feuille = onglet_(SHEETS.COMMANDES, false);
  if (!feuille) return [];
  const bloc = lireBloc_(feuille);
  const index = {};
  bloc.entetes.forEach(function (e, i) { index[String(e).trim()] = i; });
  if (index.commande_id === undefined) return [];

  const horodatage = maintenant_();
  const resultat = [];
  for (let i = 0; i < bloc.lignes.length; i++) {
    const ligne = bloc.lignes[i];
    if (String(ligne[index.terminal_cible] || '').trim() !== terminalId) continue;
    if (String(ligne[index.etat] || '').trim() !== 'EN_ATTENTE') continue;
    if (versEntier_(ligne[index.expire_le], 0) < horodatage) continue;
    resultat.push({
      commande_id: String(ligne[index.commande_id]),
      type: String(ligne[index.type]),
      payload: JSON.parse(String(ligne[index.payload] || '{}'))
    });
  }
  return resultat;
}

/**
 * POST action=ack_command
 * Le terminal confirme l'application. Idempotent : une commande déjà acquittée
 * ne repasse jamais à EN_ATTENTE, donc un rejeu ne redéclenche rien.
 */
function traiterAckCommand(corps) {
  const identifiant = String(corps.commande_id || '').trim();
  if (!identifiant) return reponseErreur_('commande_id manquant', 'PARAMETRE_MANQUANT');

  return avecVerrou_(function () {
    const feuille = onglet_(SHEETS.COMMANDES);
    const index = indexEntetes_(feuille);
    const bloc = lireBloc_(feuille);

    for (let i = 0; i < bloc.lignes.length; i++) {
      if (String(bloc.lignes[i][index.commande_id]).trim() !== identifiant) continue;
      const etat = String(bloc.lignes[i][index.etat]).trim();
      if (etat !== 'EN_ATTENTE') {
        return reponseJson_({ ok: true, deja_traitee: true, etat: etat });
      }
      feuille.getRange(i + 2, index.etat + 1).setValue(corps.resultat === 'ECHEC' ? 'ECHEC' : 'APPLIQUEE');
      feuille.getRange(i + 2, index.ts_application + 1).setValue(maintenant_());
      return reponseJson_({ ok: true, deja_traitee: false });
    }
    return reponseErreur_('Commande introuvable : ' + identifiant, 'COMMANDE_INTROUVABLE');
  });
}

/**
 * Verrouillage d'urgence : refus général sauf Staff.
 *
 * Pas de libération automatique — un verrou d'évacuation qui se relâcherait
 * tout seul serait dangereux. Il se lève explicitement.
 */
function traiterVerrouillage(corps, session) {
  const controle = autoriser_(session, 'verrouillage_urgence');
  if (!controle.ok) return reponseErreur_(controle.erreur, controle.code);

  const actif = versBooleen_(corps.actif) || corps.actif === true;
  const motif = String(corps.motif || '');
  const portee = String(corps.portee || 'FLOTTE').trim().toUpperCase();

  return avecVerrou_(function () {
    const feuille = onglet_(SHEETS.CONFIG);
    const bloc = lireBloc_(feuille);
    const index = {};
    bloc.entetes.forEach(function (e, i) { index[String(e).trim()] = i; });

    const cle = portee === 'FLOTTE' ? 'verrouillage_urgence' : 'verrouillage_' + portee;
    let ligneCible = -1;
    for (let i = 0; i < bloc.lignes.length; i++) {
      if (String(bloc.lignes[i][index.cle]).trim() === cle) { ligneCible = i + 2; break; }
    }

    const valeur = actif ? motif || 'Verrouillage d\'urgence' : '';
    if (ligneCible > 0) {
      feuille.getRange(ligneCible, index.valeur + 1).setValue(valeur);
    } else {
      ajouterLignes_(feuille, [[cle, valeur, 'Verrouillage d\'urgence — vide = inactif']]);
    }

    const horodatage = maintenant_();
    majMaxUpdatedAt_(horodatage);
    journaliserAdmin_(session, 'verrouillage_urgence', portee,
      (actif ? 'ACTIVÉ : ' : 'LEVÉ : ') + motif, 'OK');

    return reponseJson_({ ok: true, actif: actif, portee: portee, server_time: horodatage });
  });
}

/** Recherche d'un participant sans bracelet (opération STAFF). */
function traiterRecherche(params, session) {
  const controle = autoriser_(session, 'rechercher_participant');
  if (!controle.ok) return reponseErreur_(controle.erreur, controle.code);

  const requete = normaliserLibelle_(params.q || '');
  if (requete.length < 2) return reponseErreur_('Requête trop courte', 'REQUETE_COURTE');

  const feuille = onglet_(SHEETS.PARTICIPANTS);
  const colonnes = resoudreColonnes_(feuille, COLS_PARTICIPANTS);
  const bloc = lireBloc_(feuille);
  const resultats = [];

  for (let i = 0; i < bloc.lignes.length && resultats.length < 25; i++) {
    const ligne = bloc.lignes[i];
    const champs = ['numero', 'nom', 'prenom', 'ecole'].map(function (champ) {
      return colonnes[champ] >= 0 ? normaliserLibelle_(ligne[colonnes[champ]]) : '';
    }).join(' ');
    if (champs.indexOf(requete) === -1) continue;
    resultats.push({
      numero: String(ligne[colonnes.numero] || ''),
      nom: String(ligne[colonnes.nom] || ''),
      prenom: String(ligne[colonnes.prenom] || ''),
      ecole: colonnes.ecole >= 0 ? String(ligne[colonnes.ecole] || '') : '',
      statut: colonnes.statut >= 0 ? String(ligne[colonnes.statut] || '') : ''
    });
  }

  return reponseJson_({ ok: true, resultats: resultats });
}

/**
 * Écrit un champ sur la ligne d'un terminal, et invalide son cache.
 *
 * Sans cette invalidation, une bascule en supervision mettrait jusqu'à trente
 * secondes à prendre effet — soit dix cycles perdus alors que l'on cherche
 * précisément à réagir vite.
 */
function ecrireChampTerminal_(terminal, champ, valeur) {
  const feuille = onglet_(SHEETS.TERMINAUX);
  const index = indexEntetes_(feuille);
  if (index[champ] === undefined) return;
  feuille.getRange(terminal._ligne, index[champ] + 1).setValue(valeur);
  viderCache_(CACHE.terminal(String(terminal.terminal_id).trim()));
}

/**
 * Journal d'audit. Alimenté côté serveur et jamais modifiable depuis un
 * terminal : c'est ce qui rend les dérogations réellement traçables.
 */
function journaliserAdmin_(session, operation, cible, detail, resultat) {
  try {
    const feuille = onglet_(SHEETS.ADMIN_LOG, false);
    if (!feuille) return;
    ajouterLignes_(feuille, [objetVersLigne_(feuille, {
      ts: new Date(),
      role: session ? session.role : '',
      compte: session ? session.nom : '',
      terminal_id: session ? session.terminal_id : '',
      operation: operation,
      cible: cible || '',
      detail: detail || '',
      resultat: resultat || ''
    })]);
  } catch (erreur) {
    console.error('journaliserAdmin_ : ' + erreur);
  }
}

/**
 * « 🗑 Purger les données sensibles » — à lancer à la clôture de l'événement.
 * Vide les deux colonnes de commentaires, qui n'ont aucune raison de survivre
 * à l'édition (voir docs/RGPD.md).
 */
function menuPurgerDonneesSensibles() {
  const ui = SpreadsheetApp.getUi();
  const reponse = ui.alert(
    'Purger les données sensibles',
    'Les colonnes « Commentaire Participant » et « Note de sécurité » vont être ' +
    'définitivement vidées, et disparaîtront des terminaux à la prochaine ' +
    'synchronisation.\n\nCette action est irréversible. Continuer ?',
    ui.ButtonSet.YES_NO);
  if (reponse !== ui.Button.YES) return;

  const resultat = avecVerrou_(function () {
    const feuille = onglet_(SHEETS.PARTICIPANTS);
    const colonnes = resoudreColonnes_(feuille, COLS_PARTICIPANTS);
    const derniereLigne = feuille.getLastRow();
    if (derniereLigne < 2) return 0;

    let vidées = 0;
    [colonnes.commentaire, colonnes.note_secu].forEach(function (position) {
      if (position < 0) return;
      feuille.getRange(2, position + 1, derniereLigne - 1, 1).clearContent();
      vidées++;
    });

    // Les lignes doivent être réhorodatées, sinon les terminaux garderaient
    // indéfiniment en cache les commentaires qu'on vient d'effacer.
    const horodatage = maintenant_();
    const majs = [];
    for (let i = 2; i <= derniereLigne; i++) majs.push([horodatage]);
    feuille.getRange(2, colonnes.updated_at + 1, majs.length, 1).setValues(majs);
    rafraichirHashLignes_(feuille, 2, derniereLigne - 1);
    majMaxUpdatedAt_(horodatage);
    return vidées;
  }, 60000);

  journaliserAdmin_(null, 'purge_donnees_sensibles', 'Participants',
    resultat + ' colonne(s) vidée(s)', 'OK');
  ui.alert('Purge terminée', resultat + ' colonne(s) vidée(s). ' +
    'Les terminaux se mettront à jour à leur prochaine synchronisation.', ui.ButtonSet.OK);
}
