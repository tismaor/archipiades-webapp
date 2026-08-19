# Web App PWA — installation et exploitation

Application de contrôle d'accès pour téléphones. Elle décide **en local**, sur
une copie de la base : rien de ce que fait un agent devant la file ne dépend
de la 4G.

---

## ⚠️ Deux contraintes non négociables

### 1. HTTPS obligatoire

Web NFC, le Service Worker et l'installation PWA **exigent une origine
sécurisée**. Ouvrir `index.html` depuis un fichier local ne fonctionnera pas.

| Hébergement | Verdict |
|---|---|
| **GitHub Pages** | recommandé — gratuit, HTTPS d'office, mise à jour par simple push |
| Netlify, Cloudflare Pages | équivalents |
| `http://localhost` | valable pour la mise au point uniquement |
| `file://` | **ne fonctionne pas** |
| Serveur HTTP simple sur le réseau local | **ne fonctionne pas** (pas de HTTPS) |

### 2. Web NFC n'existe que sur Chrome pour Android

Ce n'est pas une limite de l'application mais du navigateur. Sur iPhone, ou
dans Firefox et Safari, la recherche manuelle reste pleinement fonctionnelle,
mais **il n'y aura pas de lecture de bracelet**.

**Prévoyez des téléphones Android aux postes NFC.** L'application le signale
d'elle-même par un bandeau explicite quand l'API est absente.

### 3. Web NFC ne lit QUE les puces au format NDEF

C'est la limite la plus surprenante, et elle a une conséquence directe sur
l'achat des bracelets.

