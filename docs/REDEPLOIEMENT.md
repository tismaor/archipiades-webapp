# Redéploiement sur un autre compte Google

Les tests de l'étape 1 ont été menés sur un compte Google **personnel**. Le
système devra tourner sur le compte **professionnel de l'association**. Cette
page permet de refaire toute la procédure sans rien redécouvrir.

À lire aussi : le § « Piège n°2 » plus bas concerne le déploiement **au
quotidien**, pas seulement le changement de compte.

---

## Ce qui suit le classeur, ce qui ne suit pas

Copier un classeur ne copie pas tout. C'est la principale source de mauvaises
surprises.

| Élément | Suit la copie ? | Conséquence |
|---|---|---|
| Onglets et données | ✅ | rien à faire |
| Code Apps Script lié | ✅ | copié avec le classeur |
| **Clé API** (Script Properties) | ❌ | **régénérée** — à recopier dans tous les terminaux |
| **ID du dossier Miniatures** (Script Properties) | ❌ | à redéclarer |
| **Déclencheurs** `onEdit` et horaire | ❌ | recréés par la migration |
| **URL de déploiement** | ❌ | **nouvelle URL** — à recopier partout |
| Autorisations OAuth | ❌ | à réaccorder au premier lancement |
| Comptes STAFF/ADMIN (onglet `Comptes`) | ✅ | les empreintes suivent, phrases inchangées |
| **Photos sur Drive** | ⚠️ | voir ci-dessous |

### Le point le plus piégeux : les photos Drive

Les liens de la colonne `Photo d'identité` pointent vers des fichiers du Drive
**personnel**. Une fois le script sur le compte pro, il les lira avec les droits
du compte pro — et **échouera si celui-ci n'y a pas accès**.

Trois options, par ordre de préférence :

1. **Transférer la propriété** du dossier de photos au compte pro
   (clic droit > Partager > passer le compte pro en propriétaire) ;
2. **Partager** le dossier avec le compte pro en lecture — suffisant, mais le
   jour où le compte perso est fermé, tout casse ;
3. **Retélécharger et redéposer** les photos depuis le compte pro, puis relancer
   `🖼 Indexer les photos` pour recalculer les `_photo_file_id`.

Symptôme d'un oubli : `action=photo` renvoie `PHOTO_INTROUVABLE` alors que la
colonne est remplie.

---

## Procédure, dans l'ordre

### 1. Préparer le compte pro
- ouvrir une session sur le compte professionnel ;
- vérifier que Apps Script n'est pas bloqué par l'administrateur Workspace —
  certains domaines interdisent les déploiements « accessibles à tout le
  monde », ce qui **empêcherait purement et simplement les mallettes de se
  synchroniser**. À vérifier **avant** l'événement, pas la veille.

