#!/usr/bin/env python3
"""
generate_test_data.py — Jeu de participants fictifs pour valider le backend.

Produit un CSV importable dans l'onglet Participants, avec des cas de test
volontairement pénibles : accents, apostrophes, tirets, homonymes, formules
partielles, commentaires médicaux, notes de sécurité, comptes suspendus.

Aucune dépendance externe : la bibliothèque standard suffit.

    python3 tools/generate_test_data.py --nombre 2000 --sortie participants_test.csv

Puis, dans le classeur : Fichier > Importer > Remplacer la feuille active,
en veillant à choisir « Détecter automatiquement » pour le séparateur.
Lancez ensuite « 🔄 Forcer la réindexation ».
"""

import argparse
import csv
import random
import sys
import unicodedata
from datetime import date, timedelta


def sans_accent(texte: str) -> str:
    """Réduit une chaîne à l'ASCII — les adresses e-mail accentuées sont
    rejetées par la plupart des systèmes, autant produire du réaliste."""
    decompose = unicodedata.normalize("NFD", texte)
    ascii_seul = "".join(c for c in decompose if unicodedata.category(c) != "Mn")
    return "".join(c for c in ascii_seul if c.isalnum())

# En-têtes ALIGNÉS sur COLS_PARTICIPANTS (backend/Config.gs). Si vous renommez
# une colonne ici, renommez-la aussi là-bas.
ENTETES = [
    "Numéro du participant", "École", "Nom", "Prénom", "Date de Naissance",
    "Email", "Numéro de Téléphone", "Sexe", "Taille Vêtement", "Statut",
    "Sport(s)", "Camping", "Formule Repas", "Régime alimentaire",
    "Repas consommé(s)", "Photo d'identité", "Commentaire Participant",
    "Note de sécurité",
]

NOMS = [
    "Durand", "Martin", "Bernard", "Dubois", "Thomas", "Robert", "Richard",
    "Petit", "Moreau", "Simon", "Laurent", "Lefebvre", "Michel", "Garcia",
    "David", "Bertrand", "Roux", "Vincent", "Fournier", "Morel", "Girard",
    "André", "Lefèvre", "Mercier", "Blanc", "Guérin", "Boyer", "Chevalier",
    # Cas volontairement pénibles pour les tris et les recherches
    "O'Brien", "Da Silva", "Ngô", "Müller", "Saint-Éloi", "de La Tour",
]

PRENOMS_M = ["Lucas", "Hugo", "Gabriel", "Léo", "Raphaël", "Arthur", "Louis",
             "Jules", "Adam", "Maël", "Noah", "Tom", "Émile", "Théo"]
PRENOMS_F = ["Emma", "Jade", "Louise", "Alice", "Chloé", "Lina", "Rose",
             "Anna", "Léa", "Mila", "Julia", "Zoé", "Éva", "Agathe"]

ECOLES = [
    "AgroParisTech", "Arts et Métiers", "Centrale Lille", "ENSAM Angers",
    "ESTP Paris", "INSA Lyon", "Mines Nancy", "Polytech Nantes",
    "UTC Compiègne", "IMT Atlantique", "ENSEEIHT", "ESIEE Paris",
]

STATUTS = ["Sportif", "Sportif", "Sportif", "Sportif", "Supporter",
           "Supporter", "Bénévole", "Bénévole", "Staff", "VIP"]

SPORTS = ["Football", "Basket-ball", "Handball", "Volley-ball", "Rugby",
          "Athlétisme", "Natation", "Badminton", "Tennis de table",
          "Escalade", "Judo", "Cross"]

TAILLES = ["XS", "S", "M", "L", "XL", "XXL"]

FORMULES = ["Pension complète", "Pension complète", "Demi-pension",
            "Repas à l'unité", "Sans repas"]

# Deux valeurs seulement : c'est une donnée logistique, pas un questionnaire.
REGIMES = ["Classique"] * 8 + ["Végétarien"] * 2

# Informations de santé déclarées par le participant, diffusées à TOUS les
# postes : quelqu'un qui fait un malaise doit être secouru où qu'il soit.
COMMENTAIRES = [
    "Épilepsie — ne pas laisser seul en cas de malaise",
    "Allergie sévère aux arachides — trousse d'urgence dans son sac",
    "Asthme — inhalateur sur lui",
    "Diabète type 1",
    "Allergie aux fruits de mer",
]

# Appréciations internes, réservées aux postes SECURITE et PC_ORGA.
# Rédigées comme l'exige la consigne : datées, situées, factuelles.
NOTES_SECURITE = [
    "A refusé le contrôle au poste B à 15h10, signalé par l'agent 4",
    "Bracelet prêté à un tiers samedi 22h, rappel à l'ordre effectué",
    "Comportement agressif à l'entrée du terrain dimanche 14h30",
]


