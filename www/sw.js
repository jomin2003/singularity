// SINGULARITY -- retired service worker.
//
// The offline cache caused stale-build confusion during web debugging ("your
// changes didn't work", fixed bugs reappearing): a previously registered
// worker keeps serving its cached bundle even after the files on disk change.
// So this worker now removes itself: on install it skips waiting, on activate
// it deletes every cache from this origin and unregisters itself. The page
// (game.js boot) also unregisters workers directly, so both paths converge on
// "always load the build actually on disk".
// Nothing is lost: the Android app never used the worker -- Capacitor bundles
// www/ straight into the APK.
'use strict';

self.addEventListener('install', (e) => {
  e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.registration.unregister())
      .catch(() => {})
  );
});
