/**
 * app.js — Orchestration de la Web App.
 *
 * Enchaînement d'un scan, dans cet ordre strict :
 *   1. décision LOCALE via rules.js, sur la base en mémoire (< 50 ms) ;
 *   2. affichage immédiat ;
 *   3. écriture du scan dans la file IndexedDB ;
 *   4. envoi réseau, en tâche de fond, sans jamais bloquer l'agent.
 *
 * Le réseau n'intervient qu'à l'étape 4. Rien de ce que fait un agent devant
 * la file d'attente ne dépend de la 4G.
 */

'use strict';

/* ─────────────────────────────── État ─────────────────────────────── */

const etat = {
  base: { participants: new Map(), bracelets: new Map() },
  refs: null,
  pointControle: '',
  scansRecents: [],
  syncEnCours: false,        // garde « une seule sync en vol »
  minuteurSync: null,
  cadenceS: 30,
  blocage: null,             // acquittement en attente
  lecteurNfc: null,
  vueCourante: 'vue-scan',
  cartes: [],                // cartes STAFF/ADMIN connues
  deverrouillage: null       // { nom, role, expire }
};

/**
 * Version de la coque applicative.
 * Incrémentée automatiquement par tools/deployer_webapp.sh, en même temps que
 * le cache du Service Worker. Affichée dans les réglages : c'est le seul moyen
 * de savoir, depuis le terrain, si un téléphone exécute bien le dernier code.
 */
const VERSION_APP = 3;

/** Durée d'ouverture des réglages après présentation d'une carte. */
const DEVERROUILLAGE_MS = 5 * 60 * 1000;

const $ = function (id) { return document.getElementById(id); };

/**
 * Message transitoire, non bloquant.
 *
 * On n'emploie JAMAIS alert() : une boîte modale fige l'application, et devant
 * une file d'attente c'est exactement ce qu'il ne faut pas. Le message
 * s'efface seul.
 */
let _minuteurMessage = null;
function message(texte, niveau) {
  const zone = $('message');
  zone.textContent = texte;
  zone.className = 'visible' + (niveau ? ' ' + niveau : '');
  clearTimeout(_minuteurMessage);
  _minuteurMessage = setTimeout(function () { zone.className = ''; }, 6000);
}

/* ─────────────────────────── Démarrage ─────────────────────────── */

/**
 * Une panne ne doit JAMAIS être muette.
 *
 * Sans ce filet, une simple erreur de script laisse l'application figée sur
 * l'écran de scan, sans le moindre bouton actif et sans aucun message : le
 * bénévole croit que le téléphone a planté et ne sait pas quoi dire. On affiche
 * l'erreur en clair, ce qui rend le diagnostic possible depuis le terrain.
 */
window.addEventListener('error', function (evenement) {
  signalerPanne(evenement.message + ' (' + (evenement.filename || '?').split('/').pop() +
                ':' + evenement.lineno + ')');
});
window.addEventListener('unhandledrejection', function (evenement) {
  signalerPanne('Promesse rejetée : ' + (evenement.reason && evenement.reason.message
                                         ? evenement.reason.message : evenement.reason));
});

function signalerPanne(texte) {
  const zone = document.getElementById('panne');
  if (!zone) return;
  zone.textContent = '⚠ Erreur : ' + texte + ' — signalez-le au PC.';
  zone.className = 'visible';
  console.error(texte);
}

/**
 * Branche un module en isolant ses erreurs.
 * Si l'un échoue, les autres continuent de fonctionner — une application
 * partiellement utilisable vaut infiniment mieux qu'un écran mort.
 */
function brancher(nom, fonction) {
  try {
    fonction();
  } catch (erreur) {
    signalerPanne(nom + ' — ' + erreur.message);
  }
}

