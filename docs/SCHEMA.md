# Schéma de données

## `Participants` — colonnes métier (les vôtres, inchangées)

`Numéro du participant` · `École` · `Nom` · `Prénom` · `Date de Naissance` ·
`Email` · `Numéro de Téléphone` · `Sexe` · `Taille Vêtement` · `Statut` ·
`Sport(s)` · `Camping` · `Formule Repas` · `Régime alimentaire` ·
`Repas consommé(s)` · `Photo d'identité` · `Commentaire Participant` ·
`Note de sécurité`

La résolution des en-têtes est **tolérante** : casse, accents et espaces
multiples sont neutralisés, et plusieurs variantes sont acceptées par colonne
(voir `COLS_PARTICIPANTS` dans `backend/Config.gs`). C'est le seul endroit à
modifier si un intitulé diffère réellement.

### Le numéro est une chaîne, jamais un nombre

Le format `0000X000` mêle zéros de tête et lettre interne. Toute conversion
numérique le corrompt. La colonne **doit être au format Texte** dans le
classeur, et le code la traite partout comme une chaîne opaque.

### Les deux colonnes de commentaires

| Colonne | Origine | Nature | Diffusion |
|---|---|---|---|
| `Commentaire Participant` | déclaré à l'inscription | **donnée de santé (RGPD art. 9)** | **tous** les postes |
| `Note de sécurité` | saisie par l'organisation | appréciation interne | `SECURITE` et `PC_ORGA` seulement |

Trois conséquences pratiques :

1. **Écrire n'est pas lire.** Un chef de poste peut consigner un incident depuis
   n'importe quelle mallette, sans jamais voir ce que les autres ont écrit.
   L'asymétrie est délibérée : elle encourage le signalement sans diffuser les
   appréciations.
2. **Tout ce qui est écrit là est communicable à la personne concernée**
   (droit d'accès, art. 15). Des faits datés, situés, factuels — jamais un
   jugement de valeur. Le backend appose automatiquement horodatage et auteur.
3. **Purge à la clôture** via `🗑 Purger les données sensibles`.

## `Participants` — colonnes techniques (ajoutées, grisées)

| Colonne | Rôle |
|---|---|
| `_updated_at` | epoch ms — **seule clé de la synchronisation différentielle** |
| `_statut_participant` | `ACTIF` / `SUSPENDU` — suspendre sans supprimer la ligne |
| `_photo_file_id` | identifiant Drive extrait du lien |
| `_photo_prete` | VRAI quand la miniature a été générée |
| `_row_hash` | empreinte des champs métier, filet de sécurité |

### Pourquoi trois niveaux pour maintenir `_updated_at`

`onEdit` ne se déclenche de façon fiable que sur une édition **humaine et
interactive**. Un import de billetterie ou une écriture par un autre script
peuvent passer au travers, et la sync rate alors des mises à jour **en silence**.
C'est le point de fragilité n°1 du système.

1. **Déclencheur `onEdit`** — l'édition manuelle au fil de l'eau.
2. **`🔄 Forcer la réindexation`** — à lancer **après chaque import**.
   *Règle impérative :* elle ne réécrit **pas** `_updated_at` en masse. Seules
   les lignes dont le hash a réellement changé sont réhorodatées. Une
   réindexation aveugle provoquerait un re-sync intégral des 5 000 lignes sur
   chaque mallette, en pleine exploitation.
3. **Déclencheur horaire** — compare les hash et répare les dérives seul.

---

## Onglets ajoutés

### `Bracelets`
`uid` · `numero_participant` · `statut` (`ACTIF`/`SUSPENDU`/`PERDU`) ·
`date_association` · `commentaire` · `_updated_at`

Table séparée pour conserver l'historique : un bracelet perdu est remplacé, pas
écrasé. À la réassociation, l'ancien bracelet du participant bascule
automatiquement en `PERDU` — sans quoi un bracelet retrouvé plus tard
redonnerait l'accès par surprise.

### `Droits`
Matrice **Statut × Point de contrôle**, valeurs `OUI`/`NON`. Éditable par un
non-développeur, et évite une colonne « zones » par participant.

### `Formules`
`formule` → `repas_autorises` (`1,2,3,4`) → `libelle`.

### `Services`
`numero_service` · `libelle` · `debut` · `fin`.

Détermine **quel repas est décompté** au moment du scan. Hors de toute plage,
l'écran l'indique et ne décompte rien.

### `Scans` — la source de vérité des consommations
`scan_id` · `ts_terminal` · `terminal_id` · `point_controle` · `uid` ·
`numero_participant` · `decision` · `motif` · `service` · `annule_scan_id` ·
`ts_serveur`

La colonne « Repas consommé(s) » de `Participants` n'en est qu'un **miroir**
recalculé par le serveur. Aucun terminal n'y écrit jamais : c'est ce qui évite
que deux mallettes s'écrasent mutuellement, et ce qui rend l'historique
rejouable en cas de litige.

**On n'efface jamais un scan.** Une annulation ajoute une ligne qui référence
l'originale via `annule_scan_id`. La piste d'audit reste intacte, le repas est
recrédité.

### `Terminaux`
`terminal_id` · `libelle` · `point_controle` · `type` · `profil_donnees` ·
`sync_interval_s` · `supervision_jusqua` · `wifi_ssid` · `actif` ·
`last_seen` · `derniere_version_base`

`point_controle` et `profil_donnees` sont **découplés** : un staff peut
requalifier une mallette sans changer ce qu'elle a le droit de recevoir. Sans
cette séparation, requalifier un deck en poste `SECURITE` suffirait à lire
toutes les notes.

### `Comptes`
`uid_carte` · `nom` · `role` (`STAFF`/`ADMIN`) · `hash_mdp` · `sel` · `actif` ·
`_updated_at`

Une carte par personne, révocable individuellement. **La carte n'est jamais le
secret** : un UID NTAG se lit et se clone avec du matériel à trente euros, elle
ne sert qu'à ouvrir la saisie.

### `Commandes`
`commande_id` · `emise_par` · `terminal_cible` · `type` · `payload` · `etat` ·
`ts_emission` · `expire_le` · `ts_application`

Relevées à la sync du terminal cible. Expirent après 5 minutes : mieux vaut
qu'une commande se périme que de voir un redémarrage surgir une heure plus tard.

### `Admin_Log`
`ts` · `role` · `compte` · `terminal_id` · `operation` · `cible` · `detail` ·
`resultat`

Alimenté côté serveur, non modifiable depuis un terminal.

### `Config`
| Clé | Défaut | Rôle |
|---|---|---|
| `antipassback_secondes` | 120 | fenêtre de détection du re-scan rapide |
| `passback_expiration_s` | 60 | déblocage auto de l'écran orange |
| `sync_interval_defaut_s` | 180 | cadence si le terminal n'en précise aucune |
| `sync_interval_supervision_s` | 3 | cadence pendant une supervision |
| `supervision_duree_s` | 600 | durée avant retour à la cadence normale |
| `session_admin_s` | 900 | durée de vie d'un jeton ADMIN |
| `session_inactivite_s` | 180 | sortie auto du mode privilégié |
| `photo_ttl_s` | 8 | durée d'affichage sur l'écran portrait |

---

## Ce qui ne quitte jamais le backend

`Date de Naissance`, `Email` et `Numéro de Téléphone` ne sont transmis à
**aucun** terminal, quel que soit son profil. Ils ne servent aucune décision
d'accès, et ce sont les champs les plus exposés en cas de perte d'un téléphone
de bénévole.
