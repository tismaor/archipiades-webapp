/**
 * test_backend.js — Banc de test local du backend Apps Script.
 *
 * Apps Script ne se teste pas hors de Google, sauf à simuler ses API. C'est ce
 * que fait ce fichier : il recrée en mémoire SpreadsheetApp, Utilities,
 * PropertiesService, CacheService et LockService, puis charge les .gs dans un
 * contexte unique — exactement comme le fait Google, où tous les fichiers
 * partagent la même portée globale.
 *
 * On vérifie ainsi la LOGIQUE (delta, idempotence, profils, rôles) avant tout
 * déploiement. Ce qui ne peut pas être testé ici (Drive, déclencheurs, le
 * fameux 302) est signalé comme tel et listé dans docs/API.md.
 *
 * Usage : node tools/test_backend.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const RACINE = path.join(__dirname, '..');
const DOSSIER_BACKEND = path.join(RACINE, 'backend');

/* ───────────────────────── Simulation des API Google ───────────────────────── */

/** Un onglet en mémoire : une matrice de cellules. */
class FeuilleSimulee {
  constructor(nom, valeurs) {
    this.nom = nom;
    this.valeurs = valeurs || [];
  }
  getName() { return this.nom; }
  getLastRow() { return this.valeurs.length; }
  getLastColumn() {
    return this.valeurs.reduce((max, ligne) => Math.max(max, ligne.length), 0);
  }
  setFrozenRows() { return this; }
  setFrozenColumns() { return this; }

  _garantir(ligne, colonne) {
    while (this.valeurs.length < ligne) this.valeurs.push([]);
    for (const l of this.valeurs) while (l.length < colonne) l.push('');
  }

  getRange(ligne, colonne, nbLignes, nbColonnes) {
    nbLignes = nbLignes || 1;
    nbColonnes = nbColonnes || 1;
    this._garantir(ligne + nbLignes - 1, colonne + nbColonnes - 1);
    const feuille = this;
    return {
      getValues() {
        const sortie = [];
        for (let i = 0; i < nbLignes; i++) {
          const source = feuille.valeurs[ligne - 1 + i] || [];
          const cible = [];
          for (let j = 0; j < nbColonnes; j++) {
            cible.push(source[colonne - 1 + j] === undefined ? '' : source[colonne - 1 + j]);
          }
          sortie.push(cible);
        }
        return sortie;
      },
      setValues(donnees) {
        for (let i = 0; i < donnees.length; i++) {
          for (let j = 0; j < donnees[i].length; j++) {
            feuille.valeurs[ligne - 1 + i][colonne - 1 + j] = donnees[i][j];
          }
        }
        return this;
      },
      setValue(valeur) { return this.setValues([[valeur]]); },
      clearContent() {
        for (let i = 0; i < nbLignes; i++) {
          for (let j = 0; j < nbColonnes; j++) {
            feuille.valeurs[ligne - 1 + i][colonne - 1 + j] = '';
          }
        }
        return this;
      },
      setBackground() { return this; },
      setFontColor() { return this; },
      setFontWeight() { return this; },
      setNumberFormat() { return this; },
      setDataValidation() { return this; }
    };
  }
}

class ClasseurSimule {
  constructor() { this.feuilles = new Map(); }
  getSheetByName(nom) { return this.feuilles.get(nom) || null; }
  insertSheet(nom) {
    const feuille = new FeuilleSimulee(nom, []);
    this.feuilles.set(nom, feuille);
    return feuille;
  }
  ajouter(nom, valeurs) {
    const feuille = new FeuilleSimulee(nom, valeurs);
    this.feuilles.set(nom, feuille);
    return feuille;
  }
}

const classeur = new ClasseurSimule();
const alertes = [];
const proprietes = new Map();
const cache = new Map();

