/**
 * Auth.gs — Clé partagée des terminaux et sessions privilégiées.
 *
 * Deux mécanismes distincts, à ne pas confondre :
 *  - la CLÉ API authentifie un terminal (toute requête doit la porter) ;
 *  - un JETON DE SESSION authentifie une personne en mode STAFF ou ADMIN.
 *
 * Rappel de conception : la carte RFID n'est jamais un secret. Un UID NTAG se
 * lit et se clone avec du matériel à trente euros ; elle ne sert qu'à ouvrir
 * la saisie. C'est la phrase de passe qui authentifie.
 */

/** Vérifie la clé partagée présente dans chaque requête. */
function verifierCleApi_(cle) {
  const attendue = PropertiesService.getScriptProperties().getProperty(PROP.API_KEY);
  if (!attendue) throw new Error('Clé API non configurée : lancez « Initialiser / mettre à jour la base ».');
  return egaliteConstante_(cle, attendue);
}

/**
 * POST action=admin_login
 * Corps : { key, uid_carte, phrase_de_passe, terminal_id }
 *
 * Seul le rôle ADMIN est vérifié ici. Le rôle STAFF se vérifie LOCALEMENT sur
 * le terminal, à partir des empreintes descendues dans le delta : réassocier
 * un bracelet doit fonctionner réseau coupé, c'est précisément le moment où
 * l'on en a besoin.
 */
function traiterAdminLogin(corps) {
  const uidCarte = normaliserUid_(corps.uid_carte);
  const phrase = String(corps.phrase_de_passe || '');
  const terminalId = String(corps.terminal_id || '').trim();

  if (!uidCarte || !phrase) {
    return reponseErreur_('Carte et phrase de passe requises', 'IDENTIFIANTS_MANQUANTS');
  }

  const compte = chargerCompte_(uidCarte);

  // Message d'erreur volontairement identique dans les deux cas : il ne doit
  // pas révéler si c'est la carte ou la phrase de passe qui est en cause.
  if (!compte || !compte.actif) {
    journaliserAdmin_(null, 'admin_login', uidCarte, 'carte inconnue ou révoquée', 'REFUS');
    return reponseErreur_('Identifiants refusés', 'REFUS');
  }

  if (!egaliteConstante_(hashPhrase_(phrase, compte.sel), compte.hash_mdp)) {
    journaliserAdmin_(null, 'admin_login', uidCarte, 'phrase de passe incorrecte', 'REFUS');
    return reponseErreur_('Identifiants refusés', 'REFUS');
  }

  const config = lireConfig_();
  const duree = versEntier_(config.session_admin_s, 900);
  const jeton = uuid_().replace(/-/g, '');
  const expiration = maintenant_() + duree * 1000;

  // Le jeton vit dans le cache du script : il expire tout seul, et ne laisse
  // aucune trace persistante à voler.
  CacheService.getScriptCache().put('SESSION_' + jeton, JSON.stringify({
    uid_carte: uidCarte,
    nom: compte.nom,
    role: compte.role,
    terminal_id: terminalId,
    expire: expiration
  }), duree);

  journaliserAdmin_({ nom: compte.nom, role: compte.role, terminal_id: terminalId },
    'admin_login', terminalId, 'ouverture de session', 'OK');

  return reponseJson_({
    ok: true,
    jeton: jeton,
    role: compte.role,
    nom: compte.nom,
    expire: expiration,
    operations: OPERATIONS_PAR_ROLE[compte.role] || [],
    inactivite_s: versEntier_(config.session_inactivite_s, 180)
  });
}

/** Charge un compte privilégié par l'UID de sa carte. */
function chargerCompte_(uidCarte) {
  const lignes = lireObjets_(SHEETS.COMPTES);
  for (let i = 0; i < lignes.length; i++) {
    if (normaliserUid_(lignes[i].uid_carte) === uidCarte) {
      const compte = lignes[i];
      compte.actif = versBooleen_(compte.actif);
      compte.role = String(compte.role || ROLES.STAFF).trim().toUpperCase();
      return compte;
    }
  }
  return null;
}

/** Relit une session à partir de son jeton. Renvoie null si expirée ou inconnue. */
function chargerSession_(jeton) {
  if (!jeton) return null;
  const brut = CacheService.getScriptCache().get('SESSION_' + String(jeton).trim());
  if (!brut) return null;
  const session = JSON.parse(brut);
  if (session.expire < maintenant_()) return null;
  return session;
}

