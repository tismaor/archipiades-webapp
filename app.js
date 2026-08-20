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
  attribution: null,         // participant en attente d'un bracelet
  reseauTexte: 'en ligne',   // état réseau affiché dans le bandeau
  reseauClasse: '',
  alterneNfc: false,         // face « NFC actif » de l'alternance
  avaitControleur: false,    // un Service Worker contrôlait déjà cette page
  profilConnu: null,         // profil_donnees de la dernière synchronisation
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
const VERSION_APP = 24;

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
  brancher('actions', brancherActions);
  brancher('démarrage', brancherDemarrage);
  brancher('historique', brancherHistorique);

  brancher('intégrité', verifierIntegriteInterface);
  brancher('bandeau', lancerAlternanceBandeau);

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

  // En développement local, PAS de Service Worker : servi « cache d'abord », il
  // masque chaque modification jusqu'au prochain changement de nom de cache, et
  // l'on teste alors sans le savoir une version périmée.
  const enDeveloppement = location.hostname === 'localhost'
                       || location.hostname === '127.0.0.1';
  if (enDeveloppement && 'serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(function (regs) {
      regs.forEach(function (r) { r.unregister(); });
    });
    caches.keys().then(function (noms) {
      noms.forEach(function (nom) { caches.delete(nom); });
    });
  } else if ('serviceWorker' in navigator) {
    // Un contrôleur déjà en place signifie qu'une version tournait avant : toute
    // activation qui suivra sera donc une mise à jour, pas une installation.
    etat.avaitControleur = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch(function (erreur) {
      console.warn('Service Worker non enregistré : ' + erreur);
    });
    // Une nouvelle coque a été installée : l'onglet ouvert exécute encore
    // l'ancien code et seul un rechargement l'alignera. On ne recharge PAS
    // d'autorité — cela effacerait un écran de décision sous les yeux de
    // l'agent — on propose.
    navigator.serviceWorker.addEventListener('message', function (evenement) {
      if (evenement.data && evenement.data.type === 'NOUVELLE_VERSION') {
        signalerMiseAJour();
      }
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

/**
 * Vérifie que le HTML servi correspond bien au code qui s'exécute.
 *
 * Le cas s'est produit en exploitation : `index.html` périmé servi à côté d'un
 * `app.js` neuf, et la première fonction qui cherchait un élément récent
 * échouait sur un « Cannot set properties of null » incompréhensible. Mieux
 * vaut nommer la cause tout de suite.
 */
const ELEMENTS_REQUIS = [
  'pave', 'pave-libelle', 'pave-detail', 'pave-uid', 'identite', 'nom',
  'liste-historique', 'filtre-historique', 'compte-historique',
  'actions', 'btn-signaler', 'btn-attribuer', 'btn-suspendre', 'btn-effacer',
  'confirmation', 'confirmation-titre', 'confirmation-champ', 'confirmation-valider',
  'filtre-ecole', 'filtre-statut', 'compte-resultats',
  'demarrage', 'demarrage-etat', 'stat-historique', 'stat-memoire'
];

function verifierIntegriteInterface() {
  // Comparaison de version D'ABORD : elle détecte tous les décalages, y compris
  // ceux qui ne se voient pas.
  //
  // Le contrôle par éléments manquants ne prend que si une balise a été ajoutée.
  // Or une livraison peut ne changer que des libellés, des styles et un ordre
  // d'affichage — c'est arrivé — et un `index.html` périmé passe alors le
  // contrôle sans encombre : la version affichée s'incrémente, l'interface ne
  // bouge pas, et rien ne le signale.
  const coque = parseInt(document.body.dataset.coque, 10);
  if (coque && coque !== VERSION_APP) {
    signalerPanne('VERSION INCOHÉRENTE — page v' + coque + ' contre programme v' +
      VERSION_APP + '. Fermez complètement l\'application et rouvrez-la ; ' +
      'si cela persiste, videz les données du site.');
    return false;
  }

  const absents = ELEMENTS_REQUIS.filter(function (id) { return !$(id); });
  if (!absents.length) return true;
  signalerPanne('VERSION INCOHÉRENTE — le HTML affiché est plus ancien que le ' +
    'programme (' + absents.length + ' élément(s) manquant(s) : ' +
    absents.slice(0, 3).join(', ') + '). Fermez complètement l\'application et ' +
    'rouvrez-la ; si cela persiste, videz les données du site.');
  return false;
}

/**
 * Bandeau non bloquant : une nouvelle version attend un rechargement.
 *
 * ⚠️ Rien à annoncer à la PREMIÈRE installation. Le Service Worker s'active
 * aussi la toute première fois, et le message apparaissait alors sur un
 * appareil parfaitement à jour — en rouge, comme une panne, dès l'ouverture
 * initiale. `etat.avaitControleur` distingue une mise à jour d'une installation.
 */
function signalerMiseAJour() {
  if (!etat.avaitControleur) return;
  const zone = $('panne');
  if (!zone) return;
  zone.textContent = '↻ Nouvelle version installée — fermez et rouvrez ' +
    'l\'application pour l\'activer.';
  // Classe distincte : ce n'est pas une erreur, et le rouge de `panne` ferait
  // croire à un incident au moment même où tout se passe bien.
  zone.className = 'visible information';
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

  // Vider le cache photos sans toucher à la base ni aux scans en attente.
  $('btn-vider-photos').addEventListener('click', function () {
    if (!confirm('Vider le cache des photos ?\n\nLa base et les scans en attente ' +
                 'sont conservés. Les photos seront retéléchargées au fil des ' +
                 'scans, ou d\'un coup avec PRÉCHARGER LES PHOTOS.')) return;
    DB.viderPhotos()
      .then(function () {
        message('Cache des photos vidé.');
        rafraichirStatistiques();
      })
      .catch(function (erreur) {
        message('Échec : ' + erreur.message, 'erreur');
      });
  });

  $('btn-purger').addEventListener('click', function () {
    if (!confirm('Effacer la base locale ? Les scans en attente sont conservés.')) return;
    // La purge emporte les cartes connues : le verrou se désarme donc avec
    // elles, sans quoi l'appareil deviendrait impossible à remettre en service.
    // Ce n'est pas une échappatoire — ce bouton est lui-même derrière le verrou.
    armerVerrou(false);
    ecrireDeverrouillage(null);
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
  definirEtatReseau('sync…');

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
        // Changement de profil de données : la base locale contient des champs
        // que le nouveau profil n'a PAS le droit de détenir — une note de
        // sécurité conservée après le passage d'un poste SECURITE à un poste
        // REPAS, par exemple. Le delta ne les enlèvera jamais, puisqu'il ne
        // transporte que ce qui a changé côté serveur. On repart donc de zéro.
        if (delta.profil_donnees && etat.profilConnu &&
            delta.profil_donnees !== etat.profilConnu) {
          etat.profilConnu = delta.profil_donnees;
          return DB.purgerBase()
            .then(function () { return DB.ecrireCurseur(0, ''); })
            .then(function () {
              message('Profil de données changé — rechargement complet de la base.');
              recues = 0;
              return parcourirPages();
            });
        }
        if (delta.profil_donnees) etat.profilConnu = delta.profil_donnees;

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
      definirEtatReseau('à jour');
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
      definirEtatReseau('échec sync', 'alerte-reseau');
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
  // Un terminal expiré ne laisse rien derrière lui : déverrouillage en cours,
  // et verrou lui-même, puisqu'il n'y a plus de carte connue à opposer.
  ecrireDeverrouillage(null);
  armerVerrou(false);
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
                      DB.lireMeta('peut_associer'), DB.lireMeta('profil_donnees')])
    .then(function (valeurs) {
      etat.base = valeurs[0];
      etat.refs = valeurs[1] || { droits: {}, formules: {}, services: [], config: {} };
      etat.pointControle = valeurs[2] || '';
      etat.scansRecents = valeurs[3];
      etat.cartes = valeurs[4] || [];
      // Dès qu'une carte est connue, le verrou s'arme DÉFINITIVEMENT sur cet
      // appareil — y compris pour les ouvertures suivantes, avant même que la
      // base ait fini de se relire.
      if (etat.cartes.length) armerVerrou(true);
      etat.peutAssocier = valeurs[5] === true;
      if (!etat.profilConnu && valeurs[6]) etat.profilConnu = valeurs[6];
      // Les cartes arrivent avec le delta : l'affichage du cadenas doit suivre.
      montrerVue(etat.vueCourante);
    });
}

/* ─────────────────────────── Verrou des réglages ─────────────────────────── */

/** Vues réservées, accessibles seulement après présentation d'une carte. */
const VUES_RESERVEES = ['vue-reglages', 'vue-recherche'];

/**
 * Le verrou est-il ARMÉ sur cet appareil ?
 *
 * ⚠️ La réponse ne peut PAS dépendre de `etat.cartes`, qui n'est renseigné
 * qu'une fois la base relue depuis IndexedDB — plusieurs centaines de
 * millisecondes après l'ouverture. Pendant cette fenêtre, les onglets réservés
 * étaient grands ouverts : il suffisait de fermer et rouvrir l'application pour
 * passer devant l'écran de chargement et filer dans RÉGLAGES.
 *
 * Un drapeau persistant répond donc immédiatement, dès le premier trait de
 * code, avant toute lecture asynchrone.
 */
const CLE_VERROU = 'verrou_arme';

function verrouArme() {
  return etat.cartes.length > 0 || localStorage.getItem(CLE_VERROU) === '1';
}

function armerVerrou(actif) {
  if (actif) localStorage.setItem(CLE_VERROU, '1');
  else localStorage.removeItem(CLE_VERROU);
}

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
  // ⚠️ On NE teste PLUS `API.estConfigure()`. C'était la seconde faille :
  // effacer l'URL ou la clé depuis les réglages suffisait à désarmer le verrou
  // pour de bon. Un appareil déjà provisionné reste verrouillé quoi qu'on fasse
  // de sa configuration ; seule une purge complète le désarme, et elle est
  // elle-même derrière le verrou.
  if (!verrouArme()) return false;   // appareil neuf : mise en service possible
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
  if (!etat.deverrouillage) {
    // Verrou inactif faute de carte déclarée : le dire vaut mieux que
    // n'afficher rien, sinon on croit à un oubli d'affichage.
    if (!verrouArme()) {
      banniere.innerHTML = '<span class="porteur">AUCUN VERROU</span>' +
        '<span class="restant">Aucune carte déclarée dans le classeur</span>';
      banniere.className = 'visible';
      return;
    }
    banniere.innerHTML = '<span class="porteur">SESSION FERMÉE</span>' +
      '<span class="restant">Présentez une carte STAFF pour ouvrir</span>';
    banniere.className = 'visible';
    return;
  }
  const restant = Math.max(0, Math.round((etat.deverrouillage.expire - Date.now()) / 60000));
  const duree = restant >= 60
    ? Math.floor(restant / 60) + ' h ' + ('0' + (restant % 60)).slice(-2)
    : restant + ' min';
  banniere.innerHTML = '<span class="porteur">' + echapper(etat.deverrouillage.nom) +
    '</span><span class="restant">' + echapper(etat.deverrouillage.role) +
    ' — refermeture dans ' + duree + '</span>';
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
    // L'état de la lecture vit désormais dans le bandeau du haut, en alternance
    // avec l'état réseau : le bouton n'a plus rien à dire et libère la place.
    $('btn-nfc').style.display = 'none';
    $('btn-nfc').disabled = true;
    etat.alterneNfc = true;
    rendreEtatReseau();
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
      else if (etat.attribution && Confirmation.ouvert()) attribuerBracelet(uid);
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
  // Un vrai scan referme toute confirmation en cours : ses boutons se
  // rapporteraient encore à la fiche consultée juste avant, donc à quelqu'un
  // d'autre.
  if (Confirmation.ouvert()) Confirmation.fermer();
  etat.attribution = null;
  etat.ficheCourante = null;

  // ⚠️ Un écran bloquant fige la lecture, y compris pour un AUTRE bracelet.
  //
  // Auparavant, présenter la personne suivante levait le blocage sans
  // acquittement : le contrôle renforcé disparaissait de l'écran sans avoir eu
  // lieu, et sans rien laisser dans le journal. La file passait, l'information
  // aussi.
  //
  // La sortie reste garantie sans immobiliser le poste : ACQUITTER, ou
  // l'expiration automatique au bout de `passback_expiration_s` (60 s par
  // défaut), journalisée comme telle.
  if (etat.blocage) {
    if (navigator.vibrate) navigator.vibrate([60, 60, 60]);
    message('Contrôle renforcé en cours — acquittez avant le scan suivant.',
            'erreur');
    return;
  }

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
  $('vue-scan').classList.remove('consultation');
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
  majActions();
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
  // jamais effacer ce que l'agent est en train de lire — ni une décision, ni
  // une fiche ouverte en consultation.
  if (!etat.paveSysteme || etat.blocage || etat.ecranOccupe) return;
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
  $('vue-scan').classList.remove('consultation');
  afficherPave('PRÊT', 'Approchez un bracelet', null, true);
  $('identite').className = '';
  $('alerte').className = '';
  $('repas').className = '';
  if (Confirmation.ouvert()) Confirmation.fermer();
  etat.attribution = null;
  etat.ficheCourante = null;
  etat.derniereDecision = null;
  etat.ecranOccupe = false;
  majBoutonEffacer();
  majActions();
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

    // Le serveur indique si une source de photo existe pour cette personne.
    // Sans ce garde-fou, chaque fiche sans photo fait patienter l'agent 3 à 4
    // secondes devant « CHARGEMENT… » pour finir sur PHOTO_INTROUVABLE.
    const fiche = etat.base.participants.get(numero);
    if (fiche && fiche.photo === false) return;

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
  // ⚠️ `systeme` reste FAUX. Un pavé « système » est celui qu'une fin de
  // synchronisation a le droit de remplacer par « PRÊT ». Une consultation n'en
  // est pas un : marquée système, elle disparaissait sous les yeux de
  // l'opérateur à la synchronisation suivante — avec la photo, la fiche et,
  // au guichet, l'attribution en cours.
  afficherPave('CONSULTATION', 'Recherche des passages…', null, false);
  $('vue-scan').classList.add('consultation');
  etat.ficheCourante = p;
  resumerPassages(p.numero);

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
  etat.ecranOccupe = true;
  majBoutonEffacer();
  majActions();
}

/**
 * Rappelle les passages connus de ce participant, sous le pavé de consultation.
 *
 * ⚠️ Formulation précise : l'historique local ne contient QUE les scans de ce
 * terminal. Écrire « aucun passage » laisserait croire que la personne n'est
 * jamais passée nulle part, alors qu'elle a très bien pu être scannée à une
 * autre entrée. On dit donc « sur ce poste », et on ne prétend rien de plus.
 */
function resumerPassages(numero) {
  etat.demandeResume = (etat.demandeResume || 0) + 1;
  const demande = etat.demandeResume;

  DB.scansRecents(HISTORIQUE_AFFICHE_MS, 500).then(function (scans) {
    // Une consultation lente ne doit pas écraser la fiche suivante.
    if (demande !== etat.demandeResume || !etat.ficheCourante
        || etat.ficheCourante.numero !== numero) return;

    const siens = scans.filter(function (s) { return s.numero === numero; });
    if (!siens.length) {
      $('pave-detail').textContent = 'Aucun passage sur ce poste';
      return;
    }
    const dernier = siens[0];
    const libelle = (typeof LIBELLES !== 'undefined' && LIBELLES[dernier.decision])
      ? LIBELLES[dernier.decision] : String(dernier.decision || '');
    $('pave-detail').textContent =
      siens.length + (siens.length > 1 ? ' passages' : ' passage') +
      ' sur ce poste — dernier à ' + heureCourte(dernier.ts_terminal) +
      ' : ' + libelle;
  }).catch(function (erreur) {
    console.warn('résumé des passages : ' + erreur.message);
  });
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

/* ─────────────────────── Panneau de confirmation ─────────────────────── */

/**
 * Un seul mécanisme de confirmation pour les trois actions de la fiche.
 *
 * Auparavant chacune avait sa grammaire : un bloc dépliant pour le signalement,
 * un bouton qui se changeait en ANNULER pour l'attribution, une boîte système
 * pour la suspension. Trois boutons, trois façons de confirmer, et une mise en
 * page qui se décalait sous les doigts au moindre message.
 *
 * Le panneau couvre l'écran — c'est ce qui empêche l'appui accidentel, la
 * qualité qu'avait `confirm()` — sans en avoir le défaut : il ne fige ni
 * l'application, ni la synchronisation, ni la lecture NFC.
 *
 * `ouvrir()` renvoie une promesse : la valeur saisie si l'on valide, `null` si
 * l'on renonce. Le panneau reste ouvert pour les actions qui se poursuivent
 * après la validation — l'attente d'un bracelet, notamment.
 */
const Confirmation = (function () {
  let resoudre = null;
  let alaFermeture = null;

  function elements() {
    return {
      panneau: $('confirmation'), titre: $('confirmation-titre'),
      champ: $('confirmation-champ'),
      note: $('confirmation-note'), etat: $('confirmation-etat'),
      valider: $('confirmation-valider'), annuler: $('confirmation-annuler')
    };
  }

  function ouvrir(options) {
    const e = elements();
    e.panneau.className = 'visible' + (options.danger ? ' danger' : '');
    e.titre.textContent = options.titre || '';
    e.note.textContent = options.note || '';
    e.etat.textContent = '';
    e.etat.className = '';
    e.champ.value = '';
    e.champ.className = options.champ ? 'visible' : '';
    if (options.champ) e.champ.placeholder = options.champ;
    e.valider.textContent = options.valider || 'VALIDER';
    e.valider.className = 'action' + (options.danger ? ' danger' : '');
    e.valider.style.display = '';
    e.valider.disabled = false;
    e.annuler.textContent = 'ANNULER';

    // Le champ ne prend PAS le focus : ouvrir le clavier virtuel masquerait la
    // moitié du panneau, dont le bouton de validation.
    return new Promise(function (r) { resoudre = r; });
  }

  /** Bascule en attente : plus rien à valider, seulement à renoncer. */
  function attendre(texte) {
    const e = elements();
    e.etat.textContent = texte;
    e.etat.className = 'attente';
    e.champ.className = '';
    e.valider.style.display = 'none';
  }

  function erreur(texte) {
    const e = elements();
    e.etat.textContent = texte;
    e.etat.className = 'erreur';
  }

  function occupe(texte) {
    const e = elements();
    e.etat.textContent = texte;
    e.etat.className = 'attente';
    e.valider.disabled = true;
  }

  function fermer() {
    $('confirmation').className = '';
    resoudre = null;
    // ⚠️ Appelé à CHAQUE fermeture, y compris par le fond ou par ANNULER en
    // pleine attente. Sans ce rappel, une attribution abandonnée laissait son
    // participant armé : le bracelet suivant présenté lui aurait été attribué,
    // panneau fermé et sans que personne ne demande quoi que ce soit.
    if (alaFermeture) alaFermeture();
  }

  function surFermeture(fonction) { alaFermeture = fonction; }

  function ouvert() { return $('confirmation').className.indexOf('visible') !== -1; }

  function brancher() {
    $('confirmation-valider').addEventListener('click', function () {
      if (!resoudre) return;
      const valeur = $('confirmation-champ').className ? $('confirmation-champ').value : true;
      const r = resoudre;
      resoudre = null;
      r(valeur);
    });
    const renoncer = function () {
      const r = resoudre;
      fermer();
      if (r) r(null);
    };
    $('confirmation-annuler').addEventListener('click', renoncer);
    // Un appui hors de la boîte vaut renoncement — jamais validation.
    $('confirmation').addEventListener('click', function (evenement) {
      if (evenement.target === $('confirmation')) renoncer();
    });
  }

  return { ouvrir, attendre, erreur, occupe, fermer, ouvert, brancher, surFermeture };
})();

/* ─────────────────────── Actions de la fiche ─────────────────────── */

/**
 * Les trois boutons, et leurs états.
 *
 * Un bouton n'est jamais retiré : il devient inerte, gris et cadenassé. Un
 * bouton qui disparaît déplace tous les autres sous le doigt de l'opérateur et
 * passe pour une panne ; un bouton cadenassé s'explique tout seul.
 */
function majActions() {
  const p = participantAffiche();
  const montrer = !!p && !etat.blocage;
  $('actions').className = montrer ? 'visible' : '';
  if (!montrer) return;

  // SIGNALER — réservé au porteur d'une carte STAFF ou ADMIN.
  $('btn-signaler').className = 'action' + (reglagesVerrouilles() ? ' inerte' : '');

  // ATTRIBUER — réservé aux terminaux habilités (colonne `peut_associer`).
  const porte = braceletActif(p.numero);
  $('btn-attribuer').textContent = porte ? 'ATTRIBUER UN NOUVEAU BRACELET'
                                         : 'ATTRIBUER UN BRACELET';
  $('btn-attribuer').className = 'action' + (etat.peutAssocier ? '' : ' inerte');

  // SUSPENDRE — sans objet tant que la personne n'a pas de bracelet actif.
  $('btn-suspendre').className = 'action' + (porte ? ' danger' : ' inerte');
}

function participantAffiche() {
  return etat.ficheCourante
    || (etat.derniereDecision && etat.derniereDecision.participant)
    || null;
}

/* ── 1. Signaler ── */

/**
 * ⚠️ Écrire n'est PAS lire. Le porteur de la carte consigne depuis n'importe
 * quel poste ; il ne verra jamais ce que les autres ont écrit — la lecture des
 * notes reste gouvernée par le `profil_donnees` du terminal, qui ne les sert
 * qu'aux postes SECURITE et PC_ORGA.
 */
function signalerParticipant() {
  const p = participantAffiche();
  if (!p) return;
  if (reglagesVerrouilles()) {
    message('Présentez une carte STAFF pour signaler un participant.', 'erreur');
    return;
  }

  Confirmation.ouvrir({
    titre: 'SIGNALER ' + (p.prenom + ' ' + p.nom).toUpperCase(),
    champ: 'Fait daté, factuel et précis',
    note: 'La note sera signée et horodatée. Ce signalement est légalement ' +
          'communicable à la personne concernée sur simple demande (RGPD) : ' +
          'des faits, pas de jugement.',
    valider: 'ENREGISTRER LA NOTE'
  }).then(function (texte) {
    if (texte === null) return;
    if (String(texte).trim().length < 5) {
      Confirmation.erreur('Décrivez le fait en quelques mots.');
      return;
    }
    Confirmation.occupe('Envoi…');
    const carte = etat.deverrouillage;
    return API.post({ action: 'ecrire_note', uid_carte: carte ? carte.uid : '',
                      terminal: localStorage.getItem('api_terminal'),
                      numero: p.numero, texte: String(texte).trim() }, 20000)
      .then(function () {
        Confirmation.fermer();
        message('✓ Note enregistrée pour ' + p.prenom + ' ' + p.nom, 'succes');
        if (navigator.vibrate) navigator.vibrate(60);
      })
      .catch(function (erreur) {
        if (erreur.code === 'SESSION_EXPIREE' || erreur.code === 'ROLE_INSUFFISANT') {
          ecrireDeverrouillage(null);
          majActions();
          Confirmation.fermer();
          message('Votre carte n\'autorise pas cette action — représentez une carte STAFF.',
                  'erreur');
          return;
        }
        // Hors ligne, la note ne partirait nulle part. On ne la met PAS en
        // file : une note remontée trois heures plus tard, sans que personne
        // ne le sache, vaut moins qu'un échec annoncé tout de suite.
        Confirmation.erreur('Échec : ' + erreur.message +
                            ' — notez le cas sur papier et prévenez le PC');
        if (navigator.vibrate) navigator.vibrate([200, 80, 200]);
      });
  });
}

/* ── 2. Attribuer ── */

function ouvrirAttribution() {
  const p = participantAffiche();
  if (!p) return;
  if (!etat.peutAssocier) {
    message('Ce terminal n\'est pas habilité à attribuer des bracelets.', 'erreur');
    return;
  }
  if (!('NDEFReader' in window)) {
    message('Ce navigateur ne lit pas le NFC — utilisez un téléphone Android sous Chrome.',
            'erreur');
    return;
  }

  const porte = braceletActif(p.numero);
  Confirmation.ouvrir({
    titre: (porte ? 'NOUVEAU BRACELET POUR ' : 'ATTRIBUER UN BRACELET À ') +
           (p.prenom + ' ' + p.nom).toUpperCase(),
    note: porte
      ? 'L\'ancien bracelet sera désactivé : il sera refusé à tous les points ' +
        'de contrôle dès la synchronisation suivante.'
      : 'Le bracelet présenté sera lié à cette personne sur tous les points de ' +
        'contrôle.',
    valider: 'APPROCHER LE BRACELET'
  }).then(function (reponse) {
    if (reponse === null) { etat.attribution = null; return; }
    etat.attribution = p;
    Confirmation.attendre('Approchez le bracelet du dos du téléphone…');
    if (!etat.lecteurNfc) demarrerNfc();
  });
}

/**
 * Attribue le bracelet présenté au participant en attente.
 *
 * L'opération est autorisée par TERMINAL (colonne `peut_associer` de l'onglet
 * `Terminaux`), pas par personne connectée : un guichet traite des centaines de
 * personnes d'affilée, ressaisir une phrase de passe toutes les quinze minutes
 * serait inapplicable.
 */
function attribuerBracelet(uid) {
  const participant = etat.attribution;
  if (!participant) return;
  const propre = normaliserUid(uid);
  if (!propre) { Confirmation.erreur('UID illisible — représentez le bracelet.'); return; }

  // Le bracelet est-il déjà attribué à quelqu'un d'autre ? On le dit AVANT
  // d'écrire : au guichet, deux personnes repartiraient avec le même bracelet.
  const existant = etat.base.bracelets.get(propre);
  if (existant && existant.numero && existant.numero !== participant.numero
      && existant.statut === 'ACTIF') {
    const autre = etat.base.participants.get(existant.numero);
    Confirmation.erreur('Bracelet déjà attribué à ' +
      (autre ? autre.prenom + ' ' + autre.nom : existant.numero) +
      ' — prenez-en un autre');
    if (navigator.vibrate) navigator.vibrate([200, 80, 200]);
    return;   // on reste en attente : le suivant sera lu sans reclic
  }

  Confirmation.occupe('Attribution en cours…');
  API.post({ action: 'update_status', terminal: localStorage.getItem('api_terminal'),
             uid: propre, numero: participant.numero, statut: 'ACTIF' }, 20000)
    .then(function (reponse) {
      // On l'ajoute tout de suite en mémoire : le bracelet doit être reconnu
      // immédiatement, sans attendre la synchronisation suivante.
      etat.base.bracelets.set(propre,
        { uid: propre, numero: participant.numero, statut: 'ACTIF' });
      if (reponse.ancien_bracelet_neutralise) {
        const ancien = etat.base.bracelets.get(reponse.ancien_bracelet_neutralise);
        if (ancien) ancien.statut = 'PERDU';
      }
      etat.attribution = null;
      Confirmation.fermer();
      message('✓ Bracelet attribué à ' + participant.prenom + ' ' + participant.nom,
              'succes');
      if (navigator.vibrate) navigator.vibrate(60);
      // Retour à la liste, FILTRES CONSERVÉS : l'opérateur enchaîne la personne
      // suivante de la file sans avoir à re-sélectionner son école.
      reinitialiserEcran();
      montrerVue('vue-recherche');
      $('champ-recherche').value = '';
      relancerRecherche();
    })
    .catch(function (erreur) {
      // Hors ligne, l'attribution est IMPOSSIBLE : elle doit être connue de
      // tous les postes, pas seulement de ce téléphone.
      Confirmation.erreur('Échec : ' + erreur.message +
                          ' — réessayez, ou notez le cas sur papier');
      if (navigator.vibrate) navigator.vibrate([200, 80, 200]);
    });
}

/* ── 3. Suspendre ── */

function suspendreBracelet() {
  const p = participantAffiche();
  if (!p) return;
  const porte = braceletActif(p.numero);
  if (!porte) {
    message('Cette personne n\'a aucun bracelet actif à suspendre.', 'erreur');
    return;
  }

  Confirmation.ouvrir({
    danger: true,
    titre: 'SUSPENDRE ' + (p.prenom + ' ' + p.nom).toUpperCase(),
    note: 'Le bracelet sera refusé à TOUS les points de contrôle dès la ' +
          'synchronisation suivante. L\'opération est réversible depuis le ' +
          'classeur.',
    valider: 'SUSPENDRE'
  }).then(function (reponse) {
    if (reponse === null) return;
    Confirmation.occupe('Suspension en cours…');
    return API.post({ action: 'update_status', terminal: localStorage.getItem('api_terminal'),
                      uid: porte.uid, numero: p.numero, statut: 'SUSPENDU' }, 20000)
      .then(function () {
        porte.statut = 'SUSPENDU';
        Confirmation.fermer();
        message('✓ Bracelet suspendu — ' + p.prenom + ' ' + p.nom, 'succes');
        if (navigator.vibrate) navigator.vibrate(60);
        majActions();
      })
      .catch(function (erreur) {
        // Hors ligne, la suspension ne vaudrait que pour ce téléphone — c'est
        // exactement l'inverse du but recherché.
        Confirmation.erreur('Échec : ' + erreur.message +
                            ' — le bracelet reste ACTIF, prévenez le PC');
        if (navigator.vibrate) navigator.vibrate([200, 80, 200]);
      });
  });
}

function brancherActions() {
  Confirmation.brancher();
  Confirmation.surFermeture(function () { etat.attribution = null; });
  $('btn-signaler').addEventListener('click', signalerParticipant);
  $('btn-attribuer').addEventListener('click', ouvrirAttribution);
  $('btn-suspendre').addEventListener('click', suspendreBracelet);
}

/* ─────────────────────────── Photos ─────────────────────────── */

/**
 * Préchargement complet, à faire en Wi-Fi.
 * Séquentiel et non parallèle : cent requêtes simultanées vers Apps Script
 * seraient étranglées côté serveur et bien plus lentes.
 */
/**
 * Nombre de téléchargements de photos menés de front.
 *
 * Mesuré contre le déploiement réel, en secondes par photo :
 *
 *   3 fils → 1,8   ·   6 fils → 1,8   ·   12 fils → 0,52   ·   20 fils → 0,44
 *
 * Apps Script parallélise donc bien mieux que ce que l'on croyait : la valeur
 * de 3 retenue au départ était largement sous-dimensionnée et transformait un
 * préchargement de vingt minutes en plusieurs heures.
 *
 * ⚠️ Ne pas monter beaucoup plus haut. Le gain plafonne au-delà de 12, et
 * plusieurs téléphones préchargeant ensemble additionnent leurs fils : dix
 * appareils à 10 fils font déjà cent requêtes simultanées, soit le plafond
 * d'exécutions concurrentes d'Apps Script. Préchargez les appareils par petits
 * groupes plutôt que d'augmenter cette valeur.
 */
const FILS_PHOTOS = 10;

function prechargerPhotos() {
  if (!API.estConfigure()) { message('Configurez d\'abord la connexion.', 'erreur'); return; }
  // On ne précharge QUE les participants dont le serveur annonce une photo.
  // Demander les autres coûte 3 à 4 secondes chacun pour un échec certain :
  // sur 2 000 fiches dont vingt seulement ont une photo, c'est la différence
  // entre quelques secondes et plusieurs heures.
  const tous = Array.from(etat.base.participants.values());
  const numeros = tous.filter(function (p) { return p.photo !== false; })
                      .map(function (p) { return p.numero; });

  if (!tous.length) { message('Base vide : synchronisez d\'abord.', 'erreur'); return; }
  if (!numeros.length) {
    message('Aucun participant n\'a de photo dans le classeur — rien à précharger.',
            'erreur');
    return;
  }
  if (numeros.length < tous.length) {
    message(numeros.length + ' photo(s) à charger sur ' + tous.length +
            ' participants ; les autres n\'en ont pas dans le classeur.');
  }

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
      // La mesure porte sur UNE photo, donc sur un seul fil : on divise par le
      // nombre de fils réellement employés.
      const minutes = Math.max(1,
        Math.round(numeros.length * dureeUnitaire / FILS_PHOTOS / 60));

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
        if (faits % FILS_PHOTOS === 0 || faits === numeros.length) {
          const restant = Math.round((Date.now() - depart) / faits *
                                     (numeros.length - faits) / 60000);
          bouton.textContent = faits + '/' + numeros.length +
                               ' — encore ~' + restant + ' min';
        }
        return suivante();
      });
  };

  const fils = [];
  for (let i = 0; i < FILS_PHOTOS; i++) fils.push(suivante());

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

/**
 * États réseau qui ne cèdent JAMAIS la place à l'indicateur NFC.
 *
 * « NFC actif » est une information de confort ; « hors ligne » ou « échec
 * sync » demandent une action. Les masquer cinq secondes sur dix serait la
 * meilleure façon de les faire manquer.
 */
const ETATS_RESEAU_PRIORITAIRES = ['sync…', 'hors ligne', 'échec sync'];

/** Durée d'affichage de chaque face de l'alternance. */
const ALTERNANCE_MS = 5000;

function definirEtatReseau(texte, classe) {
  etat.reseauTexte = texte;
  etat.reseauClasse = classe || '';
  rendreEtatReseau();
}

function rendreEtatReseau() {
  const zone = $('etat-reseau');
  if (!zone) return;
  const prioritaire = ETATS_RESEAU_PRIORITAIRES.indexOf(etat.reseauTexte) !== -1;
  const afficherNfc = !!etat.lecteurNfc && !prioritaire && etat.alterneNfc;
  zone.textContent = afficherNfc ? 'NFC actif' : (etat.reseauTexte || 'en ligne');
  zone.className = afficherNfc ? 'nfc-actif' : etat.reseauClasse;
}

/** Bascule l'alternance. Un seul minuteur pour toute l'application. */
function lancerAlternanceBandeau() {
  setInterval(function () {
    if (!etat.lecteurNfc) { etat.alterneNfc = false; return; }
    etat.alterneNfc = !etat.alterneNfc;
    rendreEtatReseau();
  }, ALTERNANCE_MS);
}

function rafraichirBandeau() {
  return DB.compterFileScans().then(function (attente) {
    $('etat-file').textContent = attente + ' en attente';
    if (!navigator.onLine) {
      definirEtatReseau('hors ligne', 'alerte-reseau');
    } else if (etat.reseauTexte === 'hors ligne') {
      definirEtatReseau('en ligne');
    }
  });
}

/**
 * Écrit dans un élément s'il existe, sans jamais lever d'exception.
 *
 * Un affichage de confort ne doit pas pouvoir faire tomber l'application. Le
 * cas s'est produit : un `index.html` périmé servi à côté d'un `app.js` neuf,
 * et le message « Cannot set properties of null » remontait dans le bandeau de
 * panne — illisible, et sans rapport apparent avec la vraie cause.
 */
function definirTexte(identifiant, valeur) {
  const element = $(identifiant);
  if (!element) { console.warn('élément absent : ' + identifiant); return false; }
  element.textContent = valeur;
  return true;
}

function rafraichirStatistiques() {
  DB.statistiques().then(function (s) {
    definirTexte('stat-participants', s.participants);
    definirTexte('stat-bracelets', s.bracelets);
    definirTexte('stat-photos', s.photos);
    definirTexte('stat-attente', s.en_attente);
    definirTexte('stat-historique', s.historique + ' passage(s)');
  }).catch(function (erreur) {
    console.warn('statistiques : ' + erreur.message);
  });
  // Jauge mémoire : le seul moyen de savoir, depuis le terrain, si un appareil
  // qui se ferme tout seul manque réellement de mémoire. Android tue l'onglet
  // sans laisser la moindre erreur JavaScript derrière lui.
  const m = performance.memory;
  definirTexte('stat-memoire', m
    ? Math.round(m.usedJSHeapSize / 1048576) + ' Mo sur ' +
      Math.round(m.jsHeapSizeLimit / 1048576) + ' Mo'
    : 'non mesurable');
  DB.lireMeta('derniere_sync').then(function (horodatage) {
    definirTexte('stat-sync', horodatage
      ? new Date(horodatage).toLocaleTimeString('fr-FR')
      : 'jamais');
  }).catch(function () {});
  DB.lireMeta('point_controle').then(function (point) {
    definirTexte('stat-point', point || '—');
  }).catch(function () {});
  definirTexte('stat-version', 'v' + VERSION_APP);

  // Espace réellement occupé sur l'appareil, et poids moyen d'une photo.
  //
  // C'est le chiffre qui dit si un téléphone qui se fait tuer par le système
  // traîne un cache de photos pleine résolution : 10 ko par photo signifie que
  // le dossier `Miniatures` était bien déclaré au préchargement, 142 ko qu'il
  // ne l'était pas — et sur deux mille participants, l'écart fait 280 Mo.
  Promise.all([DB.occupation(), DB.poidsMoyenPhotos()]).then(function (r) {
    const occupation = r[0];
    const poids = r[1];
    definirTexte('stat-stockage', occupation
      ? Math.round(occupation.utilise / 1048576) + ' Mo sur ' +
        Math.round(occupation.quota / 1048576) + ' Mo'
      : 'non mesurable');
    definirTexte('stat-poids-photo',
      poids ? Math.round(poids / 1024) + ' ko' : 'aucune photo en cache');
  }).catch(function (erreur) {
    console.warn('occupation : ' + erreur.message);
  });
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
