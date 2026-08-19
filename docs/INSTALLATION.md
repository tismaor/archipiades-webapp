# Installation du backend — étape 1

Comptez une vingtaine de minutes. Aucun outil à installer : tout se fait dans
le navigateur.

---

## 1. Sauvegarder le classeur

**Fichier > Créer une copie**, nommée par exemple
`ARCHIPIADES 12 — sauvegarde avant migration`.

La migration est conçue pour ne rien détruire — elle n'ajoute que des colonnes
et des onglets — mais une sauvegarde avant une modification structurelle ne se
discute pas.

## 2. Mettre le numéro de participant au format Texte

Sélectionnez la colonne **« Numéro du participant »**, puis
**Format > Nombre > Texte simple**.

Sans cela, Google interprète `0001A001`… et surtout ferait sauter les zéros de
tête d'un numéro purement numérique. Ce format est la seule chose à vérifier
**avant** tout import.

## 3. Ouvrir l'éditeur de script

**Extensions > Apps Script.** Le projet créé est *lié* au classeur : il y accède
sans configuration d'identifiant.

Supprimez le `Code.gs` vide proposé par défaut, puis créez un fichier par
module (bouton `+` > Script), en respectant **exactement** ces noms :

| Fichier à créer | Contenu à coller |
|---|---|
| `Config` | `backend/Config.gs` |
| `Utils` | `backend/Utils.gs` |
| `Migration` | `backend/Migration.gs` |
| `Sync` | `backend/Sync.gs` |
| `Scans` | `backend/Scans.gs` |
| `Auth` | `backend/Auth.gs` |
| `Admin` | `backend/Admin.gs` |
| `Photos` | `backend/Photos.gs` |
| `Code` | `backend/Code.gs` |

L'ordre des fichiers n'a pas d'importance : Apps Script les charge tous dans
une portée commune.

Enfin, **⚙️ Paramètres du projet > cochez « Afficher le fichier manifeste
appsscript.json »**, puis remplacez son contenu par `backend/appsscript.json`.

## 4. Initialiser la base

Rechargez le classeur : un menu **ARCHIPIADES** apparaît.

**ARCHIPIADES > ⚙️ Initialiser / mettre à jour la base**

Google demande une autorisation au premier lancement. L'écran
« Cette application n'est pas validée » est normal pour un script personnel :
**Paramètres avancés > Accéder à … (non sécurisé)**.

Le script crée alors les onglets manquants, ajoute les colonnes techniques,
installe les déclencheurs et génère la clé API. **Il est relançable sans risque** :
il ne crée que ce qui manque.

## 5. Ajuster les onglets de référence

Trois onglets sont pré-remplis avec des exemples **à adapter à votre événement** :

- **`Droits`** — matrice Statut × Point de contrôle. Une croix `OUI`/`NON` par
  case. C'est ici que se décide qu'un Supporter n'entre pas sur le terrain.
- **`Formules`** — quelle formule donne droit à quels repas
  (`Pension complète` → `1,2,3,4`).
- **`Services`** — les plages horaires qui déterminent **quel repas est
  décompté** au moment du scan.

Puis l'onglet **`Terminaux`** : une ligne par mallette et par téléphone.
La colonne `profil_donnees` commande ce que le terminal a le droit de recevoir,
`sync_interval_s` sa cadence (15 s sur le point critique, 180 à 300 s ailleurs).

## 6. Déployer en application web

**Déployer > Nouveau déploiement > type : Application Web.**

| Réglage | Valeur | Pourquoi |
|---|---|---|
| Exécuter en tant que | **Moi** | le script doit lire le Drive et le classeur avec vos droits |
| Qui a accès | **Tout le monde** | les mallettes n'ont pas de compte Google |

> Ces deux réglages ne sont pas négociables. Avec « Utilisateur accédant à
> l'application », la redirection 302 mène vers `accounts.google.com` et aucun
> terminal ne recevra jamais de données.