### 2. Transférer le classeur
Deux voies :
- **transfert de propriété** du classeur existant (garde l'historique) ;
- ou **Fichier > Créer une copie** depuis le compte pro (repart propre).

Dans les deux cas, vérifier que l'onglet des participants s'appelle bien
**`Participants`**.

### 3. Transférer les photos
Voir ci-dessus. À faire **avant** l'indexation.

### 4. Recoller le code
`Extensions > Apps Script`, puis les neuf fichiers de `backend/` plus le
manifeste `appsscript.json` (⚙️ Paramètres > afficher le manifeste).

Si le classeur a été copié, le code est déjà là — vérifier simplement qu'il est
à jour par rapport à `backend/`.

### 5. Initialiser
`ARCHIPIADES > ⚙️ Initialiser / mettre à jour la base`

Accorder les autorisations OAuth. L'écran « application non validée » est normal
pour un script personnel : **Paramètres avancés > Accéder à …**

Cela recrée les déclencheurs et **génère une nouvelle clé API**.

### 6. Déployer
`Déployer > Nouveau déploiement > Application Web`

| Réglage | Valeur |
|---|---|
| Exécuter en tant que | **Moi** |
| Qui a accès | **Tout le monde** |

Noter la **nouvelle URL `/exec`**.

### 7. Redéclarer le dossier des miniatures
Depuis l'éditeur :
```javascript
definirDossierMiniatures('<id du dossier Drive sur le compte pro>')
```

### 8. Recréer les comptes privilégiés — si le classeur n'a pas été copié
```javascript
creerCompte('<uid carte>', 'Mathis', 'ADMIN', 'une phrase de passe vraiment longue')
```
Puis **effacer la ligne de l'éditeur**, elle contient la phrase en clair.

### 9. Réindexer
`🔄 Forcer la réindexation`, puis `🖼 Indexer les photos`.

### 10. Valider
```bash
node tools/valider_deploiement.js --url <NOUVELLE_URL> --cle <NOUVELLE_CLE>
```

### 11. Reconfigurer les terminaux
La nouvelle URL et la nouvelle clé vont dans :
- le `config.json` de la microSD de **chaque mallette** (maître et esclave) ;
- la configuration de la **Web App**.

C'est précisément pour cette raison que rien n'est codé en dur : un
redéploiement se règle avec un éditeur de texte, pas avec un reflashage.

---

## ⚠️ Piège n°2 : un déploiement est figé sur une version

**Coller du code dans l'éditeur ne change rien à ce que sert l'URL `/exec`.**
Un déploiement pointe sur un *instantané de version*. Tant qu'une nouvelle
version n'est pas publiée, l'URL continue de servir l'ancien code — sans le
moindre message d'erreur.

Symptôme : vous corrigez un comportement, vous recollez, vous retestez… et
**rien ne change**. C'est ce qui s'est produit pendant l'optimisation des
performances de l'étape 1.

### La bonne manœuvre

`Déployer > Gérer les déploiements` → **crayon (modifier)** sur le déploiement
existant → **Version : Nouvelle version** → `Déployer`.

> **Modifier le déploiement existant, ne jamais en créer un nouveau.**
> Un nouveau déploiement produit une **nouvelle URL**, ce qui obligerait à
> reconfigurer toutes les mallettes. En modifiant l'existant, l'URL est
> conservée.

### Pendant le développement

L'URL de test (`Déployer > Tester les déploiements`, terminée par `/dev`) sert
**toujours le code le plus récent**, sans publication de version. Pratique pour
itérer — mais elle **exige une session Google authentifiée**, donc inutilisable
depuis une mallette. Le `/exec` reste la seule URL exploitable sur le terrain.

---

## Inventaire à conserver

À noter dans un endroit sûr (gestionnaire de mots de passe de l'association) :

| Élément | Valeur |
|---|---|
| Compte Google propriétaire | |
| ID du classeur | |
| URL `/exec` du déploiement | |
| Clé API | |
| ID du dossier Drive des photos | |
| ID du dossier Drive `Miniatures` | |
| Phrases de passe ADMIN et STAFF | |

**La clé API n'est pas un secret fort** — elle protège d'un accès accidentel,
pas d'un attaquant déterminé. Elle ne doit pas être publiée, mais sa fuite ne
compromet ni les phrases de passe, ni le journal d'audit.

---

## Vérifications finales avant l'événement

| Contrôle | Attendu |
|---|---|
| `action=ping` | corps **non vide** |
| `action=sync&since=0` | tous les participants |
| `action=photo&id=<un numéro>` | une image, fichiers Drive restés privés |
| Modifier une cellule, relancer un sync | **cette ligne seule** |
| Réindexer sans rien changer | **0 ligne modifiée** |
| Terminal `ENTREE` | ni régime, ni note de sécurité |
| Latence d'une sync à vide | **< 3 s** (voir `docs/PERFORMANCE.md`) |
| Version déployée | correspond bien au dernier code collé |

La dernière ligne est celle qu'on oublie.
