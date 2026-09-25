/* Service worker: offline app shell. Prices/FX are always fetched live (network-first, no cache). */
const CACHE = "portfolio-v13";
const SHELL = [
  "./","./index.html","./styles.css","./app.js","./engine.js","./data.json",
  "./chart.umd.min.js","./manifest.webmanifest",
  "./icons/icon-192.png","./icons/icon-512.png"
];

self.addEventListener("install", e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener("activate", e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener("fetch", e=>{
  const url=new URL(e.request.url);
  // never cache API calls (prices, fx, history) — always live
  if(url.hostname.includes("coingecko")||url.hostname.includes("coinbase")||url.hostname.includes("frankfurter")||url.hostname.includes("exchangerate")){
    return; // let it hit network directly
  }
  // app shell: cache-first, fall back to network
  e.respondWith(
    caches.match(e.request).then(r=> r || fetch(e.request).then(resp=>{
      const copy=resp.clone();
      if(e.request.method==="GET" && resp.status===200) caches.open(CACHE).then(c=>c.put(e.request,copy));
      return resp;
    }).catch(()=>caches.match("./index.html")))
  );
});