const contexte = {
  console,
  SpreadsheetApp: {
    getActive: () => classeur,
    getUi: () => ({
      alert: (titre, message) => { alertes.push({ titre, message }); return 'OK'; },
      ButtonSet: { OK: 'OK', YES_NO: 'YES_NO' },
      Button: { YES: 'YES', NO: 'NO' },
      createMenu: () => {
        const menu = {
          addItem: () => menu, addSeparator: () => menu, addToUi: () => menu
        };
        return menu;
      }
    }),
    newDataValidation: () => ({
      requireValueInList: () => ({ build: () => ({}) })
    })
  },
  Utilities: {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    computeDigest(algo, texte) {
      const condense = crypto.createHash('sha256').update(texte, 'utf8').digest();
      // Apps Script renvoie des octets SIGNÉS (-128..127) : le code de
      // production en dépend, la simulation doit reproduire ce détail.
      return Array.from(condense).map((o) => (o > 127 ? o - 256 : o));
    },
    getUuid: () => crypto.randomUUID(),
    base64Encode: (octets) => Buffer.from(octets).toString('base64'),
    formatDate: (date, fuseau, format) => {
      const p = (n) => String(n).padStart(2, '0');
      if (format === 'yyyy-MM-dd') {
        return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
      }
      return `${p(date.getDate())}/${p(date.getMonth() + 1)} ${p(date.getHours())}:${p(date.getMinutes())}`;
    }
  },
  Session: { getScriptTimeZone: () => 'Europe/Paris' },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (cle) => (proprietes.has(cle) ? proprietes.get(cle) : null),
      setProperty: (cle, valeur) => { proprietes.set(cle, String(valeur)); }
    })
  },
  CacheService: {
    getScriptCache: () => ({
      get: (cle) => (cache.has(cle) ? cache.get(cle) : null),
      // La durée de vie est ignorée : les tests doivent vérifier que le code
      // invalide EXPLICITEMENT ses caches, sans jamais compter sur l'expiration.
      put: (cle, valeur) => { cache.set(cle, valeur); },
      remove: (cle) => { cache.delete(cle); },
      removeAll: (cles) => { cles.forEach((cle) => cache.delete(cle)); }
    })
  },
  LockService: {
    getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} })
  },
  ScriptApp: {
    getProjectTriggers: () => [],
    newTrigger: () => {
      const t = {
        forSpreadsheet: () => t, onEdit: () => t, timeBased: () => t,
        everyHours: () => t, create: () => ({})
      };
      return t;
    },
    deleteTrigger: () => {}
  },
  DriveApp: {
    getFolderById: () => { throw new Error('Drive non simulé'); },
    getFileById: () => { throw new Error('Drive non simulé'); }
  },
  ContentService: {
    MimeType: { JSON: 'application/json' },
    createTextOutput: (texte) => ({
      _texte: texte,
      setMimeType() { return this; },
      getContent() { return this._texte; }
    })
  }
};

vm.createContext(contexte);

/**
 * Apps Script partage une portée globale entre tous les fichiers .gs, y compris
 * pour les `const` de premier niveau. Dans un contexte `vm`, ces déclarations
 * restent lexicales et n'apparaissent pas sur l'objet de contexte. On les
 * convertit donc en `var` — uniquement en colonne 0, donc jamais les
 * déclarations internes aux fonctions, qui sont toutes indentées.
 */
function adapterPortee(source) {
  return source.replace(/^(const|let)\s/gm, 'var ');
}

// L'ordre reproduit celui de Google : tous les fichiers partagent une portée.
['Config.gs', 'Utils.gs', 'Migration.gs', 'Sync.gs', 'Scans.gs',
 'Auth.gs', 'Admin.gs', 'Photos.gs', 'Code.gs'].forEach((nom) => {
  const source = fs.readFileSync(path.join(DOSSIER_BACKEND, nom), 'utf8');
  vm.runInContext(adapterPortee(source), contexte, { filename: nom });
});

/* ─────────────────────────── Micro-cadre de test ─────────────────────────── */

let reussis = 0;
let echecs = 0;
const details = [];

function verifier(intitule, condition, indice) {
  if (condition) {
    reussis++;
    details.push('  ✓ ' + intitule);
  } else {
    echecs++;
    details.push('  ✗ ' + intitule + (indice ? '\n      → ' + indice : ''));
  }
}

function section(titre) {
  details.push('\n' + titre);
}

/** Appelle le routeur et renvoie l'objet JSON décodé. */
function appeler(params) {
  const sortie = contexte.doPost({ parameter: {}, postData: { contents: JSON.stringify(params) } });
  return JSON.parse(sortie.getContent());
}

/* ──────────────────────────── Jeu de données ──────────────────────────── */

const CLE = 'cle-de-test';
proprietes.set('API_KEY', CLE);

const ENTETES_PARTICIPANTS = [
  'Numéro du participant', 'École', 'Nom', 'Prénom', 'Date de Naissance', 'Email',
  'Numéro de Téléphone', 'Sexe', 'Taille Vêtement', 'Statut', 'Sport(s)', 'Camping',
  'Formule Repas', 'Régime alimentaire', 'Repas consommé(s)', "Photo d'identité",
  'Commentaire Participant', 'Note de sécurité',
  '_updated_at', '_statut_participant', '_photo_file_id', '_photo_prete', '_row_hash'
];

