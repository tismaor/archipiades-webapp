/**
 * db.js — Base locale IndexedDB.
 *
 * Tout ce dont un scan a besoin vit ici, et rien d'autre : la décision se prend
 * sur cette copie, jamais sur le réseau. Les photos sont stockées en Blob et
 * non en base64, ce qui divise leur empreinte par quatre et évite de
 * reconstruire une chaîne de plusieurs kilo-octets à chaque affichage.
 *
 * Six magasins :
 *   participants  clé = numero
 *   bracelets     clé = uid
 *   photos        clé = numero, valeur = Blob
 *   file_scans    clé = scan_id — scans EN ATTENTE D'ENVOI, vidée après accusé
 *   historique    clé = scan_id — scans récents, INDÉPENDANT de l'envoi
 *   meta          clé = nom     — curseur de sync, références, réglages
 *
 * ⚠️ `file_scans` et `historique` sont deux choses distinctes, et les
 * confondre est un piège coûteux : la file se vide dès que le serveur accuse
 * réception. Si l'anti-passback lisait la file, il ne fonctionnerait que hors
 * ligne — en ligne, la mémoire des passages récents disparaîtrait aussitôt.
 * L'historique est donc conservé à part, et purgé sur critère d'âge.
 */

'use strict';

const DB_NOM = 'archipiades';
const DB_VERSION = 2;

/** Durée de conservation de l'historique local, en millisecondes. */
const HISTORIQUE_DUREE_MS = 6 * 3600 * 1000;

let _db = null;

/** Ouvre la base, en la créant au besoin. */
function ouvrirDb() {
  if (_db) return Promise.resolve(_db);
  return new Promise(function (resoudre, rejeter) {
    const requete = indexedDB.open(DB_NOM, DB_VERSION);

    requete.onupgradeneeded = function (evenement) {
      const db = evenement.target.result;
      if (!db.objectStoreNames.contains('participants')) {
        db.createObjectStore('participants', { keyPath: 'numero' });
      }
      if (!db.objectStoreNames.contains('bracelets')) {
        db.createObjectStore('bracelets', { keyPath: 'uid' });
      }
      if (!db.objectStoreNames.contains('photos')) {
        db.createObjectStore('photos');
      }
      if (!db.objectStoreNames.contains('file_scans')) {
        db.createObjectStore('file_scans', { keyPath: 'scan_id' });
      }
      if (!db.objectStoreNames.contains('historique')) {
        const historique = db.createObjectStore('historique', { keyPath: 'scan_id' });
        historique.createIndex('par_date', 'ts_terminal');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta');
      }
    };

    requete.onsuccess = function () { _db = requete.result; resoudre(_db); };
    requete.onerror = function () { rejeter(requete.error); };
  });
}

/** Exécute une transaction et résout quand elle est RÉELLEMENT validée. */
function transaction(magasins, mode, travail) {
  return ouvrirDb().then(function (db) {
    return new Promise(function (resoudre, rejeter) {
      const tx = db.transaction(magasins, mode);
      let resultat;
      // On attend `oncomplete`, pas la fin du callback : sans cela on croirait
      // les données écrites alors que la transaction peut encore échouer.
      tx.oncomplete = function () { resoudre(resultat); };
      tx.onerror = function () { rejeter(tx.error); };
      tx.onabort = function () { rejeter(tx.error || new Error('Transaction annulée')); };
      resultat = travail(tx);
    });
  });
}

function promesse(requete) {
  return new Promise(function (resoudre, rejeter) {
    requete.onsuccess = function () { resoudre(requete.result); };
    requete.onerror = function () { rejeter(requete.error); };
  });
}

/* ─────────────────────────── Écritures du delta ─────────────────────────── */

/**
 * Applique un delta de synchronisation.
 * Une seule transaction pour tout le lot : sur un delta de 500 lignes, la
 * différence avec 500 transactions se compte en secondes.
 */
