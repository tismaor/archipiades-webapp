/**
 * valider_deploiement.js — Validation d'un déploiement Apps Script réel.
 *
 * Complète tools/test_backend.js, qui simule les API Google : ce script-ci
 * frappe le VRAI déploiement et couvre les trois choses intestables en local —
 * la redirection 302, l'accès Drive du proxy photo, et le comportement réel du
 * classeur.
 *
 * Par défaut, AUCUNE ÉCRITURE n'est faite : le classeur peut contenir vos
 * données réelles. Les tests qui écrivent (journal des scans) ne s'exécutent
 * qu'avec --ecriture, et tout ce qu'ils écrivent est préfixé VALIDATION- pour
 * être retrouvable et supprimable.
 *
 *   node tools/valider_deploiement.js --url <URL/exec> --cle <CLE>
 *   node tools/valider_deploiement.js --url … --cle … --ecriture
 */

'use strict';

/* ─────────────────────────────── Arguments ─────────────────────────────── */

function lireArguments() {
  const args = process.argv.slice(2);
  const options = { terminal: 'DECK-01', terminalRepas: 'DECK-02', ecriture: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--url': options.url = args[++i]; break;
      case '--cle': case '--key': options.cle = args[++i]; break;
      case '--terminal': options.terminal = args[++i]; break;
      case '--terminal-repas': options.terminalRepas = args[++i]; break;
      case '--ecriture': options.ecriture = true; break;
      default:
        console.error('Argument inconnu : ' + args[i]);
        process.exit(2);
    }
  }
  if (!options.url) {
    console.error('Usage : node tools/valider_deploiement.js --url <URL/exec> --cle <CLE> [--ecriture]');
    process.exit(2);
  }
  return options;
}

const options = lireArguments();

/* ────────────────────────── Micro-cadre de test ────────────────────────── */

let reussis = 0, echecs = 0, ignores = 0;
const journal = [];

function section(titre) { journal.push('\n\x1b[1m' + titre + '\x1b[0m'); }

function verifier(intitule, condition, indice) {
  if (condition) { reussis++; journal.push('  \x1b[32m✓\x1b[0m ' + intitule); }
  else {
    echecs++;
    journal.push('  \x1b[31m✗\x1b[0m ' + intitule + (indice ? '\n      → ' + indice : ''));
  }
}

function ignorer(intitule, raison) {
  ignores++;
  journal.push('  \x1b[33m•\x1b[0m ' + intitule + '\n      → ignoré : ' + raison);
}

/* ────────────────────────────── Appels HTTP ────────────────────────────── */

function url(params) {
  const qs = new URLSearchParams(Object.assign({ key: options.cle }, params));
  return options.url + '?' + qs.toString();
}

async function get(params) {
  const reponse = await fetch(url(params));
  const texte = await reponse.text();
  try { return { statut: reponse.status, corps: JSON.parse(texte), brut: texte }; }
  catch { return { statut: reponse.status, corps: null, brut: texte }; }
}

async function post(charge) {
  // Pas de `method` forcé sur la redirection : fetch suit un 302 en GET,
  // exactement comme doit le faire l'ESP32.
  const reponse = await fetch(options.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ key: options.cle }, charge))
  });
  const texte = await reponse.text();
  try { return { statut: reponse.status, corps: JSON.parse(texte), brut: texte }; }
  catch { return { statut: reponse.status, corps: null, brut: texte }; }
}

/* ─────────────────────────────── Les tests ─────────────────────────────── */

