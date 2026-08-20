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
/**
 * Rétention de l'historique local.
 *
 * 18 h couvre une journée d'événement entière, du montage au démontage. C'est
 * bien plus que l'anti-passback n'en a besoin (une heure), mais l'historique
 * sert aussi à retrouver quelqu'un qui est passé le matin pour lui adjoindre un
 * signalement l'après-midi.
 *
 * Le coût est négligeable : une ligne de scan pèse environ 150 octets, donc
 * 3 000 passages tiennent dans un demi-mégaoctet. Et cela n'expose rien de plus
 * — l'appareil détient déjà la base complète des participants, noms et photos
 * compris ; un scan ne contient qu'un UID et un numéro.
 */
const HISTORIQUE_DUREE_MS = 18 * 3600 * 1000;

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
    if (typeof delta.expire_le === 'number') magasinMeta.put(delta.expire_le, 'expire_le');
    // Ce terminal a-t-il le droit d'attribuer des bracelets ? Décidé par
    // l'organisation dans l'onglet `Terminaux`, jamais par l'appareil.
    if (typeof delta.peut_associer === 'boolean') {
      magasinMeta.put(delta.peut_associer, 'peut_associer');
    }
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

/**
 * Recherche par nom, prénom, numéro ou école, sur la base déjà en mémoire.
 *
 * `filtres` = { ecole, statut }, l'un et l'autre facultatifs. Un filtre seul
 * suffit à produire une liste : c'est le mode d'usage du guichet d'accueil, où
 * l'on affiche toute une école et où l'on descend la liste au fil de la file,
 * sans rien taper.
 *
 * Le tri est alphabétique, et non l'ordre du classeur : une file d'attente
 * s'organise approximativement par ordre alphabétique, la liste doit suivre.
 *
 * Renvoie { liste, total } — `total` compte les correspondances réelles, même
 * au-delà de la limite d'affichage, pour que l'opérateur sache s'il voit tout.
 */
function rechercher(base, requete, limite, filtres) {
  const terme = normaliserTexte(requete);
  const f = filtres || {};
  const ecole = normaliserTexte(f.ecole || '');
  const statut = normaliserTexte(f.statut || '');
  const filtreActif = !!(ecole || statut);

  // Sans filtre, on exige deux caractères : afficher 2 000 fiches sur une seule
  // lettre n'aiderait personne. Avec un filtre, la liste EST le résultat.
  if (terme.length < 2 && !filtreActif) return { liste: [], total: 0 };

  const trouves = [];
  const iterateur = base.participants.values();
  let entree = iterateur.next();
  while (!entree.done) {
    const p = entree.value;
    entree = iterateur.next();
    if (ecole && normaliserTexte(p.ecole || '') !== ecole) continue;
    if (statut && normaliserTexte(p.statut || '') !== statut) continue;
    if (terme.length >= 2) {
      const champs = normaliserTexte(
        [p.numero, p.nom, p.prenom, p.ecole].filter(Boolean).join(' '));
      if (champs.indexOf(terme) === -1) continue;
    }
    trouves.push(p);
  }

  trouves.sort(function (a, b) {
    return normaliserTexte((a.nom || '') + ' ' + (a.prenom || ''))
      .localeCompare(normaliserTexte((b.nom || '') + ' ' + (b.prenom || '')));
  });

  return { liste: trouves.slice(0, limite || 200), total: trouves.length };
}