document.addEventListener('DOMContentLoaded', function () {
  brancher('navigation', brancherNavigation);
  brancher('réglages', brancherReglages);
  brancher('recherche', brancherRecherche);
  brancher('NFC', brancherNfc);
  brancher('acquittement', brancherAcquittement);
  brancher('verrou', brancherVerrou);

  chargerReglages();

  DB.ouvrirDb()
    .then(rechargerBaseMemoire)
    .then(rafraichirBandeau)
    .then(function () {
      if (API.estConfigure()) {
        planifierSync(1000);
        envoyerFileScans();
      } else {
        montrerVue('vue-reglages');
        afficherPave('CONFIGURATION REQUISE', 'Renseignez l\'URL et la clé API', null, true);
      }
    })
    .catch(function (erreur) {
      afficherPave('ERREUR', erreur.message, 'rouge', true);
    });

  window.addEventListener('online', function () {
    rafraichirBandeau();
    envoyerFileScans();
    planifierSync(500);
  });
  window.addEventListener('offline', rafraichirBandeau);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function (erreur) {
      console.warn('Service Worker non enregistré : ' + erreur);
    });
  }
});

/* ─────────────────────────── Réglages ─────────────────────────── */

function chargerReglages() {
  const url = localStorage.getItem('api_url') || '';
  const cle = localStorage.getItem('api_cle') || '';
  const terminal = localStorage.getItem('api_terminal') || 'WEB-01';
  $('champ-url').value = url;
  $('champ-cle').value = cle;
  $('champ-terminal').value = terminal;
  API.configurer(url, cle, terminal);
  $('etat-terminal').textContent = terminal;
}

function brancherReglages() {
  $('btn-enregistrer').addEventListener('click', function () {
    const url = $('champ-url').value.trim();
    const cle = $('champ-cle').value.trim();
    const terminal = $('champ-terminal').value.trim();
    if (!url || !cle || !terminal) {
      message('Les trois champs sont nécessaires.', 'erreur');
      return;
    }
    localStorage.setItem('api_url', url);
    localStorage.setItem('api_cle', cle);
    localStorage.setItem('api_terminal', terminal);
    API.configurer(url, cle, terminal);
    $('etat-terminal').textContent = terminal;
    synchroniser(true);
  });

  $('btn-sync').addEventListener('click', function () { synchroniser(true); });
  $('btn-photos').addEventListener('click', prechargerPhotos);

  $('btn-purger').addEventListener('click', function () {
    if (!confirm('Effacer la base locale ? Les scans en attente sont conservés.')) return;
    DB.purgerBase()
      .then(rechargerBaseMemoire)
      .then(rafraichirBandeau)
      .then(function () { message('Base locale effacée. Lancez une synchronisation.'); });
  });
}

/* ─────────────────────────── Synchronisation ─────────────────────────── */

function planifierSync(delaiMs) {
  clearTimeout(etat.minuteurSync);
  etat.minuteurSync = setTimeout(function () { synchroniser(false); },
    delaiMs || etat.cadenceS * 1000);
}

/**
 * Récupère le delta, en paginant jusqu'à épuisement.
 *
 * Garde-fou essentiel : une seule synchronisation en vol à la fois. Un tick qui
 * arrive alors que la précédente tourne encore est IGNORÉ, jamais empilé —
 * c'est la cause classique d'écroulement des boucles de synchronisation.
 */
function synchroniser(manuelle) {
  if (etat.syncEnCours) return Promise.resolve();
  if (!API.estConfigure()) return Promise.resolve();
  if (!navigator.onLine) { planifierSync(); return Promise.resolve(); }

  etat.syncEnCours = true;
  $('etat-reseau').textContent = 'sync…';

  // La première synchronisation dure une quinzaine de secondes sur 2 000
  // participants. Sans ceci, l'écran resterait sur « CONFIGURATION REQUISE »
  // pendant tout ce temps, alors que la configuration vient précisément d'être
  // saisie — on croit à un échec.
  if (etat.paveSysteme && !etat.blocage) {
    afficherPave('SYNCHRONISATION…', 'Chargement de la base, patientez', null, true);
  }

  let recues = 0;

  const parcourirPages = function () {
    return Promise.all([DB.lireCurseur(), DB.lireMeta('refs_version')])
      .then(function (valeurs) {
        const curseur = valeurs[0];
        return API.sync(curseur.since, curseur.apres, valeurs[1] || '', 500);
      })
      .then(function (delta) {
        recues += (delta.participants || []).length;
        etat.cadenceS = delta.sync_interval_s || etat.cadenceS;
        return DB.appliquerDelta(delta).then(function () {
          if (delta.suite) {
            return DB.ecrireCurseur(delta.since_suivant, delta.apres_suivant)
              .then(parcourirPages);
          }
          // Fin de pagination : le curseur avance jusqu'au plus grand `maj` reçu.
          const maxMaj = (delta.participants || []).reduce(function (max, p) {
            return Math.max(max, p.maj || 0);
          }, 0);
          return DB.lireCurseur().then(function (curseur) {
            const nouveau = Math.max(curseur.since, maxMaj);
            return DB.ecrireCurseur(nouveau, '');
          });
        });
      });
  };

  return parcourirPages()
    .then(rechargerBaseMemoire)
    .then(envoyerFileScans)
    .then(function () {
      $('etat-reseau').textContent = 'à jour';
      afficherEcranPret();
      if (manuelle) message(recues + ' fiche(s) mise(s) à jour.');
    })
    .catch(function (erreur) {
      $('etat-reseau').textContent = 'échec sync';
      $('etat-reseau').className = 'alerte-reseau';
      if (etat.paveSysteme && !etat.blocage) {
        afficherPave('SYNCHRONISATION IMPOSSIBLE', erreur.message, 'orange', true);
      }
      if (manuelle) message('Synchronisation impossible : ' + erreur.message, 'erreur');
      console.warn('sync : ' + erreur.message);
    })
    .then(function () {
      etat.syncEnCours = false;
      planifierSync();
      return rafraichirBandeau();
    });
}