L'accès « tout le monde » ne rend rien public : **la clé partagée protège
chaque requête**, et l'URL de déploiement n'est pas devinable.

Copiez l'URL `/exec` obtenue.

> ### ⚠️ À chaque modification du code, ensuite
>
> Un déploiement est **figé sur un instantané de version**. Coller du code dans
> l'éditeur ne change rien à ce que sert l'URL `/exec` : tant qu'une nouvelle
> version n'est pas publiée, l'ancien code continue de répondre, sans le moindre
> message d'erreur.
>
> `Déployer > Gérer les déploiements` → **crayon** sur le déploiement existant →
> **Version : Nouvelle version** → `Déployer`.
>
> **Modifiez le déploiement existant, n'en créez jamais un nouveau** : un
> nouveau déploiement produit une nouvelle URL, et toutes les mallettes seraient
> à reconfigurer.

## 7. Relever la clé API

**ARCHIPIADES > 🔑 Afficher la clé API.** Elle ira dans le `config.json` de
chaque mallette et dans la Web App.

## 8. Premier test — celui qui compte

Dans un navigateur :

```
https://script.google.com/macros/s/VOTRE_ID/exec?action=ping&key=VOTRE_CLE
```

Attendu :

```json
{"ok":true,"server_time":1755500000000,"version_api":1}
```

**Si le corps est vide**, c'est la redirection 302 non suivie — vérifiez les
réglages de déploiement de l'étape 6 avant toute autre hypothèse
(voir `docs/API.md`).

Puis un vrai delta :

```
…/exec?action=sync&key=VOTRE_CLE&terminal=DECK-01&since=0
```

## 9. Charger des données de test (facultatif)

```bash
python3 tools/generate_test_data.py --nombre 2000
```

**Fichier > Importer > Remplacer la feuille active** sur l'onglet `Participants`,
puis **ARCHIPIADES > 🔄 Forcer la réindexation**.

## 10. Créer les comptes privilégiés

Dans l'éditeur de script, sélectionnez la fonction `creerCompte` et exécutez-la
depuis la console, une fois par personne :

```javascript
creerCompte('04A1B2C3D4E5F6', 'Mathis', 'ADMIN', 'une phrase de passe vraiment longue')
creerCompte('04B1B2C3D4E5F6', 'Chef poste entrée', 'STAFF', 'une autre phrase de passe longue')
```

- l'UID de carte se lit en scannant la carte sur un deck (l'écran affiche l'UID
  des bracelets non reconnus, c'est fait pour) ;
- **12 caractères minimum, une phrase plutôt qu'un mot de passe.** Faute de
  bcrypt côté Apps Script, la longueur est la seule vraie protection ;
- **effacez ensuite la ligne de l'éditeur** : elle contient la phrase en clair.

## 11. Photos (avant l'étape 2)

**ARCHIPIADES > 🖼 Indexer les photos** remplit `_photo_file_id` à partir des
liens Drive. Le rapport signale les liens non reconnus — en général des URL
raccourcies ou des copier-coller partiels, à corriger à la main.

Créez ensuite un dossier Drive `Miniatures`, et déclarez-le une fois depuis
l'éditeur :

```javascript
definirDossierMiniatures('<id du dossier>')
```

---

## Contrôles de validation

| Test | Attendu |
|---|---|
| `action=ping` | corps **non vide** |
| `action=sync&since=0` | tous les participants |
| Modifier une cellule, relancer un sync | **cette ligne seule** dans le delta |
| Relancer « Forcer la réindexation » sans rien changer | **0 ligne modifiée** |
| Coller 500 lignes puis réindexer | **500 lignes**, pas 5 000 |
| Rejouer deux fois le même `log_scan` | une seule ligne dans `Scans` |
| Sync d'un terminal `ENTREE` | ni `regime`, ni `note_secu`, **mais** `commentaire` |

Le point le plus important est le quatrième : une réindexation qui
réhorodaterait tout le classeur déclencherait un re-sync intégral sur chaque
mallette, en pleine exploitation.
