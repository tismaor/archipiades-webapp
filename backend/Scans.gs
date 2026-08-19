/**
 * Scans.gs — Journal des passages et projection des repas.
 *
 * `Scans` est la source de vérité des consommations. La colonne
 * « Repas consommé(s) » de l'onglet Participants n'en est qu'un MIROIR lisible,
 * recalculé par le serveur. Aucun terminal n'écrit jamais dans cette colonne :
 * c'est ce qui évite que deux mallettes s'écrasent mutuellement et ce qui rend
 * l'historique rejouable en cas de litige.
 */

/**
 * POST action=log_scan
 * Corps : { key, terminal, scans: [ { scan_id, ts_terminal, uid, numero,
 *           decision, motif, service, annule_scan_id } ] }
 *
 * Idempotent par `scan_id` : un lot rejoué après une coupure réseau ne
 * consomme pas deux fois un repas.
 */
function traiterLogScan(corps) {
  const terminal = chargerTerminal_(corps.terminal);
  if (!terminal) return reponseErreur_('Terminal inconnu : ' + corps.terminal, 'TERMINAL_INCONNU');

  const entrants = Array.isArray(corps.scans) ? corps.scans : [];
  if (!entrants.length) return reponseJson_({ ok: true, enregistres: 0, ignores: 0 });

  return avecVerrou_(function () {
    const feuille = onglet_(SHEETS.SCANS);
    const index = indexEntetes_(feuille);
    const dejaVus = chargerScanIdsExistants_(feuille, index);

    const horodatageServeur = maintenant_();
    const nouvelles = [];
    const acceptes = [];
    let ignores = 0;

    entrants.forEach(function (scan) {
      const identifiant = String(scan.scan_id || '').trim();
      if (!identifiant) { ignores++; return; }
      if (dejaVus[identifiant]) { ignores++; return; }   // rejeu réseau : sans effet
      dejaVus[identifiant] = true;

      const enregistrement = {
        scan_id: identifiant,
        ts_terminal: versEntier_(scan.ts_terminal, horodatageServeur),
        terminal_id: terminal.terminal_id,
        point_controle: String(scan.point_controle || terminal.point_controle || ''),
        uid: normaliserUid_(scan.uid),
        numero_participant: String(scan.numero || scan.numero_participant || '').trim(),
        decision: String(scan.decision || '').trim(),
        motif: String(scan.motif || ''),
        service: versEntier_(scan.service, 0) || '',
        annule_scan_id: String(scan.annule_scan_id || ''),
        ts_serveur: horodatageServeur
      };

      nouvelles.push(objetVersLigne_(feuille, enregistrement));
      acceptes.push(enregistrement);
    });

    ajouterLignes_(feuille, nouvelles);

    // Le miroir n'est recalculé que pour les participants effectivement touchés.
    const impactes = {};
    acceptes.forEach(function (scan) {
      if (scan.numero_participant &&
          (scan.decision === DECISIONS.REPAS_SERVI || scan.decision === DECISIONS.ANNULATION)) {
        impactes[scan.numero_participant] = true;
      }
    });
    const numerosImpactes = Object.keys(impactes);
    if (numerosImpactes.length) projeterRepasConsommes_(numerosImpactes);

    return reponseJson_({
      ok: true,
      enregistres: nouvelles.length,
      ignores: ignores,
      server_time: horodatageServeur
    });
  }, 30000);
}

/**
 * Charge l'ensemble des scan_id déjà enregistrés.
 * On ne lit qu'UNE colonne : sur 20 000 passages, l'appel reste rapide, là où
 * relire tout l'onglet coûterait plusieurs secondes à chaque envoi.
 */
function chargerScanIdsExistants_(feuille, index) {
  const colonne = index['scan_id'];
  const derniereLigne = feuille.getLastRow();
  const ensemble = {};
  if (colonne === undefined || derniereLigne < 2) return ensemble;
  const valeurs = feuille.getRange(2, colonne + 1, derniereLigne - 1, 1).getValues();
  for (let i = 0; i < valeurs.length; i++) {
    const identifiant = String(valeurs[i][0]).trim();
    if (identifiant) ensemble[identifiant] = true;
  }
  return ensemble;
}

/**
 * Recalcule la colonne « Repas consommé(s) » à partir du journal, pour les
 * participants indiqués. Une annulation neutralise le scan qu'elle référence.
 */