function participant(numero, nom, prenom, statut, options) {
  const o = options || {};
  return [
    numero, o.ecole || 'Lycée Test', nom, prenom, '2001-05-12',
    'test@example.org', '0600000000', 'M', 'L', statut,
    o.sports || 'Football', 'Non', o.formule || 'Pension complète',
    o.regime || 'Classique', '', o.photo || '',
    o.commentaire || '', o.note || '',
    o.maj || 1000, o.actif || 'ACTIF', '', o.photoPrete || false, ''
  ];
}

classeur.ajouter(contexte.SHEETS.PARTICIPANTS, [
  ENTETES_PARTICIPANTS,
  participant('0001A001', 'Durand', 'Alice', 'Sportif', { commentaire: 'Épilepsie' }),
  participant('0002A002', 'Martin', 'Bruno', 'Supporter', { regime: 'Végétarien' }),
  participant('0003A003', 'Petit', 'Chloé', 'Staff', { note: 'Comportement à surveiller' }),
  participant('0004A004', 'Roux', 'David', 'Bénévole', { actif: 'SUSPENDU' })
]);

classeur.ajouter(contexte.SHEETS.BRACELETS, [
  contexte.ENTETES.BRACELETS,
  ['04A1B2C3D4E5F6', '0001A001', 'ACTIF', '', '', 1000],
  ['04B1B2C3D4E5F6', '0002A002', 'ACTIF', '', '', 1000],
  ['04C1B2C3D4E5F6', '0003A003', 'PERDU', '', '', 1000]
]);

classeur.ajouter(contexte.SHEETS.DROITS, [
  ['statut', 'ENTREE', 'TERRAIN', 'REPAS'],
  ['Staff', 'OUI', 'OUI', 'OUI'],
  ['Sportif', 'OUI', 'OUI', 'OUI'],
  ['Supporter', 'OUI', 'NON', 'OUI'],
  ['Bénévole', 'OUI', 'OUI', 'OUI']
]);

classeur.ajouter(contexte.SHEETS.FORMULES, [
  contexte.ENTETES.FORMULES,
  ['Pension complète', '1,2,3,4', 'Tous les repas'],
  ['Demi-pension', '2,4', 'Déjeuners']
]);

classeur.ajouter(contexte.SHEETS.SERVICES, [
  contexte.ENTETES.SERVICES,
  [1, 'Dîner samedi', '19:00', '22:00'],
  [2, 'Déjeuner dimanche', '11:30', '14:30']
]);

classeur.ajouter(contexte.SHEETS.SCANS, [contexte.ENTETES.SCANS]);
classeur.ajouter(contexte.SHEETS.COMMANDES, [contexte.ENTETES.COMMANDES]);
classeur.ajouter(contexte.SHEETS.ADMIN_LOG, [contexte.ENTETES.ADMIN_LOG]);
classeur.ajouter(contexte.SHEETS.COMPTES, [contexte.ENTETES.COMPTES]);

classeur.ajouter(contexte.SHEETS.TERMINAUX, [
  contexte.ENTETES.TERMINAUX,
  ['DECK-01', 'Entrée', 'ENTREE', 'DECK', 'ENTREE', 15, '', '', true, '', ''],
  ['DECK-02', 'Repas', 'REPAS', 'DECK', 'REPAS', 180, '', '', true, '', ''],
  ['DECK-03', 'PC sécurité', 'ENTREE', 'DECK', 'SECURITE', 60, '', '', true, '', ''],
  ['DECK-04', 'Désactivé', 'ENTREE', 'DECK', 'ENTREE', 60, '', '', false, '', '']
]);

classeur.ajouter(contexte.SHEETS.CONFIG, [
  contexte.ENTETES.CONFIG,
  ...contexte.CONFIG_DEFAUTS
]);

/* ─────────────────────────────── Les tests ─────────────────────────────── */

section('Authentification par clé partagée');
{
  const refus = appeler({ action: 'ping', key: 'mauvaise-cle' });
  verifier('une clé invalide est refusée', refus.ok === false && refus.code === 'CLE_INVALIDE');

  const ok = appeler({ action: 'ping', key: CLE });
  verifier('une clé valide passe', ok.ok === true && typeof ok.server_time === 'number');

  verifier('la comparaison de clé est à temps constant',
    contexte.egaliteConstante_('abc', 'abc') && !contexte.egaliteConstante_('abc', 'abd'));
}