function rechargerBaseMemoire() {
  return Promise.all([DB.chargerBase(), DB.lireMeta('refs'), DB.lireMeta('point_controle'),
                      DB.scansRecents(3600000), DB.lireMeta('cartes')])
    .then(function (valeurs) {
      etat.base = valeurs[0];
      etat.refs = valeurs[1] || { droits: {}, formules: {}, services: [], config: {} };
      etat.pointControle = valeurs[2] || '';
      etat.scansRecents = valeurs[3];
      etat.cartes = valeurs[4] || [];
      // Les cartes arrivent avec le delta : l'affichage du cadenas doit suivre.
      montrerVue(etat.vueCourante);
    });
}

/* ─────────────────────────── Verrou des réglages ─────────────────────────── */

/**
 * Les réglages ne s'ouvrent qu'après présentation d'une carte STAFF ou ADMIN.
 *
 * ⚠️ EXCEPTION INDISPENSABLE : tant que l'application n'est pas configurée, le
 * verrou est inactif. C'est dans les réglages que l'on saisit l'URL et la clé ;
 * sur un téléphone neuf la base est vide, donc aucune carte n'est connue —
 * verrouiller sans condition rendrait l'application impossible à installer.
 */
function reglagesVerrouilles() {
  if (!API.estConfigure()) return false;
  if (!etat.cartes.length) return false;   // aucune carte déclarée : pas de verrou
  if (!etat.deverrouillage) return true;
  if (etat.deverrouillage.expire < Date.now()) { etat.deverrouillage = null; return true; }
  return false;
}

function chercherCarte(uid) {
  const cible = String(uid || '').toUpperCase();
  for (let i = 0; i < etat.cartes.length; i++) {
    if (String(etat.cartes[i].uid).toUpperCase() === cible) return etat.cartes[i];
  }
  return null;
}

function tenterDeverrouillage(uid) {
  const carte = chercherCarte(uid);
  if (!carte) {
    $('verrou-titre').textContent = 'CARTE NON RECONNUE';
    $('verrou-detail').textContent = 'Cette carte n\'ouvre pas les réglages';
    $('pave-verrou').className = 'rouge';
    if (navigator.vibrate) navigator.vibrate([200, 80, 200]);
    return false;
  }

  etat.deverrouillage = {
    nom: carte.nom, role: carte.role, expire: Date.now() + DEVERROUILLAGE_MS
  };
  $('pave-verrou').className = '';
  $('verrou-titre').textContent = 'RÉGLAGES VERROUILLÉS';
  $('verrou-detail').textContent = 'Scanner un bracelet STAFF ou ADMIN';
  if (navigator.vibrate) navigator.vibrate(60);
  montrerVue('vue-reglages');
  return true;
}

