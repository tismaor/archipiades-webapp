# Performance mesurée du backend

Mesures relevées sur un déploiement réel, classeur de **2 004 participants**,
depuis une connexion fixe. Elles conditionnent directement le budget temps du
firmware ESP32 (étape 5).

---

## Le résultat contre-intuitif

| Appel | Temps |
|---|---|
| `ping` (socle Apps Script seul) | **1,6 s** |
| Clé invalide (sort avant tout accès au classeur) | 1,8 s |
| `sync` terminal inconnu (lit `Terminaux`, puis sort) | 2,5 s |
| `sync` à vide | **5,6 s** |
| `sync` complète, 2 004 lignes | 6,4 s |

**Lire les 2 004 participants ne coûte que 0,7 s de plus qu'une sync à vide.**

Le coût d'une synchronisation ne tient donc pas au volume de données, mais au
**nombre d'onglets touchés** : chaque accès coûte environ une demi-seconde,
qu'il porte sur quatre lignes ou sur deux mille.

Deux conséquences pour tout le projet :

1. optimiser, ici, c'est **réduire le nombre d'accès**, jamais compresser les
   données ;
2. le socle Apps Script coûte à lui seul 1,6 s, redirection 302 comprise.
   **Aucune requête ne descendra sous cette barre**, quoi qu'on fasse.

---

## Optimisations appliquées

Une sync à vide effectuait 6 lectures et 2 écritures pour ne rien renvoyer.

| Mesure | Effet |
|---|---|
| Cache 60 s des tables de référence (`Droits`, `Formules`, `Services`, `Config`) | −4 lectures |
| Cache 30 s de la ligne du terminal | −1 lecture |
| Écritures `last_seen` + `derniere_version_base` groupées (colonnes adjacentes) | 2 écritures → 1 |
| Court-circuit des commandes via une propriété de script | −1 lecture en temps normal |

### Résultat mesuré

| | Sync à vide |
|---|---|
| Avant | 3,76 · 3,93 · 4,45 · 5,27 · 5,91 s |
| **Après** | **1,95 · 2,28 · 2,43 · 2,54 · 3,05 · 3,56 s** |

Médiane divisée par deux, et l'on approche le plancher incompressible de 1,6 s.
La marge sur le timeout de 8 s est désormais confortable, y compris sur une 4G
dégradée.

> Ces chiffres n'ont bougé qu'après **publication d'une nouvelle version du
> déploiement**. Une première série de mesures, prise juste après avoir collé le
> code, ne montrait aucune amélioration — l'URL `/exec` servait toujours
> l'ancien instantané. Voir `docs/REDEPLOIEMENT.md`.

### Le risque introduit, et comment il est tenu

Un cache sur la matrice `Droits` pourrait faire appliquer d'anciennes règles
d'accès **sans le moindre signe visible**. Trois protections :

- **invalidation immédiate** par `onEdit` sur les quatre onglets concernés ;
- **expiration à 60 s** comme filet pour ce qu'`onEdit` ne voit pas ;
- **trois tests** dans `tools/test_backend.js` qui vérifient l'invalidation au
  lieu de la supposer.

Délai réel de propagation d'un changement de droits : immédiat en édition
manuelle, au pire 60 s + un cycle de sync sinon.

Ni les participants ni les bracelets ne sont mis en cache.

---

## ⚠️ Apps Script échoue de façon transitoire, environ une fois sur cinq

Mesure sur le déploiement réel, dix requêtes `sync` consécutives et identiques :

| Résultat | Occurrences |
|---|---|
| JSON attendu | **8** |
| Page HTML d'erreur (7 911 octets) | **2** |
| Corps vide | 0 |

Aucune cause côté client : la même requête, à la seconde près, réussit ou
échoue. Le service renvoie épisodiquement sa page d'erreur générique au lieu du
JSON.

**Tout client DOIT réessayer.** Sans cela, un agent voit « échec de
synchronisation » plusieurs fois par heure et conclut à une panne, alors que la
requête suivante passera.

| Nombre d'essais | Probabilité d'échec visible |
|---|---|
| 1 (aucun nouvel essai) | ~20 % |
| 2 | ~4 % |
| **3** (retenu) | **< 1 %** |

La Web App applique trois tentatives, espacées de 1,2 s puis 3 s. **Le firmware
ESP32 devra faire de même** — c'est une contrainte de conception de l'étape 5,
pas un raffinement.

Le rejeu est sans danger : `log_scan` est idempotent par `scan_id`, et `sync`
est une lecture pure.

---

## Budget temps du firmware (étape 5)

| Paramètre | Valeur | Justification |
|---|---|---|
| `http_timeout_ms` | **8 000** | couvre le pire cas mesuré avec de la marge |
| Nouvelles tentatives | **2** | ~20 % d'échecs transitoires côté Apps Script (voir ci-dessus) |
| Cadence du point critique | 15 s | laisse ~10 s de battement après une sync |
| Sync simultanées | **une seule** | un tick qui arrive pendant une sync en cours est ignoré, jamais empilé |
| Backoff sur échec | exponentiel, plafond 5 min | |

La règle du « une seule sync en vol » n'est pas un raffinement : avec 4 à 6 s de
réponse pour 15 s de cadence, un empilement suffirait à écrouler la boucle.

**Aucune de ces requêtes ne doit se trouver sur le chemin d'un scan.** La
décision se prend en local, en moins de 50 ms, sur la copie en PSRAM. Le réseau
vit sur le cœur 0, le scan sur le cœur 1.

---

## Volumétrie

| Mesure | Valeur |
|---|---|
| Réponse `sync` pour 2 000 participants | **273 ko** |
| Extrapolation à 5 000 participants | ~680 ko |
| Pagination testée | 3 pages, 2 004 lignes, **0 doublon** |

Ces 273 ko confirment empiriquement une décision du plan : **l'ESP32 ne fait
jamais de `since=0`**. Sa base initiale arrive par la microSD
(`database.csv` généré par `prepare_sd.py`), et il ne consomme ensuite que des
deltas de quelques kilo-octets.

La pagination utilise une **clé composite `(_updated_at, numéro)`** : un collage
de 500 lignes leur donne le même horodatage à la milliseconde, et paginer sur le
seul horodatage sauterait des lignes ou boucleraient indéfiniment. Vérifié en
conditions réelles.

---

## Quotas Apps Script

| Charge | Valeur |
|---|---|
| 1 deck à 15 s | 4 req/min |
| 1 deck en supervision (3 s) | 20 req/min, borné à 10 min |
| 8 decks à 180 s + 1 à 15 s | ~7 req/min |

Très en deçà des limites. Le facteur limitant est **la latence**, pas le quota.

---

## Reproduire les mesures

```bash
node tools/valider_deploiement.js --url <URL/exec> --cle <CLE>
```

Pour chronométrer une sync à vide :

```bash
curl -sL -o /dev/null -w "%{time_total}s\n" "<URL>?action=sync&key=<CLE>&terminal=DECK-01&since=9999999999999"
```

> **Avant de conclure quoi que ce soit d'une mesure**, vérifier que le
> déploiement sert bien le dernier code : une URL `/exec` est figée sur une
> version tant qu'on n'en publie pas une nouvelle. Voir `docs/REDEPLOIEMENT.md`.
