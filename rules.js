/**
 * rules.js — Moteur de décision. LE fichier le plus important du projet.
 *
 * Ce module est volontairement PUR : pas de DOM, pas de réseau, pas d'horloge
 * implicite (l'instant est toujours passé en paramètre). Trois raisons :
 *
 *  1. il est testable exhaustivement, sans navigateur ni matériel ;
 *  2. il sera porté tel quel en C++ à l'étape 3, et le banc de test sert alors
 *     de référence de parité — un même cas doit donner la même décision sur le
 *     téléphone et sur la mallette, sans quoi deux agents refuseraient
 *     différemment la même personne ;
 *  3. aucune décision ne dépend du réseau, conformément au principe n°1.
 *
 * Budget : moins de 50 ms par scan. Tout est en mémoire, aucune allocation
 * lourde, aucune recherche linéaire sur la base.
 */

'use strict';

/** Les six états de l'écran décision, plus les états du point repas. */
const ETATS = {
  NON_RECONNU:    'NON_RECONNU',
  AUTORISE:       'ACCES_AUTORISE',
  SUSPENDU:       'ACCES_SUSPENDU',
  ZONE:           'ZONE_NON_AUTORISEE',
  PASSBACK:       'PASSBACK_SUSPECTE',
  VERROUILLE:     'POSTE_VERROUILLE',
  REPAS_SERVI:    'REPAS_SERVI',
  REPAS_DEJA:     'REPAS_DEJA_CONSOMME',
  REPAS_HORS:     'REPAS_HORS_SERVICE',
  REPAS_NON_DU:   'REPAS_NON_DU'
};

/**
 * Couleurs de la charte : le fond reste noir, seul le pavé de décision porte
 * la couleur. `null` signifie « monochrome », ce qui est le cas nominal du
 * point repas — il informe, il ne juge pas.
 */
const COULEURS = {
  [ETATS.NON_RECONNU]:  'rouge',
  [ETATS.AUTORISE]:     'vert',
  [ETATS.SUSPENDU]:     'rouge',
  [ETATS.ZONE]:         'rouge',
  [ETATS.PASSBACK]:     'orange',
  [ETATS.VERROUILLE]:   'rouge',
  [ETATS.REPAS_SERVI]:  null,
  [ETATS.REPAS_DEJA]:   'orange',
  [ETATS.REPAS_HORS]:   null,
  [ETATS.REPAS_NON_DU]: 'orange'
};

/** Libellés affichés. Repris à l'identique sur les deux terminaux. */
const LIBELLES = {
  [ETATS.NON_RECONNU]:  'NON RECONNU',
  [ETATS.AUTORISE]:     'ACCÈS AUTORISÉ',
  [ETATS.SUSPENDU]:     'ACCÈS SUSPENDU',
  [ETATS.ZONE]:         'ACCÈS REFUSÉ — ZONE NON AUTORISÉE',
  [ETATS.PASSBACK]:     'PASSBACK SUSPECTÉ — CONTRÔLE RENFORCÉ REQUIS',
  [ETATS.VERROUILLE]:   'POSTE VERROUILLÉ',
  [ETATS.REPAS_SERVI]:  'REPAS SERVI',
  [ETATS.REPAS_DEJA]:   'REPAS DÉJÀ CONSOMMÉ',
  [ETATS.REPAS_HORS]:   'HORS SERVICE',
  [ETATS.REPAS_NON_DU]: 'REPAS NON INCLUS DANS LA FORMULE'
};

/**
 * Évalue un scan.
 *
 * @param {Object} e
 * @param {string} e.uid              UID du bracelet, en majuscules.
 * @param {string} e.point_controle   Point de contrôle du terminal.
 * @param {number} e.maintenant       Instant du scan, epoch ms.
 * @param {Object} e.base             { bracelets: Map, participants: Map }
 * @param {Object} e.refs             { droits, formules, services, config }
 * @param {Array}  e.scans_recents    Scans locaux récents, du plus récent au plus ancien.
 * @param {Object} e.verrouillage     { actif: bool, motif: string }
 * @return {Object} décision complète, prête à afficher.
 */
