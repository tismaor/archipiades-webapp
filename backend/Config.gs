/**
 * Config.gs — Constantes, noms d'onglets et correspondance des en-têtes.
 *
 * C'EST LE SEUL FICHIER À AJUSTER si les intitulés de colonnes du classeur
 * diffèrent de ceux prévus. La résolution est déjà tolérante (casse, accents,
 * espaces multiples), donc « Prénom », « prenom » et « PRENOM  » se valent ;
 * n'intervenez ici que si un libellé est réellement différent.
 */

/** Onglets du classeur. */
const SHEETS = {
  PARTICIPANTS: 'Participants',
  BRACELETS: 'Bracelets',
  DROITS: 'Droits',
  FORMULES: 'Formules',
  SERVICES: 'Services',
  SCANS: 'Scans',
  TERMINAUX: 'Terminaux',
  CONFIG: 'Config',
  COMPTES: 'Comptes',
  COMMANDES: 'Commandes',
  ADMIN_LOG: 'Admin_Log'
};

/**
 * Correspondance champ logique -> intitulés acceptés dans l'onglet Participants.
 * Le premier libellé est celui écrit par la migration si la colonne est absente ;
 * les suivants sont des variantes tolérées sur un classeur existant.
 */
const COLS_PARTICIPANTS = {
  numero:        ['Numéro du participant', 'Numero du participant', 'N° participant', 'Numéro'],
  ecole:         ['École', 'Ecole', 'Établissement'],
  nom:           ['Nom'],
  prenom:        ['Prénom', 'Prenom'],
  naissance:     ['Date de Naissance', 'Date de naissance', 'DDN'],
  email:         ['Email', 'E-mail', 'Mail'],
  telephone:     ['Numéro de Téléphone', 'Téléphone', 'Telephone', 'Tel'],
  sexe:          ['Sexe'],
  taille:        ['Taille Vêtement', 'Taille vêtement', 'Taille'],
  statut:        ['Statut'],
  sports:        ['Sport(s)', 'Sports', 'Sport'],
  camping:       ['Camping'],
  formule:       ['Formule Repas', 'Formule repas', 'Formule'],
  regime:        ['Régime alimentaire', 'Regime alimentaire', 'Régime'],
  repas_conso:   ['Repas consommé(s)', 'Repas consommés', 'Repas consomme(s)'],
  photo:         ["Photo d'identité", 'Photo identité', 'Photo'],
  commentaire:   ['Commentaire Participant', 'Commentaire participant', 'Commentaire'],
  note_secu:     ['Note de sécurité', 'Note de securite', 'Note sécurité'],
  // Colonnes techniques, ajoutées par la migration.
  updated_at:    ['_updated_at'],
  statut_part:   ['_statut_participant'],
  photo_file_id: ['_photo_file_id'],
  photo_prete:   ['_photo_prete'],
  row_hash:      ['_row_hash']
};

/** Colonnes techniques créées par la migration si absentes. */
const COLS_TECHNIQUES = ['_updated_at', '_statut_participant', '_photo_file_id', '_photo_prete', '_row_hash'];

/**
 * Champs entrant dans le calcul de _row_hash : toute modification de l'un
 * d'eux doit produire un delta. Les colonnes techniques en sont exclues,
 * sans quoi le hash dépendrait de lui-même.
 */
const CHAMPS_HASHES = [
  'numero', 'ecole', 'nom', 'prenom', 'naissance', 'email', 'telephone',
  'sexe', 'taille', 'statut', 'sports', 'camping', 'formule', 'regime',
  'repas_conso', 'photo', 'commentaire', 'note_secu', 'statut_part'
];

/**
 * Profils de données : ce que chaque type de terminal a le droit de recevoir.
 *
 * Règles structurantes du projet, à ne pas assouplir sans y réfléchir :
 *  - la date de naissance, l'email et le téléphone ne quittent JAMAIS le backend,
 *    ils ne servent aucune décision d'accès ;
 *  - `commentaire` (santé déclarée) part partout, c'est une information de secours ;
 *  - `note_secu` ne part que vers SECURITE et PC_ORGA.
 */
const PROFILS_DONNEES = {
  ENTREE:   ['numero', 'nom', 'prenom', 'statut', 'commentaire'],
  REPAS:    ['numero', 'nom', 'prenom', 'statut', 'commentaire', 'formule', 'repas_conso', 'regime'],
  SPORT:    ['numero', 'nom', 'prenom', 'statut', 'commentaire', 'sports', 'ecole'],
  SECURITE: ['numero', 'nom', 'prenom', 'statut', 'commentaire', 'note_secu'],
  PC_ORGA:  ['numero', 'nom', 'prenom', 'statut', 'commentaire', 'formule', 'repas_conso',
             'regime', 'sports', 'ecole', 'note_secu']
};

/** Profil appliqué si le terminal en déclare un inconnu : le plus restrictif. */
const PROFIL_PAR_DEFAUT = 'ENTREE';