function brancherVerrou() {
  $('btn-verrou-nfc').addEventListener('click', demarrerNfc);
  $('btn-verrou-uid').addEventListener('click', function () {
    const saisi = $('champ-uid-carte').value.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    if (!saisi) { message('Saisissez l\'UID de la carte.', 'erreur'); return; }
    if (tenterDeverrouillage(saisi)) $('champ-uid-carte').value = '';
  });

  // La saisie manuelle n'apparaît que si Web NFC est indisponible — sur iPhone
  // ou hors Chrome Android, sans quoi les réglages seraient inaccessibles.
  if (!('NDEFReader' in window)) {
    $('btn-verrou-nfc').style.display = 'none';
    $('verrou-manuel').className = 'visible';
  }
}

function rafraichirBanniereDeverrouillage() {
  const banniere = $('banniere-deverrouille');
  if (!etat.deverrouillage) { banniere.className = ''; return; }
  const restant = Math.max(0, Math.round((etat.deverrouillage.expire - Date.now()) / 60000));
  banniere.textContent = 'Ouvert par ' + etat.deverrouillage.nom +
    ' (' + etat.deverrouillage.role + ') — refermeture dans ' + restant + ' min';
  banniere.className = 'visible';
}

/* ─────────────────────────── Envoi des scans ─────────────────────────── */

/**
 * Vide la file d'attente. Les scans ne sont retirés qu'APRÈS confirmation du
 * serveur ; en cas d'échec ils restent en file et repartiront au prochain
 * essai. L'idempotence par `scan_id` rend ce rejeu sans conséquence.
 */
function envoyerFileScans() {
  if (!API.estConfigure() || !navigator.onLine) return Promise.resolve();
  return DB.lireFileScans(100).then(function (file) {
    if (!file.length) return;
    return API.envoyerScans(file).then(function () {
      return DB.retirerScans(file.map(function (s) { return s.scan_id; }));
    }).catch(function (erreur) {
      console.warn('envoi des scans différé : ' + erreur.message);
    });
  }).then(rafraichirBandeau);
}

/* ─────────────────────────── Lecture NFC ─────────────────────────── */

function brancherNfc() {
  // La saisie manuelle est TOUJOURS disponible : un bracelet abîmé, une puce
  // non compatible NDEF ou un téléphone sans Web NFC ne doivent jamais empêcher
  // de traiter une personne devant la file.
  $('btn-basculer-manuel').addEventListener('click', function () {
    const zone = $('saisie-manuelle');
    const ouvert = zone.className === 'visible';
    zone.className = ouvert ? '' : 'visible';
    if (!ouvert) $('champ-uid-scan').focus();
  });

  const controler = function () {
    const saisi = normaliserUid($('champ-uid-scan').value);
    if (!saisi) { message('Saisissez un UID.', 'erreur'); return; }
    $('champ-uid-scan').value = '';
    traiterScan(saisi);
  };
  $('btn-scan-manuel').addEventListener('click', controler);
  $('champ-uid-scan').addEventListener('keydown', function (evenement) {
    if (evenement.key === 'Enter') controler();
  });

  if (!('NDEFReader' in window)) {
    $('btn-nfc').style.display = 'none';
    $('nfc-indispo').style.display = 'block';
    $('saisie-manuelle').className = 'visible';
    return;
  }
  $('btn-nfc').addEventListener('click', demarrerNfc);
}

