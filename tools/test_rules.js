/**
 * test_rules.js — Banc de test du moteur de décision.
 *
 * CE FICHIER EST LA RÉFÉRENCE DE PARITÉ. À l'étape 3, le portage C++ devra
 * produire exactement les mêmes états sur exactement les mêmes cas. Un écart
 * signifie que deux agents refuseraient différemment la même personne — c'est
 * le pire défaut possible pour un contrôle d'accès.
 *
 * Le jeu de cas est exporté en JSON (`--export`) pour être rejoué tel quel par
 * le firmware.
 *
 *   node tools/test_rules.js
 *   node tools/test_rules.js --export tools/cas_de_test.json
 */

'use strict';

const path = require('path');
const { evaluerScan, ETATS } = require(path.join(__dirname, '..', 'webapp', 'rules.js'));

/* ─────────────────────────── Décor commun ─────────────────────────── */

// Samedi 18 h 30 — hors de tout service repas.
const HORS_SERVICE = new Date(2026, 7, 22, 18, 30, 0).getTime();
// Samedi 20 h 00 — pendant le service n°1.
const PENDANT_SERVICE_1 = new Date(2026, 7, 22, 20, 0, 0).getTime();
// Dimanche 12 h 30 — pendant le service n°2.
const PENDANT_SERVICE_2 = new Date(2026, 7, 23, 12, 30, 0).getTime();
// Samedi 23 h 30 — dans une plage qui franchit minuit.
const APRES_MINUIT = new Date(2026, 7, 22, 23, 30, 0).getTime();

const REFS = {
  droits: {
    'Staff':     { ENTREE: true,  TERRAIN: true,  VIP: true,  REPAS: true },
    'Sportif':   { ENTREE: true,  TERRAIN: true,  VIP: false, REPAS: true },
    'Supporter': { ENTREE: true,  TERRAIN: false, VIP: false, REPAS: true },
    'Bénévole':  { ENTREE: true,  TERRAIN: true,  VIP: false, REPAS: true }
  },
  formules: {
    'Pension complète': [1, 2, 3, 4],
    'Demi-pension': [2, 4],
    'Sans repas': []
  },
  services: [
    { numero: 1, libelle: 'Dîner samedi',      debut: 19 * 60,      fin: 22 * 60 },
    { numero: 2, libelle: 'Déjeuner dimanche', debut: 11 * 60 + 30, fin: 14 * 60 + 30 },
    // Plage franchissant minuit : 23:00 → 01:00.
    { numero: 3, libelle: 'Veillée',           debut: 23 * 60,      fin: 60 }
  ],
  config: { antipassback_secondes: 120, passback_expiration_s: 60 }
};

function participants(liste) {
  const m = new Map();
  liste.forEach(function (p) { m.set(p.numero, p); });
  return m;
}

function bracelets(liste) {
  const m = new Map();
  liste.forEach(function (b) { m.set(b.uid, b); });
  return m;
}

const ALICE = {
  numero: '0001A001', nom: 'Durand', prenom: 'Alice', statut: 'Sportif',
  actif: true, formule: 'Pension complète', regime: 'Classique',
  repas_conso: '', commentaire: ''
};
const BRUNO = {
  numero: '0002A002', nom: 'Martin', prenom: 'Bruno', statut: 'Supporter',
  actif: true, formule: 'Demi-pension', regime: 'Végétarien',
  repas_conso: '', commentaire: ''
};
const CHLOE = {
  numero: '0003A003', nom: 'Petit', prenom: 'Chloé', statut: 'Staff',
  actif: true, formule: 'Pension complète', regime: 'Classique',
  repas_conso: '', commentaire: 'Épilepsie — ne pas laisser seul'
};
const DAVID = {
  numero: '0004A004', nom: 'Roux', prenom: 'David', statut: 'Bénévole',
  actif: false, formule: 'Sans repas', regime: 'Classique',
  repas_conso: '', commentaire: ''
};

const BASE = {
  participants: participants([ALICE, BRUNO, CHLOE, DAVID]),
  bracelets: bracelets([
    { uid: 'AAA1', numero: '0001A001', statut: 'ACTIF' },
    { uid: 'BBB2', numero: '0002A002', statut: 'ACTIF' },
    { uid: 'CCC3', numero: '0003A003', statut: 'ACTIF' },
    { uid: 'DDD4', numero: '0004A004', statut: 'ACTIF' },
    { uid: 'PERD', numero: '0001A001', statut: 'PERDU' },
    { uid: 'SUSP', numero: '0002A002', statut: 'SUSPENDU' }
  ])
};

/* ─────────────────────────── Cas de test ─────────────────────────── */

