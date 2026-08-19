/**
 * Code.gs — Routeur HTTP et menu du classeur.
 *
 * RAPPEL À DESTINATION DES CLIENTS (surtout l'ESP32) : une URL de déploiement
 * Apps Script ne renvoie JAMAIS les données directement, elle répond par un
 * 302 vers script.googleusercontent.com. Sans suivi de redirection, le client
 * reçoit un corps vide avec un code « réussi » — c'est le piège n°1 de ce
 * projet, documenté dans docs/PIEGES.md.
 */

/** Point d'entrée GET. */
function doGet(e) {
  return router_(e, e && e.parameter ? e.parameter : {});
}

/** Point d'entrée POST : accepte du JSON brut comme un formulaire classique. */
function doPost(e) {
  let corps = {};
  try {
    if (e && e.postData && e.postData.contents) {
      corps = JSON.parse(e.postData.contents);
    }
  } catch (erreur) {
    corps = {};
  }
  // Les paramètres d'URL complètent le corps (pratique pour la clé et l'action).
  if (e && e.parameter) {
    Object.keys(e.parameter).forEach(function (cle) {
      if (corps[cle] === undefined) corps[cle] = e.parameter[cle];
    });
  }
  return router_(e, corps);
}

/**
 * Routeur commun. Toute action exige la clé partagée ; les actions
 * privilégiées exigent en plus un jeton de session valide.
 */
function router_(e, params) {
  try {
    const action = String(params.action || '').trim();
    if (!action) return reponseErreur_('Paramètre « action » manquant', 'ACTION_MANQUANTE');

    if (!verifierCleApi_(params.key)) {
      return reponseErreur_('Clé API invalide', 'CLE_INVALIDE');
    }

    // Actions ouvertes à tout terminal authentifié par la clé.
    switch (action) {
      case 'ping':
        return reponseJson_({ ok: true, server_time: maintenant_(), version_api: 1 });
      case 'sync':
        return traiterSync(params);
      case 'photo':
        return traiterPhoto(params);
      case 'log_scan':
        return traiterLogScan(params);
      case 'ack_command':
        return traiterAckCommand(params);
      case 'admin_login':
        return traiterAdminLogin(params);
    }

    // Actions privilégiées : jeton obligatoire, rôle vérifié dans chaque
    // fonction via autoriser_(). Le menu du terminal filtre déjà l'affichage,
    // mais c'est ici que se joue la véritable barrière.
    const session = chargerSession_(params.jeton);
    if (!session) return reponseErreur_('Session absente ou expirée', 'SESSION_EXPIREE');

    switch (action) {
      case 'update_status': {
        const controle = autoriser_(session, 'suspendre_bracelet');
        if (!controle.ok) return reponseErreur_(controle.erreur, controle.code);
        return traiterUpdateStatus(params, session);
      }
      case 'annuler_scan': {
        const controle = autoriser_(session, 'annuler_scan');
        if (!controle.ok) return reponseErreur_(controle.erreur, controle.code);
        return traiterAnnulerScan(params, session);
      }
      case 'ecrire_note': {
        const controle = autoriser_(session, 'ecrire_note_securite');
        if (!controle.ok) return reponseErreur_(controle.erreur, controle.code);
        return traiterEcrireNote(params, session);
      }
      case 'rechercher':
        return traiterRecherche(params, session);
      case 'supervision':
        return traiterSupervision(params, session);
      case 'flotte':
        return traiterFlotte(params, session);
      case 'admin_command':
        return traiterAdminCommand(params, session);
      case 'verrouillage':
        return traiterVerrouillage(params, session);
      default:
        return reponseErreur_('Action inconnue : ' + action, 'ACTION_INCONNUE');
    }
  } catch (erreur) {
    console.error('router_ : ' + erreur + '\n' + (erreur.stack || ''));
    return reponseErreur_(String(erreur.message || erreur), 'ERREUR_SERVEUR');
  }
}

/** Menu du classeur, accessible à un organisateur non-développeur. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('ARCHIPIADES')
    .addItem('⚙️ Initialiser / mettre à jour la base', 'initialiserBase')
    .addSeparator()
    .addItem('🔄 Forcer la réindexation', 'menuForcerReindexation')
    .addItem('🖼 Indexer les photos', 'menuIndexerPhotos')
    .addSeparator()
    .addItem('🔑 Afficher la clé API', 'menuAfficherCleApi')
    .addItem('♻️ Régénérer la clé API', 'menuRegenererCleApi')
    .addSeparator()
    .addItem('🗑 Purger les données sensibles', 'menuPurgerDonneesSensibles')
    .addToUi();
}