section('Réindexation — le filet derrière onEdit');
{
  const premier = contexte.forcerReindexation();
  verifier('première passe : les 4 lignes sont horodatées',
    premier.lignes_modifiees === 4, 'obtenu ' + premier.lignes_modifiees);

  const second = contexte.forcerReindexation();
  verifier('seconde passe à vide : AUCUNE ligne réhorodatée',
    second.lignes_modifiees === 0,
    'obtenu ' + second.lignes_modifiees + ' — une réindexation aveugle re-syncerait tout le classeur');

  // Modification d'une seule cellule métier.
  const feuille = classeur.getSheetByName(contexte.SHEETS.PARTICIPANTS);
  feuille.valeurs[1][2] = 'Durand-Modifié';
  const troisieme = contexte.forcerReindexation();
  verifier('une cellule modifiée ne fait remonter QUE sa ligne',
    troisieme.lignes_modifiees === 1, 'obtenu ' + troisieme.lignes_modifiees);
}

section('Synchronisation différentielle');
{
  const complet = appeler({ action: 'sync', key: CLE, terminal: 'DECK-01', since: 0 });
  verifier('since=0 renvoie tous les participants',
    complet.participants.length === 4, 'obtenu ' + complet.participants.length);
  verifier('les bracelets accompagnent le delta', complet.bracelets.length === 3);
  verifier('les tables de référence sont jointes au premier appel', !!complet.refs);
  verifier('la cadence du terminal est renvoyée', complet.sync_interval_s === 15);

  const maxConnu = Math.max(...complet.participants.map((p) => p.maj));
  const vide = appeler({ action: 'sync', key: CLE, terminal: 'DECK-01', since: maxConnu });
  verifier('un delta sans changement est vide',
    vide.participants.length === 0, 'obtenu ' + vide.participants.length);

  const memeVersion = appeler({
    action: 'sync', key: CLE, terminal: 'DECK-01', since: maxConnu, refs: complet.refs_version
  });
  verifier('les références ne sont pas réémises si la version est identique', !memeVersion.refs);

  const inconnu = appeler({ action: 'sync', key: CLE, terminal: 'DECK-99', since: 0 });
  verifier('un terminal inconnu est refusé', inconnu.code === 'TERMINAL_INCONNU');

  const desactive = appeler({ action: 'sync', key: CLE, terminal: 'DECK-04', since: 0 });
  verifier('un terminal désactivé est refusé', desactive.code === 'TERMINAL_DESACTIVE');
}

section('Pagination par clé composite (collage de masse)');
{
  // On force le même horodatage sur toutes les lignes, comme le ferait un
  // collage de 500 lignes : une pagination sur le seul timestamp sauterait
  // des lignes ou boucleraient indéfiniment.
  const feuille = classeur.getSheetByName(contexte.SHEETS.PARTICIPANTS);
  for (let i = 1; i < feuille.valeurs.length; i++) feuille.valeurs[i][18] = 5000;

  const page1 = appeler({ action: 'sync', key: CLE, terminal: 'DECK-01', since: 0, limite: 2 });
  verifier('la première page est bornée à la limite demandée', page1.participants.length === 2);
  verifier('la suite est signalée', page1.suite === true);

  const page2 = appeler({
    action: 'sync', key: CLE, terminal: 'DECK-01',
    since: page1.since_suivant, apres: page1.apres_suivant, limite: 2
  });
  const numeros1 = page1.participants.map((p) => p.numero);
  const numeros2 = page2.participants.map((p) => p.numero);
  const chevauchement = numeros1.filter((n) => numeros2.indexOf(n) !== -1);
  verifier('la seconde page ne chevauche pas la première',
    chevauchement.length === 0, 'doublons : ' + chevauchement.join(','));
  verifier('les deux pages couvrent bien les 4 participants',
    new Set([...numeros1, ...numeros2]).size === 4,
    'obtenu ' + new Set([...numeros1, ...numeros2]).size);
}