const CAS = [
  /* --- Les six états de l'écran décision --- */
  {
    nom: 'UID inconnu → NON RECONNU, avec l\'UID affiché pour association',
    entree: { uid: 'ZZZZ', point_controle: 'ENTREE', maintenant: HORS_SERVICE },
    attendu: { etat: ETATS.NON_RECONNU, couleur: 'rouge' },
    verifications: function (d) { return d.uid === 'ZZZZ'; }
  },
  {
    nom: 'bracelet actif, droits accordés → ACCÈS AUTORISÉ',
    entree: { uid: 'AAA1', point_controle: 'ENTREE', maintenant: HORS_SERVICE },
    attendu: { etat: ETATS.AUTORISE, couleur: 'vert' }
  },
  {
    nom: 'bracelet déclaré perdu → ACCÈS SUSPENDU, motif explicite',
    entree: { uid: 'PERD', point_controle: 'ENTREE', maintenant: HORS_SERVICE },
    attendu: { etat: ETATS.SUSPENDU, couleur: 'rouge' },
    verifications: function (d) { return /perdu/i.test(d.detail); }
  },
  {
    nom: 'bracelet suspendu → ACCÈS SUSPENDU, motif distinct de « perdu »',
    entree: { uid: 'SUSP', point_controle: 'ENTREE', maintenant: HORS_SERVICE },
    attendu: { etat: ETATS.SUSPENDU, couleur: 'rouge' },
    verifications: function (d) { return !/perdu/i.test(d.detail); }
  },
  {
    nom: 'participant exclu, bracelet valide → ACCÈS SUSPENDU',
    entree: { uid: 'DDD4', point_controle: 'ENTREE', maintenant: HORS_SERVICE },
    attendu: { etat: ETATS.SUSPENDU, couleur: 'rouge' },
    verifications: function (d) { return /exclu|suspendu/i.test(d.detail); }
  },
  {
    nom: 'Supporter au TERRAIN → ZONE NON AUTORISÉE (le cas que l\'énumération oubliait)',
    entree: { uid: 'BBB2', point_controle: 'TERRAIN', maintenant: HORS_SERVICE },
    attendu: { etat: ETATS.ZONE, couleur: 'rouge' }
  },
  {
    nom: 'Sportif au TERRAIN → autorisé',
    entree: { uid: 'AAA1', point_controle: 'TERRAIN', maintenant: HORS_SERVICE },
    attendu: { etat: ETATS.AUTORISE, couleur: 'vert' }
  },
  {
    nom: 'statut absent de la matrice Droits → refus par défaut',
    entree: { uid: 'AAA1', point_controle: 'POINT_INCONNU', maintenant: HORS_SERVICE },
    attendu: { etat: ETATS.ZONE, couleur: 'rouge' }
  },

  /* --- Anti-passback --- */
  {
    nom: 're-scan à 30 s → PASSBACK SUSPECTÉ, écran BLOQUANT',
    entree: {
      uid: 'AAA1', point_controle: 'ENTREE', maintenant: HORS_SERVICE,
      scans_recents: [{ uid: 'AAA1', decision: ETATS.AUTORISE, ts_terminal: HORS_SERVICE - 30000,
                        point_controle: 'ENTREE' }]
    },
    attendu: { etat: ETATS.PASSBACK, couleur: 'orange' },
    verifications: function (d) { return d.bloquant === true && d.expiration_s === 60; }
  },
  {
    nom: 're-scan à 121 s → hors fenêtre, autorisé normalement',
    entree: {
      uid: 'AAA1', point_controle: 'ENTREE', maintenant: HORS_SERVICE,
      scans_recents: [{ uid: 'AAA1', decision: ETATS.AUTORISE, ts_terminal: HORS_SERVICE - 121000,
                        point_controle: 'ENTREE' }]
    },
    attendu: { etat: ETATS.AUTORISE, couleur: 'vert' },
    verifications: function (d) { return d.bloquant === false; }
  },
  {
    nom: 'passback détecté même depuis un AUTRE poste',
    entree: {
      uid: 'AAA1', point_controle: 'ENTREE', maintenant: HORS_SERVICE,
      scans_recents: [{ uid: 'AAA1', decision: ETATS.AUTORISE, ts_terminal: HORS_SERVICE - 10000,
                        point_controle: 'TERRAIN' }]
    },
    attendu: { etat: ETATS.PASSBACK, couleur: 'orange' },
    verifications: function (d) { return /TERRAIN/.test(d.detail); }
  },
  {
    nom: 'un refus précédent ne déclenche PAS de passback',
    entree: {
      uid: 'AAA1', point_controle: 'ENTREE', maintenant: HORS_SERVICE,
      scans_recents: [{ uid: 'AAA1', decision: ETATS.ZONE, ts_terminal: HORS_SERVICE - 10000 }]
    },
    attendu: { etat: ETATS.AUTORISE, couleur: 'vert' }
  },

  /* --- Verrouillage d'urgence --- */
  {
    nom: 'verrouillage actif → POSTE VERROUILLÉ pour un Sportif',
    entree: {
      uid: 'AAA1', point_controle: 'ENTREE', maintenant: HORS_SERVICE,
      verrouillage: { actif: true, motif: 'Évacuation' }
    },
    attendu: { etat: ETATS.VERROUILLE, couleur: 'rouge' },
    verifications: function (d) { return d.detail === 'Évacuation'; }
  },
  {
    nom: 'verrouillage actif → le Staff passe quand même',
    entree: {
      uid: 'CCC3', point_controle: 'ENTREE', maintenant: HORS_SERVICE,
      verrouillage: { actif: true, motif: 'Évacuation' }
    },
    attendu: { etat: ETATS.AUTORISE, couleur: 'vert' }
  },
  {
    nom: 'verrouillage actif → un UID inconnu reste identifiable',
    entree: {
      uid: 'ZZZZ', point_controle: 'ENTREE', maintenant: HORS_SERVICE,
      verrouillage: { actif: true, motif: 'Évacuation' }
    },
    attendu: { etat: ETATS.NON_RECONNU, couleur: 'rouge' }
  },

  /* --- Alerte médicale : jamais masquée par la couleur d'état --- */
  {
    nom: 'badge VALIDE + alerte médicale → les deux informations coexistent',
    entree: { uid: 'CCC3', point_controle: 'ENTREE', maintenant: HORS_SERVICE },
    attendu: { etat: ETATS.AUTORISE, couleur: 'vert' },
    verifications: function (d) { return /Épilepsie/.test(d.alerte); }
  },
  {
    nom: 'l\'alerte survit aussi à un refus',
    entree: {
      uid: 'CCC3', point_controle: 'ENTREE', maintenant: HORS_SERVICE,
      verrouillage: { actif: false }, forcerSuspension: true
    },
    prepare: function (entree) {
      entree.base = {
        participants: BASE.participants,
        bracelets: bracelets([{ uid: 'CCC3', numero: '0003A003', statut: 'SUSPENDU' }])
      };
    },
    attendu: { etat: ETATS.SUSPENDU, couleur: 'rouge' },
    verifications: function (d) { return /Épilepsie/.test(d.alerte); }
  },

  /* --- Point repas --- */
  {
    nom: 'repas hors de toute plage horaire → rien n\'est décompté',
    entree: { uid: 'AAA1', point_controle: 'REPAS', maintenant: HORS_SERVICE },
    attendu: { etat: ETATS.REPAS_HORS, couleur: null },
    verifications: function (d) { return d.service === 0; }
  },
  {
    nom: 'service 1 en cours, formule complète → REPAS SERVI, écran monochrome',
    entree: { uid: 'AAA1', point_controle: 'REPAS', maintenant: PENDANT_SERVICE_1 },
    attendu: { etat: ETATS.REPAS_SERVI, couleur: null },
    verifications: function (d) { return d.service === 1 && d.repas.regime === 'Classique'; }
  },
  {
    nom: 'demi-pension au dîner (service 1) → REPAS NON INCLUS',
    entree: { uid: 'BBB2', point_controle: 'REPAS', maintenant: PENDANT_SERVICE_1 },
    attendu: { etat: ETATS.REPAS_NON_DU, couleur: 'orange' }
  },
  {
    nom: 'demi-pension au déjeuner (service 2) → servi, régime végétarien remonté',
    entree: { uid: 'BBB2', point_controle: 'REPAS', maintenant: PENDANT_SERVICE_2 },
    attendu: { etat: ETATS.REPAS_SERVI, couleur: null },
    verifications: function (d) { return d.repas.regime === 'Végétarien' && d.service === 2; }
  },
  {
    nom: 'repas déjà décompté côté serveur → orange, seul cas qui arrête l\'agent',
    entree: { uid: 'AAA1', point_controle: 'REPAS', maintenant: PENDANT_SERVICE_1 },
    prepare: function (entree) {
      const alice = Object.assign({}, ALICE, { repas_conso: 'n°1' });
      entree.base = { participants: participants([alice]), bracelets: BASE.bracelets };
    },
    attendu: { etat: ETATS.REPAS_DEJA, couleur: 'orange' }
  },
  {
    nom: 'repas servi localement, pas encore remonté → détecté quand même',
    entree: {
      uid: 'AAA1', point_controle: 'REPAS', maintenant: PENDANT_SERVICE_1,
      scans_recents: [{ uid: 'AAA1', numero: '0001A001', decision: ETATS.REPAS_SERVI,
                        service: 1, ts_terminal: PENDANT_SERVICE_1 - 60000, terminal_id: 'DECK-02' }]
    },
    attendu: { etat: ETATS.REPAS_DEJA, couleur: 'orange' },
    verifications: function (d) { return /DECK-02/.test(d.detail); }
  },
  {
    nom: 'bracelet perdu présenté au point repas → suspendu, pas de repas',
    entree: { uid: 'PERD', point_controle: 'REPAS', maintenant: PENDANT_SERVICE_1 },
    attendu: { etat: ETATS.SUSPENDU, couleur: 'rouge' }
  },
  {
    nom: 'formule « Sans repas » → non inclus',
    entree: { uid: 'DDD4', point_controle: 'REPAS', maintenant: PENDANT_SERVICE_1 },
    prepare: function (entree) {
      const david = Object.assign({}, DAVID, { actif: true });
      entree.base = { participants: participants([david]), bracelets: BASE.bracelets };
    },
    attendu: { etat: ETATS.REPAS_NON_DU, couleur: 'orange' }
  },

  /* --- Plage horaire franchissant minuit --- */
  {
    nom: 'service 23:00 → 01:00, scan à 23:30 → dans la plage',
    entree: { uid: 'AAA1', point_controle: 'REPAS', maintenant: APRES_MINUIT },
    attendu: { etat: ETATS.REPAS_SERVI, couleur: null },
    verifications: function (d) { return d.service === 3; }
  },
  {
    nom: 'même service, scan à 00:30 le lendemain → toujours dans la plage',
    entree: {
      uid: 'AAA1', point_controle: 'REPAS',
      maintenant: new Date(2026, 7, 23, 0, 30, 0).getTime()
    },
    attendu: { etat: ETATS.REPAS_SERVI, couleur: null },
    verifications: function (d) { return d.service === 3; }
  },
  {
    nom: 'même service, scan à 02:00 → hors plage',
    entree: {
      uid: 'AAA1', point_controle: 'REPAS',
      maintenant: new Date(2026, 7, 23, 2, 0, 0).getTime()
    },
    attendu: { etat: ETATS.REPAS_HORS, couleur: null }
  }
];

