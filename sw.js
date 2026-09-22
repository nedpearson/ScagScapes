const CACHE='scagscapes-v18';
const ASSETS=['./','./index.html','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const u=new URL(e.request.url);
  if(u.origin!==location.origin){return}
  e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(CACHE).then(x=>x.put(e.request,c));return r}).catch(()=>caches.match(e.request).then(r=>r||caches.match('./index.html'))));
});
// Web Push (only fires when VAPID keys are configured server-side and the device subscribed)
self.addEventListener('push',e=>{let d={};try{d=e.data?e.data.json():{}}catch(x){d={body:e.data&&e.data.text()}}
  e.waitUntil(self.registration.showNotification(d.title||'Scag Scapes Command',{body:d.body||'',icon:'./icons/icon-192.png',badge:'./icons/icon-192.png',data:d.ref||null,tag:d.ref?d.ref.type+':'+d.ref.id:undefined}))});
self.addEventListener('notificationclick',e=>{e.notification.close();const ref=e.notification.data;const sec=ref&&ref.type==='breakdown'?'breakdowns':ref&&ref.type==='reservation'?'sourcing':ref&&ref.type==='job'?'jobs':'overview';
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{for(const c of cs){if('focus' in c){c.postMessage({open:sec,ref});return c.focus()}}return self.clients.openWindow('./#'+sec)}))});