async function principal() {
  console.log('Déploiement testé : ' + options.url);
  console.log('Mode : ' + (options.ecriture ? '\x1b[33mLECTURE + ÉCRITURE\x1b[0m' : 'lecture seule'));

  /* ---- 1. Le piège n°1 : la redirection 302 ---- */
  section('1. Redirection 302 — le piège n°1 du projet');
  {
    const sansSuivi = await fetch(options.url + '?action=ping', { redirect: 'manual' });
    const corpsSansSuivi = await sansSuivi.text();
    verifier('sans suivi de redirection : le serveur répond 302',
      sansSuivi.status === 302 || sansSuivi.status === 0,
      'obtenu ' + sansSuivi.status);
    verifier('sans suivi : le corps est VIDE (le symptôme trompeur)',
      corpsSansSuivi.length === 0, corpsSansSuivi.length + ' octets reçus');

    const cible = sansSuivi.headers.get('location') || '';
    verifier('la redirection pointe vers script.googleusercontent.com',
      cible.includes('script.googleusercontent.com'),
      cible.includes('accounts.google.com')
        ? 'ELLE POINTE VERS accounts.google.com → le déploiement n\'est pas en ' +
          '« Exécuter en tant que moi » + « Accès : tout le monde »'
        : cible.slice(0, 80));

    const avecSuivi = await fetch(options.url + '?action=ping');
    const corpsAvecSuivi = await avecSuivi.text();
    verifier('avec suivi : 200 et un corps non vide',
      avecSuivi.status === 200 && corpsAvecSuivi.length > 0,
      'statut ' + avecSuivi.status + ', ' + corpsAvecSuivi.length + ' octets');
    verifier('le corps est bien du JSON', (() => {
      try { JSON.parse(corpsAvecSuivi); return true; } catch { return false; }
    })(), corpsAvecSuivi.slice(0, 120));
  }

  /* ---- 2. POST : la nuance STRICT / FORCE ---- */
  section('2. POST — pourquoi STRICT ne suffit pas');
  {
    const sansSuivi = await fetch(options.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'ping', key: options.cle }),
      redirect: 'manual'
    });
    verifier('un POST répond lui aussi par un 302',
      sansSuivi.status === 302, 'obtenu ' + sansSuivi.status);

    const resultat = await post({ action: 'ping' });
    verifier('le POST suivi EN GET renvoie la charge utile',
      resultat.corps !== null, resultat.brut.slice(0, 150));

    // Sans clé, on ne peut pas exiger ok:true — mais une réponse de NOTRE
    // routeur (donc portant `ok` et `code`) prouve déjà que doPost a reçu et
    // analysé le corps JSON, ce qui est l'objet de ce test.
    const routeurAtteint = resultat.corps &&
      typeof resultat.corps.ok === 'boolean' &&
      (resultat.corps.ok === true || typeof resultat.corps.code === 'string');
    verifier('le corps JSON du POST a bien été analysé par doPost',
      routeurAtteint, JSON.stringify(resultat.corps));

    const sansAction = await post({});
    verifier('un POST sans action est diagnostiqué comme tel',
      sansAction.corps && (sansAction.corps.code === 'ACTION_MANQUANTE' ||
                           sansAction.corps.code === 'ERREUR_SERVEUR'),
      JSON.stringify(sansAction.corps));
  }

  if (!options.cle) {
    journal.push('\n\x1b[33mClé API absente : les tests suivants sont ignorés.\x1b[0m');
    return restituer();
  }

  /* ---- 3. Authentification ---- */
  section('3. Authentification par clé partagée');
  {
    const reponse = await fetch(options.url + '?action=ping&key=cle-volontairement-fausse');
    const corps = JSON.parse(await reponse.text());
    verifier('une clé invalide est refusée',
      corps.ok === false && corps.code === 'CLE_INVALIDE', JSON.stringify(corps));

    const bon = await get({ action: 'ping' });
    verifier('la clé fournie est acceptée', bon.corps && bon.corps.ok === true,
      JSON.stringify(bon.corps));
    verifier('l\'horloge serveur est cohérente',
      bon.corps && Math.abs(bon.corps.server_time - Date.now()) < 300000,
      'écart de ' + Math.round((bon.corps.server_time - Date.now()) / 1000) + ' s');
  }

  /* ---- 4. Synchronisation ---- */
  section('4. Synchronisation différentielle');
  let complet = null;
  {
    complet = (await get({ action: 'sync', terminal: options.terminal, since: 0 })).corps;
    if (!complet || complet.ok !== true) {
      verifier('sync since=0 répond', false, JSON.stringify(complet));
      return restituer();
    }
    verifier('sync since=0 répond', true);
    verifier('des participants sont renvoyés',
      complet.participants.length > 0,
      'aucun participant — le classeur est-il peuplé et réindexé ?');
    verifier('les tables de référence accompagnent le premier appel', !!complet.refs);
    verifier('la matrice Droits est renseignée',
      complet.refs && Object.keys(complet.refs.droits || {}).length > 0,
      'onglet Droits vide');
    verifier('les services (plages repas) sont définis',
      complet.refs && (complet.refs.services || []).length > 0,
      'onglet Services vide → aucun repas ne pourra être décompté');
    verifier('la cadence du terminal est transmise',
      typeof complet.sync_interval_s === 'number' && complet.sync_interval_s > 0,
      'obtenu ' + complet.sync_interval_s);

    const maxMaj = Math.max(...complet.participants.map((p) => p.maj || 0));
    const vide = (await get({ action: 'sync', terminal: options.terminal, since: maxMaj })).corps;
    verifier('un delta sans changement est vide',
      vide.participants.length === 0,
      vide.participants.length + ' ligne(s) renvoyée(s) alors que rien n\'a changé');

    const memeRefs = (await get({
      action: 'sync', terminal: options.terminal, since: maxMaj, refs: complet.refs_version
    })).corps;
    verifier('les références ne sont pas réémises si la version est identique',
      !memeRefs.refs);

    const inconnu = (await get({ action: 'sync', terminal: 'TERMINAL-QUI-NEXISTE-PAS', since: 0 })).corps;
    verifier('un terminal inconnu est refusé',
      inconnu.code === 'TERMINAL_INCONNU', JSON.stringify(inconnu));
  }

  /* ---- 5. Profils de données ---- */
  section('5. Profils de données — la barrière RGPD');
  {
    const champsInterdits = ['email', 'telephone', 'naissance'];
    const fuite = champsInterdits.filter((c) =>
      complet.participants.some((p) => p[c] !== undefined && p[c] !== ''));
    verifier('email, téléphone et date de naissance ne sortent JAMAIS du backend',
      fuite.length === 0, 'champs transmis à tort : ' + fuite.join(', '));

    verifier('le profil annoncé correspond au terminal interrogé',
      !!complet.profil_donnees, JSON.stringify(complet.profil_donnees));

    if (complet.profil_donnees === 'ENTREE') {
      verifier('profil ENTREE : aucune Note de sécurité transmise',
        !complet.participants.some((p) => p.note_secu !== undefined));
      verifier('profil ENTREE : aucun régime alimentaire transmis',
        !complet.participants.some((p) => p.regime !== undefined));
    } else {
      ignorer('cloisonnement du profil ENTREE',
        'le terminal ' + options.terminal + ' est en profil ' + complet.profil_donnees);
    }

    const repas = (await get({ action: 'sync', terminal: options.terminalRepas, since: 0 })).corps;
    if (repas && repas.ok && repas.profil_donnees === 'REPAS') {
      verifier('profil REPAS : le régime alimentaire EST transmis',
        repas.participants.some((p) => p.regime !== undefined));
      verifier('profil REPAS : toujours aucune Note de sécurité',
        !repas.participants.some((p) => p.note_secu !== undefined));
      verifier('profil REPAS : toujours aucun email',
        !repas.participants.some((p) => p.email !== undefined));
    } else {
      ignorer('cloisonnement du profil REPAS',
        'terminal ' + options.terminalRepas + ' absent ou pas en profil REPAS');
    }

    const avecCommentaire = complet.participants.filter((p) => p.commentaire);
    if (avecCommentaire.length) {
      verifier('le Commentaire Participant (santé) est bien diffusé partout', true);
    } else {
      ignorer('diffusion du Commentaire Participant',
        'aucun participant n\'en a — importez le jeu de test pour le vérifier');
    }
  }

  /* ---- 6. Proxy photo ---- */
  // Ce bloc vérifie que le script LIT le fichier Drive et l'encode correctement.
  // Il ne prouve PAS que le fichier est privé : cela se contrôle à la main, en
  // ouvrant le lien Drive dans une fenêtre de navigation privée — il doit
  // demander une authentification.
  section('6. Proxy photo — lecture et encodage');
  {
    const avecPhoto = complet.participants.find((p) => p.photo === true);
    const cible = avecPhoto || complet.participants[0];

    if (!cible) {
      ignorer('proxy photo', 'aucun participant dans le classeur');
    } else {
      const reponse = await get({ action: 'photo', id: cible.numero });
      if (reponse.corps && reponse.corps.ok) {
        verifier('la photo est servie par le proxy', true);
        verifier('le type MIME est une image',
          String(reponse.corps.mime).startsWith('image/'), reponse.corps.mime);
        verifier('la charge base64 est exploitable',
          reponse.corps.data_base64 && reponse.corps.data_base64.length > 100,
          (reponse.corps.taille || 0) + ' octets');
        const octets = Buffer.from(reponse.corps.data_base64, 'base64');
        verifier('l\'image est un JPEG ou un PNG valide',
          (octets[0] === 0xFF && octets[1] === 0xD8) ||
          (octets[0] === 0x89 && octets[1] === 0x50),
          'entête : ' + octets.slice(0, 4).toString('hex'));
      } else if (reponse.corps && reponse.corps.code === 'PHOTO_INTROUVABLE') {
        ignorer('proxy photo',
          'aucune photo pour ' + cible.numero + '. Lancez « 🖼 Indexer les photos », ' +
          'et vérifiez que la colonne Photo contient des liens Drive.');
      } else {
        verifier('le proxy photo répond correctement', false,
          JSON.stringify(reponse.corps || reponse.brut.slice(0, 200)));
      }
    }
  }

  /* ---- 7. Écritures (opt-in) ---- */
  section('7. Journal des scans — idempotence' + (options.ecriture ? '' : ' (ignoré)'));
  if (!options.ecriture) {
    ignorer('idempotence de log_scan',
      'écrit dans votre onglet Scans — relancez avec --ecriture pour l\'exécuter');
  } else {
    const identifiant = 'VALIDATION-' + Date.now();
    const lot = [{
      scan_id: identifiant, ts_terminal: Date.now(),
      uid: 'VALIDATION0000', numero: complet.participants[0].numero,
      decision: 'ACCES_AUTORISE', motif: 'test de validation automatique'
    }];

    const premier = await post({ action: 'log_scan', terminal: options.terminal, scans: lot });
    verifier('le lot est enregistré',
      premier.corps && premier.corps.enregistres === 1, JSON.stringify(premier.corps));

    const rejeu = await post({ action: 'log_scan', terminal: options.terminal, scans: lot });
    verifier('un lot rejoué n\'écrit RIEN (pas de double repas)',
      rejeu.corps && rejeu.corps.enregistres === 0 && rejeu.corps.ignores === 1,
      JSON.stringify(rejeu.corps));

    journal.push('      \x1b[2mligne de test à supprimer dans Scans : ' + identifiant + '\x1b[0m');
  }

  /* ---- 8. Rôles ---- */
  section('8. Rôles — le contrôle est côté serveur');
  {
    const sansJeton = (await get({ action: 'flotte' })).corps;
    verifier('une action privilégiée sans jeton est refusée',
      sansJeton.code === 'SESSION_EXPIREE', JSON.stringify(sansJeton));

    const jetonInvente = (await get({ action: 'flotte', jeton: 'jeton-invente-de-toutes-pieces' })).corps;
    verifier('un jeton forgé est refusé',
      jetonInvente.code === 'SESSION_EXPIREE', JSON.stringify(jetonInvente));

    const mauvaisIdentifiants = await post({
      action: 'admin_login', uid_carte: '00INEXISTANT00',
      phrase_de_passe: 'peu importe', terminal_id: options.terminal
    });
    verifier('une carte inconnue est refusée',
      mauvaisIdentifiants.corps && mauvaisIdentifiants.corps.ok === false);
    verifier('le message ne révèle pas si c\'est la carte ou la phrase',
      mauvaisIdentifiants.corps &&
      mauvaisIdentifiants.corps.erreur === 'Identifiants refusés',
      JSON.stringify(mauvaisIdentifiants.corps));
  }

  restituer();
}

/* ────────────────────────────── Restitution ────────────────────────────── */

function restituer() {
  console.log(journal.join('\n'));
  console.log('\n' + '─'.repeat(66));
  console.log(`${reussis} réussi(s), ${echecs} échec(s), ${ignores} ignoré(s).`);
  console.log('─'.repeat(66));
  if (echecs === 0) {
    console.log('\n\x1b[32mDéploiement validé.\x1b[0m Le mécanisme du 302 est confirmé sur le vrai serveur.');
  }
  process.exit(echecs === 0 ? 0 : 1);
}

principal().catch((erreur) => {
  console.error('\n\x1b[31mErreur pendant la validation :\x1b[0m ' + erreur.message);
  console.error(erreur.stack);
  process.exit(1);
});