function projeterRepasConsommes_(numeros) {
  const cibles = {};
  numeros.forEach(function (n) { cibles[String(n).trim()] = {}; });

  const feuilleScans = onglet_(SHEETS.SCANS);
  const bloc = lireBloc_(feuilleScans);
  const index = {};
  bloc.entetes.forEach(function (e, i) { index[String(e).trim()] = i; });
  if (index.numero_participant === undefined) return;

  // Premier passage : repérer les scans annulés.
  const annules = {};
  bloc.lignes.forEach(function (ligne) {
    const reference = String(ligne[index.annule_scan_id] || '').trim();
    if (reference) annules[reference] = true;
  });

  // Second passage : ne retenir que les repas servis non annulés.
  bloc.lignes.forEach(function (ligne) {
    const numero = String(ligne[index.numero_participant] || '').trim();
    if (!cibles[numero]) return;
    if (String(ligne[index.decision] || '').trim() !== DECISIONS.REPAS_SERVI) return;
    if (annules[String(ligne[index.scan_id] || '').trim()]) return;
    const service = versEntier_(ligne[index.service], 0);
    if (service > 0) cibles[numero][service] = true;
  });

  // Écriture du miroir dans l'onglet Participants.
  const feuille = onglet_(SHEETS.PARTICIPANTS);
  const colonnes = resoudreColonnes_(feuille, COLS_PARTICIPANTS);
  if (colonnes.repas_conso < 0 || colonnes.numero < 0) return;

  const blocParticipants = lireBloc_(feuille);
  const misesAJour = [];

  for (let i = 0; i < blocParticipants.lignes.length; i++) {
    const numero = String(blocParticipants.lignes[i][colonnes.numero]).trim();
    if (!cibles[numero]) continue;
    const services = Object.keys(cibles[numero])
      .map(function (s) { return parseInt(s, 10); })
      .sort(function (a, b) { return a - b; });
    const texte = services.length
      ? services.map(function (s) { return 'n°' + s; }).join(', ')
      : '';
    misesAJour.push({ ligne: i + 2, texte: texte });
  }

  // Écriture ciblée : quelques lignes seulement, jamais tout l'onglet.
  misesAJour.forEach(function (maj) {
    feuille.getRange(maj.ligne, colonnes.repas_conso + 1).setValue(maj.texte);
  });
}

/**
 * POST action=update_status
 * Association, réassociation ou changement de statut d'un bracelet.
 * Opération de niveau STAFF : le contrôle du rôle est fait par Admin.gs.
 */
function traiterUpdateStatus(corps, session) {
  const uid = normaliserUid_(corps.uid);
  if (!uid) return reponseErreur_('UID manquant', 'UID_MANQUANT');

  const statut = String(corps.statut || STATUT_BRACELET.ACTIF).trim().toUpperCase();
  if (!STATUT_BRACELET[statut]) {
    return reponseErreur_('Statut invalide : ' + statut, 'STATUT_INVALIDE');
  }

  const numero = String(corps.numero || '').trim();

  return avecVerrou_(function () {
    const feuille = onglet_(SHEETS.BRACELETS);
    const index = indexEntetes_(feuille);
    const bloc = lireBloc_(feuille);
    const horodatage = maintenant_();

    let ligneCible = -1;
    for (let i = 0; i < bloc.lignes.length; i++) {
      if (normaliserUid_(bloc.lignes[i][index.uid]) === uid) { ligneCible = i + 2; break; }
    }

    // Réassociation : l'ancien bracelet du participant bascule en PERDU, pour
    // qu'un bracelet retrouvé plus tard ne redonne pas l'accès par surprise.
    let ancienNeutralise = '';
    if (numero && statut === STATUT_BRACELET.ACTIF) {
      for (let i = 0; i < bloc.lignes.length; i++) {
        const memeParticipant = String(bloc.lignes[i][index.numero_participant]).trim() === numero;
        const autreBracelet = normaliserUid_(bloc.lignes[i][index.uid]) !== uid;
        const encoreActif = String(bloc.lignes[i][index.statut]).trim().toUpperCase() === STATUT_BRACELET.ACTIF;
        if (memeParticipant && autreBracelet && encoreActif) {
          feuille.getRange(i + 2, index.statut + 1).setValue(STATUT_BRACELET.PERDU);
          feuille.getRange(i + 2, index._updated_at + 1).setValue(horodatage);
          ancienNeutralise = normaliserUid_(bloc.lignes[i][index.uid]);
        }
      }
    }

    if (ligneCible > 0) {
      feuille.getRange(ligneCible, index.statut + 1).setValue(statut);
      if (numero) feuille.getRange(ligneCible, index.numero_participant + 1).setValue(numero);
      feuille.getRange(ligneCible, index._updated_at + 1).setValue(horodatage);
    } else {
      ajouterLignes_(feuille, [objetVersLigne_(feuille, {
        uid: uid,
        numero_participant: numero,
        statut: statut,
        date_association: new Date(),
        commentaire: String(corps.commentaire || ''),
        _updated_at: horodatage
      })]);
    }

    majMaxUpdatedAt_(horodatage);
    journaliserAdmin_(session, 'suspendre_bracelet', uid,
      'statut=' + statut + (numero ? ' participant=' + numero : '') +
      (ancienNeutralise ? ' ancien=' + ancienNeutralise + ' passé en PERDU' : ''), 'OK');

    return reponseJson_({
      ok: true,
      uid: uid,
      statut: statut,
      numero: numero,
      ancien_bracelet_neutralise: ancienNeutralise || null,
      server_time: horodatage
    });
  });
}

