# API — Backend Apps Script

Toutes les requêtes portent la clé partagée `key`. Les actions privilégiées
exigent en plus un `jeton` de session obtenu par `admin_login`.

Réponse toujours en JSON, avec `ok: true|false`. En cas d'erreur, `erreur`
porte le message et `code` un identifiant stable exploitable par le client.

---

## ⚠️ Le piège n°1 : la redirection 302

Une URL de déploiement `script.google.com/macros/s/…` **ne renvoie jamais les
données directement** : elle répond par un **302** vers
`script.googleusercontent.com`.

Sans suivi de redirection, le client reçoit **un corps vide avec un code de
retour d'apparence normale**. C'est le symptôme le plus trompeur du projet.

**Si une réponse est vide, vérifiez cela avant toute autre hypothèse.**

```cpp
WiFiClientSecure client;
client.setInsecure();          // ou CA Google GTS Root R1 embarquée
HTTPClient http;
http.setTimeout(8000);

// GET /sync : STRICT suffit (le RFC ne fait suivre que GET et HEAD)
http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);

// POST /log_scan : STRICT ne suit PAS la redirection pour un POST, les scans
// partiraient dans le vide. Apps Script attend que la cible du 302 soit
// consommée en GET :
http.setFollowRedirects(HTTPC_FORCE_FOLLOW_REDIRECTS);
```

Deux corollaires :

- le déploiement doit être **« Exécuter en tant que moi »** et
  **« Accès : tout le monde »**. Sinon le 302 pointe vers
  `accounts.google.com` et aucun réglage de redirection ne sauvera la requête ;
- la cible de la redirection est un **hôte différent**, d'où `WiFiClientSecure`
  et non `WiFiClient`.

### Mesures relevées sur le déploiement réel

| Requête | Suivi | Résultat |
|---|---|---|
| `GET ?action=ping` | aucun | **302, 0 octet** |
| `GET ?action=ping` | suivi | 200, corps JSON |
| `POST` | aucun | **302, 0 octet** |
| `POST` | suivi **en GET** | 200, corps JSON — le corps POST a bien été traité |
| `POST` | suivi **en POST** | **405**, page HTML d'erreur de 7,9 ko |

La dernière ligne est le piège dans le piège : **re-POSTer sur la cible du 302
échoue**. Apps Script traite le POST au premier appel et ne sert que le
*résultat* sur l'URL de redirection, qui n'accepte que GET. C'est exactement ce
que fait `HTTPC_FORCE_FOLLOW_REDIRECTS`, et c'est pourquoi `STRICT` — qui ne
suit rien pour un POST — ne convient pas ici.

Un client qui reçoit une page HTML de 7,9 ko au lieu de JSON re-POSTe sur la
redirection.

### Reproduire ces tests

```bash
node tools/valider_deploiement.js --url <URL/exec> --cle <CLE>
```

En ligne de commande, attention au piège `curl` : **`-X POST` combiné à `-L`
force curl à re-POSTer** sur la redirection et renvoie 405. Il faut employer
`-d` seul, qui laisse curl basculer en GET selon le RFC :

```bash
curl -sL -H 'Content-Type: application/json' -d '{"action":"ping","key":"CLE"}' <URL/exec>
```

---

## Actions ouvertes (clé partagée uniquement)

### `ping`
Test de vie. `GET ?action=ping&key=…`
```json
{ "ok": true, "server_time": 1755500000000, "version_api": 1 }
```

### `sync`
`GET ?action=sync&key=…&terminal=DECK-01&since=<ms>[&apres=<numero>][&limite=500][&refs=<version>]`

Le terminal envoie le plus grand `maj` qu'il connaît ; le serveur renvoie ce
qui a changé depuis.

| Paramètre | Rôle |
|---|---|
| `since` | dernier `_updated_at` connu du terminal ; `0` = tout |
| `apres` | dernier numéro reçu — **obligatoire pour paginer correctement** |
| `limite` | taille de page (défaut 500, plafond 2000) |
| `refs` | version des tables de référence détenue par le terminal |

```json
{
  "ok": true,
  "server_time": 1755500000000,
  "terminal_id": "DECK-01",
  "point_controle": "ENTREE",
  "profil_donnees": "ENTREE",
  "sync_interval_s": 15,
  "supervision_active": false,
  "participants": [
    { "numero": "0001A001", "maj": 1755499000000, "nom": "Durand",
      "prenom": "Alice", "statut": "Sportif", "commentaire": "Épilepsie",
      "actif": true, "photo": true }
  ],
  "bracelets": [
    { "uid": "04A1B2C3D4E5F6", "numero": "0001A001", "statut": "ACTIF",
      "maj": 1755499000000 }
  ],
  "commandes": [],
  "suite": false,
  "refs_version": "a1b2c3d4e5f6",
  "refs": { "droits": {}, "formules": {}, "services": [], "config": {} }
}
```

**Pagination.** Si `suite: true`, rappeler avec `since = since_suivant` **et**
`apres = apres_suivant`. La clé est composite car un collage de 500 lignes leur
donne le même horodatage : paginer sur le seul `since` sauterait des lignes ou
boucleraient indéfiniment.