function demarrerNfc() {
  const lecteur = new NDEFReader();
  // `scan()` doit être déclenché par un geste de l'utilisateur : c'est une
  // exigence du navigateur, on ne peut pas démarrer la lecture au chargement.
  lecteur.scan().then(function () {
    etat.lecteurNfc = lecteur;
    $('btn-nfc').textContent = 'LECTURE NFC ACTIVE';
    $('btn-nfc').disabled = true;
    $('btn-verrou-nfc').textContent = 'LECTURE NFC ACTIVE — PRÉSENTEZ LA CARTE';
    $('btn-verrou-nfc').disabled = true;
    afficherPave('PRÊT', 'Approchez un bracelet', null, true);

    lecteur.onreading = function (evenement) {
      const uid = normaliserUid(evenement.serialNumber);
      // Un seul lecteur pour toute l'application : c'est l'écran affiché qui
      // décide de ce que l'on fait de la carte présentée.
      if (etat.vueCourante === 'vue-verrou') tenterDeverrouillage(uid);
      else traiterScan(uid);
    };
    /**
     * Web NFC ne sait lire QUE les puces au format NDEF.
     *
     * Une carte de transport, un badge MIFARE Classic ou une puce non formatée
     * déclenchent cette erreur — même si une application native comme NFC Tools
     * les lit sans difficulté, car elle accède à l'UID sous la couche NDEF.
     *
     * Le message doit donc orienter vers la vraie cause plutôt que d'inviter à
     * représenter indéfiniment une puce que le navigateur ne lira jamais.
     */
    lecteur.onreadingerror = function () {
      etat.echecsLecture = (etat.echecsLecture || 0) + 1;
      afficherPave('LECTURE IMPOSSIBLE',
        etat.echecsLecture >= 2
          ? 'Puce non compatible NDEF (carte de transport, badge MIFARE) — ' +
            'utilisez la saisie manuelle'
          : 'Représentez le bracelet',
        'orange');
    };
  }).catch(function (erreur) {
    $('btn-nfc').textContent = 'DÉMARRER LA LECTURE NFC';
    afficherPave('NFC INDISPONIBLE', erreur.message, 'rouge');
  });
}

/**
 * Le navigateur renvoie l'UID sous la forme « 04:a1:b2:c3:d4:e5:f6 ».
 * Le backend le stocke en hexadécimal continu et en majuscules : sans cette
 * normalisation, aucun bracelet ne serait jamais reconnu.
 */