/* ─────────────────────────────── Exécution ─────────────────────────────── */

let reussis = 0;
let echecs = 0;
const exportables = [];

CAS.forEach(function (cas) {
  const entree = Object.assign({
    base: BASE, refs: REFS, scans_recents: [], verrouillage: { actif: false }
  }, cas.entree);
  if (cas.prepare) cas.prepare(entree);

  let decision;
  try {
    decision = evaluerScan(entree);
  } catch (erreur) {
    echecs++;
    console.log('  \x1b[31m✗\x1b[0m ' + cas.nom + '\n      → exception : ' + erreur.message);
    return;
  }

  const ecarts = [];
  if (decision.etat !== cas.attendu.etat) {
    ecarts.push('état attendu ' + cas.attendu.etat + ', obtenu ' + decision.etat);
  }
  if (decision.couleur !== cas.attendu.couleur) {
    ecarts.push('couleur attendue ' + cas.attendu.couleur + ', obtenue ' + decision.couleur);
  }
  if (cas.verifications && !cas.verifications(decision)) {
    ecarts.push('vérification spécifique non satisfaite — ' + JSON.stringify({
      detail: decision.detail, alerte: decision.alerte,
      service: decision.service, bloquant: decision.bloquant
    }));
  }

  if (ecarts.length) {
    echecs++;
    console.log('  \x1b[31m✗\x1b[0m ' + cas.nom);
    ecarts.forEach(function (e) { console.log('      → ' + e); });
  } else {
    reussis++;
    console.log('  \x1b[32m✓\x1b[0m ' + cas.nom);
  }

  exportables.push({
    nom: cas.nom,
    uid: entree.uid,
    point_controle: entree.point_controle,
    maintenant: entree.maintenant,
    etat_attendu: cas.attendu.etat,
    couleur_attendue: cas.attendu.couleur
  });
});

console.log('\n' + '─'.repeat(66));
console.log(reussis + ' réussi(s), ' + echecs + ' échec(s) sur ' + CAS.length + ' cas.');
console.log('─'.repeat(66));

const indexExport = process.argv.indexOf('--export');
if (indexExport !== -1 && process.argv[indexExport + 1]) {
  require('fs').writeFileSync(process.argv[indexExport + 1],
    JSON.stringify(exportables, null, 2), 'utf8');
  console.log('\nJeu de cas exporté vers ' + process.argv[indexExport + 1]);
  console.log('À rejouer à l\'identique par le firmware C++ (étape 3).');
}

process.exit(echecs === 0 ? 0 : 1);
