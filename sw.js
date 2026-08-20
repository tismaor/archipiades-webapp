/**
 * sw.js — Service Worker.
 *
 * Il ne met en cache QUE la coque applicative (HTML, CSS, JS). Les données
 * vivent dans IndexedDB, les photos aussi : mettre les réponses de l'API en
 * cache HTTP serait une faute — l'application servirait des droits d'accès
 * périmés sans que personne ne s'en aperçoive.
 *
 * Stratégie : **cache d'abord pour la coque**, et le cache est traité comme une
 * génération indivisible.
 *
 * ⚠️ Pourquoi PAS « réseau d'abord ». Chaque fichier se résolvait alors
 * indépendamment vers le réseau OU le cache. Sur une 4G capricieuse, on
 * obtenait un `index.html` du cache et un `app.js` du réseau — deux versions
 * mélangées dans la même page. Le symptôme observé : « Cannot set properties of
 * null », parce que le JavaScript neuf cherchait un élément que le HTML périmé
 * ne contenait pas encore.
 *
 * Ici, `install` télécharge toute la coque en bloc sous un nom de cache
 * versionné : tout vient de la même génération, ou rien. La mise à jour reste
 * immédiate — le navigateur revérifie `sw.js` à chaque navigation, et le nom du
 * cache est incrémenté à chaque déploiement.
 */

'use strict';

/**
 * ⚠️ À INCRÉMENTER À CHAQUE MODIFICATION DE LA COQUE.
 *
 * Sans cela, un téléphone peut continuer d'exécuter l'ancien code — donc
 * d'appliquer d'anciennes règles d'accès — sans que personne ne s'en aperçoive.
 * C'est le même piège que le déploiement figé d'Apps Script, une couche plus bas.
 */
const CACHE = 'archipiades-coque-v15';

const COQUE = [
  './',
  'index.html',
  'rules.js',
  'db.js',
  'api.js',
  'app.js',
  'manifest.json'
];

self.addEventListener('install', function (evenement) {
  evenement.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(COQUE); })
      // Nouvelle version active immédiatement : un bénévole ne va pas fermer
      // tous ses onglets en pleine exploitation.
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (evenement) {
  evenement.waitUntil(
    caches.keys()
      .then(function (noms) {
        return Promise.all(noms.filter(function (nom) { return nom !== CACHE; })
                               .map(function (nom) { return caches.delete(nom); }));
      })
      .then(function () { return self.clients.claim(); })
      // Prévenir les onglets ouverts : ils exécutent encore l'ancien code, et
      // seul un rechargement les alignera. Sans ce signal, un bénévole peut
      // travailler une journée entière sur une version périmée.
      .then(function () { return self.clients.matchAll({ type: 'window' }); })
      .then(function (clients) {
        clients.forEach(function (client) {
          client.postMessage({ type: 'NOUVELLE_VERSION', cache: CACHE });
        });
      })
  );
});

self.addEventListener('fetch', function (evenement) {
  const requete = evenement.request;

  // Ne JAMAIS intercepter les appels à l'API : les décisions d'accès doivent
  // se prendre sur la base IndexedDB, jamais sur une réponse HTTP mise en cache.
  if (requete.url.indexOf('script.google.com') !== -1 ||
      requete.url.indexOf('script.googleusercontent.com') !== -1) {
    return;
  }
  if (requete.method !== 'GET') return;

  evenement.respondWith(
    // Le cache de CETTE génération d'abord : c'est ce qui garantit que tous les
    // fichiers de la coque proviennent du même déploiement.
    caches.open(CACHE).then(function (cache) {
      return cache.match(requete).then(function (miseEnCache) {
        if (miseEnCache) return miseEnCache;

        // Fichier hors coque : réseau, avec `no-store` pour court-circuiter le
        // cache HTTP du navigateur, puis repli sur l'écran d'accueil hors ligne.
        return fetch(requete, { cache: 'no-store' })
          .then(function (reponse) {
            if (reponse && reponse.status === 200 && reponse.type === 'basic') {
              cache.put(requete, reponse.clone());
            }
            return reponse;
          })
          .catch(function () {
            return cache.match('index.html');
          });
      });
    })
  );
});