function normaliserUid(serie) {
  return String(serie || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

/* ─────────────────────────── Traitement d'un scan ─────────────────────────── */

function traiterScan(uid) {
  if (!uid) return;

  // Un écran bloquant doit être acquitté avant tout nouveau scan… sauf si l'on
  // présente un AUTRE bracelet : la file ne doit pas s'arrêter parce que
  // quelqu'un s'est éloigné sans acquitter.
  if (etat.blocage && etat.blocage.uid === uid) return;
  if (etat.blocage) leverBlocage();

  const decision = evaluerScan({
    uid: uid,
    point_controle: etat.pointControle,
    maintenant: Date.now(),
    base: etat.base,
    refs: etat.refs,
    scans_recents: etat.scansRecents,
    verrouillage: lireVerrouillage()
  });

  afficherDecision(decision);
  vibrer(decision);

  const scan = {
    scan_id: uuid(),
    ts_terminal: Date.now(),
    uid: uid,
    numero: decision.participant ? decision.participant.numero : '',
    point_controle: etat.pointControle,
    decision: decision.etat,
    motif: decision.detail,
    service: decision.service || 0
  };

  // Écrit AVANT tout appel réseau : un scan doit survivre à une fermeture
  // d'onglet ou à une coupure.
  DB.empilerScan(scan)
    .then(function () {
      etat.scansRecents.unshift(scan);
      return rafraichirBandeau();
    })
    .then(envoyerFileScans);
}

function lireVerrouillage() {
  const config = (etat.refs && etat.refs.config) || {};
  const motif = config.verrouillage_urgence || '';
  return { actif: !!motif, motif: motif };
}

/* ─────────────────────────── Affichage ─────────────────────────── */

function afficherDecision(decision) {
  afficherPave(decision.libelle, decision.detail, decision.couleur);

  // L'alerte médicale est un bandeau SÉPARÉ : un badge peut être parfaitement
  // valide et porter un risque d'épilepsie, les deux doivent coexister.
  const alerte = $('alerte');
  alerte.textContent = decision.alerte ? '⚠ ' + decision.alerte : '';
  alerte.className = decision.alerte ? 'visible' : '';

  const p = decision.participant;
  const identite = $('identite');
  if (p) {
    identite.className = 'visible';
    $('nom').textContent = (p.prenom || '') + ' ' + (p.nom || '');
    $('ligne-numero').innerHTML = 'N° <b>' + echapper(p.numero) + '</b>';
    $('ligne-statut').innerHTML = 'Statut <b>' + echapper(p.statut || '—') + '</b>';
    $('ligne-ecole').innerHTML = p.ecole ? 'École <b>' + echapper(p.ecole) + '</b>' : '';
    afficherPhoto(p.numero);
  } else {
    identite.className = '';
  }

  afficherRepas(decision);
  gererBlocage(decision);
}

/**
 * @param {boolean=} systeme Message d'état de l'application (configuration
 *   requise, erreur, prêt) plutôt que la décision d'un scan. Ces messages-là
 *   peuvent être remplacés automatiquement ; une décision affichée à l'agent,
 *   jamais.
 */
function afficherPave(libelle, detail, couleur, systeme) {
  $('pave-libelle').textContent = libelle;
  $('pave-detail').textContent = detail || '';
  $('pave').className = couleur || '';
  etat.paveSysteme = systeme === true;
}

/**
 * Remet l'écran en attente de scan.
 *
 * Appelé après une synchronisation réussie : sans cela, le pavé
 * « CONFIGURATION REQUISE » affiché au démarrage restait indéfiniment à
 * l'écran, alors que l'application était devenue opérationnelle.
 *
 * Ne touche JAMAIS à une décision en cours d'affichage, ni à un écran bloquant
 * en attente d'acquittement.
 */
function afficherEcranPret() {
  if (!etat.paveSysteme || etat.blocage) return;
  afficherPave('PRÊT', 'Approchez un bracelet', null, true);
  $('identite').className = '';
  $('alerte').className = '';
  $('repas').className = '';
}

function afficherPhoto(numero) {
  const img = $('photo');
  const absente = $('photo-absente');

  const montrer = function (blob) {
    // L'URL précédente est révoquée : sans cela, chaque scan fuirait quelques
    // kilo-octets, ce qui finit par compter sur une journée de milliers de
    // passages.
    if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
    const url = URL.createObjectURL(blob);
    img.dataset.url = url;
    img.src = url;
    img.className = 'visible';
    absente.className = 'cache';
  };

  const masquer = function () {
    img.removeAttribute('src');
    img.className = '';
    absente.className = '';
  };

  masquer();
  DB.lirePhoto(numero).then(function (blob) {
    if (blob) { montrer(blob); return; }
    // Absente du cache : on tente de la récupérer, mais le cadre explicite
    // reste affiché en attendant — jamais d'image cassée.
    if (navigator.onLine && API.estConfigure()) {
      API.photo(numero)
        .then(function (blob) {
          return DB.ecrirePhoto(numero, blob).then(function () { return blob; });
        })
        .then(montrer)
        .catch(function () { /* photo réellement absente : le cadre suffit */ });
    }
  });
}

function afficherRepas(decision) {
  const bloc = $('repas');
  if (!decision.repas) { bloc.className = ''; return; }
  bloc.className = 'visible';

  const regime = decision.repas.regime || 'Classique';
  $('regime').textContent = regime.toUpperCase();
  $('regime').className = 'regime' +
    (regime.toLowerCase().indexOf('végét') === 0 ? ' vegetarien' : '');

  const services = (etat.refs.services || []);
  const consommes = decision.repas.repas_consommes || [];
  const courant = decision.repas.service ? decision.repas.service.numero : 0;

  $('services').innerHTML = services.map(function (s) {
    const classes = ['service'];
    if (consommes.indexOf(s.numero) !== -1) classes.push('consomme');
    if (s.numero === courant) classes.push('courant');
    return '<div class="' + classes.join(' ') + '">n°' + s.numero + '</div>';
  }).join('');

  $('formule').textContent = 'Formule : ' + (decision.repas.formule || '—');
}

/* ─────────────────────────── Écran bloquant ─────────────────────────── */

/**
 * L'état PASSBACK bloque l'écran jusqu'à acquittement — un contrôle approfondi
 * ne doit pas pouvoir être escamoté en laissant la file avancer.
 *
 * Mais un blocage sans échappatoire arrêterait la file indéfiniment : d'où
 * l'expiration automatique, journalisée COMME TELLE pour qu'un dépouillement
 * distingue un contrôle réellement effectué d'un simple délai écoulé.
 */
function gererBlocage(decision) {
  const zone = $('acquittement');
  if (!decision.bloquant) { zone.className = ''; etat.blocage = null; return; }

  zone.className = 'visible';
  const expiration = Date.now() + (decision.expiration_s || 60) * 1000;
  etat.blocage = { uid: decision.uid || '', expiration: expiration, minuteur: null };

  const tic = function () {
    const restant = Math.ceil((expiration - Date.now()) / 1000);
    if (restant <= 0) {
      leverBlocage('EXPIRATION');
      return;
    }
    $('compte-a-rebours').textContent =
      'Déblocage automatique dans ' + restant + ' s (journalisé comme expiration)';
    etat.blocage.minuteur = setTimeout(tic, 500);
  };
  tic();
}

function leverBlocage(motif) {
  if (!etat.blocage) return;
  clearTimeout(etat.blocage.minuteur);

  if (motif === 'EXPIRATION') {
    DB.empilerScan({
      scan_id: uuid(), ts_terminal: Date.now(), uid: etat.blocage.uid,
      numero: '', point_controle: etat.pointControle,
      decision: 'PASSBACK_SUSPECTE', motif: 'Déblocage par expiration, sans acquittement',
      service: 0
    }).then(envoyerFileScans);
  }

  etat.blocage = null;
  $('acquittement').className = '';
  afficherPave('PRÊT', 'Approchez un bracelet', null, true);
}

function brancherAcquittement() {
  $('btn-acquitter').addEventListener('click', function () { leverBlocage('ACQUITTE'); });
}

/* ─────────────────────────── Recherche ─────────────────────────── */

function brancherRecherche() {
  let minuteur = null;
  $('champ-recherche').addEventListener('input', function (evenement) {
    clearTimeout(minuteur);
    const requete = evenement.target.value;
    minuteur = setTimeout(function () { afficherResultats(requete); }, 120);
  });
}

function afficherResultats(requete) {
  const resultats = DB.rechercher(etat.base, requete, 20);
  if (!resultats.length) {
    $('resultats').innerHTML = requete.length < 2
      ? '<div class="note">Saisissez au moins deux caractères.</div>'
      : '<div class="note">Aucun résultat.</div>';
    return;
  }
  $('resultats').innerHTML = resultats.map(function (p) {
    return '<div class="resultat" data-numero="' + echapper(p.numero) + '">' +
           '<div class="nom">' + echapper(p.prenom + ' ' + p.nom) + '</div>' +
           '<div class="meta">' + echapper(p.numero) + ' · ' + echapper(p.statut || '') +
           (p.ecole ? ' · ' + echapper(p.ecole) : '') + '</div></div>';
  }).join('');

  Array.prototype.forEach.call($('resultats').children, function (element) {
    element.addEventListener('click', function () {
      afficherFiche(element.dataset.numero);
    });
  });
}

/**
 * Consultation d'une fiche : ce n'est PAS un scan.
 * Aucune ligne n'est écrite dans le journal — consulter n'est pas contrôler.
 */
function afficherFiche(numero) {
  const p = etat.base.participants.get(numero);
  if (!p) return;
  montrerVue('vue-scan');
  afficherPave('CONSULTATION', 'Aucun passage enregistré', null);

  $('alerte').textContent = p.commentaire ? '⚠ ' + p.commentaire : '';
  $('alerte').className = p.commentaire ? 'visible' : '';
  $('identite').className = 'visible';
  $('nom').textContent = (p.prenom || '') + ' ' + (p.nom || '');
  $('ligne-numero').innerHTML = 'N° <b>' + echapper(p.numero) + '</b>';
  $('ligne-statut').innerHTML = 'Statut <b>' + echapper(p.statut || '—') + '</b>';
  $('ligne-ecole').innerHTML = p.ecole ? 'École <b>' + echapper(p.ecole) + '</b>' : '';
  $('repas').className = '';
  $('acquittement').className = '';
  afficherPhoto(p.numero);
}

/* ─────────────────────────── Photos ─────────────────────────── */

/**
 * Préchargement complet, à faire en Wi-Fi.
 * Séquentiel et non parallèle : cent requêtes simultanées vers Apps Script
 * seraient étranglées côté serveur et bien plus lentes.
 */
function prechargerPhotos() {
  if (!API.estConfigure()) { message('Configurez d\'abord la connexion.', 'erreur'); return; }
  const numeros = Array.from(etat.base.participants.keys());
  if (!numeros.length) { message('Base vide : synchronisez d\'abord.', 'erreur'); return; }
  if (!confirm(numeros.length + ' photos à télécharger (~' +
      Math.round(numeros.length * 12 / 1024) + ' Mo).\n\nÀ faire en Wi-Fi. Continuer ?')) return;

  const bouton = $('btn-photos');
  bouton.disabled = true;
  let index = 0, obtenues = 0, absentes = 0;

  const suivante = function () {
    if (index >= numeros.length) {
      bouton.disabled = false;
      bouton.textContent = 'PRÉCHARGER LES PHOTOS';
      message(obtenues + ' photo(s) en cache, ' + absentes + ' absente(s).');
      return rafraichirBandeau();
    }
    const numero = numeros[index++];
    bouton.textContent = 'TÉLÉCHARGEMENT ' + index + '/' + numeros.length;

    return DB.lirePhoto(numero).then(function (existante) {
      if (existante) { obtenues++; return; }
      return API.photo(numero)
        .then(function (blob) { obtenues++; return DB.ecrirePhoto(numero, blob); })
        .catch(function () { absentes++; });
    }).then(suivante);
  };
  suivante();
}

/* ─────────────────────────── Interface ─────────────────────────── */

function brancherNavigation() {
  Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (bouton) {
    bouton.addEventListener('click', function () { montrerVue(bouton.dataset.vue); });
  });
}

function montrerVue(identifiant) {
  // Interception : les réglages passent par l'écran de verrou tant qu'aucune
  // carte STAFF ou ADMIN n'a été présentée.
  if (identifiant === 'vue-reglages' && reglagesVerrouilles()) {
    identifiant = 'vue-verrou';
  }
  etat.vueCourante = identifiant;

  Array.prototype.forEach.call(document.querySelectorAll('.vue'), function (vue) {
    vue.className = 'vue' + (vue.id === identifiant ? ' visible' : '');
  });
  // L'onglet RÉGLAGES reste visuellement actif même sur l'écran de verrou :
  // l'agent doit comprendre où il est, pas se croire perdu.
  const ongletActif = identifiant === 'vue-verrou' ? 'vue-reglages' : identifiant;
  const verrouille = reglagesVerrouilles();
  Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (bouton) {
    const classes = [];
    if (bouton.dataset.vue === ongletActif) classes.push('actif');
    // Le cadenas dit que l'onglet EXISTE mais demande une carte — un bouton
    // simplement inerte laisserait croire à une panne.
    if (bouton.dataset.vue === 'vue-reglages' && verrouille) classes.push('verrouille');
    bouton.className = classes.join(' ');
  });

  if (identifiant === 'vue-reglages') {
    rafraichirStatistiques();
    rafraichirBanniereDeverrouillage();
  }
}

