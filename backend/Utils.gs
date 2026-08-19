/**
 * Utils.gs — Helpers partagés.
 *
 * Deux règles de performance s'appliquent partout dans ce projet :
 *  1. on lit et on écrit EN BLOC (getValues / setValues), jamais cellule par
 *     cellule — sur 5 000 lignes, la différence se compte en minutes ;
 *  2. toute écriture qui peut être concurrente passe par LockService.
 */

/** Classeur porteur du script (script lié au Sheet via Extensions > Apps Script). */
function classeur_() {
  return SpreadsheetApp.getActive();
}

/**
 * Récupère un onglet par son nom.
 * @param {string} nom
 * @param {boolean=} obligatoire Lève une erreur si l'onglet manque.
 */
function onglet_(nom, obligatoire) {
  const feuille = classeur_().getSheetByName(nom);
  if (!feuille && obligatoire !== false) {
    // `Participants` est le seul onglet que la migration ne sait pas créer :
    // c'est VOTRE table, elle doit préexister. Renvoyer ici « lancez la
    // migration » enverrait dans une boucle, puisque c'est elle qui échoue.
    if (nom === SHEETS.PARTICIPANTS) {
      const noms = classeur_().getSheets().map(function (f) { return f.getName(); });
      throw new Error(
        'Onglet « ' + nom + ' » introuvable. Onglets présents : ' + noms.join(', ') + '.\n\n' +
        'Renommez votre onglet de participants en « ' + nom + ' » (clic droit sur ' +
        'l\'onglet > Renommer), ou ajustez SHEETS.PARTICIPANTS dans Config.gs.');
    }
    throw new Error('Onglet introuvable : ' + nom + '. Lancez « Initialiser / mettre à jour la base ».');
  }
  return feuille;
}

/**
 * Normalise un intitulé pour la comparaison : minuscules, sans accent,
 * espaces réduits. Permet de retrouver « Prénom » derrière « PRENOM  ».
 */
