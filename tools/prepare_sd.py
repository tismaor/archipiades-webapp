#!/usr/bin/env python3
"""
prepare_sd.py — Prépare la microSD des mallettes et les miniatures de la Web App.

Une seule source, deux rendus :

  photos_deck/<numero>.jpg   800x480, portrait DÉJÀ PIVOTÉ, pour l'écran esclave
  miniatures/<numero>.jpg    200x260, pour la Web App

Pourquoi pivoter ici et pas sur l'ESP32 : faire tourner un panneau RGB de 90°
dans LovyanGFX impose une transformation par pixel, coûteuse en CPU et en RAM.
Le coût est déplacé sur un poste de bureau, une fois pour toutes, avant
l'événement — l'esclave se contente alors d'un drawJpgFile() sans rotation.

Le script n'a besoin d'AUCUN accès Drive : il passe par le proxy photo du
backend, avec la même clé API que les terminaux.

    python3 tools/prepare_sd.py --url <URL/exec> --cle <CLE> --sortie ./sd

Dépendances : Pillow, requests
    python3 -m pip install --user Pillow requests
"""

import argparse
import concurrent.futures
import csv
import json
import os
import ssl
import sys
import time
import urllib.parse
import urllib.request

try:
    from PIL import Image, ImageOps
except ImportError:
    sys.exit("Pillow est requis :  python3 -m pip install --user Pillow")


def contexte_ssl():
    """
    Contexte TLS utilisable sur toutes les installations Python.

    Le Python distribué par python.org sur macOS n'utilise pas le magasin de
    certificats du système : sans cela, toute requête HTTPS échoue sur
    « CERTIFICATE_VERIFY_FAILED », y compris vers Google. On s'appuie sur
    certifi s'il est présent, sinon sur le magasin par défaut.
    """
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()

# Résolution native du panneau de l'écran esclave (5\" ou 7\" Sunton).
PANNEAU_LARGEUR = 800
PANNEAU_HAUTEUR = 480

# Le rendu portrait vu par l'agent, avant rotation.
PORTRAIT_LARGEUR = PANNEAU_HAUTEUR   # 480
PORTRAIT_HAUTEUR = PANNEAU_LARGEUR   # 800

MINIATURE = (200, 260)

FOND = (24, 24, 24)      # gris très sombre, cohérent avec la charte terminal


# ───────────────────────────── Accès au backend ─────────────────────────────

_CONTEXTE = None


def appeler(url_base, cle, params, delai=30):
    """GET sur l'API. La redirection 302 d'Apps Script est suivie par urllib."""
    global _CONTEXTE
    if _CONTEXTE is None:
        _CONTEXTE = contexte_ssl()

    params = dict(params)
    params["key"] = cle
    url = url_base + "?" + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(url, timeout=delai, context=_CONTEXTE) as reponse:
            brut = reponse.read().decode("utf-8")
    except urllib.error.URLError as erreur:
        if "CERTIFICATE_VERIFY_FAILED" in str(erreur):
            raise RuntimeError(
                "Vérification du certificat TLS impossible.\n"
                "  Votre Python n'a pas accès au magasin de certificats. Corrigez par :\n"
                "      python3 -m pip install --user certifi\n"
                "  ou, sur macOS avec le Python de python.org :\n"
                "      open /Applications/Python*/Install\\\\ Certificates.command"
            ) from erreur
        raise
    if not brut:
        raise RuntimeError(
            "Réponse vide — redirection 302 non suivie ou déploiement mal configuré."
        )
    donnees = json.loads(brut)
    if donnees.get("ok") is False:
        raise RuntimeError(f"{donnees.get('code')} : {donnees.get('erreur')}")
    return donnees


def telecharger_base(url, cle, terminal):
    """Récupère tous les participants et bracelets, en paginant."""
    participants, bracelets = [], []
    since, apres, page = 0, "", 0
    refs = None

    while True:
        page += 1
        delta = appeler(url, cle, {
            "action": "sync", "terminal": terminal,
            "since": since, "apres": apres, "limite": 500,
        })
        participants.extend(delta.get("participants", []))
        bracelets.extend(delta.get("bracelets", []))
        if delta.get("refs"):
            refs = delta["refs"]
        print(f"  page {page} : {len(delta.get('participants', []))} participants")
        if not delta.get("suite"):
            break
        since, apres = delta["since_suivant"], delta["apres_suivant"]

    return participants, bracelets, refs