section('Profils de données — la barrière RGPD');
{
  const entree = appeler({ action: 'sync', key: CLE, terminal: 'DECK-01', since: 0 });
  const chloe = entree.participants.find((p) => p.numero === '0003A003');
  verifier('profil ENTREE : pas de Note de sécurité', chloe.note_secu === undefined);
  verifier('profil ENTREE : pas de régime alimentaire', chloe.regime === undefined);
  verifier('profil ENTREE : le Commentaire Participant EST transmis',
    entree.participants.find((p) => p.numero === '0001A001').commentaire === 'Épilepsie');
  verifier('aucun profil ne transmet l\'email', chloe.email === undefined);
  verifier('aucun profil ne transmet le téléphone', chloe.telephone === undefined);
  verifier('aucun profil ne transmet la date de naissance', chloe.naissance === undefined);

  const repas = appeler({ action: 'sync', key: CLE, terminal: 'DECK-02', since: 0 });
  const bruno = repas.participants.find((p) => p.numero === '0002A002');
  verifier('profil REPAS : le régime est transmis (nécessité logistique)',
    bruno.regime === 'Végétarien');
  verifier('profil REPAS : toujours pas de Note de sécurité',
    repas.participants.find((p) => p.numero === '0003A003').note_secu === undefined);

  const secu = appeler({ action: 'sync', key: CLE, terminal: 'DECK-03', since: 0 });
  verifier('profil SECURITE : la Note de sécurité est transmise',
    secu.participants.find((p) => p.numero === '0003A003').note_secu === 'Comportement à surveiller');
  verifier('profil SECURITE : pas de régime alimentaire',
    secu.participants.find((p) => p.numero === '0002A002').regime === undefined);

  const suspendu = entree.participants.find((p) => p.numero === '0004A004');
  verifier('l\'état actif/suspendu accompagne tous les profils', suspendu.actif === false);
}

section('Journal des scans — idempotence');
{
  const lot = [
    { scan_id: 'S-001', ts_terminal: 1, uid: '04A1B2C3D4E5F6', numero: '0001A001',
      decision: 'ACCES_AUTORISE', motif: '' },
    { scan_id: 'S-002', ts_terminal: 2, uid: '04B1B2C3D4E5F6', numero: '0002A002',
      decision: 'REPAS_SERVI', service: 1 }
  ];

  const premier = appeler({ action: 'log_scan', key: CLE, terminal: 'DECK-01', scans: lot });
  verifier('le lot est enregistré', premier.enregistres === 2, JSON.stringify(premier));

  const rejeu = appeler({ action: 'log_scan', key: CLE, terminal: 'DECK-01', scans: lot });
  verifier('un lot rejoué n\'écrit RIEN (pas de double repas)',
    rejeu.enregistres === 0 && rejeu.ignores === 2, JSON.stringify(rejeu));

  const feuille = classeur.getSheetByName(contexte.SHEETS.SCANS);
  verifier('le journal contient exactement 2 lignes',
    feuille.valeurs.length === 3, 'obtenu ' + (feuille.valeurs.length - 1));
}

section('Projection des repas — Scans fait foi');
{
  const participants = classeur.getSheetByName(contexte.SHEETS.PARTICIPANTS);
  const colRepas = ENTETES_PARTICIPANTS.indexOf('Repas consommé(s)');
  verifier('le repas servi est projeté dans la colonne miroir',
    String(participants.valeurs[2][colRepas]) === 'n°1',
    'obtenu « ' + participants.valeurs[2][colRepas] + ' »');

  // Annulation : on n'efface jamais, on ajoute une ligne d'annulation.
  const scans = classeur.getSheetByName(contexte.SHEETS.SCANS);
  const lignesAvant = scans.valeurs.length;
  const session = { nom: 'Test', role: 'ADMIN', terminal_id: 'DECK-01' };
  contexte.traiterAnnulerScan({ scan_id: 'S-002', terminal: 'DECK-01' }, session);

  verifier('l\'annulation AJOUTE une ligne au lieu d\'en supprimer une',
    scans.valeurs.length === lignesAvant + 1);
  verifier('la ligne d\'origine est toujours présente',
    scans.valeurs.some((l) => String(l[0]) === 'S-002'));
  verifier('le repas est recrédité dans le miroir',
    String(participants.valeurs[2][colRepas]) === '',
    'obtenu « ' + participants.valeurs[2][colRepas] + ' »');
}

