/**
 * api.js — Client du backend Apps Script.
 *
 * ⚠️ CONTRAINTE CORS, mesurée sur le déploiement réel :
 *
 * Un POST en `application/json` déclenche un contrôle préalable OPTIONS, et
 * Apps Script y répond **HTTP 500**. Toute écriture depuis le navigateur
 * échouerait donc, sans message compréhensible.
 *
 * La parade est d'employer `text/plain;charset=utf-8` : la requête devient
 * « simple » au sens CORS, aucun contrôle préalable n'est émis, et le backend
 * lit le corps JSON exactement de la même façon. Ne changez pas ce type de
 * contenu en croyant bien faire.
 *
 * (Cette contrainte ne concerne que le navigateur. L'ESP32, qui n'applique pas
 * la politique d'origine, poste normalement — voir docs/API.md.)
 */

'use strict';

const API = (function () {

  let _url = '';
  let _cle = '';
  let _terminal = '';

  function configurer(url, cle, terminal) {
    _url = String(url || '').trim();
    _cle = String(cle || '').trim();
    _terminal = String(terminal || '').trim();
  }

  function estConfigure() {
    return _url !== '' && _cle !== '' && _terminal !== '';
  }

  /**
   * GET : requête simple, aucun contrôle préalable.
   *
   * Réessaie une fois en cas d'échec transitoire. Apps Script renvoie
   * épisodiquement une page HTML d'erreur au lieu du JSON attendu, sans cause
   * côté client — mesuré sur le déploiement réel, une requête sur cinq environ
   * quand le service est sollicité. Sans ce filet, l'agent verrait « échec de
   * synchronisation » et conclurait à une panne, alors qu'un simple nouvel
   * essai suffit.
   */
  function get(params, delaiMs) {
    const emettre = function () {
      const parametres = new URLSearchParams(Object.assign({ key: _cle }, params));
      return avecDelai(fetch(_url + '?' + parametres.toString(), {
        method: 'GET',
        redirect: 'follow'        // le 302 d'Apps Script DOIT être suivi
      }), delaiMs).then(analyser);
    };
    return avecNouvelEssai(emettre, 2);
  }

  /**
   * Relance jusqu'à `essais` fois sur échec transitoire, avec attente croissante.
   *
   * Mesure sur le déploiement réel : environ **2 requêtes sur 10** échouent en
   * renvoyant une page HTML d'erreur, sans cause côté client. Deux nouvelles
   * tentatives ramènent la probabilité d'échec visible sous le pour cent.
   */
  function avecNouvelEssai(emettre, essais) {
    return emettre().catch(function (erreur) {
      if (essais <= 0 || !estTransitoire(erreur)) throw erreur;
      const attente = (3 - essais) * 1800 + 1200;
      console.warn('Nouvel essai dans ' + attente + ' ms — ' + erreur.message);
      return new Promise(function (resoudre) { setTimeout(resoudre, attente); })
        .then(function () { return avecNouvelEssai(emettre, essais - 1); });
    });
  }

  /**
   * Un échec transitoire mérite un nouvel essai ; une erreur métier, non.
   * Réessayer une clé invalide ou un terminal inconnu ne ferait que doubler
   * l'attente avant d'afficher le vrai message.
   */
  function estTransitoire(erreur) {
    if (erreur.code) return false;          // erreur métier renvoyée par le backend
    return /non JSON|Réponse vide|Délai dépassé|Failed to fetch|NetworkError/i
      .test(erreur.message || '');
  }

  /**
   * POST en text/plain — voir l'avertissement en tête de fichier.
   *
   * Relancé lui aussi : l'idempotence par `scan_id` côté serveur rend un
   * doublon d'envoi totalement inoffensif, il n'y a donc aucune raison de
   * s'interdire un nouvel essai.
   */
  function post(charge, delaiMs) {
    const emettre = function () {
      return avecDelai(fetch(_url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ key: _cle }, charge)),
        redirect: 'follow'
      }), delaiMs).then(analyser);
    };
    return avecNouvelEssai(emettre, 2);
  }

  function analyser(reponse) {
    return reponse.text().then(function (texte) {
      if (!texte) {
        // Corps vide : dans la quasi-totalité des cas, une redirection 302 non
        // suivie. Le message doit orienter le diagnostic, pas le masquer.
        throw new Error('Réponse vide du serveur — redirection 302 non suivie ' +
                        'ou déploiement mal configuré.');
      }
      let donnees;
      try {
        donnees = JSON.parse(texte);
      } catch (erreur) {
        // Apps Script renvoie une page HTML quand le déploiement exige une
        // authentification, ou sur un 405.
        throw new Error('Réponse non JSON (' + texte.length + ' octets) — le ' +
                        'déploiement doit être « Exécuter en tant que moi » et ' +
                        '« Accès : tout le monde ».');
      }
      if (donnees.ok === false) {
        const erreur = new Error(donnees.erreur || 'Erreur serveur');
        erreur.code = donnees.code;
        throw erreur;
      }
      return donnees;
    });
  }

  /**
   * Impose un délai maximal : `fetch` n'expire pas tout seul, et une requête
   * suspendue sur une 4G saturée bloquerait la synchronisation indéfiniment.
   */
  function avecDelai(promesseFetch, delaiMs) {
    const delai = delaiMs || 15000;
    return Promise.race([
      promesseFetch,
      new Promise(function (_, rejeter) {
        setTimeout(function () {
          rejeter(new Error('Délai dépassé après ' + Math.round(delai / 1000) + ' s'));
        }, delai);
      })
    ]);
  }

  /* ─────────────────────────── Points d'entrée ─────────────────────────── */

  function ping() {
    return get({ action: 'ping' }, 10000);
  }

  /**
   * Récupère un delta. Le curseur est composite `(since, apres)` : un collage
   * de masse donne le même horodatage à des centaines de lignes, et paginer sur
   * le seul horodatage en sauterait.
   */
  function sync(since, apres, refsVersion, limite) {
    return get({
      action: 'sync',
      terminal: _terminal,
      since: since || 0,
      apres: apres || '',
      refs: refsVersion || '',
      limite: limite || 500
    }, 20000);
  }

  /** Envoie un lot de scans. Idempotent par `scan_id` côté serveur. */
  function envoyerScans(scans) {
    return post({ action: 'log_scan', terminal: _terminal, scans: scans }, 20000);
  }

  /**
   * Télécharge une photo et la renvoie en Blob.
   * Le backend sert du base64 pour rester dans un corps JSON ; on reconvertit
   * ici, une seule fois, avant stockage.
   */
  function photo(numero) {
    return get({ action: 'photo', id: numero }, 20000).then(function (reponse) {
      if (!reponse || !reponse.data_base64) {
        throw new Error('Réponse photo sans données');
      }
      // Décodage confié au navigateur via une URL `data:`.
      //
      // La méthode manuelle — atob() puis une boucle caractère par caractère —
      // construisait deux copies intermédiaires en mémoire JS (la chaîne
      // binaire, puis le tableau d'octets) et occupait le fil principal pendant
      // tout le parcours. Ici, le décodage se fait hors du tas JS et sans
      // bloquer l'affichage.
      return fetch('data:' + (reponse.mime || 'image/jpeg') + ';base64,' +
                   reponse.data_base64).then(function (r) { return r.blob(); });
    });
  }

  return { configurer, estConfigure, ping, sync, envoyerScans, photo, get, post };
})();

window.API = API;