/** En-têtes des onglets créés par la migration. */
const ENTETES = {
  BRACELETS: ['uid', 'numero_participant', 'statut', 'date_association', 'commentaire', '_updated_at'],
  DROITS:    ['statut'],  // les colonnes suivantes sont les points de contrôle, ajoutées à la main
  FORMULES:  ['formule', 'repas_autorises', 'libelle'],
  SERVICES:  ['numero_service', 'libelle', 'debut', 'fin'],
  SCANS:     ['scan_id', 'ts_terminal', 'terminal_id', 'point_controle', 'uid',
              'numero_participant', 'decision', 'motif', 'service', 'annule_scan_id', 'ts_serveur'],
  TERMINAUX: ['terminal_id', 'libelle', 'point_controle', 'type', 'profil_donnees',
              'sync_interval_s', 'supervision_jusqua', 'wifi_ssid', 'actif',
              'last_seen', 'derniere_version_base'],
  CONFIG:    ['cle', 'valeur', 'description'],
  COMPTES:   ['uid_carte', 'nom', 'role', 'hash_mdp', 'sel', 'actif', '_updated_at'],
  COMMANDES: ['commande_id', 'emise_par', 'terminal_cible', 'type', 'payload',
              'etat', 'ts_emission', 'expire_le', 'ts_application'],
  ADMIN_LOG: ['ts', 'role', 'compte', 'terminal_id', 'operation', 'cible', 'detail', 'resultat']
};

/** Valeurs par défaut de l'onglet Config, écrites par la migration si absentes. */
const CONFIG_DEFAUTS = [
  ['antipassback_secondes', 120, 'Fenêtre de détection du re-scan rapide, en secondes'],
  ['passback_expiration_s', 60, 'Déblocage automatique de l\'écran orange si personne n\'acquitte'],
  ['sync_interval_defaut_s', 180, 'Cadence de synchronisation si le terminal n\'en précise aucune'],
  ['sync_interval_supervision_s', 3, 'Cadence pendant une supervision à distance'],
  ['supervision_duree_s', 600, 'Durée d\'une session de supervision avant retour à la cadence normale'],
  ['http_timeout_ms', 8000, 'Délai maximal d\'une requête côté terminal'],
  ['session_admin_s', 900, 'Durée de vie d\'un jeton ADMIN'],
  ['session_inactivite_s', 180, 'Sortie automatique du mode privilégié après inactivité'],
  ['photo_ttl_s', 8, 'Durée d\'affichage d\'une photo sur l\'écran portrait'],
  ['version_schema', 1, 'Version du schéma de données']
];

/** Statuts de bracelet. */
const STATUT_BRACELET = { ACTIF: 'ACTIF', SUSPENDU: 'SUSPENDU', PERDU: 'PERDU' };

/** Décisions inscrites dans le journal des scans. */
const DECISIONS = {
  AUTORISE:     'ACCES_AUTORISE',
  NON_RECONNU:  'NON_RECONNU',
  SUSPENDU:     'ACCES_SUSPENDU',
  ZONE:         'ZONE_NON_AUTORISEE',
  PASSBACK:     'PASSBACK_SUSPECTE',
  VERROUILLE:   'POSTE_VERROUILLE',
  REPAS_SERVI:  'REPAS_SERVI',
  REPAS_DEJA:   'REPAS_DEJA_CONSOMME',
  REPAS_HORS:   'REPAS_HORS_SERVICE',
  REPAS_NON_DU: 'REPAS_NON_DU',
  ANNULATION:   'ANNULATION'
};

/** Rôles des comptes privilégiés. */
const ROLES = { STAFF: 'STAFF', ADMIN: 'ADMIN' };

/**
 * Opérations autorisées par rôle. Ce tableau est LA référence : le contrôle
 * est fait côté serveur, jamais seulement dans le menu du terminal.
 */
const OPERATIONS_PAR_ROLE = {
  STAFF: [
    'reassocier_bracelet',
    'rechercher_participant',
    'suspendre_bracelet',
    'ecrire_note_securite',
    'changer_point_controle'
  ],
  ADMIN: [
    'reassocier_bracelet',
    'rechercher_participant',
    'suspendre_bracelet',
    'ecrire_note_securite',
    'changer_point_controle',
    'diagnostic_deck',
    'annuler_scan',
    'verrouillage_urgence',
    'forcer_passage',
    'superviser_deck',
    'redemarrer_deck',
    'changer_profil_donnees'
  ]
};

/** Clés stockées dans les Script Properties (jamais en dur dans le code). */
const PROP = {
  API_KEY: 'API_KEY',
  DOSSIER_MINIATURES: 'DOSSIER_MINIATURES_ID',
  MAX_UPDATED_AT: 'MAX_UPDATED_AT'
};

/** Taille maximale d'un lot de participants renvoyé par sync. */
const SYNC_LIMITE_DEFAUT = 500;