def numero_participant(index: int) -> str:
    """
    Format 0000X000 : quatre chiffres, une lettre, trois chiffres.

    Traité comme une CHAÎNE OPAQUE de bout en bout — les zéros de tête et la
    lettre interne interdisent tout stockage numérique. C'est la raison pour
    laquelle la colonne doit être mise au format Texte dans le classeur.
    """
    lettre = chr(ord("A") + (index // 1000) % 26)
    return f"{index % 10000:04d}{lettre}{index % 1000:03d}"


def genere(nombre: int, graine: int):
    random.seed(graine)
    lignes = []
    naissance_min = date(1998, 1, 1)
    plage_jours = (date(2008, 12, 31) - naissance_min).days

    for i in range(1, nombre + 1):
        sexe = random.choice(["M", "F"])
        prenom = random.choice(PRENOMS_M if sexe == "M" else PRENOMS_F)
        nom = random.choice(NOMS)
        statut = random.choice(STATUTS)
        formule = random.choice(FORMULES)

        # Un supporter n'a pas de sport ; un staff peut en encadrer plusieurs.
        if statut == "Supporter":
            sports = ""
        elif statut == "Staff":
            sports = ", ".join(random.sample(SPORTS, k=random.randint(1, 3)))
        else:
            sports = random.choice(SPORTS)

        lignes.append([
            numero_participant(i),
            random.choice(ECOLES),
            nom,
            prenom,
            (naissance_min + timedelta(days=random.randint(0, plage_jours))).isoformat(),
            f"{sans_accent(prenom).lower()}.{sans_accent(nom).lower()}{i}@example.org",
            f"06{random.randint(10000000, 99999999)}",
            sexe,
            random.choice(TAILLES),
            statut,
            sports,
            random.choice(["Oui", "Non"]),
            formule,
            random.choice(REGIMES),
            "",                      # Repas consommé(s) : rempli par le backend
            "",                      # Photo d'identité : lien Drive, ajouté à part
            random.choice(COMMENTAIRES) if random.random() < 0.03 else "",
            random.choice(NOTES_SECURITE) if random.random() < 0.01 else "",
        ])

    # Cas limites ajoutés délibérément en fin de jeu, pour qu'ils soient
    # faciles à retrouver pendant les tests manuels.
    lignes.extend([
        # 2004 est bien bissextile : un 29 février VALIDE mais piégeux,
        # là où une date inexistante ne testerait que le parseur.
        ["9001Z001", "INSA Lyon", "Éloi-Bérenger", "Marie-Ange", "2004-02-29",
         "cas.limite1@example.org", "0600000001", "F", "XS", "Sportif",
         "Natation", "Oui", "Demi-pension", "Végétarien", "", "",
         "Épilepsie — ne pas laisser seul en cas de malaise", ""],
        ["9002Z002", "O'Brien School", "O'Neill", "Seán", "2003-07-14",
         "cas.limite2@example.org", "0600000002", "M", "XXL", "Supporter",
         "", "Non", "Sans repas", "Classique", "", "", "",
         "A refusé le contrôle au poste B à 15h10, signalé par l'agent 4"],
        ["9003Z003", "Mines Nancy", "Durand", "Alice", "2001-01-01",
         "homonyme.a@example.org", "0600000003", "F", "M", "Sportif",
         "Football", "Oui", "Pension complète", "Classique", "", "", "", ""],
        ["9004Z004", "Mines Nancy", "Durand", "Alice", "2004-06-30",
         "homonyme.b@example.org", "0600000004", "F", "S", "Bénévole",
         "Football", "Non", "Pension complète", "Végétarien", "", "", "", ""],
    ])
    return lignes


def main():
    analyseur = argparse.ArgumentParser(description=__doc__,
                                        formatter_class=argparse.RawDescriptionHelpFormatter)
    analyseur.add_argument("--nombre", type=int, default=2000,
                           help="nombre de participants générés (défaut : 2000)")
    analyseur.add_argument("--sortie", default="participants_test.csv",
                           help="fichier CSV produit")
    analyseur.add_argument("--graine", type=int, default=12,
                           help="graine aléatoire, pour un jeu reproductible")
    arguments = analyseur.parse_args()

    lignes = genere(arguments.nombre, arguments.graine)

    # utf-8-sig : sans le BOM, Google Sheets casse les accents à l'import.
    with open(arguments.sortie, "w", newline="", encoding="utf-8-sig") as fichier:
        redacteur = csv.writer(fichier)
        redacteur.writerow(ENTETES)
        redacteur.writerows(lignes)

    avec_commentaire = sum(1 for l in lignes if l[16])
    avec_note = sum(1 for l in lignes if l[17])
    vegetariens = sum(1 for l in lignes if l[13] == "Végétarien")

    print(f"{len(lignes)} participants écrits dans {arguments.sortie}")
    print(f"  · {avec_commentaire} avec Commentaire Participant (donnée de santé)")
    print(f"  · {avec_note} avec Note de sécurité")
    print(f"  · {vegetariens} végétariens")
    print()
    print("Import : Fichier > Importer > Remplacer la feuille active.")
    print("IMPORTANT : mettez la colonne « Numéro du participant » au format Texte")
    print("            AVANT l'import, sinon les zéros de tête sautent.")
    print("Puis lancez « 🔄 Forcer la réindexation » depuis le menu ARCHIPIADES.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