function normaliserLibelle_(valeur) {
  return String(valeur == null ? '' : valeur)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Lit la ligne d'en-tête d'un onglet et renvoie { libelleNormalise: index0 }.
 */
function indexEntetes_(feuille) {
  const derniereColonne = feuille.getLastColumn();
  if (derniereColonne === 0) return {};
  const entetes = feuille.getRange(1, 1, 1, derniereColonne).getValues()[0];
  const index = {};
  for (let i = 0; i < entetes.length; i++) {
    const cle = normaliserLibelle_(entetes[i]);
    if (cle && index[cle] === undefined) index[cle] = i;
  }
  return index;
}

/**
 * Résout la position de chaque champ logique d'après COLS_PARTICIPANTS.
 * Renvoie { champ: index0 } ; un champ introuvable vaut -1, ce qui permet au
 * code appelant de traiter proprement une colonne absente plutôt que de planter.
 */
function resoudreColonnes_(feuille, definitions) {
  const index = indexEntetes_(feuille);
  const resolu = {};
  Object.keys(definitions).forEach(function (champ) {
    let position = -1;
    const variantes = definitions[champ];
    for (let i = 0; i < variantes.length && position === -1; i++) {
      const cle = normaliserLibelle_(variantes[i]);
      if (index[cle] !== undefined) position = index[cle];
    }
    resolu[champ] = position;
  });
  return resolu;
}

/**
 * Lit tout le contenu d'un onglet (hors en-tête) en un seul appel.
 * @return {{entetes: Array, lignes: Array<Array>, premiereLigne: number}}
 */
function lireBloc_(feuille) {
  const derniereLigne = feuille.getLastRow();
  const derniereColonne = feuille.getLastColumn();
  if (derniereLigne < 2 || derniereColonne === 0) {
    return { entetes: derniereColonne ? feuille.getRange(1, 1, 1, derniereColonne).getValues()[0] : [], lignes: [], premiereLigne: 2 };
  }
  const valeurs = feuille.getRange(1, 1, derniereLigne, derniereColonne).getValues();
  return { entetes: valeurs[0], lignes: valeurs.slice(1), premiereLigne: 2 };
}

/**
 * Lit un onglet simple (en-tête + lignes) sous forme de tableau d'objets.
 * Réservé aux petits onglets de référence (Droits, Formules, Services…).
 */
function lireObjets_(nomOnglet) {
  const feuille = onglet_(nomOnglet, false);
  if (!feuille) return [];
  const bloc = lireBloc_(feuille);
  const cles = bloc.entetes.map(function (e) { return String(e).trim(); });
  return bloc.lignes
    .filter(function (ligne) { return ligne.join('').trim() !== ''; })
    .map(function (ligne) {
      const objet = {};
      for (let i = 0; i < cles.length; i++) if (cles[i]) objet[cles[i]] = ligne[i];
      return objet;
    });
}

/** Horodatage epoch en millisecondes. */
function maintenant_() {
  return Date.now();
}

/**
 * Empreinte stable d'une ligne métier. Le séparateur U+001F ne peut pas
 * apparaître dans une saisie utilisateur, ce qui évite les collisions du type
 * ("AB","C") vs ("A","BC").
 */
function hashLigne_(valeurs) {
  const brut = valeurs.map(function (v) {
    if (v instanceof Date) return String(v.getTime());
    return v == null ? '' : String(v).trim();
  }).join('\u001f');
  const octets = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, brut, Utilities.Charset.UTF_8);
  // 12 octets suffisent largement à détecter une modification, et allègent la colonne.
  let hex = '';
  for (let i = 0; i < 12; i++) {
    const b = (octets[i] + 256) % 256;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

/** Empreinte salée d'une phrase de passe (voir la limite documentée dans ADMIN.md). */
function hashPhrase_(phrase, sel) {
  const octets = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, String(sel) + '\u001f' + String(phrase), Utilities.Charset.UTF_8);
  return octets.map(function (b) {
    const v = (b + 256) % 256;
    return (v < 16 ? '0' : '') + v.toString(16);
  }).join('');
}

/**
 * Comparaison à temps constant : évite qu'un attaquant déduise un préfixe
 * correct en mesurant le temps de réponse.
 */
function egaliteConstante_(a, b) {
  const s1 = String(a == null ? '' : a);
  const s2 = String(b == null ? '' : b);
  if (s1.length !== s2.length) return false;
  let diff = 0;
  for (let i = 0; i < s1.length; i++) diff |= s1.charCodeAt(i) ^ s2.charCodeAt(i);
  return diff === 0;
}

/**
 * Normalise un UID de bracelet : majuscules, sans séparateur.
 *
 * Web NFC renvoie l'UID sous la forme « 04:a1:b2:c3:d4:e5:f6 », et c'est aussi
 * ce que la plupart des lecteurs affichent. Une saisie au clavier reproduira
 * donc naturellement ces deux-points… alors que le terminal, lui, compare une
 * chaîne hexadécimale continue. Sans cette normalisation des DEUX côtés, le
 * bracelet reste éternellement « NON RECONNU » sans que rien n'explique
 * pourquoi.
 */
function normaliserUid_(valeur) {
  return String(valeur == null ? '' : valeur).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

/** Identifiant unique, utilisé pour les scans et les commandes. */
function uuid_() {
  return Utilities.getUuid();
}

/** Réponse JSON standard de l'API. */
function reponseJson_(objet) {
  return ContentService
    .createTextOutput(JSON.stringify(objet))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Réponse d'erreur : toujours HTTP 200 côté Apps Script, l'erreur est dans le corps. */
function reponseErreur_(message, code) {
  return reponseJson_({ ok: false, erreur: message, code: code || 'ERREUR' });
}

/** Convertit une valeur de cellule en booléen, en tolérant Oui/Non et VRAI/FAUX. */
function versBooleen_(valeur) {
  if (typeof valeur === 'boolean') return valeur;
  const texte = normaliserLibelle_(valeur);
  return texte === 'oui' || texte === 'vrai' || texte === 'true' || texte === '1' || texte === 'x';
}

/** Convertit une valeur de cellule en entier, avec valeur de repli. */
function versEntier_(valeur, repli) {
  const n = parseInt(valeur, 10);
  return isNaN(n) ? repli : n;
}

/**
 * Convertit une cellule horaire (Date ou « 12:30 ») en minutes depuis minuit.
 * Renvoie -1 si la valeur est inexploitable.
 */
function versMinutes_(valeur) {
  if (valeur instanceof Date) return valeur.getHours() * 60 + valeur.getMinutes();
  const m = String(valeur == null ? '' : valeur).match(/^(\d{1,2})\s*[:hH]\s*(\d{2})?/);
  if (!m) return -1;
  return parseInt(m[1], 10) * 60 + (m[2] ? parseInt(m[2], 10) : 0);
}

/**
 * Lit l'onglet Config sous forme d'objet { cle: valeur }.
 * Mémorisé 60 s : une modification manuelle met donc au plus une minute à
 * s'appliquer, ce qui est sans conséquence pour des paramètres d'exploitation.
 */
function lireConfig_() {
  return enCache_(CACHE.CONFIG, 60, function () {
    const lignes = lireObjets_(SHEETS.CONFIG);
    const config = {};
    lignes.forEach(function (l) {
      if (l.cle) config[String(l.cle).trim()] = l.valeur;
    });
    return config;
  });
}

/**
 * Exécute une fonction en détenant le verrou du script.
 * Toute écriture concurrente (scans, commandes, journal) doit passer par ici.
 */
function avecVerrou_(fonction, delaiMs) {
  const verrou = LockService.getScriptLock();
  if (!verrou.tryLock(delaiMs || 20000)) {
    throw new Error('Le classeur est occupé par une autre écriture, réessayez.');
  }
  try {
    return fonction();
  } finally {
    verrou.releaseLock();
  }
}

/**
 * Mémorise le plus grand _updated_at connu. C'est le court-circuit qui rend
 * la cadence de 15 s soutenable : la grande majorité des synchronisations
 * répondent « rien de neuf » sans lire les 5 000 lignes du classeur.
 */
function majMaxUpdatedAt_(valeur) {
  const proprietes = PropertiesService.getScriptProperties();
  const actuel = versEntier_(proprietes.getProperty(PROP.MAX_UPDATED_AT), 0);
  if (valeur > actuel) proprietes.setProperty(PROP.MAX_UPDATED_AT, String(valeur));
}

function lireMaxUpdatedAt_() {
  return versEntier_(PropertiesService.getScriptProperties().getProperty(PROP.MAX_UPDATED_AT), 0);
}

/**
 * Mémorise le résultat JSON d'un calcul coûteux.
 *
 * Mesuré sur le déploiement réel : chaque accès à un onglet coûte environ une
 * demi-seconde, quelle que soit sa taille — lire les 2 000 participants ne
 * prend que 0,7 s de plus qu'une sync à vide. Le coût d'une synchronisation
 * tient donc au NOMBRE d'onglets touchés, pas au volume de données. D'où ce
 * cache, qui vise les petits onglets de référence relus à chaque cycle.
 */
function enCache_(cle, dureeSecondes, producteur) {
  const cache = CacheService.getScriptCache();
  const memorise = cache.get(cle);
  if (memorise) {
    try { return JSON.parse(memorise); } catch (erreur) { /* cache corrompu : on recalcule */ }
  }
  const valeur = producteur();
  try {
    cache.put(cle, JSON.stringify(valeur), dureeSecondes);
  } catch (erreur) {
    // Dépassement de la limite de 100 ko : on sert la valeur sans la mémoriser.
    console.warn('enCache_ : ' + cle + ' non mémorisable (' + erreur + ')');
  }
  return valeur;
}

/** Invalide une ou plusieurs clés de cache. */
function viderCache_(cles) {
  try {
    CacheService.getScriptCache().removeAll([].concat(cles));
  } catch (erreur) {
    console.warn('viderCache_ : ' + erreur);
  }
}

/** Clés de cache utilisées par le projet. */
const CACHE = {
  REFERENCES: 'REFS_V1',
  CONFIG: 'CONFIG_V1',
  terminal: function (identifiant) { return 'TERM_' + identifiant; }
};

/** Ajoute des lignes à la fin d'un onglet, en un seul appel. */
function ajouterLignes_(feuille, lignes) {
  if (!lignes.length) return;
  const depart = feuille.getLastRow() + 1;
  feuille.getRange(depart, 1, lignes.length, lignes[0].length).setValues(lignes);
}

/** Construit une ligne alignée sur les en-têtes d'un onglet à partir d'un objet. */
function objetVersLigne_(feuille, objet) {
  const entetes = feuille.getRange(1, 1, 1, feuille.getLastColumn()).getValues()[0];
  return entetes.map(function (e) {
    const cle = String(e).trim();
    return objet[cle] === undefined ? '' : objet[cle];
  });
}