function appliquerDelta(delta) {
  return transaction(['participants', 'bracelets', 'meta'], 'readwrite', function (tx) {
    const magasinParticipants = tx.objectStore('participants');
    const magasinBracelets = tx.objectStore('bracelets');
    const magasinMeta = tx.objectStore('meta');

    (delta.participants || []).forEach(function (p) { magasinParticipants.put(p); });
    (delta.bracelets || []).forEach(function (b) { magasinBracelets.put(b); });

    if (delta.refs) magasinMeta.put(delta.refs, 'refs');
    // Cartes STAFF/ADMIN : uid, nom et rôle seulement — jamais d'empreinte de
    // phrase de passe. Elles servent à déverrouiller un écran, pas à autoriser
    // une opération, qui reste vérifiée côté serveur.
    if (delta.cartes) magasinMeta.put(delta.cartes, 'cartes');
    if (delta.refs_version) magasinMeta.put(delta.refs_version, 'refs_version');
    if (delta.point_controle) magasinMeta.put(delta.point_controle, 'point_controle');
    if (delta.profil_donnees) magasinMeta.put(delta.profil_donnees, 'profil_donnees');
    if (typeof delta.sync_interval_s === 'number') {
      magasinMeta.put(delta.sync_interval_s, 'sync_interval_s');
    }
    magasinMeta.put(Date.now(), 'derniere_sync');
  });
}

/** Curseur de synchronisation : le plus grand `maj` connu, et le numéro associé. */
function lireCurseur() {
  return Promise.all([lireMeta('since'), lireMeta('apres')]).then(function (valeurs) {
    return { since: valeurs[0] || 0, apres: valeurs[1] || '' };
  });
}

function ecrireCurseur(since, apres) {
  return transaction(['meta'], 'readwrite', function (tx) {
    const magasin = tx.objectStore('meta');
    magasin.put(since, 'since');
    magasin.put(apres || '', 'apres');
  });
}

/* ─────────────────────────── Lectures ─────────────────────────── */

function lireMeta(cle) {
  return ouvrirDb().then(function (db) {
    return promesse(db.transaction(['meta'], 'readonly').objectStore('meta').get(cle));
  });
}

function ecrireMeta(cle, valeur) {
  return transaction(['meta'], 'readwrite', function (tx) {
    tx.objectStore('meta').put(valeur, cle);
  });
}

/**
 * Charge toute la base en mémoire, sous forme de Map.
 *
 * Appelé une fois au démarrage puis après chaque sync : le moteur de règles
 * travaille ensuite en RAM, ce qui garantit la décision en moins de 50 ms.
 * 5 000 participants représentent quelques mégaoctets, un téléphone encaisse
 * sans difficulté.
 */
function chargerBase() {
  return ouvrirDb().then(function (db) {
    const tx = db.transaction(['participants', 'bracelets'], 'readonly');
    return Promise.all([
      promesse(tx.objectStore('participants').getAll()),
      promesse(tx.objectStore('bracelets').getAll())
    ]);
  }).then(function (resultats) {
    const participants = new Map();
    const bracelets = new Map();
    resultats[0].forEach(function (p) { participants.set(p.numero, p); });
    // Un bracelet PERDU et son remplaçant coexistent : on les garde tous les
    // deux, c'est le moteur de règles qui distingue les statuts.
    resultats[1].forEach(function (b) { bracelets.set(b.uid, b); });
    return { participants: participants, bracelets: bracelets };
  });
}

/** Recherche par nom, prénom, numéro ou école. Sur la base déjà en mémoire. */
function rechercher(base, requete, limite) {
  const terme = normaliserTexte(requete);
  if (terme.length < 2) return [];
  const resultats = [];
  const iterateur = base.participants.values();
  let entree = iterateur.next();
  while (!entree.done && resultats.length < (limite || 20)) {
    const p = entree.value;
    const champs = normaliserTexte(
      [p.numero, p.nom, p.prenom, p.ecole].filter(Boolean).join(' '));
    if (champs.indexOf(terme) !== -1) resultats.push(p);
    entree = iterateur.next();
  }
  return resultats;
}