function evaluerScan(e) {
  const maintenant = e.maintenant;
  const point = e.point_controle;
  const refs = e.refs || {};
  const config = refs.config || {};
  const verrouillage = e.verrouillage || {};

  const bracelet = e.base.bracelets.get(e.uid) || null;
  const participant = bracelet ? (e.base.participants.get(bracelet.numero) || null) : null;

  // --- 1. UID inconnu, ou bracelet orphelin ---------------------------------
  // Testé AVANT le verrouillage : afficher l'UID en clair permet d'associer le
  // bracelet sur place, y compris pendant une évacuation.
  //
  // On distingue deux cas qui se ressemblent à l'écran mais appellent des
  // gestes opposés :
  //   - UID absent de la table    → bracelet jamais enregistré, à associer ;
  //   - bracelet SANS participant → la ligne existe mais son numéro est vide ou
  //     pointe vers un participant inexistant. C'est une erreur de saisie dans
  //     le classeur, pas un bracelet inconnu — et sans ce message, on chercherait
  //     longtemps du côté du bracelet.
  if (!bracelet) {
    return decision(ETATS.NON_RECONNU, {
      detail: 'Bracelet non enregistré',
      uid: e.uid
    });
  }
  if (!participant) {
    return decision(ETATS.NON_RECONNU, {
      detail: bracelet.numero
        ? 'Bracelet lié au participant ' + bracelet.numero + ', introuvable dans la base'
        : 'Bracelet enregistré mais sans numéro de participant',
      uid: e.uid
    });
  }

  const alerte = participant.commentaire ? String(participant.commentaire) : '';

  // --- 2. Verrouillage d'urgence -------------------------------------------
  // Certains statuts continuent de passer : ceux qui gèrent l'incident, et les
  // invités qu'on ne veut pas bloquer à un poste. La liste vient de l'onglet
  // `Config` — le terrain tranchera peut-être autrement, et cela ne doit pas
  // exiger une modification du code.
  if (verrouillage.actif && !statutFranchit(participant.statut, config)) {
    return decision(ETATS.VERROUILLE, {
      participant: participant,
      detail: verrouillage.motif || 'Verrouillage d\'urgence',
      alerte: alerte
    });
  }

  // --- 3. Bracelet ou participant neutralisé --------------------------------
  const statutBracelet = String(bracelet.statut || 'ACTIF').toUpperCase();
  if (statutBracelet === 'PERDU') {
    return decision(ETATS.SUSPENDU, {
      participant: participant,
      detail: 'Bracelet déclaré perdu — un remplacement a été émis',
      alerte: alerte
    });
  }
  if (statutBracelet === 'SUSPENDU') {
    return decision(ETATS.SUSPENDU, {
      participant: participant,
      detail: 'Bracelet suspendu',
      alerte: alerte
    });
  }
  if (participant.actif === false) {
    return decision(ETATS.SUSPENDU, {
      participant: participant,
      detail: 'Participant exclu ou suspendu',
      alerte: alerte
    });
  }

  // --- 4. Point repas : aucune question d'accès, on informe ----------------
  if (estPointRepas(point, refs)) {
    return evaluerRepas(e, participant, alerte);
  }

  // --- 5. Droits par statut sur ce point de contrôle -----------------------
  const droitsStatut = (refs.droits || {})[participant.statut];
  const autorise = droitsStatut ? droitsStatut[point] === true : false;
  if (!autorise) {
    return decision(ETATS.ZONE, {
      participant: participant,
      detail: 'Statut ' + participant.statut + ' — accès « ' + point + ' » non autorisé',
      alerte: alerte
    });
  }

  // --- 6. Anti-passback -----------------------------------------------------
  // Ce n'est PAS un refus : c'est une demande de contrôle approfondi, et
  // l'écran reste bloqué jusqu'à acquittement pour que le contrôle ait
  // réellement lieu.
  const fenetre = entier(config.antipassback_secondes, 120) * 1000;
  const precedent = dernierScanAutorise(e.scans_recents, e.uid, point);
  if (precedent && (maintenant - precedent.ts_terminal) < fenetre) {
    return decision(ETATS.PASSBACK, {
      participant: participant,
      detail: 'Déjà scanné il y a ' + Math.round((maintenant - precedent.ts_terminal) / 1000) +
              ' s au poste ' + (precedent.point_controle || point),
      alerte: alerte,
      bloquant: true,
      expiration_s: entier(config.passback_expiration_s, 60)
    });
  }

  // --- 7. Tout est en ordre -------------------------------------------------
  return decision(ETATS.AUTORISE, {
    participant: participant,
    detail: participant.statut,
    alerte: alerte
  });
}

/**
 * Point repas : on n'autorise ni ne refuse, on renseigne l'agent.
 * Le seul cas qui doit l'arrêter est un repas déjà décompté.
 */
function evaluerRepas(e, participant, alerte) {
  const refs = e.refs || {};
  const service = serviceEnCours(refs.services || [], e.maintenant);

  const infos = {
    formule: participant.formule || '',
    regime: participant.regime || 'Classique',
    repas_consommes: listerRepasConsommes(participant, e.scans_recents)
  };

  if (!service) {
    return decision(ETATS.REPAS_HORS, {
      participant: participant,
      detail: 'Aucun service en cours — rien n\'est décompté',
      alerte: alerte,
      repas: infos
    });
  }

  infos.service = service;

  const autorises = (refs.formules || {})[participant.formule] || [];
  if (autorises.indexOf(service.numero) === -1) {
    return decision(ETATS.REPAS_NON_DU, {
      participant: participant,
      detail: 'Formule « ' + (participant.formule || 'aucune') + ' » — ' +
              service.libelle + ' non inclus',
      alerte: alerte,
      repas: infos
    });
  }

  const deja = infos.repas_consommes.indexOf(service.numero) !== -1;
  if (deja) {
    const precedent = dernierRepas(e.scans_recents, e.uid, service.numero);
    return decision(ETATS.REPAS_DEJA, {
      participant: participant,
      detail: precedent
        ? 'Déjà servi à ' + heure(precedent.ts_terminal) + ' au poste ' + (precedent.terminal_id || '?')
        : 'Déjà décompté d\'après la dernière synchronisation',
      alerte: alerte,
      repas: infos
    });
  }

  return decision(ETATS.REPAS_SERVI, {
    participant: participant,
    detail: service.libelle + ' — ' + (participant.regime || 'Classique'),
    alerte: alerte,
    repas: infos,
    service: service.numero
  });
}