| Puce | Lisible par la Web App ? |
|---|---|
| NTAG 213/215/216 **formatée NDEF** | ✅ |
| NTAG **non formatée** (sortie d'usine, selon le lot) | ❌ |
| Carte de transport, badge MIFARE Classic | ❌ |
| Carte bancaire | ❌ (et UID souvent aléatoire) |

Une application native comme **NFC Tools lit ces puces sans difficulté** — elle
accède à l'UID sous la couche NDEF, ce que le navigateur interdit. Le fait
qu'une carte fonctionne dans NFC Tools ne dit donc **rien** de sa compatibilité
avec la Web App.

> **À vérifier dès réception des bracelets** : scannez-en un avec la Web App.
> S'il n'est pas reconnu alors que NFC Tools le lit, le lot n'est pas formaté
> NDEF. NFC Tools permet de les formater — mais sur plusieurs milliers de
> bracelets, c'est une opération à prévoir et à chiffrer. **Exigez des
> bracelets pré-formatés NDEF à la commande.**
>
> Cette limite ne concerne pas les Cyberdecks : le PN532 lit l'UID au niveau
> ISO 14443, sans passer par NDEF.

### La saisie manuelle, filet permanent

L'écran de scan propose toujours **SAISIE MANUELLE D'UN UID**. Elle sert pour un
bracelet abîmé, une puce non compatible NDEF, ou un téléphone sans Web NFC.
L'UID s'y colle dans n'importe quelle forme — avec deux-points, tirets, espaces,
en minuscules — et le passage est enregistré exactement comme un scan.

---

## Mise en service

1. **Publier le dossier `webapp/`** sur un hébergement HTTPS.
2. Ouvrir l'adresse dans **Chrome sur Android**.
3. Menu du navigateur → **Ajouter à l'écran d'accueil** (l'application passe
   alors en plein écran, sans barre d'adresse).
4. Onglet **RÉGLAGES** : coller l'URL `/exec`, la clé API, et l'identifiant du
   terminal — qui **doit exister dans l'onglet `Terminaux`** du classeur.
5. **ENREGISTRER ET SYNCHRONISER**. La base descend en quelques secondes.
6. Onglet **SCAN** → **DÉMARRER LA LECTURE NFC** (le navigateur exige un geste
   de l'utilisateur, la lecture ne peut pas démarrer toute seule).

### Préchargement des photos

À faire **au briefing, en Wi-Fi** : bouton **PRÉCHARGER LES PHOTOS**.
Environ 12 ko par participant, soit ~60 Mo pour 5 000. Une fois en cache, les
photos s'affichent hors ligne. En 4G, seules les photos manquantes sont
récupérées à la volée.

---

## Ce que voit l'agent

Fond noir, texte blanc, police à chasse fixe. **La couleur ne sert qu'à
l'information critique** : un agent qui voit du rouge sait immédiatement que
quelque chose ne va pas, sans rien lire.

| État | Couleur |
|---|---|
| ACCÈS AUTORISÉ | vert |
| NON RECONNU · ACCÈS SUSPENDU · ZONE NON AUTORISÉE · POSTE VERROUILLÉ | rouge |
| PASSBACK SUSPECTÉ | orange, **écran bloquant** |
| Alerte médicale (`Commentaire Participant`) | bandeau jaune **séparé** |
| Point repas | monochrome, sauf repas déjà consommé (orange) |

**La miniature est affichée d'office.** Une vérification visuelle qui exigerait
un appui supplémentaire n'est pas faite sous la pression de la file.

**L'alerte médicale ne peut pas être masquée** par la couleur d'état : un badge
peut être parfaitement valide *et* signaler un risque d'épilepsie.

### L'écran bloquant du passback

Un re-scan rapide affiche un écran orange qui **exige un acquittement** — un
contrôle approfondi ne doit pas pouvoir être escamoté en laissant la file
avancer.

Deux échappatoires, pour qu'un poste ne soit jamais bloqué indéfiniment :
présenter **un autre bracelet** passe à la personne suivante, et faute
d'acquittement l'écran se libère seul au bout de 60 secondes — **en journalisant
le déblocage comme une expiration**, distinct d'un contrôle réellement effectué.

---

## Verrou des réglages

L'onglet **RÉGLAGES** n'est accessible qu'après présentation d'une carte
**STAFF ou ADMIN** — celles déclarées dans l'onglet `Comptes` du classeur.
Pas de phrase de passe : l'ouverture doit être rapide, et le vol d'un bracelet
staff pour aller trafiquer des réglages n'est pas un scénario crédible.

Le déverrouillage dure **5 minutes**, puis se referme seul. Un bandeau indique
qui a ouvert la session et le temps restant.

### Deux points à connaître

**Tant que l'application n'est pas configurée, le verrou est inactif.** C'est
dans les réglages que l'on saisit l'URL et la clé ; sur un téléphone neuf,
aucune carte n'est connue. Verrouiller sans condition rendrait l'application
impossible à installer. Le verrou s'active dès la première synchronisation
réussie.

**Sur un appareil sans Web NFC** (iPhone, Firefox…), un champ de saisie
manuelle de l'UID remplace le bouton de scan — sinon les réglages y seraient
définitivement inaccessibles.

### Ce que ce verrou protège, et ce qu'il ne protège pas

Il empêche **la fausse manœuvre** : un bénévole qui explore l'application et
efface la base locale ou change l'identifiant du terminal.

Il n'empêche pas une intrusion déterminée. Un UID NTAG n'a jamais été un
secret : il se lit avec n'importe quel téléphone en approchant la carte, et la
liste des UID autorisés est présente sur chaque terminal. C'est un arbitrage
assumé en faveur de la rapidité — **les opérations réellement sensibles
(annuler un scan, verrouiller un poste, superviser un deck) restent vérifiées
côté serveur, avec phrase de passe et jeton de session**.

---

## Fonctionnement hors ligne

- La décision est **toujours** locale : la base entière est en mémoire.
- Chaque scan est écrit dans IndexedDB **avant** tout appel réseau. Il survit à
  la fermeture de l'onglet, à la coupure réseau et au redémarrage du téléphone.
- Le bandeau supérieur indique en permanence le nombre de scans en attente.
- Au retour du réseau, la file se vide seule. Un scan n'est retiré qu'après
  confirmation du serveur, et l'idempotence par `scan_id` rend un rejeu
  totalement inoffensif.

### Historique et file d'envoi sont deux choses distinctes

La file d'envoi se vide dès l'accusé de réception ; l'**historique** des scans
récents est conservé à part, six heures durant. Sans cette séparation,
l'anti-passback perdrait la mémoire des passages dès que le réseau fonctionne
— il n'aurait fonctionné qu'hors ligne.

---

## ⚠️ Après chaque modification du code

Le Service Worker met la coque applicative en cache. **Incrémentez `CACHE` dans
`webapp/sw.js`** à chaque publication, sinon un téléphone peut continuer
d'exécuter l'ancien code — donc d'appliquer d'anciennes règles d'accès — sans
que personne ne s'en aperçoive.

C'est le même piège que le déploiement figé d'Apps Script, une couche plus bas.

Pour forcer la mise à jour sur un téléphone récalcitrant : Chrome → Paramètres
du site → Effacer les données.

---

## `prepare_sd.py` — cartes microSD et miniatures

```bash
python3 tools/prepare_sd.py --url <URL/exec> --cle <CLE> \
    --terminal DECK-01 --sortie ./sd_deck01
```

Produit, depuis une seule source :

| Sortie | Contenu |
|---|---|
| `photos/<numero>.jpg` | 800×480, **portrait déjà pivoté**, pour l'écran esclave |
| `miniatures/<numero>.jpg` | 200×260, pour la Web App |
| `database.csv`, `bracelets.csv` | base initiale de la mallette |
| `refs.json`, `curseur.json` | droits, formules, services, point de départ du delta |
| `rapport_photos.txt` | photos absentes, illisibles ou de résolution insuffisante |

**Une carte par profil de terminal.** Le paramètre `--terminal` détermine les
champs écrits : un deck d'entrée n'embarque pas les données repas. La
minimisation des données se propage jusqu'à la carte SD.

**Le pivotement est fait ici, pas sur l'ESP32** : faire tourner un panneau RGB
de 90° impose une transformation par pixel, coûteuse en CPU et en RAM. Le
`--rotation` (90 ou 270) dépend du sens de montage physique de l'écran.

**Les photos ne sont jamais agrandies** au-delà de leur résolution native : un
visage flou plein cadre rendrait le contrôle visuel inutile. Le rapport liste
les cas concernés.

### Durée

Environ **5 secondes par photo** côté Apps Script. Le script télécharge donc en
parallèle (`--parallele`, 6 par défaut) : comptez **~35 minutes pour 5 000
photos**, contre plus de sept heures en séquentiel.

Une exécution interrompue **reprend où elle s'est arrêtée** — les photos déjà
produites sont ignorées. `--refaire` force le retraitement complet.

### Certificats TLS sur macOS

Le Python de python.org n'utilise pas le magasin de certificats du système. En
cas d'échec `CERTIFICATE_VERIFY_FAILED` :

```bash
python3 -m pip install --user certifi
```

---

## Contrôles de validation

| Test | Attendu |
|---|---|
| Configurer puis synchroniser | tous les participants en quelques secondes |
| Scanner un bracelet valide | vert, photo affichée d'office, < 200 ms |
| Scanner deux fois de suite | orange bloquant, compte à rebours visible |
| Participant avec commentaire médical | bandeau jaune **en plus** de la couleur d'état |
| Mode avion, 20 scans | bandeau « 20 en attente », aucune décision perdue |
| Retour du réseau | file vidée seule, lignes présentes dans `Scans` |
| Mode avion après préchargement | photos toujours affichées |
