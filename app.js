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
  deverrouillage: null,      // { nom, role, expire }
  vueDemandee: null,         // vue visée avant interception par le verrou
  demarrage: false,          // écran de première mise en service affiché
  ecranOccupe: false,        // une décision ou une fiche est affichée
  derniereDecision: null,    // décision affichée, pour savoir qui l'on signale
  filtres: { ecole: '', statut: '' }   // conservés d'une recherche à l'autre
};

/**
 * Version de la coque applicative.
 * Incrémentée automatiquement par tools/deployer_webapp.sh, en même temps que
 * le cache du Service Worker. Affichée dans les réglages : c'est le seul moyen
 * de savoir, depuis le terrain, si un téléphone exécute bien le dernier code.
 */
const VERSION_APP = 13;

/**
 * Durée d'ouverture des fonctions réservées après présentation d'une carte.
 *
 * Réglable depuis l'onglet `Config` du classeur (`deverrouillage_s`) : au
 * guichet d'accueil, un opérateur enchaîne 800 attributions dans l'après-midi
 * et ne peut pas représenter une carte toutes les cinq minutes. On y met
 * plusieurs heures ; sur un téléphone de terrain, quelques minutes.
 */
const DEVERROUILLAGE_S_DEFAUT = 900;

/**
 * Rôle attribué au déverrouillage de dépannage ouvert depuis l'écran de
 * démarrage. Nommé pour qu'il apparaisse tel quel dans le bandeau : on doit
 * voir que cette session n'a été ouverte par aucune carte.
 */
const ROLE_DEPANNAGE = 'SANS CARTE';