/* ─────────────────────────────── Helpers ─────────────────────────────── */

/** Construit l'objet de décision, uniforme quel que soit l'état. */
function decision(etat, options) {
  const o = options || {};
  const p = o.participant || null;
  return {
    etat: etat,
    libelle: LIBELLES[etat],
    couleur: COULEURS[etat],
    detail: o.detail || '',
    // Une alerte médicale ne doit JAMAIS être masquée par la couleur d'état :
    // un badge peut être parfaitement valide ET porter un risque d'épilepsie.
    alerte: o.alerte || '',
    bloquant: o.bloquant === true,
    expiration_s: o.expiration_s || 0,
    participant: p,
    repas: o.repas || null,
    service: o.service || 0,
    uid: o.uid || ''
  };
}

/** Un point de contrôle est un point repas si un service y est rattaché. */
function estPointRepas(point, refs) {
  return String(point || '').toUpperCase() === 'REPAS';
}

/**
 * Service actif à l'instant donné, d'après les plages horaires.
 * Les plages sont exprimées en minutes depuis minuit ; une plage qui franchit
 * minuit (22:00 → 01:00) est gérée explicitement, sinon un dîner tardif
 * cesserait d'être décompté au changement de jour.
 */
function serviceEnCours(services, maintenant) {
  const date = new Date(maintenant);
  const minutes = date.getHours() * 60 + date.getMinutes();
  for (let i = 0; i < services.length; i++) {
    const s = services[i];
    if (s.debut < 0 || s.fin < 0) continue;
    const dansLaPlage = s.debut <= s.fin
      ? (minutes >= s.debut && minutes <= s.fin)
      : (minutes >= s.debut || minutes <= s.fin);
    if (dansLaPlage) return s;
  }
  return null;
}

/**
 * Repas déjà consommés : union de ce que dit le serveur (dernière sync) et de
 * ce que ce terminal a servi depuis, encore en file d'envoi.
 *
 * C'est le cœur du compromis « optimiste puis réconcilié » : hors ligne, deux
 * terminaux peuvent servir le même repas, aucune architecture ne l'empêche.
 * On additionne au moins ce que l'on sait.
 */
function listerRepasConsommes(participant, scansRecents) {
  const services = {};

  // Miroir serveur, au format « n°1, n°3 ».
  String(participant.repas_conso || '').split(',').forEach(function (morceau) {
    const trouve = morceau.match(/(\d+)/);
    if (trouve) services[parseInt(trouve[1], 10)] = true;
  });

  // Scans locaux pas encore remontés.
  (scansRecents || []).forEach(function (scan) {
    if (scan.numero !== participant.numero) return;
    if (scan.decision === ETATS.REPAS_SERVI && scan.service > 0) {
      services[scan.service] = true;
    }
  });

  return Object.keys(services).map(Number).sort(function (a, b) { return a - b; });
}

/** Dernier scan autorisé de ce bracelet, tous points confondus. */
function dernierScanAutorise(scansRecents, uid, point) {
  const liste = scansRecents || [];
  for (let i = 0; i < liste.length; i++) {
    if (liste[i].uid !== uid) continue;
    if (liste[i].decision === ETATS.AUTORISE) return liste[i];
  }
  return null;
}

/** Dernier scan ayant servi ce numéro de repas à ce bracelet. */
function dernierRepas(scansRecents, uid, numeroService) {
  const liste = scansRecents || [];
  for (let i = 0; i < liste.length; i++) {
    if (liste[i].uid === uid &&
        liste[i].decision === ETATS.REPAS_SERVI &&
        liste[i].service === numeroService) {
      return liste[i];
    }
  }
  return null;
}

function heure(horodatage) {
  const d = new Date(horodatage);
  return (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' +
         (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
}

/**
 * Ce statut franchit-il un verrouillage d'urgence ?
 * Défaut « Staff » si la configuration n'est pas descendue — le plus restrictif.
 */
function statutFranchit(statut, config) {
  const autorises = (config && config.statuts_verrouillage) || ['Staff'];
  const cible = normaliser(statut);
  for (let i = 0; i < autorises.length; i++) {
    if (normaliser(autorises[i]) === cible) return true;
  }
  return false;
}

function normaliser(valeur) {
  return String(valeur == null ? '' : valeur)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function entier(valeur, repli) {
  const n = parseInt(valeur, 10);
  return isNaN(n) ? repli : n;
}

/* Export double : module Node pour les tests, global pour le navigateur. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { evaluerScan, ETATS, COULEURS, LIBELLES, serviceEnCours, listerRepasConsommes };
}
