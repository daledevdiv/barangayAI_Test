// ── SERVICE WORKER ────────────────────────────────────────────────────
// The app's whole claim is that it runs offline against a model on your own
// machine. That was only ever half true: the page itself came off the network
// every load, so a camp laptop with no signal got a blank screen — sql.js
// missing means no database means no app.
//
// This makes the claim true. Every file the shell needs is precached on the
// first visit; after that the page opens with the network unplugged, and the
// only thing that still needs to be reachable is the model endpoint itself
// (which is localhost anyway).
//
// Bump CACHE_VERSION whenever a shell file changes — the old cache is deleted
// on activate, so a stale app can never outlive a deploy.
// ─────────────────────────────────────────────────────────────────────

const CACHE_VERSION = 'v5';
const CACHE_NAME    = `barangay-ai-${CACHE_VERSION}`;

// The shell: everything required to boot and hold a conversation offline.
const PRECACHE = [
  './',
  'index.html',
  'styles.css',
  'db.js',
  'rag.js',
  'app/config.js',
  'app/sessions.js',
  'app/settings.js',
  'app/training.js',
  'app/onboarding.js',
  'app/models.js',
  'app/chat.js',
  'app/thinking.js',
  'app/publish.js',
  'app/init.js',
  // Third-party libraries (see vendor/README.md)
  'vendor/sql-wasm.js',
  'vendor/sql-wasm.wasm',
  'vendor/pdf.min.mjs',
  'vendor/pdf.worker.min.mjs',
  'vendor/mammoth.browser.min.js',
  'vendor/fonts.css',
  // One variable font per family covers every weight — see vendor/fonts.css.
  'vendor/fonts/plus-jakarta-sans-variable-latin.woff2',
  'vendor/fonts/jetbrains-mono-variable-latin.woff2',
  // Seeded knowledge source — fetched at runtime by app/training.js
  'assets/DEVCON-17-Brand-Kit-Aug-6-2026.md',
  'assets/logos/17_logo.png',
  'assets/logos/light_logo.png',
  'assets/logos/ollama_logo.png',
  'assets/logos/Qwen_logo.webp',
  'assets/logos/Meta_logo.png',
  'assets/logos/Mistral_logo.webp',
  'assets/logos/deepseek_logo.png',
  'assets/logos/gemma_logo.png',
  'assets/logos/hugging_face.png',
  'assets/logos/microsoft_logo.png',
  'assets/logos/open-ai_logo.png',
  'assets/logos/IBM_granite_logo.webp',
];

// Nice to have, not load-bearing. Kept out of PRECACHE because a 404 in there
// costs the whole offline shell, and none of this is worth that.
const PRECACHE_OPTIONAL = [
  'assets/poster.png',
];

// cache.addAll is atomic: one failed request and nothing is cached at all. That
// is the wrong trade here — the networks this app is built for are exactly the
// ones where a request out of thirty-five times out, and "your connection
// hiccuped, so you get no offline mode whatsoever" is a bad outcome. Try the
// atomic path first, then fall back to caching each file on its own so a single
// dropped request costs one file instead of the whole shell.
async function precache(cache, urls) {
  try {
    await cache.addAll(urls);
    return [];
  } catch {
    const failed = [];
    for (const u of urls) {
      try { await cache.add(u); } catch { failed.push(u); }
    }
    return failed;
  }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const failed = await precache(cache, PRECACHE);
    if (failed.length) {
      // Loud on purpose. A half-populated shell still works online and mostly
      // works offline, but someone debugging "why did it go blank on the plane"
      // needs to be able to find this.
      console.warn(`[SW] ${failed.length} shell file(s) not cached — offline mode is incomplete:`, failed);
    }
    await Promise.all(PRECACHE_OPTIONAL.map(u => cache.add(u).catch(() => {})));
    // A camp facilitator refreshing after an edit should get the edit, not a
    // worker sitting in "waiting" until every tab is closed.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter(n => n.startsWith('barangay-ai-') && n !== CACHE_NAME)
           .map(n => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

// Ask the network first, fall back to whatever was cached last time. For things
// that must be fresh when fresh is possible but must still exist when it isn't.
async function networkFirst(req, fallbackKey) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req))
        || (fallbackKey ? await cache.match(fallbackKey) : null)
        || Response.error();
  }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Cross-origin is the model endpoint, Tavily, or a link the student clicked —
  // none of it belongs in the app shell cache.
  if (url.origin !== self.location.origin) return;
  // Model traffic is never cached: a cached reply would be the same answer to
  // every question, forever.
  if (url.pathname.startsWith('/api')) return;

  // Navigations: try the network so a redeploy is picked up immediately, and
  // fall back to the cached shell when there's no signal. This is the request
  // that decides whether the app opens at all offline.
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, 'index.html'));
    return;
  }

  // A published AI's whole identity — name, persona, sources — lives in this
  // file. Network-first so republishing takes effect on the next load, but
  // cached as a fallback: serving it from cache offline is the difference
  // between "the owner's AI, currently unable to reach its model" and a
  // stranger's app wearing the default personality.
  if (url.pathname.endsWith('/my-ai.json')) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Everything else: cache-first (instant, works offline), refreshing the entry
  // in the background so the next load has the newer file.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(req);
    const network = fetch(req)
      .then(res => { if (res && res.ok) cache.put(req, res.clone()); return res; })
      .catch(() => null);
    return hit || (await network) || Response.error();
  })());
});