section('Rôles STAFF / ADMIN — contrôle côté serveur');
{
  contexte.creerCompte('04AAAAAAAAAAAA', 'Chef de poste', 'STAFF', 'phrase de passe staff longue');
  contexte.creerCompte('04BBBBBBBBBBBB', 'Mathis', 'ADMIN', 'phrase de passe admin encore plus longue');

  const mauvaise = appeler({
    action: 'admin_login', key: CLE, uid_carte: '04AAAAAAAAAAAA',
    phrase_de_passe: 'mauvaise', terminal_id: 'DECK-01'
  });
  verifier('une phrase de passe erronée est refusée', mauvaise.ok === false);
  verifier('le message ne dit pas si c\'est la carte ou la phrase',
    mauvaise.erreur === 'Identifiants refusés');

  const carteInconnue = appeler({
    action: 'admin_login', key: CLE, uid_carte: '04ZZZZZZZZZZZZ',
    phrase_de_passe: 'peu importe', terminal_id: 'DECK-01'
  });
  verifier('une carte inconnue donne le MÊME message qu\'une phrase erronée',
    carteInconnue.erreur === mauvaise.erreur);

  const staff = appeler({
    action: 'admin_login', key: CLE, uid_carte: '04AAAAAAAAAAAA',
    phrase_de_passe: 'phrase de passe staff longue', terminal_id: 'DECK-01'
  });
  verifier('le STAFF ouvre bien une session', staff.ok === true && staff.role === 'STAFF');
  verifier('le STAFF ne reçoit pas les opérations ADMIN',
    staff.operations.indexOf('verrouillage_urgence') === -1 &&
    staff.operations.indexOf('annuler_scan') === -1);
  verifier('le STAFF reçoit bien ses propres opérations',
    staff.operations.indexOf('reassocier_bracelet') !== -1 &&
    staff.operations.indexOf('ecrire_note_securite') !== -1 &&
    staff.operations.indexOf('suspendre_bracelet') !== -1);

  const admin = appeler({
    action: 'admin_login', key: CLE, uid_carte: '04BBBBBBBBBBBB',
    phrase_de_passe: 'phrase de passe admin encore plus longue', terminal_id: 'DECK-01'
  });
  verifier('l\'ADMIN ouvre une session avec ses opérations',
    admin.ok === true && admin.operations.indexOf('verrouillage_urgence') !== -1);

  // LE test qui compte : une requête ADMIN forgée avec un jeton STAFF,
  // hors de toute interface, doit être refusée par le serveur.
  const forgee = appeler({
    action: 'verrouillage', key: CLE, jeton: staff.jeton, actif: true, motif: 'tentative'
  });
  verifier('une opération ADMIN forgée avec un jeton STAFF est REFUSÉE',
    forgee.ok === false && forgee.code === 'ROLE_INSUFFISANT', JSON.stringify(forgee));

  const legitime = appeler({
    action: 'verrouillage', key: CLE, jeton: admin.jeton, actif: true, motif: 'évacuation'
  });
  verifier('la même opération passe avec un jeton ADMIN', legitime.ok === true);

  const sansJeton = appeler({ action: 'flotte', key: CLE });
  verifier('une action privilégiée sans jeton est refusée',
    sansJeton.code === 'SESSION_EXPIREE');

  // Révocation : le compte est désactivé dans le classeur.
  const comptes = classeur.getSheetByName(contexte.SHEETS.COMPTES);
  const colActif = contexte.ENTETES.COMPTES.indexOf('actif');
  comptes.valeurs[1][colActif] = false;
  const revoque = appeler({
    action: 'admin_login', key: CLE, uid_carte: '04AAAAAAAAAAAA',
    phrase_de_passe: 'phrase de passe staff longue', terminal_id: 'DECK-01'
  });
  verifier('une carte révoquée n\'ouvre plus rien', revoque.ok === false);
}

section('Écriture d\'une Note de sécurité — écrire n\'est pas lire');
{
  const admin = appeler({
    action: 'admin_login', key: CLE, uid_carte: '04BBBBBBBBBBBB',
    phrase_de_passe: 'phrase de passe admin encore plus longue', terminal_id: 'DECK-02'
  });
  const ecriture = appeler({
    action: 'ecrire_note', key: CLE, jeton: admin.jeton,
    numero: '0001A001', texte: 'Refus de contrôle au poste B à 15h10'
  });
  verifier('la note est écrite', ecriture.ok === true, JSON.stringify(ecriture));

  const entree = appeler({ action: 'sync', key: CLE, terminal: 'DECK-01', since: 0 });
  const alice = entree.participants.find((p) => p.numero === '0001A001');
  verifier('un poste ENTREE ne reçoit pas la note qu\'on vient d\'écrire',
    alice.note_secu === undefined);

  const secu = appeler({ action: 'sync', key: CLE, terminal: 'DECK-03', since: 0 });
  const aliceSecu = secu.participants.find((p) => p.numero === '0001A001');
  verifier('un poste SECURITE la reçoit',
    String(aliceSecu.note_secu).indexOf('Refus de contrôle') !== -1);
  verifier('la note est horodatée et attribuée automatiquement',
    /^\[\d{2}\/\d{2} \d{2}:\d{2} — Mathis\]/.test(String(aliceSecu.note_secu)));
}