def telecharger_photo(url, cle, numero):
    """
    Renvoie (octets, motif). `octets` vaut None en cas d'échec.

    On distingue soigneusement « le participant n'a pas de photo » d'une
    véritable panne : avaler les deux dans un même `return None` masquerait un
    problème réseau derrière un rapport rassurant, et laisserait partir des
    mallettes sans photos sans que personne ne s'en aperçoive.
    """
    import base64
    try:
        reponse = appeler(url, cle, {"action": "photo", "id": numero}, delai=60)
    except RuntimeError as erreur:
        if "PHOTO_INTROUVABLE" in str(erreur):
            return None, "aucune photo pour ce participant"
        return None, f"erreur serveur : {erreur}"
    except Exception as erreur:
        return None, f"{type(erreur).__name__} : {erreur}"

    charge = reponse.get("data_base64")
    if not charge:
        return None, "réponse sans charge utile"
    try:
        return base64.b64decode(charge), ""
    except Exception as erreur:
        return None, f"base64 illisible : {erreur}"


# ───────────────────────────── Traitement d'image ─────────────────────────────

def preparer_portrait(source, rotation):
    """
    Construit le rendu de l'écran esclave.

    L'image est cadrée en 480x800 sur fond neutre, PUIS pivotée pour être
    stockée en 800x480 — l'orientation native du panneau, monté à 90° dans la
    mallette.

    On N'AGRANDIT JAMAIS au-delà de la résolution native de la source : mieux
    vaut un visage petit et net qu'un visage plein cadre et flou, qui rendrait
    le contrôle visuel inutile.
    """
    image = ImageOps.exif_transpose(source).convert("RGB")
    agrandissement = max(PORTRAIT_LARGEUR / image.width, PORTRAIT_HAUTEUR / image.height)

    if agrandissement > 1.0:
        # Source trop petite : on la centre à sa taille réelle sur fond neutre.
        cadre = Image.new("RGB", (PORTRAIT_LARGEUR, PORTRAIT_HAUTEUR), FOND)
        cadre.paste(image, ((PORTRAIT_LARGEUR - image.width) // 2,
                            (PORTRAIT_HAUTEUR - image.height) // 2))
        insuffisante = True
    else:
        cadre = ImageOps.fit(image, (PORTRAIT_LARGEUR, PORTRAIT_HAUTEUR),
                             method=Image.LANCZOS, centering=(0.5, 0.35))
        insuffisante = False

    # `expand=True` : sans lui, Pillow rognerait aux dimensions d'origine.
    return cadre.rotate(rotation, expand=True), insuffisante


def preparer_miniature(source):
    image = ImageOps.exif_transpose(source).convert("RGB")
    if image.width < MINIATURE[0] or image.height < MINIATURE[1]:
        cadre = Image.new("RGB", MINIATURE, FOND)
        cadre.paste(image, ((MINIATURE[0] - image.width) // 2,
                            (MINIATURE[1] - image.height) // 2))
        return cadre
    return ImageOps.fit(image, MINIATURE, method=Image.LANCZOS, centering=(0.5, 0.35))


# ───────────────────────────── Écriture de la microSD ─────────────────────────

CHAMPS_BASE = ["numero", "nom", "prenom", "statut", "commentaire",
               "formule", "repas_conso", "regime", "sports", "ecole", "actif", "maj"]


def ecrire_base(dossier, participants, bracelets, refs):
    """
    Écrit la base initiale de la mallette.

    C'est par ici qu'arrive la base des Cyberdecks, JAMAIS par un sync
    `since=0` : une réponse complète pèse ~275 ko pour 2 000 participants, et
    plus de 600 ko pour 5 000 — indigeste pour un parsing embarqué.
    """
    chemin = os.path.join(dossier, "database.csv")
    with open(chemin, "w", newline="", encoding="utf-8") as fichier:
        redacteur = csv.writer(fichier)
        redacteur.writerow(CHAMPS_BASE)
        for p in participants:
            redacteur.writerow([
                p.get("numero", ""), p.get("nom", ""), p.get("prenom", ""),
                p.get("statut", ""), p.get("commentaire", ""), p.get("formule", ""),
                p.get("repas_conso", ""), p.get("regime", ""), p.get("sports", ""),
                p.get("ecole", ""), 1 if p.get("actif", True) else 0, p.get("maj", 0),
            ])

    chemin_bracelets = os.path.join(dossier, "bracelets.csv")
    with open(chemin_bracelets, "w", newline="", encoding="utf-8") as fichier:
        redacteur = csv.writer(fichier)
        redacteur.writerow(["uid", "numero", "statut", "maj"])
        for b in bracelets:
            redacteur.writerow([b.get("uid", ""), b.get("numero", ""),
                                b.get("statut", ""), b.get("maj", 0)])

    if refs:
        with open(os.path.join(dossier, "refs.json"), "w", encoding="utf-8") as fichier:
            json.dump(refs, fichier, ensure_ascii=False, indent=2)

    # Curseur de départ : le firmware ne redemandera que les modifications
    # postérieures, jamais la base entière.
    max_maj = max((p.get("maj", 0) for p in participants), default=0)
    with open(os.path.join(dossier, "curseur.json"), "w", encoding="utf-8") as fichier:
        json.dump({"since": max_maj, "genere_le": int(time.time() * 1000)}, fichier)

    return max_maj


# ───────────────────────────────── Programme ─────────────────────────────────

def main():
    analyseur = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    analyseur.add_argument("--url", required=True, help="URL de déploiement (…/exec)")
    analyseur.add_argument("--cle", required=True, help="clé API")
    analyseur.add_argument("--terminal", default="DECK-01",
                           help="terminal destinataire — SON PROFIL détermine les champs "
                                "écrits sur la carte (défaut DECK-01)")
    analyseur.add_argument("--max", type=int, default=0,
                           help="ne traiter que les N premières photos (mise au point)")
    analyseur.add_argument("--sortie", default="./sd", help="dossier de sortie")
    analyseur.add_argument("--rotation", type=int, default=90, choices=[90, 270],
                           help="sens de montage de l'écran esclave (défaut 90)")
    analyseur.add_argument("--parallele", type=int, default=6,
                           help="téléchargements simultanés (défaut 6)")
    analyseur.add_argument("--refaire", action="store_true",
                           help="retraiter les photos déjà présentes")
    analyseur.add_argument("--sans-photos", action="store_true",
                           help="ne produire que la base, sans télécharger les photos")
    arguments = analyseur.parse_args()

    dossier_deck = os.path.join(arguments.sortie, "photos")
    dossier_mini = os.path.join(arguments.sortie, "miniatures")
    os.makedirs(dossier_deck, exist_ok=True)
    os.makedirs(dossier_mini, exist_ok=True)

    print("Téléchargement de la base…")
    participants, bracelets, refs = telecharger_base(
        arguments.url, arguments.cle, arguments.terminal)
    print(f"  {len(participants)} participants, {len(bracelets)} bracelets")
    print(f"  profil du terminal {arguments.terminal} : seuls les champs qu'il a le\n"
          f"  droit de recevoir sont écrits sur la carte. Préparez UNE CARTE PAR\n"
          f"  PROFIL — un deck d'entrée n'a pas à embarquer les données repas.")

    max_maj = ecrire_base(arguments.sortie, participants, bracelets, refs)
    print(f"  database.csv, bracelets.csv, refs.json et curseur.json écrits "
          f"(curseur = {max_maj})")

    if arguments.sans_photos:
        print("\nPhotos ignorées (--sans-photos).")
        return 0

    print("\nTraitement des photos…")
    import io
    if arguments.max:
        participants = participants[:arguments.max]
        print(f"  (limité aux {len(participants)} premiers, option --max)")

    numeros = [p.get("numero", "") for p in participants if p.get("numero")]

    # Reprise : une campagne de plusieurs milliers de photos dure une bonne
    # heure, elle DOIT pouvoir être relancée sans tout refaire.
    if not arguments.refaire:
        deja = {f[:-4] for f in os.listdir(dossier_deck) if f.endswith(".jpg")}
        restants = [n for n in numeros if n not in deja]
        if len(restants) < len(numeros):
            print(f"  {len(numeros) - len(restants)} déjà présentes, reprise sur "
                  f"{len(restants)} (--refaire pour tout reprendre)")
        numeros = restants

    obtenues = absentes = illisibles = insuffisantes = 0
    rapport = []
    faits = 0
    depart = time.time()

    def traiter(numero):
        """Télécharge et convertit une photo. Exécuté dans un fil de travail."""
        octets, motif = telecharger_photo(arguments.url, arguments.cle, numero)
        if not octets:
            return numero, "absente", motif, None
        try:
            source = Image.open(io.BytesIO(octets))
            portrait, insuffisante = preparer_portrait(source, arguments.rotation)
            portrait.save(os.path.join(dossier_deck, numero + ".jpg"),
                          "JPEG", quality=82, optimize=True)
            miniature = preparer_miniature(Image.open(io.BytesIO(octets)))
            miniature.save(os.path.join(dossier_mini, numero + ".jpg"),
                           "JPEG", quality=80, optimize=True)
            detail = (f"résolution insuffisante ({source.width}x{source.height}), "
                      f"non agrandie") if insuffisante else ""
            return numero, "ok", detail, insuffisante
        except Exception as erreur:
            return numero, "illisible", f"illisible : {erreur}", None

    # Le goulot est le RÉSEAU, pas le processeur : chaque photo prend environ
    # cinq secondes côté Apps Script. En séquentiel, 5 000 photos demanderaient
    # plus de sept heures. Quelques fils de travail ramènent cela à une heure,
    # tout en restant loin des limites de concurrence d'Apps Script.
    with concurrent.futures.ThreadPoolExecutor(max_workers=arguments.parallele) as pool:
        for numero, issue, motif, insuffisante in pool.map(traiter, numeros):
            faits += 1
            if issue == "ok":
                obtenues += 1
                if insuffisante:
                    insuffisantes += 1
                    rapport.append((numero, motif))
            elif issue == "absente":
                absentes += 1
                rapport.append((numero, motif))
            else:
                illisibles += 1
                rapport.append((numero, motif))

            if faits % 10 == 0 or faits == len(numeros):
                ecoule = time.time() - depart
                reste = (ecoule / faits) * (len(numeros) - faits)
                print(f"  {faits}/{len(numeros)} — {ecoule / 60:.0f} min écoulées, "
                      f"~{reste / 60:.0f} min restantes    ", end="\r", flush=True)

    print(" " * 70, end="\r")

    chemin_rapport = os.path.join(arguments.sortie, "rapport_photos.txt")
    with open(chemin_rapport, "w", encoding="utf-8") as fichier:
        fichier.write(f"{obtenues} traitées, {absentes} absentes, "
                      f"{illisibles} illisibles, {insuffisantes} de résolution insuffisante\n\n")
        for numero, motif in rapport:
            fichier.write(f"{numero}\t{motif}\n")

    taille = sum(os.path.getsize(os.path.join(dossier_deck, f))
                 for f in os.listdir(dossier_deck))

    print(f"\n{obtenues} photo(s) traitée(s)")
    print(f"  · {absentes} absente(s)")
    print(f"  · {illisibles} illisible(s)")
    print(f"  · {insuffisantes} de résolution insuffisante (centrées, NON agrandies)")
    print(f"  · {taille / 1048576:.1f} Mo dans {dossier_deck}")
    print(f"\nRapport détaillé : {chemin_rapport}")
    print("\nÀ faire ensuite :")
    print(f"  1. copier {arguments.sortie}/ à la racine de la microSD de l'esclave ;")
    print(f"  2. déposer {dossier_mini}/ dans le dossier Drive « Miniatures »,")
    print("     puis declarer son identifiant :  definirDossierMiniatures('<id>')")
    return 0


if __name__ == "__main__":
    sys.exit(main())
