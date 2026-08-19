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

  /** GET : requête simple, aucun contrôle préalable. */
  function get(params, delaiMs) {
    const parametres = new URLSearchParams(Object.assign({ key: _cle }, params));
    return avecDelai(fetch(_url + '?' + parametres.toString(), {
      method: 'GET',
      redirect: 'follow'          // le 302 d'Apps Script DOIT être suivi
    }), delaiMs).then(analyser);
  }

  /** POST en text/plain — voir l'avertissement en tête de fichier. */
  function post(charge, delaiMs) {
    return avecDelai(fetch(_url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ key: _cle }, charge)),
      redirect: 'follow'
    }), delaiMs).then(analyser);
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
      const binaire = atob(reponse.data_base64);
      const octets = new Uint8Array(binaire.length);
      for (let i = 0; i < binaire.length; i++) octets[i] = binaire.charCodeAt(i);
      return new Blob([octets], { type: reponse.mime || 'image/jpeg' });
    });
  }

  return { configurer, estConfigure, ping, sync, envoyerScans, photo, get, post };
})();

window.API = API;