/**
 * Annulation d'un scan (opération ADMIN).
 * On n'efface JAMAIS la ligne d'origine : on ajoute une ligne d'annulation qui
 * la référence. La piste d'audit reste intacte et le repas est recrédité.
 */
function traiterAnnulerScan(corps, session) {
  const cible = String(corps.scan_id || '').trim();
  if (!cible) return reponseErreur_('scan_id manquant', 'SCAN_MANQUANT');

  return avecVerrou_(function () {
    const feuille = onglet_(SHEETS.SCANS);
    const bloc = lireBloc_(feuille);
    const index = {};
    bloc.entetes.forEach(function (e, i) { index[String(e).trim()] = i; });

    let origine = null;
    for (let i = 0; i < bloc.lignes.length; i++) {
      if (String(bloc.lignes[i][index.scan_id]).trim() === cible) { origine = bloc.lignes[i]; break; }
    }
    if (!origine) return reponseErreur_('Scan introuvable : ' + cible, 'SCAN_INTROUVABLE');

    const horodatage = maintenant_();
    const numero = String(origine[index.numero_participant] || '').trim();

    ajouterLignes_(feuille, [objetVersLigne_(feuille, {
      scan_id: uuid_(),
      ts_terminal: horodatage,
      terminal_id: String(corps.terminal || ''),
      point_controle: String(origine[index.point_controle] || ''),
      uid: String(origine[index.uid] || ''),
      numero_participant: numero,
      decision: DECISIONS.ANNULATION,
      motif: String(corps.motif || 'Annulation administrative'),
      service: origine[index.service] || '',
      annule_scan_id: cible,
      ts_serveur: horodatage
    })]);

    if (numero) projeterRepasConsommes_([numero]);
    journaliserAdmin_(session, 'annuler_scan', cible, 'participant=' + numero, 'OK');

    return reponseJson_({ ok: true, scan_annule: cible, participant: numero, server_time: horodatage });
  });
}

/**
 * Écriture d'une Note de sécurité (opération STAFF).
 * Écrire n'est pas lire : la diffusion de cette colonne reste gouvernée par le
 * profil de données du terminal, un poste REPAS peut donc signaler sans jamais
 * consulter ce que les autres ont écrit.
 */
function traiterEcrireNote(corps, session) {
  const numero = String(corps.numero || '').trim();
  const texte = String(corps.texte || '').trim();
  if (!numero || !texte) return reponseErreur_('numero et texte requis', 'PARAMETRES_MANQUANTS');

  return avecVerrou_(function () {
    const feuille = onglet_(SHEETS.PARTICIPANTS);
    const colonnes = resoudreColonnes_(feuille, COLS_PARTICIPANTS);
    if (colonnes.note_secu < 0) return reponseErreur_('Colonne « Note de sécurité » absente', 'COLONNE_ABSENTE');

    const bloc = lireBloc_(feuille);
    let ligneCible = -1;
    for (let i = 0; i < bloc.lignes.length; i++) {
      if (String(bloc.lignes[i][colonnes.numero]).trim() === numero) { ligneCible = i + 2; break; }
    }
    if (ligneCible < 0) return reponseErreur_('Participant introuvable : ' + numero, 'PARTICIPANT_INCONNU');

    // Une note s'ajoute, elle n'écrase pas les précédentes : l'horodatage et
    // l'auteur sont apposés automatiquement, comme l'exige la consigne de saisie.
    const existant = String(bloc.lignes[ligneCible - 2][colonnes.note_secu] || '').trim();
    const entete = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM HH:mm');
    const auteur = session && session.nom ? session.nom : 'inconnu';
    const nouvelle = '[' + entete + ' — ' + auteur + '] ' + texte;
    const valeur = existant ? existant + '\n' + nouvelle : nouvelle;

    const horodatage = maintenant_();
    feuille.getRange(ligneCible, colonnes.note_secu + 1).setValue(valeur);
    feuille.getRange(ligneCible, colonnes.updated_at + 1).setValue(horodatage);
    rafraichirHashLignes_(feuille, ligneCible, 1);
    majMaxUpdatedAt_(horodatage);

    journaliserAdmin_(session, 'ecrire_note_securite', numero, texte.substring(0, 120), 'OK');
    return reponseJson_({ ok: true, numero: numero, server_time: horodatage });
  });
}