/**
 * Autorise une opération pour une session donnée.
 *
 * CONTRÔLE CÔTÉ SERVEUR, PAS SEULEMENT DANS LE MENU : un compte STAFF qui
 * forgerait une requête ADMIN hors de l'interface doit être refusé ici.
 */
function autoriser_(session, operation) {
  if (!session) return { ok: false, erreur: 'Session absente ou expirée', code: 'SESSION_EXPIREE' };
  const autorisees = OPERATIONS_PAR_ROLE[session.role] || [];
  if (autorisees.indexOf(operation) === -1) {
    journaliserAdmin_(session, operation, '', 'opération hors du rôle ' + session.role, 'REFUS');
    return { ok: false, erreur: 'Opération non autorisée pour le rôle ' + session.role, code: 'ROLE_INSUFFISANT' };
  }
  return { ok: true };
}

/**
 * Crée ou mets à jour un compte privilégié depuis l'éditeur de script.
 * À utiliser une fois par personne, puis à supprimer de l'historique : la
 * phrase de passe ne doit jamais rester écrite quelque part.
 *
 * Exemple : creerCompte('04A1B2C3D4E5F6', 'Mathis', 'ADMIN', 'ma phrase de passe longue')
 */
function creerCompte(uidCarte, nom, role, phraseDePasse) {
  if (!uidCarte || !nom || !phraseDePasse) {
    throw new Error('Usage : creerCompte(uidCarte, nom, role, phraseDePasse)');
  }
  const roleNormalise = String(role || ROLES.STAFF).trim().toUpperCase();
  if (!ROLES[roleNormalise]) throw new Error('Rôle inconnu : ' + role + ' (STAFF ou ADMIN)');
  if (String(phraseDePasse).length < 12) {
    throw new Error('Phrase de passe trop courte : 12 caractères minimum. ' +
                    'Faute de bcrypt côté Apps Script, la longueur est la seule vraie protection.');
  }

  return avecVerrou_(function () {
    const feuille = onglet_(SHEETS.COMPTES);
    const index = indexEntetes_(feuille);
    const bloc = lireBloc_(feuille);
    const uid = normaliserUid_(uidCarte);
    const sel = uuid_().replace(/-/g, '');
    const horodatage = maintenant_();

    let ligneCible = -1;
    for (let i = 0; i < bloc.lignes.length; i++) {
      if (normaliserUid_(bloc.lignes[i][index.uid_carte]) === uid) { ligneCible = i + 2; break; }
    }

    const donnees = {
      uid_carte: uid,
      nom: nom,
      role: roleNormalise,
      hash_mdp: hashPhrase_(phraseDePasse, sel),
      sel: sel,
      actif: true,
      _updated_at: horodatage
    };

    if (ligneCible > 0) {
      const ligne = objetVersLigne_(feuille, donnees);
      feuille.getRange(ligneCible, 1, 1, ligne.length).setValues([ligne]);
    } else {
      ajouterLignes_(feuille, [objetVersLigne_(feuille, donnees)]);
    }

    viderCache_(['CARTES_V1']);
    return 'Compte ' + roleNormalise + ' enregistré pour ' + nom +
           '. Pensez à effacer la phrase de passe de l\'éditeur de script.';
  });
}

/** Affiche la clé API dans une boîte de dialogue (menu). */
function menuAfficherCleApi() {
  const cle = PropertiesService.getScriptProperties().getProperty(PROP.API_KEY);
  SpreadsheetApp.getUi().alert(
    'Clé API',
    cle
      ? 'Clé partagée des terminaux :\n\n' + cle +
        '\n\nÀ recopier dans le config.json de chaque mallette et dans la Web App.'
      : 'Aucune clé : lancez « Initialiser / mettre à jour la base ».',
    SpreadsheetApp.getUi().ButtonSet.OK);
}

/** Régénère la clé API — invalide TOUS les terminaux jusqu'à reconfiguration. */
function menuRegenererCleApi() {
  const ui = SpreadsheetApp.getUi();
  const reponse = ui.alert(
    'Régénérer la clé API',
    'Tous les terminaux cesseront de se synchroniser jusqu\'à ce que vous ayez ' +
    'recopié la nouvelle clé dans chacun d\'eux.\n\nÀ ne pas faire en pleine exploitation. Continuer ?',
    ui.ButtonSet.YES_NO);
  if (reponse !== ui.Button.YES) return;
  PropertiesService.getScriptProperties().setProperty(PROP.API_KEY, uuid_().replace(/-/g, ''));
  menuAfficherCleApi();
}