function rafraichirBandeau() {
  return DB.compterFileScans().then(function (attente) {
    $('etat-file').textContent = attente + ' en attente';
    if (!navigator.onLine) {
      $('etat-reseau').textContent = 'hors ligne';
      $('etat-reseau').className = 'alerte-reseau';
    } else if ($('etat-reseau').textContent === 'hors ligne') {
      $('etat-reseau').textContent = 'en ligne';
      $('etat-reseau').className = '';
    }
  });
}

function rafraichirStatistiques() {
  DB.statistiques().then(function (s) {
    $('stat-participants').textContent = s.participants;
    $('stat-bracelets').textContent = s.bracelets;
    $('stat-photos').textContent = s.photos;
    $('stat-attente').textContent = s.en_attente;
  });
  DB.lireMeta('derniere_sync').then(function (horodatage) {
    $('stat-sync').textContent = horodatage
      ? new Date(horodatage).toLocaleTimeString('fr-FR')
      : 'jamais';
  });
  DB.lireMeta('point_controle').then(function (point) {
    $('stat-point').textContent = point || '—';
  });
  $('stat-version').textContent = 'v' + VERSION_APP;
}

/** Retour haptique : distinct selon la gravité, perceptible sans regarder. */
function vibrer(decision) {
  if (!navigator.vibrate) return;
  if (decision.couleur === 'vert') navigator.vibrate(60);
  else if (decision.couleur === 'orange') navigator.vibrate([80, 60, 80]);
  else if (decision.couleur === 'rouge') navigator.vibrate([200, 80, 200]);
}

function echapper(texte) {
  const div = document.createElement('div');
  div.textContent = texte == null ? '' : String(texte);
  return div.innerHTML;
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}