**Champs reçus selon le profil du terminal** (colonne `profil_donnees` de
l'onglet `Terminaux`) :

| Profil | Champs supplémentaires |
|---|---|
| `ENTREE` | — |
| `REPAS` | `formule`, `repas_conso`, `regime` |
| `SPORT` | `sports`, `ecole` |
| `SECURITE` | `note_secu` |
| `PC_ORGA` | tous les précédents |

`numero`, `nom`, `prenom`, `statut`, `commentaire`, `actif` et `photo` sont
toujours transmis. **La date de naissance, l'email et le téléphone ne sortent
jamais du backend**, quel que soit le profil.

### `photo`
`GET ?action=photo&key=…&id=0001A001`

Renvoie la miniature en base64. Les fichiers Drive restent **privés** : le
script les lit avec ses propres droits, aucun partage public n'est nécessaire.

```json
{ "ok": true, "numero": "0001A001", "mime": "image/jpeg",
  "taille": 12480, "data_base64": "…" }
```

### `log_scan`
`POST` — lot de scans, **idempotent par `scan_id`**. Un lot rejoué après une
coupure réseau ne consomme pas deux fois un repas.

```json
{
  "action": "log_scan", "key": "…", "terminal": "DECK-01",
  "scans": [
    { "scan_id": "<uuid généré par le terminal>", "ts_terminal": 1755499000000,
      "uid": "04A1B2C3D4E5F6", "numero": "0001A001",
      "decision": "ACCES_AUTORISE", "motif": "", "service": 0 }
  ]
}
```
```json
{ "ok": true, "enregistres": 1, "ignores": 0, "server_time": 1755500000000 }
```

`ignores` compte les rejeux : c'est une information normale, pas une erreur.

**Décisions admises :** `ACCES_AUTORISE`, `NON_RECONNU`, `ACCES_SUSPENDU`,
`ZONE_NON_AUTORISEE`, `PASSBACK_SUSPECTE`, `POSTE_VERROUILLE`, `REPAS_SERVI`,
`REPAS_DEJA_CONSOMME`, `REPAS_HORS_SERVICE`, `REPAS_NON_DU`, `ANNULATION`.

### `ack_command`
`POST { action, key, commande_id, resultat }` — le terminal confirme
l'application. Idempotent : `deja_traitee: true` sur un rejeu.

### `admin_login`
`POST { action, key, uid_carte, phrase_de_passe, terminal_id }`

```json
{ "ok": true, "jeton": "…", "role": "ADMIN", "nom": "Mathis",
  "expire": 1755500900000, "operations": ["…"], "inactivite_s": 180 }
```

En cas d'échec, le message est **volontairement identique** que la carte soit
inconnue ou la phrase erronée : il ne doit pas indiquer laquelle des deux est
en cause.

---

## Actions privilégiées (jeton obligatoire)

Le rôle est vérifié **côté serveur** dans tous les cas. Le menu du terminal
filtre l'affichage, mais c'est ici que se joue la barrière : une requête
forgée hors de l'interface avec un jeton STAFF est refusée
(`code: "ROLE_INSUFFISANT"`).

| Action | Rôle requis | Effet |
|---|---|---|
| `update_status` | STAFF | associe / réassocie / suspend un bracelet ; l'ancien bracelet du participant passe automatiquement en `PERDU` |
| `ecrire_note` | STAFF | ajoute une `Note de sécurité` datée et attribuée |
| `rechercher` | STAFF | recherche par nom, école ou numéro (`&q=`) |
| `annuler_scan` | ADMIN | **ajoute** une ligne d'annulation, ne supprime jamais ; recrédite le repas |
| `verrouillage` | ADMIN | refus général sauf Staff, **sans libération automatique** |
| `supervision` | ADMIN | derniers scans d'un deck (`&cible=`), avec `age_donnee_s` |
| `flotte` | ADMIN | tableau de bord : retard de sync, postes muets |
| `admin_command` | selon `type` | dépose une commande relevée à la sync suivante |

---

## Codes d'erreur

| Code | Signification |
|---|---|
| `CLE_INVALIDE` | clé partagée absente ou fausse |
| `TERMINAL_INCONNU` | `terminal_id` absent de l'onglet `Terminaux` |
| `TERMINAL_DESACTIVE` | colonne `actif` à FAUX |
| `SESSION_EXPIREE` | jeton absent, inconnu ou périmé |
| `ROLE_INSUFFISANT` | opération hors du rôle de la session |
| `PARTICIPANT_INCONNU` | numéro introuvable |
| `SCAN_INTROUVABLE` | `scan_id` inconnu |
| `COMMANDE_INTROUVABLE` | `commande_id` inconnu |
| `PHOTO_INTROUVABLE` | ni miniature ni photo d'origine accessible |
| `ERREUR_SERVEUR` | exception non prévue, détail dans `erreur` |

---

## Ce qui est vérifié, et ce qui ne l'est pas

`node tools/test_backend.js` simule les API Google et couvre **69 tests** :
delta et pagination, profils de données, idempotence des scans, projection des
repas, rôles STAFF/ADMIN, réassociation, commandes, supervision.

Trois choses ne peuvent pas être testées hors de Google et **doivent être
vérifiées après le premier déploiement** :

1. **la redirection 302** — premier test à faire : un `GET ?action=ping` doit
   renvoyer un corps non vide ;
2. **l'accès Drive** du proxy photo ;
3. **les déclencheurs** `onEdit` et horaire, ainsi que la concurrence réelle
   entre plusieurs terminaux.