/** Valeurs distinctes d'un champ, triées — alimente les listes de filtres. */
function valeursDistinctes(base, champ) {
  const vues = Object.create(null);
  base.participants.forEach(function (p) {
    const valeur = String(p[champ] == null ? '' : p[champ]).trim();
    if (valeur) vues[valeur] = true;
  });
  return Object.keys(vues).sort(function (a, b) { return a.localeCompare(b); });
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
/**
 * Scans récents, du plus récent au plus ancien.
 *
 * ⚠️ Parcours par CURSEUR sur l'index `par_date`, jamais `getAll()`.
 *
 * `getAll()` charge tout l'historique en mémoire avant de filtrer : le coût
 * grandit avec le nombre de passages, indéfiniment, alors que l'appelant n'a
 * jamais besoin que de la dernière heure ou des cent derniers. Sur un téléphone
 * de bénévole après une journée de scans, c'est un pic d'allocation à chaque
 * ouverture de l'historique et à chaque synchronisation — et un onglet qui se
 * fait tuer par le système.
 *
 * Ici, on descend le curseur du plus récent vers le plus ancien et on s'arrête
 * dès qu'on a ce qu'il faut. Le coût ne dépend plus de la taille du magasin.
 */
function scansRecents(fenetreMs, maximum) {
  const plancher = Date.now() - (fenetreMs || 3600000);
  const plafond = maximum || 500;
  return ouvrirDb().then(function (db) {
    return new Promise(function (resoudre, rejeter) {
      const resultats = [];
      const requete = db.transaction(['historique'], 'readonly')
        .objectStore('historique').index('par_date')
        .openCursor(IDBKeyRange.lowerBound(plancher), 'prev');
      requete.onerror = function () { rejeter(requete.error); };
      requete.onsuccess = function (evenement) {
        const curseur = evenement.target.result;
        if (!curseur || resultats.length >= plafond) { resoudre(resultats); return; }
        resultats.push(curseur.value);
        curseur.continue();
      };
    });
  });
}

/** Efface tout l'historique — utilisé à la péremption du terminal. */
function viderHistorique() {
  return transaction(['historique'], 'readwrite', function (tx) {
    tx.objectStore('historique').clear();
  });
}

/** Élague l'historique : il ne sert qu'aux dernières heures. */
/**
 * Supprime les scans plus vieux que la rétention.
 *
 * Appelée après chaque synchronisation réussie. Sans elle, le magasin grossit
 * indéfiniment : la rétention annoncée ne serait qu'une intention.
 *
 * Le curseur ne touche QUE les périmés — il s'arrête à la borne haute de la
 * plage — donc le coût est proportionnel à ce qu'on supprime, pas au volume
 * conservé.
 */
function purgerHistorique() {
  const limite = Date.now() - HISTORIQUE_DUREE_MS;
  return ouvrirDb().then(function (db) {
    return new Promise(function (resoudre, rejeter) {
      let supprimes = 0;
      const tx = db.transaction(['historique'], 'readwrite');
      const requete = tx.objectStore('historique').index('par_date')
        .openCursor(IDBKeyRange.upperBound(limite, true));
      requete.onerror = function () { rejeter(requete.error); };
      requete.onsuccess = function (evenement) {
        const curseur = evenement.target.result;
        if (!curseur) return;
        curseur.delete();
        supprimes++;
        curseur.continue();
      };
      tx.oncomplete = function () { resoudre(supprimes); };
      tx.onerror = function () { rejeter(tx.error); };
    });
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
/**
 * Vide le seul cache des photos, en gardant la base et les scans.
 *
 * Utile quand les photos en cache sont **périmées par leur poids** : celles
 * téléchargées avant la déclaration du dossier `Miniatures` pèsent 142 ko au
 * lieu de 10 ko. Deux mille d'entre elles occupent près de 280 Mo, que rien ne
 * remplace jamais — `afficherPhoto` lit le cache en premier et ne redemande
 * pas une photo qu'il a déjà.
 */
function viderPhotos() {
  return transaction(['photos'], 'readwrite', function (tx) {
    tx.objectStore('photos').clear();
  });
}

/** Octets réellement occupés sur l'appareil, tous magasins confondus. */
function occupation() {
  if (!navigator.storage || !navigator.storage.estimate) {
    return Promise.resolve(null);
  }
  return navigator.storage.estimate().then(function (e) {
    return { utilise: e.usage || 0, quota: e.quota || 0 };
  }).catch(function () { return null; });
}

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
    const tx = db.transaction(['participants', 'bracelets', 'photos', 'file_scans',
                               'historique'], 'readonly');
    return Promise.all([
      promesse(tx.objectStore('participants').count()),
      promesse(tx.objectStore('bracelets').count()),
      promesse(tx.objectStore('photos').count()),
      promesse(tx.objectStore('file_scans').count()),
      promesse(tx.objectStore('historique').count())
    ]);
  }).then(function (n) {
    return { participants: n[0], bracelets: n[1], photos: n[2], en_attente: n[3],
             historique: n[4] };
  });
}

window.DB = {
  ouvrirDb, appliquerDelta, lireCurseur, ecrireCurseur, lireMeta, ecrireMeta,
  chargerBase, rechercher, valeursDistinctes, normaliserTexte, lirePhoto, ecrirePhoto, compterPhotos,
  empilerScan, lireFileScans, retirerScans, compterFileScans, scansRecents,
  purgerHistorique, viderHistorique, viderPhotos, occupation,
  purgerBase, statistiques
};