function dureeDeverrouillageMs() {
  const config = (etat.refs && etat.refs.config) || {};
  const valeur = parseInt(config.deverrouillage_s, 10);
  return (valeur > 0 ? valeur : DEVERROUILLAGE_S_DEFAUT) * 1000;
}

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
  brancher('association', brancherAssociation);
  brancher('démarrage', brancherDemarrage);
  brancher('historique', brancherHistorique);
  brancher('signalement', brancherSignalement);

  chargerReglages();
  etat.deverrouillage = lireDeverrouillagePersiste();

  DB.ouvrirDb()
    .then(rechargerBaseMemoire)
    .then(rafraichirBandeau)
    .then(function () {
      if (!API.estConfigure()) {
        montrerVue('vue-reglages');
        afficherPave('CONFIGURATION REQUISE', 'Renseignez l\'URL et la clé API', null, true);
        return;
      }
      envoyerFileScans();
      // Base vide : l'appareil ne peut RIEN décider. On bloque sur l'écran de
      // démarrage plutôt que de laisser croire qu'il est opérationnel — un
      // bénévole qui scanne sur une base vide obtiendrait « NON RECONNU » sur
      // tout le monde et conclurait à des bracelets défectueux.
      if (etat.base.participants.size === 0) {
        ouvrirEcranDemarrage();
        synchroniser(false);
      } else {
        planifierSync(1000);
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

/* ──────────────────── Écran de première mise en service ──────────────────── */

/**
 * Bloque l'application tant que la base n'est pas chargée.
 *
 * Deux raisons, aucune cosmétique :
 *   1. un terminal à base vide refuserait TOUT LE MONDE avec « NON RECONNU »,
 *      ce qu'un bénévole interpréterait comme des bracelets défectueux ;
 *   2. le premier chargement dure une quinzaine de secondes sur 2 000 fiches —
 *      sans écran dédié, on croit que le lien n'a pas fonctionné et on le
 *      rouvre en boucle.
 *
 * ⚠️ Un écran bloquant DOIT avoir une issue. En cas d'échec (mauvaise clé, pas
 * de réseau), on offre « RÉESSAYER » et « OUVRIR LES RÉGLAGES » : sans cela un
 * téléphone mal configuré serait définitivement inutilisable.
 */
function ouvrirEcranDemarrage() {
  etat.demarrage = true;
  const zone = $('demarrage');
  zone.className = 'visible';
  $('demarrage-etat').textContent = 'Chargement de la base…';
  $('demarrage-compteur').textContent = '';
}

function fermerEcranDemarrage() {
  etat.demarrage = false;
  $('demarrage').className = '';
}

function majProgressionDemarrage(recues) {
  if (!etat.demarrage) return;
  $('demarrage-compteur').textContent = recues
    ? recues.toLocaleString('fr-FR') + ' fiches chargées'
    : '';
}

function echecEcranDemarrage(motif) {
  if (!etat.demarrage) return;
  $('demarrage').className = 'visible echec';
  $('demarrage-etat').textContent = 'Synchronisation impossible';
  $('demarrage-compteur').textContent = motif;
}

function brancherDemarrage() {
  $('btn-demarrage-reessayer').addEventListener('click', function () {
    $('demarrage').className = 'visible';
    $('demarrage-etat').textContent = 'Chargement de la base…';
    $('demarrage-compteur').textContent = '';
    synchroniser(false);
  });
  // Porte de sortie : c'est dans les réglages que l'on corrige l'URL ou la clé.
  //
  // Elle passe DÉLIBÉRÉMENT outre le verrou par carte. Un écran bloquant dont
  // la seule issue mène à un second écran bloquant transforme un téléphone mal
  // configuré en brique, et il n'y a pas toujours un bracelet STAFF à portée
  // de main quand on met en service à 7 h du matin.
  $('btn-demarrage-reglages').addEventListener('click', function () {
    fermerEcranDemarrage();
    // Volontairement NON persisté : ce déverrouillage de dépannage contourne le
    // verrou, il ne doit pas survivre au rechargement qui suit la correction.
    etat.deverrouillage = { nom: 'Dépannage', role: ROLE_DEPANNAGE,
                            expire: Date.now() + 5 * 60 * 1000 };
    montrerVue('vue-reglages');
  });
}

/* ─────────────────────────── Réglages ─────────────────────────── */

/**
 * Configuration transmise par le lien lui-même.
 *
 * Format : …/index.html#url=<URL>&cle=<CLE>&terminal=<ID>
 *
 * On emploie le FRAGMENT (#) et non la requête (?) : le fragment n'est jamais
 * envoyé au serveur, il ne se retrouve donc ni dans les journaux de GitHub
 * Pages ni dans un en-tête Referer. Il est effacé de la barre d'adresse aussitôt
 * lu, pour ne pas rester en clair à l'écran ni dans l'historique.
 *
 * Pourquoi ne PAS inscrire la clé dans le code : le dépôt est public et le
 * JavaScript servi est lisible de toute façon. La clé voyage donc avec
 * l'invitation, que l'on transmet aux bénévoles, et pas avec le programme.
 */
function lireConfigDuLien() {
  const fragment = location.hash.replace(/^#/, '');
  if (!fragment) return false;

  const params = new URLSearchParams(fragment);
  const url = params.get('url') || '';
  const cle = params.get('cle') || '';
  const terminal = params.get('terminal') || '';
  if (!cle && !url && !terminal) return false;

  if (url) localStorage.setItem('api_url', url);
  if (cle) localStorage.setItem('api_cle', cle);
  if (terminal) localStorage.setItem('api_terminal', terminal);

  // Effacement immédiat : la clé ne doit pas rester visible dans la barre
  // d'adresse, ni être capturée par une capture d'écran ou un partage de lien.
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}

function chargerReglages() {
  const venuDuLien = lireConfigDuLien();

  const url = localStorage.getItem('api_url') || '';
  const cle = localStorage.getItem('api_cle') || '';
  const terminal = localStorage.getItem('api_terminal') || 'WEB-01';

  if (venuDuLien) {
    message('Configuration reçue par le lien — synchronisation en cours.');
  }
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
    // Première configuration saisie à la main : même écran de chargement que
    // par le lien, le chemin ne change pas ce que l'appareil sait faire.
    if (etat.base.participants.size === 0) ouvrirEcranDemarrage();
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

  // La synchronisation ne s'affiche QUE dans le bandeau du haut : c'est une
  // activité de fond, elle n'a rien à faire dans le pavé de décision que
  // l'agent regarde entre deux scans. Le tout premier chargement, lui, a son
  // écran dédié — voir ouvrirEcranDemarrage().
  let recues = 0;

  const parcourirPages = function () {
    return Promise.all([DB.lireCurseur(), DB.lireMeta('refs_version')])
      .then(function (valeurs) {
        const curseur = valeurs[0];
        return API.sync(curseur.since, curseur.apres, valeurs[1] || '', 500);
      })
      .then(function (delta) {
        recues += (delta.participants || []).length;
        majProgressionDemarrage(recues);
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
      // On ne libère l'écran de démarrage que si la base est RÉELLEMENT peuplée :
      // une sync réussie sur un classeur vide ne rend pas l'appareil utilisable.
      if (etat.demarrage) {
        if (etat.base.participants.size > 0) fermerEcranDemarrage();
        else echecEcranDemarrage('Le serveur n\'a renvoyé aucun participant — '
          + 'vérifiez l\'identifiant du terminal et le classeur.');
      }
      if (manuelle) message(recues + ' fiche(s) mise(s) à jour.');
      // Sans cet appel, la rétention de l'historique n'est qu'une intention :
      // le magasin grossit indéfiniment, et chaque lecture avec lui.
      DB.purgerHistorique().catch(function (erreur) {
        console.warn('purge de l\'historique : ' + erreur.message);
      });
      return verifierPeremption();
    })
    .catch(function (erreur) {
      $('etat-reseau').textContent = 'échec sync';
      $('etat-reseau').className = 'alerte-reseau';
      echecEcranDemarrage(erreur.message);
      if (manuelle) message('Synchronisation impossible : ' + erreur.message, 'erreur');
      console.warn('sync : ' + erreur.message);
    })
    .then(function () {
      etat.syncEnCours = false;
      planifierSync();
      return rafraichirBandeau();
    });
}

/**
 * Péremption du terminal.
 *
 * Le serveur renvoie `expire_le` (colonne de l'onglet `Terminaux`). Passé ce
 * moment, l'appareil efface LUI-MÊME la clé API, l'URL et toute la base locale.
 *
 * C'est la révocation individuelle : elle évite d'avoir à régénérer la clé API,
 * qui invaliderait tous les terminaux d'un coup. Un téléphone rendu — ou gardé —
 * cesse simplement de contenir quoi que ce soit.
 *
 * ⚠️ PRÉCAUTION CAPITALE : on n'efface RIEN tant que des scans attendent d'être
 * envoyés. Effacer un téléphone dont la file n'est pas vide perdrait des
 * passages définitivement. L'écran le dit, et l'effacement attend.
 */
function verifierPeremption() {
  return DB.lireMeta('expire_le').then(function (expiration) {
    if (!expiration || Date.now() < expiration) return;

    return DB.compterFileScans().then(function (enAttente) {
      if (enAttente > 0) {
        afficherPave('EXPIRÉ — ENVOI EN COURS',
          enAttente + ' scan(s) restent à remonter avant effacement', 'orange', true);
        return;
      }
      return effacerTerminal();
    });
  });
}

/**
 * Efface toute trace du terminal : configuration, base, photos, historique.
 * Appelé uniquement quand la file d'envoi est vide.
 */
function effacerTerminal() {
  clearTimeout(etat.minuteurSync);
  localStorage.removeItem('api_url');
  localStorage.removeItem('api_cle');
  // Un terminal expiré ne laisse rien derrière lui, déverrouillage compris.
  ecrireDeverrouillage(null);
  API.configurer('', '', localStorage.getItem('api_terminal') || '');

  return DB.purgerBase()
    .then(function () { return DB.viderHistorique(); })
    .then(function () {
      etat.base = { participants: new Map(), bracelets: new Map() };
      etat.cartes = [];
      afficherPave('TERMINAL EXPIRÉ',
        'Données effacées. Rescannez un QR code de configuration pour réactiver.',
        'rouge', true);
      $('identite').className = '';
      $('repas').className = '';
      return rafraichirBandeau();
    });
}

function rechargerBaseMemoire() {
  return Promise.all([DB.chargerBase(), DB.lireMeta('refs'), DB.lireMeta('point_controle'),
                      DB.scansRecents(3600000, 500), DB.lireMeta('cartes'),
                      DB.lireMeta('peut_associer')])
    .then(function (valeurs) {
      etat.base = valeurs[0];
      etat.refs = valeurs[1] || { droits: {}, formules: {}, services: [], config: {} };
      etat.pointControle = valeurs[2] || '';
      etat.scansRecents = valeurs[3];
      etat.cartes = valeurs[4] || [];
      etat.peutAssocier = valeurs[5] === true;
      // Les cartes arrivent avec le delta : l'affichage du cadenas doit suivre.
      montrerVue(etat.vueCourante);
    });
}

/* ─────────────────────────── Verrou des réglages ─────────────────────────── */

/** Vues réservées, accessibles seulement après présentation d'une carte. */
const VUES_RESERVEES = ['vue-reglages', 'vue-recherche'];

/**
 * Réglages ET recherche ne s'ouvrent qu'après présentation d'une carte STAFF
 * ou ADMIN.
 *
 * La recherche donne accès à l'identité des participants, à leurs alertes
 * médicales et — depuis un terminal habilité — à l'attribution des bracelets.
 * Ce n'est pas un écran de consultation anodin.
 *
 * ⚠️ EXCEPTION INDISPENSABLE : tant que l'application n'est pas configurée, le
 * verrou est inactif. C'est dans les réglages que l'on saisit l'URL et la clé ;
 * sur un téléphone neuf la base est vide, donc aucune carte n'est connue —
 * verrouiller sans condition rendrait l'application impossible à installer.
 */
/**
 * Clé de stockage du déverrouillage en cours.
 *
 * Il DOIT survivre à un rechargement de page : au guichet d'accueil, une
 * vacation dure près de cinq heures, et Android ferme volontiers une PWA passée
 * en arrière-plan. Sans persistance, l'opérateur qui verrouille son écran deux
 * minutes doit rechercher son bracelet STAFF — alors que le classeur annonce
 * plusieurs heures d'ouverture.
 *
 * Ce que cela change côté sécurité : rien de significatif. Un téléphone
 * abandonné restait déjà ouvert jusqu'à l'expiration tant que l'application
 * était à l'écran. Le verrou protège de la fausse manœuvre, pas du vol — c'est
 * l'arbitrage assumé depuis le début, et `deverrouillage_s` reste le réglage
 * qui le borne.
 */
const CLE_DEVERROUILLAGE = 'deverrouillage';

/** Relit le déverrouillage persisté. Renvoie null s'il est absent ou périmé. */
function lireDeverrouillagePersiste() {
  try {
    const brut = localStorage.getItem(CLE_DEVERROUILLAGE);
    if (!brut) return null;
    const ouverture = JSON.parse(brut);
    if (!ouverture || !(ouverture.expire > Date.now())) {
      localStorage.removeItem(CLE_DEVERROUILLAGE);
      return null;
    }
    return ouverture;
  } catch (erreur) {
    // Contenu illisible : on referme, c'est le comportement sûr.
    localStorage.removeItem(CLE_DEVERROUILLAGE);
    return null;
  }
}

function ecrireDeverrouillage(ouverture) {
  etat.deverrouillage = ouverture;
  if (ouverture) {
    try { localStorage.setItem(CLE_DEVERROUILLAGE, JSON.stringify(ouverture)); }
    catch (erreur) { console.warn('déverrouillage non persisté : ' + erreur.message); }
  } else {
    localStorage.removeItem(CLE_DEVERROUILLAGE);
  }
}

function reglagesVerrouilles() {
  if (!API.estConfigure()) return false;
  if (!etat.cartes.length) return false;   // aucune carte déclarée : pas de verrou
  if (!etat.deverrouillage) return true;
  if (etat.deverrouillage.expire < Date.now()) { ecrireDeverrouillage(null); return true; }
  return false;
}

function chercherCarte(uid) {
  const cible = String(uid || '').toUpperCase();
  for (let i = 0; i < etat.cartes.length; i++) {
    if (String(etat.cartes[i].uid).toUpperCase() === cible) return etat.cartes[i];
  }
  return null;
}

/** Prépare l'écran de verrou en nommant la fonction que l'on cherchait. */
function preparerVerrou(vueVisee) {
  etat.vueDemandee = vueVisee;
  $('pave-verrou').className = '';
  $('verrou-titre').textContent = vueVisee === 'vue-recherche'
    ? 'RECHERCHE VERROUILLÉE' : 'RÉGLAGES VERROUILLÉS';
  $('verrou-detail').textContent = 'Scannez un bracelet STAFF pour déverrouiller';
}

function tenterDeverrouillage(uid) {
  const carte = chercherCarte(uid);
  if (!carte) {
    $('verrou-titre').textContent = 'CARTE NON RECONNUE';
    $('verrou-detail').textContent = 'Ce bracelet n\'est pas déclaré comme STAFF';
    $('pave-verrou').className = 'rouge';
    if (navigator.vibrate) navigator.vibrate([200, 80, 200]);
    return false;
  }

  ecrireDeverrouillage({
    uid: carte.uid, nom: carte.nom, role: carte.role,
    expire: Date.now() + dureeDeverrouillageMs()
  });
  $('pave-verrou').className = '';
  $('verrou-detail').textContent = 'Scannez un bracelet STAFF pour déverrouiller';
  if (navigator.vibrate) navigator.vibrate(60);
  // On rouvre l'écran que l'agent voulait, pas systématiquement les réglages :
  // il a cliqué sur RECHERCHE, il doit atterrir sur la recherche.
  montrerVue(etat.vueDemandee || 'vue-reglages');
  etat.vueDemandee = null;
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
  // Pas de saisie manuelle d'UID sur l'écran de scan : elle ne sert pas en
  // pratique, et un cas exceptionnel se traite mieux directement dans le
  // classeur. Le champ subsiste sur l'écran de verrou, où il reste
  // indispensable aux appareils sans Web NFC.
  if (!('NDEFReader' in window)) {
    $('btn-nfc').style.display = 'none';
    $('nfc-indispo').style.display = 'block';
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
      // Une fiche ouverte ne détourne plus la lecture : il faut avoir cliqué
      // sur ATTRIBUER. Sinon, présenter un bracelet devant une fiche affichée
      // le réattribuerait par accident à la personne consultée.
      else if (etat.association && etat.association.enAttente) attribuerBracelet(uid);
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

  // Un vrai scan referme le bloc d'attribution : sans cela, les boutons
  // resteraient à l'écran sous la décision et se rapporteraient encore à la
  // fiche consultée juste avant — donc à quelqu'un d'autre.
  fermerAssociation();
  etat.ficheCourante = null;
  fermerSignalement();

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
  etat.derniereDecision = decision;
  const inconnu = decision.etat === 'NON_RECONNU';
  afficherPave(decision.libelle, decision.detail, decision.couleur, false,
               inconnu ? decision.uid : '');

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
  etat.ecranOccupe = true;
  majBoutonEffacer();
  majBlocSignalement();
}

/**
 * @param {boolean=} systeme Message d'état de l'application (configuration
 *   requise, erreur, prêt) plutôt que la décision d'un scan. Ces messages-là
 *   peuvent être remplacés automatiquement ; une décision affichée à l'agent,
 *   jamais.
 */
function afficherPave(libelle, detail, couleur, systeme, uid) {
  $('pave-libelle').textContent = libelle;
  $('pave-detail').textContent = detail || '';
  // L'UID n'est affiché que pour un bracelet inconnu : c'est le seul cas où il
  // sert à quelque chose — le recopier dans le classeur pour déclarer une carte
  // privilégiée ou rattraper une association ratée.
  $('pave-uid').textContent = uid || '';
  $('pave-uid').className = uid ? 'visible' : '';
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
  // Ne s'applique qu'à un pavé « système » : une fin de synchronisation ne doit
  // jamais effacer la décision que l'agent est en train de lire.
  if (!etat.paveSysteme || etat.blocage) return;
  reinitialiserEcran();
}

/**
 * Retour à l'écran d'accueil, quel que soit ce qui était affiché.
 *
 * Sans cette sortie, la dernière personne scannée reste à l'écran jusqu'au scan
 * suivant : on se croit bloqué sur sa fiche, et il n'y a aucun moyen de revenir
 * à un écran neutre — c'est déroutant, et gênant quand on tend le téléphone à
 * quelqu'un d'autre alors qu'il affiche encore un nom et une photo.
 */
function reinitialiserEcran() {
  afficherPave('PRÊT', 'Approchez un bracelet', null, true);
  $('identite').className = '';
  $('alerte').className = '';
  $('repas').className = '';
  fermerAssociation();
  etat.ficheCourante = null;
  etat.derniereDecision = null;
  etat.ecranOccupe = false;
  majBoutonEffacer();
  majBlocSignalement();
}

/** Le bouton n'existe que s'il y a quelque chose à effacer. */
function majBoutonEffacer() {
  // Pendant un blocage passback, c'est ACQUITTER qui gouverne : offrir un
  // second bouton permettrait d'escamoter le contrôle sans le journaliser.
  const montrer = etat.ecranOccupe && !etat.blocage;
  $('btn-effacer').className = montrer ? 'visible' : '';
}

/** Un vrai scan efface la fiche consultée : le signalement suit la personne. */

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

  const cadre = function (texte) {
    img.removeAttribute('src');
    img.className = '';
    absente.innerHTML = texte;
    absente.className = '';
  };

  // Un numéro de demande évite qu'une photo lente écrase celle du participant
  // suivant : deux personnes qui se présentent coup sur coup, et l'agent
  // vérifierait un visage contre la mauvaise identité.
  etat.demandePhoto = (etat.demandePhoto || 0) + 1;
  const demande = etat.demandePhoto;
  const encoreValable = function () { return demande === etat.demandePhoto; };

  cadre('PHOTO NON<br>EMBARQUÉE');

  DB.lirePhoto(numero).then(function (blob) {
    if (!encoreValable()) return;
    if (blob) { montrer(blob); return; }

    if (!navigator.onLine || !API.estConfigure()) return;

    // Distinguer « absente » de « en train d'arriver » : sans cela, l'agent
    // reste plusieurs secondes devant un cadre qui semble définitif, alors que
    // la photo est en route.
    cadre('CHARGEMENT…');
    API.photo(numero)
      .then(function (blob) {
        return DB.ecrirePhoto(numero, blob).then(function () { return blob; });
      })
      .then(function (blob) {
        if (encoreValable()) montrer(blob);
      })
      .catch(function () {
        if (encoreValable()) cadre('PHOTO NON<br>EMBARQUÉE');
      });
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
  reinitialiserEcran();
}

function brancherAcquittement() {
  $('btn-acquitter').addEventListener('click', function () { leverBlocage('ACQUITTE'); });
  $('btn-effacer').addEventListener('click', reinitialiserEcran);
}

/* ─────────────────────────── Historique local ─────────────────────────── */

/**
 * Journal des passages de CE terminal, consultable sans aucun privilège.
 *
 * Le besoin est concret : on laisse passer quelqu'un, et c'est deux minutes
 * plus tard qu'on réalise qu'il fallait le signaler. Sans historique, il faut
 * retrouver son nom de mémoire dans la recherche — laquelle est verrouillée —
 * ou aller dans le classeur. Autant dire que le signalement ne se fera pas.
 *
 * Pas de verrou par carte, délibérément : ce sont les gens que l'agent vient de
 * voir passer devant lui, l'écran ne lui apprend rien qu'il ne sache déjà. Et
 * un signalement qui exige d'aller chercher un chef de poste est un signalement
 * perdu.
 */
const MAX_HISTORIQUE = 100;

/** Profondeur consultable depuis l'onglet HISTORIQUE. */
const HISTORIQUE_AFFICHE_MS = 18 * 3600 * 1000;

/** Couleur de l'état, reprise du moteur pour rester cohérente avec le pavé. */
function couleurEtat(nomEtat) {
  const couleurs = (typeof COULEURS !== 'undefined') ? COULEURS : {};
  return couleurs[nomEtat] || 'neutre';
}

function brancherHistorique() {
  let minuteur = null;
  $('filtre-historique').addEventListener('input', function () {
    clearTimeout(minuteur);
    minuteur = setTimeout(afficherHistorique, 120);
  });
}

function afficherHistorique() {
  const terme = DB.normaliserTexte($('filtre-historique').value);

  // On ne demande jamais plus que ce que l'on peut afficher : c'est ce qui
  // rend le coût indépendant du nombre de passages de la journée. Le facteur 3
  // laisse de la marge au filtre textuel sans charger tout l'historique.
  return DB.scansRecents(HISTORIQUE_AFFICHE_MS, MAX_HISTORIQUE * 3).then(function (scans) {
    const retenus = [];
    for (let i = 0; i < scans.length && retenus.length < MAX_HISTORIQUE; i++) {
      const scan = scans[i];
      const p = scan.numero ? etat.base.participants.get(scan.numero) : null;
      if (terme) {
        const champs = DB.normaliserTexte(
          [(p && p.nom) || '', (p && p.prenom) || '', scan.numero || '', scan.uid || ''].join(' '));
        if (champs.indexOf(terme) === -1) continue;
      }
      retenus.push({ scan: scan, participant: p });
    }

    // On n'annonce PAS de total : le curseur s'arrête à un plafond, il ne compte
    // pas la journée entière. Dire « sur 300 » laisserait croire qu'il n'y a eu
    // que 300 passages, ce qui est faux dès qu'un poste est chargé.
    $('compte-historique').textContent = retenus.length
      ? retenus.length + (retenus.length > 1 ? ' passages affichés' : ' passage affiché')
        + (retenus.length >= MAX_HISTORIQUE ? ' — les plus récents' : '')
      : '';

    if (!retenus.length) {
      $('liste-historique').innerHTML = scans.length
        ? '<div class="note">Aucun passage ne correspond.</div>'
        : '<div class="note">Aucun passage enregistré sur ce poste.</div>';
      return;
    }

    $('liste-historique').innerHTML = retenus.map(function (entree) {
      const scan = entree.scan;
      const p = entree.participant;
      const nom = p ? (p.nom + ' ' + p.prenom) : ('Bracelet ' + (scan.uid || '?'));
      const libelle = (typeof LIBELLES !== 'undefined' && LIBELLES[scan.decision])
        ? LIBELLES[scan.decision] : String(scan.decision || '');
      return '<div class="entree-historique" data-numero="' + echapper(scan.numero || '') + '">' +
             '<div class="heure">' + echapper(heureCourte(scan.ts_terminal)) + '</div>' +
             '<div class="corps"><div class="nom">' + echapper(nom) + '</div>' +
             '<div class="decision ' + couleurEtat(scan.decision) + '">' +
             echapper(libelle) + '</div></div></div>';
    }).join('');

    Array.prototype.forEach.call($('liste-historique').children, function (element) {
      element.addEventListener('click', function () {
        const numero = element.dataset.numero;
        // Un bracelet jamais attribué n'a pas de fiche à ouvrir : il n'y a
        // personne à signaler, seulement une puce inconnue.
        if (!numero) { message('Ce bracelet n\'est rattaché à aucun participant.'); return; }
        afficherFiche(numero);
      });
    });
  });
}

function heureCourte(horodatage) {
  const d = new Date(horodatage);
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

/* ─────────────────────────── Recherche ─────────────────────────── */

/** Plafond d'affichage : au-delà, on annonce le total sans tout dessiner. */
const MAX_RESULTATS = 200;

function brancherRecherche() {
  let minuteur = null;
  $('champ-recherche').addEventListener('input', function () {
    clearTimeout(minuteur);
    minuteur = setTimeout(relancerRecherche, 120);
  });

  // Les filtres SURVIVENT à la consultation d'une fiche et à une attribution.
  // C'est tout l'intérêt : au guichet, on filtre une fois sur l'école, puis on
  // descend la file sans jamais retoucher au filtre.
  $('filtre-ecole').addEventListener('change', function (e) {
    etat.filtres.ecole = e.target.value;
    relancerRecherche();
  });
  $('filtre-statut').addEventListener('change', function (e) {
    etat.filtres.statut = e.target.value;
    relancerRecherche();
  });
}

/**
 * Remplit les deux listes déroulantes à partir de la base réellement chargée.
 *
 * On repart des valeurs présentes plutôt que d'une liste figée dans le code :
 * une école ajoutée dans le classeur apparaît d'elle-même après la sync.
 * La sélection en cours est restaurée — sans quoi chaque synchronisation
 * remettrait le filtre à zéro sous les doigts de l'opérateur.
 */
function remplirFiltres() {
  [['filtre-ecole', 'ecole', 'Toutes les écoles'],
   ['filtre-statut', 'statut', 'Tous les statuts']].forEach(function (def) {
    const select = $(def[0]);
    const valeurs = DB.valeursDistinctes(etat.base, def[1]);
    const signature = valeurs.join('\u001f');
    // On ne redessine les options que si la base a changé — mais on réaligne
    // TOUJOURS la sélection affichée sur l'état interne, sinon la liste
    // continue d'annoncer un filtre qui ne s'applique plus.
    if (select.dataset.signature !== signature) {
      select.dataset.signature = signature;
      select.innerHTML = '<option value="">' + echapper(def[2]) + '</option>' +
        valeurs.map(function (v) {
          return '<option value="' + echapper(v) + '">' + echapper(v) + '</option>';
        }).join('');
    }
    select.value = etat.filtres[def[1]] || '';
    // Le filtre mémorisé peut avoir disparu de la base : on ne laisse pas un
    // filtre fantôme masquer tout le monde.
    if (select.value !== (etat.filtres[def[1]] || '')) etat.filtres[def[1]] = '';
  });
}

function relancerRecherche() {
  // Un filtre qui persiste doit se VOIR : sinon, l'opérateur suivant cherche un
  // nom, ne le trouve pas, et ne comprend pas qu'une école est encore filtrée.
  $('filtre-ecole').className = etat.filtres.ecole ? 'actif' : '';
  $('filtre-statut').className = etat.filtres.statut ? 'actif' : '';
  afficherResultats($('champ-recherche').value);
}

function afficherResultats(requete) {
  const trouves = DB.rechercher(etat.base, requete, MAX_RESULTATS, etat.filtres);
  const filtreActif = !!(etat.filtres.ecole || etat.filtres.statut);

  if (!trouves.total) {
    $('compte-resultats').textContent = '';
    $('resultats').innerHTML = (String(requete).trim().length < 2 && !filtreActif)
      ? '<div class="note">Saisissez au moins deux caractères, ou choisissez un filtre.</div>'
      : '<div class="note">Aucun résultat.</div>';
    return;
  }

  $('compte-resultats').textContent = trouves.total > trouves.liste.length
    ? trouves.total + ' résultats — ' + trouves.liste.length + ' premiers affichés'
    : trouves.total + (trouves.total > 1 ? ' résultats' : ' résultat');

  $('resultats').innerHTML = trouves.liste.map(function (p) {
    return '<div class="resultat" data-numero="' + echapper(p.numero) + '">' +
           '<div class="nom">' + echapper(p.nom + ' ' + p.prenom) + '</div>' +
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
  afficherPave('CONSULTATION', 'Aucun passage enregistré', null, true);
  etat.ficheCourante = p;

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

  // Le guichet d'accueil enchaîne : on cherche la personne, on lui attribue son
  // bracelet dans la foulée. C'est un geste de plus sur un flux qui existe déjà,
  // pas une procédure séparée.
  if (etat.peutAssocier) ouvrirAssociation(p);
  else fermerAssociation();
  etat.ecranOccupe = true;
  majBoutonEffacer();
  majBlocSignalement();
}

/* ─────────────────────── Attribution de bracelet ─────────────────────── */

/** Bracelet ACTIF actuellement porté par ce participant, s'il en a un. */
function braceletActif(numero) {
  let trouve = null;
  etat.base.bracelets.forEach(function (b) {
    if (!trouve && b.numero === numero && b.statut === 'ACTIF') trouve = b;
  });
  return trouve;
}

function ouvrirAssociation(participant) {
  etat.association = { participant: participant, enAttente: false };
  $('association').className = 'visible';
  majEtatAssociation('', '');
  rafraichirBoutonsAssociation();
}

/**
 * Les deux boutons disent l'état du participant sans qu'on ait à le lire.
 *
 * Un bouton grisé et cadenassé vaut mieux qu'un bouton absent : l'opérateur
 * voit que la fonction existe et comprend pourquoi elle ne s'applique pas —
 * un bouton qui disparaît, lui, passe pour une panne.
 */
function rafraichirBoutonsAssociation() {
  if (!etat.association) return;
  const porte = braceletActif(etat.association.participant.numero);
  const attribuer = $('btn-attribuer');
  const suspendre = $('btn-suspendre');

  if (etat.association.enAttente) {
    attribuer.textContent = 'ANNULER';
    attribuer.className = 'principal attente';
  } else {
    attribuer.textContent = porte ? 'ATTRIBUER UN NOUVEAU BRACELET'
                                  : 'ATTRIBUER UN BRACELET';
    attribuer.className = 'principal';
  }

  suspendre.textContent = 'SUSPENDRE LE BRACELET';
  suspendre.className = porte ? '' : 'inerte';
  suspendre.disabled = !porte || etat.association.enAttente;
}

function fermerAssociation() {
  etat.association = null;
  $('association').className = '';
}

function majEtatAssociation(texte, niveau) {
  $('assoc-etat').textContent = texte;
  $('assoc-etat').className = niveau || '';
}

/** Démarre (ou arrête) l'attente d'un bracelet à attribuer. */
function basculerAttente() {
  if (!etat.association) return;
  if (etat.association.enAttente) {
    etat.association.enAttente = false;
    majEtatAssociation('', '');
    rafraichirBoutonsAssociation();
    return;
  }
  // Sans Web NFC, il n'y a plus aucun moyen de saisir un bracelet : autant le
  // dire tout de suite plutôt que de laisser attendre devant un écran muet.
  if (!('NDEFReader' in window)) {
    majEtatAssociation('Ce navigateur ne lit pas le NFC — utilisez un téléphone '
      + 'Android sous Chrome pour attribuer un bracelet', 'erreur');
    return;
  }
  etat.association.enAttente = true;
  const porte = braceletActif(etat.association.participant.numero);
  majEtatAssociation(porte
    ? 'Approchez le nouveau bracelet — l\'ancien sera désactivé'
    : 'Approchez le bracelet à attribuer', '');
  rafraichirBoutonsAssociation();
  if (!etat.lecteurNfc) demarrerNfc();
}

/**
 * Suspension du bracelet porté.
 *
 * Confirmation exigée : l'action bloque la personne à TOUS les points de
 * contrôle, et une fausse manœuvre au guichet se paierait à l'entrée du site.
 */
function suspendreBracelet() {
  if (!etat.association) return;
  const participant = etat.association.participant;
  const porte = braceletActif(participant.numero);
  if (!porte) return;
  if (!confirm('Suspendre le bracelet de ' + participant.prenom + ' ' +
               participant.nom + ' ?\n\nIl sera refusé à tous les points de ' +
               'contrôle dès la synchronisation suivante.')) return;

  majEtatAssociation('Suspension en cours…', '');
  API.post({ action: 'update_status', terminal: localStorage.getItem('api_terminal'),
             uid: porte.uid, numero: participant.numero, statut: 'SUSPENDU' }, 20000)
    .then(function () {
      porte.statut = 'SUSPENDU';
      majEtatAssociation('✓ Bracelet suspendu', 'succes');
      if (navigator.vibrate) navigator.vibrate(60);
      rafraichirBoutonsAssociation();
    })
    .catch(function (erreur) {
      // Hors ligne, la suspension ne vaudrait que pour ce téléphone — c'est
      // exactement l'inverse du but recherché.
      majEtatAssociation('Échec : ' + erreur.message +
                         ' — le bracelet reste ACTIF, prévenez le PC', 'erreur');
      if (navigator.vibrate) navigator.vibrate([200, 80, 200]);
    });
}

/**
 * Attribue un bracelet au participant affiché.
 *
 * L'opération est autorisée par TERMINAL (colonne `peut_associer` de l'onglet
 * `Terminaux`), pas par personne connectée : un guichet traite des centaines de
 * personnes d'affilée, ressaisir une phrase de passe toutes les quinze minutes
 * serait inapplicable.
 */
function attribuerBracelet(uid) {
  if (!etat.association) return;
  etat.association.enAttente = false;
  rafraichirBoutonsAssociation();
  const participant = etat.association.participant;
  const propre = normaliserUid(uid);
  if (!propre) { majEtatAssociation('UID vide', 'erreur'); return; }

  // Le bracelet est-il déjà attribué à quelqu'un d'autre ? On le dit AVANT
  // d'écrire : au guichet, deux personnes repartiraient avec le même bracelet.
  const existant = etat.base.bracelets.get(propre);
  if (existant && existant.numero && existant.numero !== participant.numero
      && existant.statut === 'ACTIF') {
    const autre = etat.base.participants.get(existant.numero);
    majEtatAssociation('Bracelet déjà attribué à ' +
      (autre ? autre.prenom + ' ' + autre.nom : existant.numero) +
      ' — prenez-en un autre', 'erreur');
    if (navigator.vibrate) navigator.vibrate([200, 80, 200]);
    // On rouvre l'attente : l'opérateur va présenter un autre bracelet tout de
    // suite, lui faire recliquer sur ATTRIBUER n'aurait aucun sens.
    etat.association.enAttente = true;
    rafraichirBoutonsAssociation();
    return;
  }

  majEtatAssociation('Attribution en cours…', '');
  API.post({ action: 'update_status', terminal: localStorage.getItem('api_terminal'),
             uid: propre, numero: participant.numero, statut: 'ACTIF' }, 20000)
    .then(function (reponse) {
      majEtatAssociation('✓ Bracelet attribué à ' + participant.prenom + ' ' +
                         participant.nom, 'succes');
      if (navigator.vibrate) navigator.vibrate(60);

      // On l'ajoute tout de suite en mémoire : le bracelet doit être reconnu
      // immédiatement, sans attendre la synchronisation suivante.
      etat.base.bracelets.set(propre,
        { uid: propre, numero: participant.numero, statut: 'ACTIF' });
      if (reponse.ancien_bracelet_neutralise) {
        const ancien = etat.base.bracelets.get(reponse.ancien_bracelet_neutralise);
        if (ancien) ancien.statut = 'PERDU';
      }

      rafraichirBoutonsAssociation();
      // Retour à la liste, FILTRES CONSERVÉS : l'opérateur enchaîne la personne
      // suivante de la file sans avoir à re-sélectionner son école.
      setTimeout(function () {
        const nom = participant.prenom + ' ' + participant.nom;
        fermerAssociation();
        montrerVue('vue-recherche');
        $('champ-recherche').value = '';
        relancerRecherche();
        message('✓ Bracelet attribué à ' + nom, 'succes');
      }, 1200);
    })
    .catch(function (erreur) {
      // Hors ligne, l'attribution est IMPOSSIBLE : elle doit être connue de
      // tous les postes, pas seulement de ce téléphone. On le dit franchement
      // plutôt que de laisser croire à un succès.
      majEtatAssociation('Échec : ' + erreur.message +
                         ' — réessayez, ou notez le cas sur papier', 'erreur');
      if (navigator.vibrate) navigator.vibrate([200, 80, 200]);
      rafraichirBoutonsAssociation();
    });
}

function brancherAssociation() {
  $('btn-attribuer').addEventListener('click', basculerAttente);
  $('btn-suspendre').addEventListener('click', suspendreBracelet);
}

/* ─────────────────────────── Signalement ─────────────────────────── */

/**
 * Écrire une note de sécurité : pouvoir STAFF ou ADMIN, vérifié côté SERVEUR.
 *
 * Deux barrières, et elles ne font pas le même travail :
 *
 *   1. **La carte** ouvre l'écran. Tant qu'aucune carte n'a été présentée, le
 *      bouton n'existe pas : un bénévole à qui l'on confie un terminal ne peut
 *      pas écrire n'importe quoi sur n'importe qui.
 *   2. **La phrase de passe** authentifie l'écriture, via `admin_login`. Un UID
 *      NTAG se clone pour trente euros — la carte ne peut donc pas être le
 *      secret. C'est le principe n°6 du projet, appliqué ici tel quel.
 *
 * ⚠️ Écrire n'est PAS lire. Le porteur de la carte consigne depuis n'importe
 * quel poste, mais ne verra jamais ce que les autres ont écrit : la lecture des
 * notes reste gouvernée par le `profil_donnees` du terminal et n'est servie
 * qu'aux postes SECURITE et PC_ORGA. Cette asymétrie est délibérée — elle
 * encourage le signalement sans diffuser les appréciations.
 *
 * La note s'ajoute aux précédentes, jamais ne les écrase, et le serveur y
 * appose l'horodatage et le nom du porteur de la carte.
 */
function majBlocSignalement() {
  const p = etat.ficheCourante || (etat.derniereDecision && etat.derniereDecision.participant);
  // `reglagesVerrouilles()` est faux tant qu'aucune carte n'est déclarée dans
  // le classeur : sur une base sans compte, le signalement reste donc ouvert,
  // exactement comme les réglages. C'est le même arbitrage de mise en service.
  const montrer = !!p && !etat.blocage && !reglagesVerrouilles();
  $('signalement').className = montrer ? 'visible' : '';
  if (!montrer) fermerSignalement();
}

function ouvrirSignalement() {
  $('signalement-saisie').className = 'visible';
  $('btn-signaler').style.display = 'none';
  $('signalement-etat').textContent = '';
  $('signalement-etat').className = '';
  $('champ-signalement').focus();
}

function fermerSignalement() {
  $('signalement-saisie').className = '';
  $('btn-signaler').style.display = '';
  $('champ-signalement').value = '';
}

function participantSignale() {
  return etat.ficheCourante
    || (etat.derniereDecision && etat.derniereDecision.participant)
    || null;
}

function envoyerSignalement() {
  const p = participantSignale();
  if (!p) return;
  const texte = $('champ-signalement').value.trim();
  if (texte.length < 5) {
    $('signalement-etat').textContent = 'Décrivez le fait en quelques mots.';
    $('signalement-etat').className = 'erreur';
    return;
  }

  $('signalement-etat').textContent = 'Envoi…';
  $('signalement-etat').className = '';
  $('btn-signalement-envoyer').disabled = true;

  // La carte présentée fait foi : son UID accompagne la requête, et le serveur
  // vérifie le rôle contre l'onglet `Comptes`. Pas de phrase de passe — écrire
  // un fait constaté n'est pas une opération assez lourde pour en exiger une à
  // chaque signalement, et une fonction pénible est une fonction inutilisée.
  const carte = etat.deverrouillage;
  API.post({ action: 'ecrire_note', uid_carte: carte ? carte.uid : '',
             terminal: localStorage.getItem('api_terminal'),
             numero: p.numero, texte: texte }, 20000)
    .then(function () {
      fermerSignalement();
      $('signalement-etat').textContent = '✓ Note enregistrée pour ' + p.prenom + ' ' + p.nom;
      $('signalement-etat').className = 'succes';
      if (navigator.vibrate) navigator.vibrate(60);
    })
    .catch(function (erreur) {
      // Carte révoquée dans le classeur depuis le déverrouillage : on referme
      // plutôt que de laisser croire que le signalement reste possible.
      if (erreur.code === 'SESSION_EXPIREE' || erreur.code === 'ROLE_INSUFFISANT') {
        ecrireDeverrouillage(null);
        majBlocSignalement();
        message('Votre carte n\'autorise pas cette action — représentez une carte STAFF.',
                'erreur');
      } else {
        // Hors ligne, la note ne partirait nulle part. On ne la met PAS en
        // file : une note remontée trois heures plus tard, sans que personne
        // ne le sache, vaut moins qu'un échec annoncé tout de suite.
        $('signalement-etat').textContent = 'Échec : ' + erreur.message +
          ' — notez le cas sur papier et prévenez le PC';
        $('signalement-etat').className = 'erreur';
      }
      if (navigator.vibrate) navigator.vibrate([200, 80, 200]);
    })
    .then(function () { $('btn-signalement-envoyer').disabled = false; });
}

function brancherSignalement() {
  $('btn-signaler').addEventListener('click', ouvrirSignalement);
  $('btn-signalement-annuler').addEventListener('click', fermerSignalement);
  $('btn-signalement-envoyer').addEventListener('click', envoyerSignalement);
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

  const bouton = $('btn-photos');
  bouton.disabled = true;
  bouton.textContent = 'MESURE EN COURS…';

  // On MESURE une photo avant d'annoncer quoi que ce soit. Une estimation
  // théorique mentirait d'un facteur douze quand le dossier « Miniatures » n'est
  // pas déclaré : le proxy sert alors la photo Drive d'origine.
  const debut = Date.now();
  API.photo(numeros[0])
    .then(function (blob) {
      return DB.ecrirePhoto(numeros[0], blob).then(function () { return blob; });
    })
    .then(function (blob) {
      const dureeUnitaire = (Date.now() - debut) / 1000;
      const tailleKo = blob.size / 1024;
      const totalMo = Math.round(numeros.length * tailleKo / 1024);
      // Trois téléchargements simultanés : au-delà, Apps Script étrangle et
      // l'on perd le bénéfice.
      const minutes = Math.round(numeros.length * dureeUnitaire / 3 / 60);

      let texte = numeros.length + ' photos, environ ' + totalMo + ' Mo.\n' +
                  'Durée estimée : ' + (minutes > 60
                    ? Math.round(minutes / 60) + ' h ' + (minutes % 60) + ' min'
                    : minutes + ' min') + '.\n\n';

      if (tailleKo > 50) {
        texte += '⚠️ Chaque photo pèse ' + Math.round(tailleKo) + ' ko au lieu des ~12 ko\n' +
                 'attendus : le dossier « Miniatures » n\'est pas déclaré côté\n' +
                 'serveur. Générez-le avec prepare_sd.py AVANT de précharger,\n' +
                 'vous diviserez le volume et la durée par dix.\n\n';
      }
      texte += 'À faire en Wi-Fi. Continuer ?';

      if (!confirm(texte)) {
        bouton.disabled = false;
        bouton.textContent = 'PRÉCHARGER LES PHOTOS';
        return;
      }
      return telechargerPhotos(numeros, bouton, dureeUnitaire);
    })
    .catch(function (erreur) {
      bouton.disabled = false;
      bouton.textContent = 'PRÉCHARGER LES PHOTOS';
      message('Mesure impossible : ' + erreur.message, 'erreur');
    });
}

/**
 * Télécharge les photos manquantes, trois à la fois.
 *
 * Le séquentiel serait trois fois plus lent pour rien : le goulot est la
 * latence d'Apps Script, pas la bande passante. Au-delà de trois, le service
 * étrangle et l'on ne gagne plus rien.
 */
function telechargerPhotos(numeros, bouton, dureeUnitaire) {
  const depart = Date.now();
  let index = 0, obtenues = 0, absentes = 0, faits = 0;

  const suivante = function () {
    if (index >= numeros.length) return Promise.resolve();
    const numero = numeros[index++];

    return DB.lirePhoto(numero)
      .then(function (existante) {
        if (existante) { obtenues++; return; }
        return API.photo(numero)
          .then(function (blob) { obtenues++; return DB.ecrirePhoto(numero, blob); })
          .catch(function () { absentes++; });
      })
      .then(function () {
        faits++;
        if (faits % 5 === 0 || faits === numeros.length) {
          const restant = Math.round((Date.now() - depart) / faits *
                                     (numeros.length - faits) / 60000);
          bouton.textContent = faits + '/' + numeros.length +
                               ' — encore ~' + restant + ' min';
        }
        return suivante();
      });
  };

  const fils = [];
  for (let i = 0; i < 3; i++) fils.push(suivante());

  return Promise.all(fils).then(function () {
    bouton.disabled = false;
    bouton.textContent = 'PRÉCHARGER LES PHOTOS';
    message(obtenues + ' photo(s) en cache, ' + absentes + ' absente(s).');
    return rafraichirBandeau();
  });
}

/* ─────────────────────────── Interface ─────────────────────────── */

function brancherNavigation() {
  Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (bouton) {
    bouton.addEventListener('click', function () { montrerVue(bouton.dataset.vue); });
  });
}

function montrerVue(identifiant) {
  // Interception : les vues réservées passent par l'écran de verrou tant
  // qu'aucune carte STAFF ou ADMIN n'a été présentée.
  if (VUES_RESERVEES.indexOf(identifiant) !== -1 && reglagesVerrouilles()) {
    preparerVerrou(identifiant);
    identifiant = 'vue-verrou';
  }
  etat.vueCourante = identifiant;

  Array.prototype.forEach.call(document.querySelectorAll('.vue'), function (vue) {
    vue.className = 'vue' + (vue.id === identifiant ? ' visible' : '');
  });
  // L'onglet d'origine reste visuellement actif même sur l'écran de verrou :
  // l'agent doit comprendre où il est, pas se croire perdu.
  const ongletActif = identifiant === 'vue-verrou'
    ? (etat.vueDemandee || 'vue-reglages') : identifiant;
  const verrouille = reglagesVerrouilles();
  Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (bouton) {
    const classes = [];
    if (bouton.dataset.vue === ongletActif) classes.push('actif');
    // Le cadenas dit que l'onglet EXISTE mais demande une carte — un bouton
    // simplement inerte laisserait croire à une panne.
    if (VUES_RESERVEES.indexOf(bouton.dataset.vue) !== -1 && verrouille) {
      classes.push('verrouille');
    }
    bouton.className = classes.join(' ');
  });

  if (identifiant === 'vue-reglages') {
    rafraichirStatistiques();
    rafraichirBanniereDeverrouillage();
  }
  if (identifiant === 'vue-recherche') {
    remplirFiltres();
    relancerRecherche();
  }
  // L'historique n'est PAS dans VUES_RESERVEES : il s'ouvre sans carte.
  if (identifiant === 'vue-historique') afficherHistorique();
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
    $('stat-historique').textContent = s.historique + ' passage(s)';
  });
  // Jauge mémoire : le seul moyen de savoir, depuis le terrain, si un appareil
  // qui se ferme tout seul manque réellement de mémoire. Android tue l'onglet
  // sans laisser la moindre erreur JavaScript derrière lui.
  const m = performance.memory;
  $('stat-memoire').textContent = m
    ? Math.round(m.usedJSHeapSize / 1048576) + ' Mo sur ' +
      Math.round(m.jsHeapSizeLimit / 1048576) + ' Mo'
    : 'non mesurable';
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
