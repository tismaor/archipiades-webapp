# Déployer la Web App sur GitHub Pages

Comptez dix minutes la première fois, une commande ensuite.

---

## Ce qu'il faut savoir avant de commencer

### Le dépôt sera public

Sur un compte GitHub gratuit, **Pages n'est disponible que pour les dépôts
publics** (les dépôts privés exigent un abonnement Pro).

C'est sans conséquence ici, et c'est vérifié : **aucune URL ni clé API n'est
écrite dans le code**. Elles sont saisies sur chaque appareil et rangées dans le
stockage local du navigateur. Rendre public le dépôt expose la logique de
l'application, pas vos données ni vos accès.

Quelqu'un qui trouverait l'adresse de l'application ne pourrait rien en faire
sans la clé API — et l'onglet `Terminaux` refuse tout identifiant non déclaré.

> Si vous préférez malgré tout un dépôt privé, **Cloudflare Pages** et
> **Netlify** l'autorisent sur leur offre gratuite. La procédure ci-dessous
> reste valable à l'étape de publication près.

### Un dépôt distinct de celui du projet

La Web App va dans **son propre dépôt**, avec `index.html` à la racine. Pages
sert un dossier racine ou `/docs`, et le reste du projet — code Apps Script,
outils, documentation — n'a aucune raison d'être publié.

---

## Première mise en place

### 1. Créer le dépôt sur GitHub

Sur [github.com/new](https://github.com/new) :

| Champ | Valeur |
|---|---|
| Nom | `archipiades-webapp` |
| Visibilité | **Public** |
| Initialiser avec un README | **non coché** |

Ne créez ni README, ni `.gitignore`, ni licence : le dépôt doit rester vide
pour que le premier envoi passe sans conflit.

### 2. Préparer le dépôt en local

Remplacez `VOTRE-COMPTE` par votre identifiant GitHub.

```bash
mkdir -p ~/archipiades-webapp && cd ~/archipiades-webapp && git init -b main && git remote add origin https://github.com/VOTRE-COMPTE/archipiades-webapp.git
```

### 3. Premier déploiement

Depuis le dossier du projet :

```bash
tools/deployer_webapp.sh ~/archipiades-webapp "première publication"
```

GitHub demandera vos identifiants. **Le mot de passe du compte ne fonctionne
pas** : il faut un jeton d'accès personnel, à créer sur
[github.com/settings/tokens](https://github.com/settings/tokens) — *Generate new
token (classic)*, portée **`repo`**. Collez ce jeton à la place du mot de passe.

### 4. Activer Pages

Dans le dépôt sur GitHub : **Settings → Pages**

| Réglage | Valeur |
|---|---|
| Source | **Deploy from a branch** |
| Branch | **main** · dossier **/ (root)** |

Cliquez **Save**. Comptez une à deux minutes.

Votre adresse :

```
https://VOTRE-COMPTE.github.io/archipiades-webapp/
```

### 5. Vérifier

Ouvrez cette adresse **dans Chrome sur Android**, puis :

1. le cadenas HTTPS est présent ;
2. onglet **RÉGLAGES** → coller l'URL `/exec`, la clé API, l'identifiant du
   terminal (qui **doit exister dans l'onglet `Terminaux`**) ;
3. **ENREGISTRER ET SYNCHRONISER** → les participants descendent ;
4. onglet **SCAN** → **DÉMARRER LA LECTURE NFC** ;
5. menu Chrome → **Ajouter à l'écran d'accueil**.

Si le bouton NFC est remplacé par un bandeau orange, c'est que le navigateur
n'est pas Chrome pour Android — la lecture de bracelet n'y sera pas disponible.

---

## Mises à jour suivantes

```bash
tools/deployer_webapp.sh ~/archipiades-webapp "description de la correction"
```

Le script fait trois choses avant de publier :

1. il **refuse de publier du code cassé** — contrôle de syntaxe et exécution des
   28 tests du moteur de règles ;
2. il **incrémente la version du cache** du Service Worker ;
3. il ne commet rien s'il n'y a rien à publier.

Le deuxième point est le plus important. **C'est le geste que l'on oublie
toujours**, et sa conséquence est invisible : un téléphone continue d'exécuter
l'ancien code, donc d'appliquer d'anciennes règles d'accès, sans le moindre
signe. C'est le même piège que le déploiement figé d'Apps Script, une couche
plus bas — le script le traite pour vous.

Sur les téléphones, la nouvelle version s'applique **au prochain lancement**.
Pour forcer immédiatement : Chrome → Paramètres du site → Effacer les données.

---

## Avant l'événement

| À faire | Pourquoi |
|---|---|
| Déployer **au moins une semaine avant** | GitHub Pages peut mettre du temps la première fois |
| Installer l'application sur **chaque téléphone**, au briefing | l'ajout à l'écran d'accueil ne se fait pas dans la file d'attente |
| **Précharger les photos en Wi-Fi** sur chaque appareil | ~60 Mo pour 5 000 participants, impensable en 4G le jour J |
| Déclarer **un `terminal_id` distinct par téléphone** | sans cela, deux appareils écrasent leur `last_seen` et la supervision devient illisible |
| Faire un **essai en mode avion** avec chaque bénévole | c'est le mode qui compte réellement, et personne ne doit le découvrir le jour J |

---

## Si quelque chose ne va pas

| Symptôme | Cause la plus probable |
|---|---|
| Page blanche, erreur 404 | Pages pas encore actif, ou branche/dossier mal réglés dans Settings |
| « Réponse vide du serveur » | redirection 302 non suivie côté déploiement Apps Script — voir `docs/API.md` |
| « Réponse non JSON » | le déploiement n'est pas en « Exécuter en tant que moi » + « Accès : tout le monde » |
| `TERMINAL_INCONNU` | l'identifiant saisi n'existe pas dans l'onglet `Terminaux` |
| Pas de bouton NFC | navigateur autre que Chrome pour Android |
| Une correction ne prend pas effet | cache du Service Worker — le script gère la version, mais videz les données du site sur l'appareil récalcitrant |
| `git push` refusé | mot de passe employé au lieu d'un jeton d'accès personnel |
