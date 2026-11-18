/* G360 service worker
 * ---------------------------------------------------------------------------------------------
 * Purpose: let the app reopen and work offline after one successful online visit.
 *
 * - Every path is RELATIVE to this file (self.registration.scope), so it works at a domain root
 *   or under a GitHub Pages project sub-path such as https://<user>.github.io/<repo>/.
 * - Only same-origin GET requests are ever handled or cached. Cross-origin requests (WhatsApp,
 *   shop / checkout / booking pages, externally hosted product images) are never intercepted
 *   and never cached.
 * - Only the app's own static files are cached. No patient data is stored here: progress lives
 *   in the page's localStorage, which this file never touches.
 * - Change CACHE_VERSION whenever you change this file or the static assets listed below.
 *   Older "rbg-" caches are cleaned up on activation, after their entries are copied forward
 *   so the app keeps working offline straight after an update.
 */
var CACHE_VERSION = "2026-11-09-1";
var CACHE_NAME = "rbg-shell-" + CACHE_VERSION;
var CACHE_PREFIX = "rbg-";
var NAV_TIMEOUT_MS = 4000;

// Static files that sit next to this file. The HTML page itself is added by the page at
// runtime (see the CACHE_PAGE message) so its file name never has to be hard-coded here.
var PRECACHE = [
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "icon-96.png",
  "icon-maskable-192.png",
  "icon-maskable-512.png",
  "apple-touch-icon.png",
  "favicon.ico",
  "favicon-32.png"
];

function scopeUrl(path){ return new URL(path || "./", self.registration.scope).href; }

self.addEventListener("install", function(event){
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){
      // Individual adds: a missing optional icon must not stop the worker installing.
      return Promise.all(PRECACHE.map(function(p){
        return cache.add(scopeUrl(p)).catch(function(){ /* optional asset missing */ });
      }));
    }).then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function(event){
  event.waitUntil(
    caches.keys().then(function(names){
      var old = names.filter(function(n){ return n.indexOf(CACHE_PREFIX) === 0 && n !== CACHE_NAME; });
      return caches.open(CACHE_NAME).then(function(fresh){
        // Copy forward anything the new cache does not have yet (notably the cached page).
        return Promise.all(old.map(function(name){
          return caches.open(name).then(function(oldCache){
            return oldCache.keys().then(function(reqs){
              return Promise.all(reqs.map(function(req){
                return fresh.match(req).then(function(hit){
                  if(hit) return null;
                  return oldCache.match(req).then(function(res){ return res ? fresh.put(req, res) : null; });
                });
              }));
            });
          });
        })).then(function(){
          return Promise.all(old.map(function(n){ return caches.delete(n); }));
        });
      });
    }).then(function(){ return self.clients.claim(); })
  );
});

// The page asks us to store itself (it knows its own URL, whatever the file is called).
self.addEventListener("message", function(event){
  var data = event.data || {};
  if(data.type !== "CACHE_PAGE" || typeof data.url !== "string") return;
  var target;
  try{ target = new URL(data.url, self.registration.scope); }catch(e){ return; }
  if(target.origin !== self.location.origin) return;           // never cache other origins
  target.hash = "";
  var source = event.source;
  event.waitUntil(
    fetch(target.href, { cache: "reload" }).then(function(res){
      if(!res || !res.ok) throw new Error("bad response");
      return caches.open(CACHE_NAME).then(function(cache){
        // Also keep a copy under the scope root so a launch of "./" works offline.
        return Promise.all([
          cache.put(target.href, res.clone()),
          cache.put(scopeUrl("./"), res.clone())
        ]);
      });
    }).then(function(){
      if(source) source.postMessage({ type: "PAGE_CACHED", ok: true });
    }).catch(function(){
      if(source) source.postMessage({ type: "PAGE_CACHED", ok: false });
    })
  );
});

function offlineFallback(){
  return new Response(
    "You are offline and G360 has not been saved for offline use on this device yet. " +
    "Open the app once while online, then it will work without a connection.",
    { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }
  );
}

// Network first (so updates arrive), falling back to the cached copy when offline or slow.
function navigationResponse(request){
  return caches.open(CACHE_NAME).then(function(cache){
    return new Promise(function(resolve){
      var settled = false;
      function fromCache(){
        return cache.match(request, { ignoreSearch: true })
          .then(function(hit){ return hit || cache.match(scopeUrl("./")); });
      }
      var timer = setTimeout(function(){
        fromCache().then(function(hit){ if(hit && !settled){ settled = true; resolve(hit); } });
      }, NAV_TIMEOUT_MS);
      fetch(request).then(function(res){
        clearTimeout(timer);
        if(res && res.ok && res.type === "basic"){ cache.put(request, res.clone()); }
        if(!settled){ settled = true; resolve(res); }
      }).catch(function(){
        clearTimeout(timer);
        if(settled) return;
        fromCache().then(function(hit){ settled = true; resolve(hit || offlineFallback()); });
      });
    });
  });
}

// Cache first with a background refresh for the app's static files.
function staticResponse(request){
  return caches.open(CACHE_NAME).then(function(cache){
    return cache.match(request).then(function(hit){
      var refresh = fetch(request).then(function(res){
        if(res && res.ok && res.type === "basic"){ cache.put(request, res.clone()); }
        return res;
      }).catch(function(){ return null; });
      return hit || refresh.then(function(res){ return res || offlineFallback(); });
    });
  });
}

self.addEventListener("fetch", function(event){
  var request = event.request;
  if(request.method !== "GET") return;
  var url = new URL(request.url);
  if(url.origin !== self.location.origin) return;               // external services: never touched
  if(url.pathname.slice(-5) === "sw.js") return;                // always let the browser update the worker itself
  if(request.mode === "navigate"){ event.respondWith(navigationResponse(request)); return; }
  event.respondWith(staticResponse(request));
});
