# ARCHIPIADES — Système de contrôle d'accès événementiel

Contrôle d'accès par bracelets NTAG 13,56 MHz pour un événement sportif
associatif : plusieurs milliers de passages, contrôle des droits par statut,
décompte des repas, vérification visuelle par photo.

Le plan complet est dans `~/.claude/plans/mission-syst-me-wiggly-quokka.md`.

## Architecture

```
Google Sheets (source de vérité)
        │
Apps Script (API REST, clé partagée)
        │
   ┌────┴──────────────────────┐
Web App PWA          MALLETTE CYBERDECK
(Android, Web NFC)   routeur 4G
                       ├── MAÎTRE 7" paysage : PN532, règles, sync
                       │        │ TCP local
                       └── ESCLAVE 5" portrait : photo, clavier USB
```

## Principes non négociables

1. **Aucune décision d'accès ne dépend du réseau.** Chaque terminal décide en
   local en moins de 50 ms sur une copie de la base. La 4G sature toujours sur
   un site rassemblant plusieurs milliers de personnes.
2. **`Scans` fait foi pour les repas.** La colonne « Repas consommé(s) » n'est
   qu'un miroir recalculé par le serveur. Aucun terminal n'y écrit.
3. **On n'efface jamais un scan.** Une annulation ajoute une ligne référençant
   l'originale.
4. **La réindexation ne réhorodate que ce qui a changé.** Sinon, re-sync
   intégral des 5 000 lignes sur chaque mallette en pleine exploitation.
5. **Les rôles sont vérifiés côté serveur.** Le menu du terminal filtre
   l'affichage ; la barrière réelle est dans `autoriser_()`.
6. **La carte RFID n'est jamais un secret.** Un UID NTAG se clone pour trente
   euros. Elle ouvre la saisie, la phrase de passe authentifie.
7. **Le tactile est inerte par défaut**, activé seulement en « MODE SECOURS
   CLAVIER » quand le clavier physique ne répond plus.

## Charte d'écran

Terminal monochrome : fond noir, texte blanc, police à chasse fixe. **La couleur
est réservée à l'information critique** — vert autorisé, rouge refusé, orange
contrôle approfondi, jaune alerte médicale. Rien d'autre n'est coloré.

Seule exception : la photo d'identité reste en couleur, l'identification
visuelle y gagne trop.

## Structure

| Dossier | Contenu |
|---|---|
| `backend/` | Apps Script — à coller dans l'éditeur lié au classeur |
| `tools/` | `test_backend.js`, `test_rules.js`, `valider_deploiement.js`, `generate_test_data.py`, `prepare_sd.py` |
| `docs/` | `INSTALLATION.md`, `API.md`, `SCHEMA.md`, `WEBAPP.md`, `DEPLOIEMENT_WEBAPP.md`, `PERFORMANCE.md`, `REDEPLOIEMENT.md` |
| `webapp/` | Web App PWA — `rules.js` est le moteur de décision partagé |

## Commandes

```bash
node tools/test_backend.js
```

```bash
node tools/test_rules.js
```

```bash
node tools/valider_deploiement.js --url <URL/exec> --cle <CLE>
```

```bash
python3 tools/prepare_sd.py --url <URL/exec> --cle <CLE> --terminal DECK-01 --sortie ./sd
```

```bash
tools/deployer_webapp.sh ~/archipiades-webapp "description de la modification"
```

## Conventions

- **Code et commentaires en français**, comme le reste du projet.
- Apps Script : lecture et écriture **en bloc** (`getValues`/`setValues`),
  jamais cellule par cellule ; toute écriture concurrente via `avecVerrou_()`.
- Les fichiers `.gs` partagent une portée globale unique — attention aux
  collisions de noms entre modules.
- Les helpers internes sont suffixés `_` (convention Apps Script : ils ne sont
  pas exposés comme points d'entrée).

## Pièges connus

- **Redirection 302** : Apps Script ne renvoie jamais les données directement.
  Un corps vide côté ESP32 vient de là dans la quasi-totalité des cas — voir
  `docs/API.md`. `STRICT` suffit en GET, `FORCE` est nécessaire en POST.
  Re-POSTer sur la cible du 302 donne un **405 + 8 ko de HTML**.
- **Un déploiement est figé sur une version.** Coller du code dans l'éditeur ne
  change rien à ce que sert l'URL `/exec`. Il faut `Gérer les déploiements` >
  modifier l'existant > `Nouvelle version` — **modifier, jamais recréer**, sinon
  l'URL change et toutes les mallettes sont à reconfigurer. Symptôme : on
  corrige, on recolle, et rien ne change.
- **Le coût d'une requête tient au nombre d'onglets lus, pas au volume.** Lire
  2 000 participants ne coûte que 0,7 s de plus qu'une sync à vide. Optimiser
  ici, c'est réduire les accès — voir `docs/PERFORMANCE.md`.
- **`onEdit` n'attrape pas tout** : ni les imports, ni les écritures d'un autre
  script. D'où la réindexation et le contrôle horaire.
- **GPIO Sunton** : le panneau RGB consomme presque tous les pins. Seuls
  IO17/IO18 sont libres, et le PN532 les prend. Le port USB-C est un pont
  CH340C, pas de l'USB natif — un clavier branché dessus ne sera jamais vu.
- **Web NFC ne lit que le NDEF** : cartes de transport, badges MIFARE et NTAG
  non formatées sont invisibles au navigateur, alors que NFC Tools les lit.
  Exiger des bracelets **pré-formatés NDEF**. Ne concerne pas le PN532.
- **CGNAT 4G** : les mallettes n'ont pas d'IP publique et ne peuvent pas se
  joindre entre elles. Toute supervision passe par le backend.
- **CORS** : un POST en `application/json` déclenche un preflight OPTIONS
  auquel Apps Script répond **500**. La Web App poste en `text/plain`.
  Ne concerne pas l'ESP32.
- **Trois couches de cache peuvent servir du code périmé** : le déploiement
  Apps Script figé sur une version, le Service Worker, et le cache HTTP du
  navigateur. Le symptôme est toujours le même — on corrige, et rien ne change.
- **Apps Script échoue transitoirement ~1 fois sur 5** : page HTML au lieu du
  JSON, sans cause côté client. Tout client doit réessayer 2 fois — la Web App
  le fait, le firmware devra le faire.
- **`lireObjets_()` écarte les lignes vides**, son index ne correspond donc pas
  au numéro de ligne du classeur. Pour écrire dans une ligne, passer par
  `lireBloc_()`.
- **File d'envoi ≠ historique** : la file se vide dès l'accusé de réception.
  L'anti-passback lit l'historique, sinon il ne fonctionnerait qu'hors ligne.

## État

- ✅ **Étape 1** — backend Apps Script : 73 tests locaux + 39 sur déploiement
  réel. Sync à vide à ~2,5 s.
- ✅ **Étape 2** — Web App PWA + `prepare_sd.py` : 28 tests du moteur de règles,
  validée en navigateur (sync 2004 lignes, passback, hors ligne, photos).
- ⬜ Étape 3 — socle firmware maître
- ⬜ Étape 4 — lecteur PN532
- ⬜ Étape 5 — réseau 4G, sync, FreeRTOS
- ⬜ Étape 6 — second écran portrait, liaison, clavier
- ⬜ Étape 7 — modes STAFF/ADMIN sur deck
- ⬜ Étape 8 — durcissement terrain