section('Réassociation de bracelet');
{
  const staff = appeler({
    action: 'admin_login', key: CLE, uid_carte: '04BBBBBBBBBBBB',
    phrase_de_passe: 'phrase de passe admin encore plus longue', terminal_id: 'DECK-01'
  });
  const resultat = appeler({
    action: 'update_status', key: CLE, jeton: staff.jeton,
    uid: '04NOUVEAU00001', numero: '0001A001', statut: 'ACTIF'
  });
  verifier('le nouveau bracelet est associé', resultat.ok === true);
  verifier('l\'ancien bracelet est automatiquement neutralisé',
    resultat.ancien_bracelet_neutralise === '04A1B2C3D4E5F6',
    'obtenu ' + resultat.ancien_bracelet_neutralise);

  const delta = appeler({ action: 'sync', key: CLE, terminal: 'DECK-01', since: 0 });
  const ancien = delta.bracelets.find((b) => b.uid === '04A1B2C3D4E5F6');
  verifier('l\'ancien bracelet remonte en PERDU dans le delta', ancien.statut === 'PERDU');
}

section('Commandes et supervision');
{
  const admin = appeler({
    action: 'admin_login', key: CLE, uid_carte: '04BBBBBBBBBBBB',
    phrase_de_passe: 'phrase de passe admin encore plus longue', terminal_id: 'DECK-01'
  });

  const commande = appeler({
    action: 'admin_command', key: CLE, jeton: admin.jeton,
    terminal_cible: 'DECK-02', type: 'redemarrer_deck', payload: {}
  });
  verifier('la commande est déposée', commande.ok === true && !!commande.commande_id);

  const sync = appeler({ action: 'sync', key: CLE, terminal: 'DECK-02', since: 0 });
  verifier('le terminal cible reçoit la commande dans sa sync',
    sync.commandes.length === 1 && sync.commandes[0].type === 'redemarrer_deck');

  const ack = appeler({ action: 'ack_command', key: CLE, commande_id: commande.commande_id });
  verifier('l\'acquittement est accepté', ack.ok === true && ack.deja_traitee === false);

  const rejeu = appeler({ action: 'ack_command', key: CLE, commande_id: commande.commande_id });
  verifier('un acquittement rejoué ne réapplique rien', rejeu.deja_traitee === true);

  const apres = appeler({ action: 'sync', key: CLE, terminal: 'DECK-02', since: 0 });
  verifier('la commande acquittée ne revient plus', apres.commandes.length === 0);

  const supervision = appeler({
    action: 'supervision', key: CLE, jeton: admin.jeton, cible: 'DECK-01'
  });
  verifier('la supervision renvoie les scans du deck visé', supervision.ok === true);
  verifier('l\'âge de la donnée est explicite',
    supervision.age_donnee_s !== undefined);

  const cadence = appeler({ action: 'sync', key: CLE, terminal: 'DECK-01', since: 0 });
  verifier('le deck supervisé passe en scrutation accélérée',
    cadence.sync_interval_s === 3 && cadence.supervision_active === true,
    'cadence obtenue : ' + cadence.sync_interval_s);
}

section('Caches — le risque introduit par l\'optimisation');
{
  // Les tables de référence sont mémorisées pour tenir la cadence de 15 s.
  // Une matrice Droits périmée appliquerait silencieusement d'anciennes règles
  // d'accès : l'invalidation doit donc être vérifiée, pas supposée.
  const avant = appeler({ action: 'sync', key: CLE, terminal: 'DECK-01', since: 0 });
  const versionAvant = avant.refs_version;

  // Sportif/TERRAIN vaut OUI dans le jeu de départ : on le bascule à NON pour
  // que le contenu change RÉELLEMENT, sinon le hash resterait identique et le
  // test ne prouverait rien.
  const droits = classeur.getSheetByName(contexte.SHEETS.DROITS);
  droits.valeurs[2][2] = 'NON';

  const sansInvalidation = appeler({ action: 'sync', key: CLE, terminal: 'DECK-01', since: 0 });
  verifier('sans invalidation, le cache sert encore l\'ancienne matrice',
    sansInvalidation.refs_version === versionAvant,
    'le cache ne fonctionne pas — la performance mesurée serait fausse');

  // C'est ce que fait le déclencheur onEdit sur l'onglet Droits.
  contexte.viderCache_([contexte.CACHE.REFERENCES, contexte.CACHE.CONFIG]);

  const apres = appeler({ action: 'sync', key: CLE, terminal: 'DECK-01', since: 0 });
  verifier('après invalidation, la nouvelle matrice est diffusée',
    apres.refs_version !== versionAvant, 'version inchangée : ' + apres.refs_version);
  verifier('la modification est bien celle attendue',
    apres.refs.droits['Sportif'].TERRAIN === false,
    JSON.stringify(apres.refs.droits['Sportif']));

  // Le cache des terminaux, lui, doit céder dès qu'une supervision démarre.
  const terminaux = classeur.getSheetByName(contexte.SHEETS.TERMINAUX);
  const colCadence = contexte.ENTETES.TERMINAUX.indexOf('sync_interval_s');
  terminaux.valeurs[2][colCadence] = 42;
  contexte.viderCache_(contexte.CACHE.terminal('DECK-02'));
  const cadence = appeler({ action: 'sync', key: CLE, terminal: 'DECK-02', since: 0 });
  verifier('l\'invalidation d\'un terminal reprend bien sa nouvelle cadence',
    cadence.sync_interval_s === 42, 'obtenu ' + cadence.sync_interval_s);
}

