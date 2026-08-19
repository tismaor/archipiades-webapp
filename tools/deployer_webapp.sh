#!/usr/bin/env bash
#
# deployer_webapp.sh — Publie webapp/ sur GitHub Pages.
#
# Le script fait surtout UNE chose que l'on oublie systématiquement à la main :
# il incrémente la version du cache du Service Worker. Sans cela, les téléphones
# continuent d'exécuter l'ancien code — donc d'appliquer d'anciennes règles
# d'accès — sans le moindre signe visible.
#
#   tools/deployer_webapp.sh ~/archipiades-webapp "correction du passback"
#
# Le premier argument est le dossier du dépôt Git local (créé à la première
# utilisation, voir docs/DEPLOIEMENT_WEBAPP.md).

set -euo pipefail

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$RACINE/webapp"
DEPOT="${1:-}"
MESSAGE="${2:-mise à jour de la Web App}"

if [ -z "$DEPOT" ]; then
  echo "Usage : tools/deployer_webapp.sh <dossier-du-depot> [message]" >&2
  exit 2
fi

if [ ! -d "$DEPOT/.git" ]; then
  echo "Erreur : $DEPOT n'est pas un dépôt Git." >&2
  echo "Créez-le d'abord — voir docs/DEPLOIEMENT_WEBAPP.md." >&2
  exit 2
fi

# ── 1. Refuser de publier du code cassé ──────────────────────────────────────
echo "Vérification de la syntaxe…"
for fichier in "$SOURCE"/*.js; do
  node --check "$fichier" || { echo "Syntaxe invalide : $fichier" >&2; exit 1; }
done
node "$RACINE/tools/test_rules.js" > /dev/null || {
  echo "Les tests du moteur de règles échouent — publication annulée." >&2
  exit 1
}
echo "  syntaxe et moteur de règles au vert"

# ── 2. Y a-t-il seulement quelque chose à publier ? ──────────────────────────
# On copie AVANT d'incrémenter : la version fait partie du fichier, donc la
# bousculer d'abord créerait un changement à tous les coups et rendrait cette
# vérification inutile.
echo "Copie vers $DEPOT…"
cp "$SOURCE"/index.html "$SOURCE"/*.js "$SOURCE"/manifest.json "$DEPOT/"

cd "$DEPOT"
# `git add` d'abord : `git diff` ignore les fichiers non suivis, et un premier
# déploiement paraîtrait donc « sans changement ».
git add -A
if git diff --cached --quiet; then
  echo "Aucun changement à publier."
  exit 0
fi

# ── 3. Incrémenter la version du cache ───────────────────────────────────────
# C'est LE geste que l'on oublie, et sa conséquence est invisible : un
# téléphone qui garde l'ancienne version des règles.
VERSION_ACTUELLE=$(grep -oE "archipiades-coque-v[0-9]+" "$SOURCE/sw.js" | head -1 | grep -oE "[0-9]+$")
VERSION_SUIVANTE=$((VERSION_ACTUELLE + 1))
sed -i '' "s/archipiades-coque-v${VERSION_ACTUELLE}/archipiades-coque-v${VERSION_SUIVANTE}/" "$SOURCE/sw.js"
cp "$SOURCE/sw.js" "$DEPOT/"
echo "  cache du Service Worker : v${VERSION_ACTUELLE} → v${VERSION_SUIVANTE}"

# ── 4. Publier ───────────────────────────────────────────────────────────────
git add -A
git commit -m "$MESSAGE (coque v${VERSION_SUIVANTE})"
git push

echo
echo "Publié. Comptez une à deux minutes avant que GitHub Pages ne serve la"
echo "nouvelle version."
echo
echo "Sur les téléphones : la mise à jour s'applique au prochain lancement."
echo "Pour forcer immédiatement — Chrome > Paramètres du site > Effacer les données."
