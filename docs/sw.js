// Ideario web app service worker.
// 1. `asset/<id>` → the image/file stored in IndexedDB by the app (src/webstore.ts).
// 2. Everything else from this site: network first, cached copy when offline.
const CACHE = 'ideario-shell-v3';
const SCOPE = self.registration.scope; // e.g. https://user.github.io/ideario/

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon.png']).catch(() => {}))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// One connection for every picture request (it used to open a new one each time and never close
// them), and it lets go as soon as the page needs to upgrade or delete the database.
let dbp = null;
function openDb() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('ideario', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('assets')) d.createObjectStore('assets');
    };
    req.onsuccess = () => {
      const d = req.result;
      d.onversionchange = () => {
        d.close();
        dbp = null;
      };
      resolve(d);
    };
    req.onerror = () => {
      dbp = null;
      reject(req.error);
    };
  });
  return dbp;
}

async function serveAsset(id, request) {
  const d = await openDb();
  const blob = await new Promise((resolve, reject) => {
    const r = d.transaction('assets', 'readonly').objectStore('assets').get(id);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  if (!blob) return new Response('Not found', { status: 404 });
  const headers = { 'Content-Type': blob.type || 'application/octet-stream', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
  // audio/video players ask for byte ranges
  const range = request.headers.get('range');
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (m) {
    const size = blob.size;
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
    if (!m[1] && m[2]) {
      start = size - parseInt(m[2], 10);
      end = size - 1;
    }
    return new Response(blob.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
    });
  }
  return new Response(blob, { headers: { ...headers, 'Content-Length': String(blob.size) } });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith(SCOPE)) return;
  const rel = req.url.slice(SCOPE.length).split(/[?#]/)[0];
  if (rel.startsWith('asset/')) {
    e.respondWith(serveAsset(decodeURIComponent(rel.slice(6)), req));
    return;
  }
  if (rel === 'sw.js') return;
  // the saved copy of a request: the exact file, or the app page for navigations
  const cached = async () => (await caches.match(req)) || (req.mode === 'navigate' ? await caches.match('./index.html') : undefined);
  e.respondWith(
    fetch(req)
      .then(async (res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        }
        // a missing or broken site (404/5xx) must not replace the working offline copy of the app:
        // the page and its scripts/styles keep coming from the cache
        if (!res.ok) return (await cached()) || res;
        return res;
      })
      .catch(async () => (await cached()) || Response.error()),
  );
});