section('UID avec separateurs — le piege de la saisie manuelle');
{
  // Web NFC renvoie « 04:a1:b2:… » : un organisateur recopiera naturellement
  // les deux-points dans le classeur, alors que le terminal compare une chaine
  // hexadecimale continue.
  const feuille = classeur.getSheetByName(contexte.SHEETS.BRACELETS);
  feuille.valeurs.push(['04:aa:bb:cc:dd:ee:01', '0001A001', 'ACTIF', '', '',
                        contexte.maintenant_()]);

  // `since: 0` — un `since` artificiellement grand déclencherait le
  // court-circuit « rien de neuf » et le test ne prouverait rien.
  const delta = appeler({ action: 'sync', key: CLE, terminal: 'DECK-01', since: 0 });
  const trouve = delta.bracelets.find(function (b) { return b.uid === '04AABBCCDDEE01'; });
  verifier('un UID saisi avec deux-points est normalisé pour le terminal',
    !!trouve, 'uids reçus : ' + delta.bracelets.map(function (b) { return b.uid; }).join(', '));

  verifier('la casse minuscule est également normalisée',
    contexte.normaliserUid_('04aabb') === '04AABB');
  verifier('espaces et tirets sont neutralisés',
    contexte.normaliserUid_('04-AA BB') === '04AABB');
}

section('Extraction des identifiants Drive');
{
  const cas = [
    ['https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view?usp=sharing',
     '1AbCdEfGhIjKlMnOpQrStUvWxYz012345'],
    ['https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQrStUvWxYz012345',
     '1AbCdEfGhIjKlMnOpQrStUvWxYz012345'],
    ['https://lh3.googleusercontent.com/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345',
     '1AbCdEfGhIjKlMnOpQrStUvWxYz012345'],
    ['1AbCdEfGhIjKlMnOpQrStUvWxYz012345', '1AbCdEfGhIjKlMnOpQrStUvWxYz012345'],
    ['', ''],
    ['pas une url', '']
  ];
  let tousBons = true;
  cas.forEach(([entree, attendu]) => {
    if (contexte.extraireIdDrive_(entree) !== attendu) tousBons = false;
  });
  verifier('les 4 formats d\'URL Drive sont reconnus', tousBons);
}

section('Utilitaires de conversion');
{
  verifier('les horaires « 19:00 » deviennent des minutes',
    contexte.versMinutes_('19:00') === 1140);
  verifier('la variante « 19h30 » est acceptée', contexte.versMinutes_('19h30') === 1170);
  verifier('une valeur inexploitable renvoie -1', contexte.versMinutes_('n\'importe quoi') === -1);
  verifier('« Oui » et « VRAI » valent vrai',
    contexte.versBooleen_('Oui') && contexte.versBooleen_('VRAI') && !contexte.versBooleen_('Non'));
  verifier('les accents et la casse sont neutralisés dans les en-têtes',
    contexte.normaliserLibelle_('  PRÉNOM  ') === 'prenom');
  verifier('le hash distingue ("AB","C") de ("A","BC")',
    contexte.hashLigne_(['AB', 'C']) !== contexte.hashLigne_(['A', 'BC']));
}

/* ────────────────────────────── Restitution ────────────────────────────── */

console.log(details.join('\n'));
console.log('\n' + '─'.repeat(64));
console.log(`${reussis} test(s) réussi(s), ${echecs} échec(s).`);
console.log('─'.repeat(64));
console.log('\nNon couvert par ce banc, à valider après déploiement :');
console.log('  • la redirection 302 d\'Apps Script (voir docs/PIEGES.md) ;');
console.log('  • l\'accès Drive du proxy photo ;');
console.log('  • les déclencheurs onEdit et horaire ;');
console.log('  • la concurrence réelle entre plusieurs terminaux.');

process.exit(echecs === 0 ? 0 : 1);