function normaliserTexte(valeur) {
  return String(valeur == null ? '' : valeur)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

/* ─────────────────────────── Photos ─────────────────────────── */

function lirePhoto(numero) {
  return ouvrirDb().then(function (db) {
    return promesse(db.transaction(['photos'], 'readonly').objectStore('photos').get(numero));
  });
}

function ecrirePhoto(numero, blob) {
  return transaction(['photos'], 'readwrite', function (tx) {
    tx.objectStore('photos').put(blob, numero);
  });
}

function compterPhotos() {
  return ouvrirDb().then(function (db) {
    return promesse(db.transaction(['photos'], 'readonly').objectStore('photos').count());
  });
}

/* ─────────────────────────── File de scans ─────────────────────────── */

/**
 * Enregistre un scan, dans la file d'envoi ET dans l'historique.
 *
 * Écrit AVANT tout appel réseau : un scan doit survivre à la fermeture de
 * l'onglet, à la coupure réseau et au rechargement de la page. Il quitte la
 * file une fois le serveur ayant accusé réception, mais RESTE dans
 * l'historique — sans quoi l'anti-passback perdrait la mémoire des passages
 * dès que le réseau fonctionne.
 */
function empilerScan(scan) {
  return transaction(['file_scans', 'historique'], 'readwrite', function (tx) {
    tx.objectStore('file_scans').put(scan);
    tx.objectStore('historique').put(scan);
  });
}

function lireFileScans(limite) {
  return ouvrirDb().then(function (db) {
    return promesse(db.transaction(['file_scans'], 'readonly').objectStore('file_scans').getAll());
  }).then(function (tout) {
    tout.sort(function (a, b) { return a.ts_terminal - b.ts_terminal; });
    return limite ? tout.slice(0, limite) : tout;
  });
}

function retirerScans(identifiants) {
  return transaction(['file_scans'], 'readwrite', function (tx) {
    const magasin = tx.objectStore('file_scans');
    identifiants.forEach(function (id) { magasin.delete(id); });
  });
}

function compterFileScans() {
  return ouvrirDb().then(function (db) {
    return promesse(db.transaction(['file_scans'], 'readonly').objectStore('file_scans').count());
  });
}

/**
 * Scans récents, pour l'anti-passback et le décompte local des repas.
 *
 * Lit l'HISTORIQUE, jamais la file d'envoi : celle-ci se vide dès l'accusé de
 * réception du serveur, et l'anti-passback ne fonctionnerait alors plus qu'en
 * mode déconnecté.
 *
 * Renvoyés du plus récent au plus ancien, comme l'attend le moteur de règles.
 */
function scansRecents(fenetreMs) {
  const limite = Date.now() - (fenetreMs || 3600000);
  return ouvrirDb().then(function (db) {
    return promesse(db.transaction(['historique'], 'readonly')
                      .objectStore('historique').getAll());
  }).then(function (tout) {
    return tout.filter(function (s) { return s.ts_terminal >= limite; })
               .sort(function (a, b) { return b.ts_terminal - a.ts_terminal; });
  });
}

/** Élague l'historique : il ne sert qu'aux dernières heures. */
function purgerHistorique() {
  const limite = Date.now() - HISTORIQUE_DUREE_MS;
  return ouvrirDb().then(function (db) {
    return promesse(db.transaction(['historique'], 'readonly')
                      .objectStore('historique').getAll());
  }).then(function (tout) {
    const perimes = tout.filter(function (s) { return s.ts_terminal < limite; })
                        .map(function (s) { return s.scan_id; });
    if (!perimes.length) return 0;
    return transaction(['historique'], 'readwrite', function (tx) {
      const magasin = tx.objectStore('historique');
      perimes.forEach(function (id) { magasin.delete(id); });
    }).then(function () { return perimes.length; });
  });
}

/* ─────────────────────────── Entretien ─────────────────────────── */

/**
 * Efface la base locale — utilisé au changement de déploiement.
 *
 * La file de scans et l'historique sont VOLONTAIREMENT épargnés : la file
 * peut contenir des passages non encore remontés, et l'historique porte la
 * mémoire anti-passback des dernières heures.
 */
function purgerBase() {
  return transaction(['participants', 'bracelets', 'photos', 'meta'], 'readwrite',
    function (tx) {
      tx.objectStore('participants').clear();
      tx.objectStore('bracelets').clear();
      tx.objectStore('photos').clear();
      tx.objectStore('meta').delete('since');
      tx.objectStore('meta').delete('apres');
      tx.objectStore('meta').delete('refs_version');
    });
}

function statistiques() {
  return ouvrirDb().then(function (db) {
    const tx = db.transaction(['participants', 'bracelets', 'photos', 'file_scans'], 'readonly');
    return Promise.all([
      promesse(tx.objectStore('participants').count()),
      promesse(tx.objectStore('bracelets').count()),
      promesse(tx.objectStore('photos').count()),
      promesse(tx.objectStore('file_scans').count())
    ]);
  }).then(function (n) {
    return { participants: n[0], bracelets: n[1], photos: n[2], en_attente: n[3] };
  });
}

window.DB = {
  ouvrirDb, appliquerDelta, lireCurseur, ecrireCurseur, lireMeta, ecrireMeta,
  chargerBase, rechercher, lirePhoto, ecrirePhoto, compterPhotos,
  empilerScan, lireFileScans, retirerScans, compterFileScans, scansRecents,
  purgerHistorique,
  purgerBase, statistiques
};
