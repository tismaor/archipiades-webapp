/**
 * sw.js — Service Worker.
 *
 * Il ne met en cache QUE la coque applicative (HTML, CSS, JS). Les données
 * vivent dans IndexedDB, les photos aussi : mettre les réponses de l'API en
 * cache HTTP serait une faute — l'application servirait des droits d'accès
 * périmés sans que personne ne s'en aperçoive.
 *
 * Stratégie : réseau d'abord pour la coque (afin qu'une mise à jour soit prise
 * en compte), repli sur le cache si le réseau manque.
 */

'use strict';

/**
 * ⚠️ À INCRÉMENTER À CHAQUE MODIFICATION DE LA COQUE.
 *
 * Sans cela, un téléphone peut continuer d'exécuter l'ancien code — donc
 * d'appliquer d'anciennes règles d'accès — sans que personne ne s'en aperçoive.
 * C'est le même piège que le déploiement figé d'Apps Script, une couche plus bas.
 */
const CACHE = 'archipiades-coque-v8';

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
    // `no-store` court-circuite le cache HTTP du navigateur, qui sert sinon une
    // version périmée sans même contacter le serveur. Le surcoût est
    // négligeable — quelques kilo-octets — et le risque évité considérable :
    // une application qui applique des règles d'accès obsolètes.
    fetch(requete, { cache: 'no-store' })
      .then(function (reponse) {
        if (reponse && reponse.status === 200 && reponse.type === 'basic') {
          const copie = reponse.clone();
          caches.open(CACHE).then(function (cache) { cache.put(requete, copie); });
        }
        return reponse;
      })
      .catch(function () {
        return caches.match(requete).then(function (miseEnCache) {
          return miseEnCache || caches.match('index.html');
        });
      })
  );
});
