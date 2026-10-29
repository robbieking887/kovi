/* Kovi web app: core. State, API, offline queue, caching, rendering. Features live in driver.js and admin.js. */
(() => {
'use strict';
const K = window.K = { s: { me: null, co: null, view: 'home', busy: false, err: '', authMode: 'pin', ck: null, ho: null, deep: null, cache: {}, queue: 0 }, views: {}, actions: {}, changes: {}, inputs: {}, tabs: [] };
const S = K.s;

/* ---------- helpers ---------- */
const $ = K.$ = s => document.querySelector(s);
K.esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
K.gbp = n => '£' + Number(n || 0).toFixed(2);
K.dt = s => s ? new Date(s).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
K.d = s => s ? new Date(String(s).slice(0, 10) + 'T12:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
K.toast = m => { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(K._tt); K._tt = setTimeout(() => t.classList.remove('on'), 3000); };
K.uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
const esc = K.esc;
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} };
K.lsGet = lsGet; K.lsSet = lsSet;

/* ---------- API ---------- */
K.token = lsGet('kovi_t') || '';
K.setToken = t => { K.token = t || ''; lsSet('kovi_t', t || null); };
K.api = async function api(method, url, body, raw, tok) {
  let r;
  try {
    r = await fetch(url, { method, headers: Object.assign({ Authorization: 'Bearer ' + (tok ?? K.token) }, raw ? { 'Content-Type': 'image/jpeg' } : body ? { 'Content-Type': 'application/json' } : {}), body: raw ? raw : body ? JSON.stringify(body) : undefined });
  } catch (e) { const er = new Error('No signal'); er.offline = true; throw er; }
  let j = null; try { j = await r.json(); } catch (e) {}
  if (!r.ok) { const e = new Error((j && j.error) || 'Something went wrong (' + r.status + ')'); e.status = r.status; throw e; }
  return j;
};
const api = K.api;
K.download = async (url, name) => {
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + K.token } });
  if (!r.ok) { let m = 'Download failed'; try { m = (await r.json()).error || m; } catch (e) {} throw new Error(m); }
  const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = name; document.body.appendChild(a); a.click(); a.remove();
};

/* ---------- cache: lets a driver start a check with no signal ---------- */
const readCache = () => { try { return JSON.parse(lsGet('kovi_cache') || '{}'); } catch (e) { return {}; } };
K.cacheGet = k => (readCache()[(S.co && S.co.id || '-') + ':' + k]);
K.cacheSet = (k, v) => { const c = readCache(); c[(S.co && S.co.id || '-') + ':' + k] = v; lsSet('kovi_cache', JSON.stringify(c)); };
K.cached = async (key, fn) => { try { const v = await fn(); K.cacheSet(key, v); return v; } catch (e) { if (e.offline) { const c = K.cacheGet(key); if (c) return c; } throw e; } };
K.vehicles = () => K.cached('vehicles', () => api('GET', '/api/vehicles'));
K.templates = () => K.cached('templates', () => api('GET', '/api/templates'));
K.vehicleDefects = id => K.cached('defects:' + id, () => api('GET', '/api/vehicles/' + id + '/defects')).catch(() => []);

/* ---------- offline queue (IndexedDB). Each item remembers WHO made it, so a shared phone never credits a check to the next driver. ---------- */
const idb = () => new Promise((res, rej) => { const r = indexedDB.open('kovi', 1); r.onupgradeneeded = () => r.result.createObjectStore('q', { keyPath: 'id' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
K.qput = async v => { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction('q', 'readwrite'); t.objectStore('q').put(v); t.oncomplete = res; t.onerror = () => rej(t.error); }); };
K.qall = async () => { try { const d = await idb(); return await new Promise(res => { const r = d.transaction('q').objectStore('q').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]); }); } catch (e) { return []; } };
K.qdel = async id => { const d = await idb(); return new Promise(res => { const t = d.transaction('q', 'readwrite'); t.objectStore('q').delete(id); t.oncomplete = res; }); };
async function sendItem(it) {
  const tok = it.tok || K.token;
  for (const p of it.photos || []) await api('POST', `/api/photos/${it.row.id}/${p.name}`, null, p.blob, tok);
  await api('POST', it.kind === 'handover' ? '/api/handovers' : '/api/checks', it.row, null, null, tok);
}
K.sendItem = sendItem;
let flushing = false;
K.flush = async function flush(quiet) {
  if (flushing || !navigator.onLine) return; flushing = true; let n = 0, stuck = 0, rejected = 0;
  try {
    for (const it of await K.qall()) {
      try { await sendItem(it); await K.qdel(it.id); n++; }
      catch (e) {
        if (e.offline || !e.status || e.status >= 500) break;                 // no signal or server trouble: try again later
        if (e.status === 401) { stuck++; continue; }                          // that person's login has expired or been switched off
        await K.qdel(it.id); rejected++;                                      // the server says it is not valid, so retrying cannot help
      }
    }
  } finally { flushing = false; }
  if (n) { K.toast(n + ' saved check' + (n > 1 ? 's' : '') + ' sent'); S.cache = {}; }
  if (rejected) K.toast(rejected + ' saved item(s) were rejected by the server');
  if (n || rejected || stuck) K.render();
};
window.addEventListener('online', () => K.flush());

/* ---------- boot / auth ---------- */
K.loadMe = async function () {
  if (!K.token) { S.me = S.co = null; return; }
  try { const r = await api('GET', '/api/me'); S.me = r.me; S.co = r.co; lsSet('kovi_me', JSON.stringify(r)); }
  catch (e) {
    if (e.status === 401) { K.setToken(''); S.me = S.co = null; }
    else if (e.offline) { try { const c = JSON.parse(lsGet('kovi_me') || 'null'); if (c) { S.me = c.me; S.co = c.co; } } catch (x) {} if (!S.me) throw e; }
    else throw e;
  }
};
K.run = async function run(fn) { if (S.busy) return; S.busy = true; S.err = ''; try { await fn(); } catch (e) { S.err = e.offline ? 'No signal. Try again when you are back online.' : (e.message || String(e)); } S.busy = false; K.render(); };
K.go = (view, keep) => { S.view = view; S.err = ''; if (!keep) S.cache.open = null; K.render(); };
K.signOut = () => { S.form = null; K.setToken(''); S.me = S.co = null; S.ck = null; S.ho = null; S.cache = {}; S.view = 'home'; S.authMode = lsGet('kovi_code') ? 'pin' : 'in'; if (K.stopSensors) K.stopSensors(); K.render(); };

/* ---------- render ---------- */
const isAdmin = K.isAdmin = () => S.me && S.me.role === 'admin';
K.shell = function shell(body) {
  const tabs = K.tabs.filter(t => (!t.admin || isAdmin()) && (!t.platform || S.me.is_platform_admin) && (!t.when || t.when()));
  const label = !S.me.email ? 'Switch driver' : 'Sign out';
  return `<header><b>KOVI</b><small>${esc(S.co ? S.co.name : '')}</small><span class="sp"></span><small>${esc(S.me.full_name || S.me.email)}</small><button class="b sec sm" data-a="out" style="color:#fff;border-color:#ffffff55">${label}</button></header>
  <nav>${tabs.map(t => `<button data-a="tab" data-v="${t.id}" class="${S.view === t.id ? 'on' : ''}">${t.label}${t.id === 'alerts' && S.cache.openAlerts ? ' (' + S.cache.openAlerts + ')' : ''}${t.id === 'defects' && S.cache.openDefects ? ' (' + S.cache.openDefects + ')' : ''}</button>`).join('')}</nav>
  <main>${S.err ? `<div class="err">${esc(S.err)}</div>` : ''}${body}${K.foot()}</main>`;
};
K.foot = () => `<p class="foot"><a href="/legal/terms" target="_blank" rel="noopener">Terms</a> · <a href="/legal/privacy" target="_blank" rel="noopener">Privacy</a> · <a href="/legal/driver-notice" target="_blank" rel="noopener">Driver notice</a></p>`;
let rt = 0;
K.render = async function render() {
  const app = $('#app'), my = ++rt;
  if (!S.me) { app.innerHTML = K.authView(); if (S.form) for (const [k, v] of Object.entries(S.form)) { const e = document.getElementById(k); if (e) { if (e.type === 'checkbox') e.checked = v; else e.value = v; } } return; }
  if (!S.co) { app.innerHTML = K.shell('<div class="card"><h2>No company yet</h2><p>Sign out and create or join a company.</p></div>'); return; }
  if (S.ck && S.view === 'check') { app.innerHTML = K.shell(K.checkView()); K.gate(); return; }
  if (S.ho && S.view === 'handover') { app.innerHTML = K.shell(K.handoverView()); K.afterRender(); return; }
  let body = '';
  try { body = await (K.views[S.view] || K.views.home)(); } catch (e) { body = `<div class="err">${esc(e.offline ? 'No signal, and this page needs it.' : e.message)}</div>`; }
  if (my !== rt) return;                                                      // a newer render has started; do not overwrite it
  app.innerHTML = K.shell(body); K.afterRender();
  if (isAdmin()) {
    api('GET', '/api/alerts/count').then(r => { if ((r.n || 0) !== S.cache.openAlerts) { S.cache.openAlerts = r.n || 0; const b = document.querySelector('nav [data-v="alerts"]'); if (b) b.textContent = 'Alerts' + (r.n ? ` (${r.n})` : ''); } }).catch(() => {});
    api('GET', '/api/defects/count').then(r => { if ((r.n || 0) !== S.cache.openDefects) { S.cache.openDefects = r.n || 0; const b = document.querySelector('nav [data-v="defects"]'); if (b) b.textContent = 'Defects' + (r.n ? ` (${r.n})` : ''); } }).catch(() => {});
  }
};
K.afterRender = () => { K.hydratePhotos(); if (K.after) K.after(); };

/* ---------- photos (office users only; fetched with their login) ---------- */
const photoCache = new Map();
K.photoBlobUrl = async p => { if (photoCache.has(p)) return photoCache.get(p); const r = await fetch('/api/photo?p=' + encodeURIComponent(p), { headers: { Authorization: 'Bearer ' + K.token } }); if (!r.ok) throw new Error('Photo not found'); const u = URL.createObjectURL(await r.blob()); photoCache.set(p, u); return u; };
K.hydratePhotos = () => document.querySelectorAll('img[data-p]').forEach(img => { if (img.src) return; K.photoBlobUrl(img.dataset.p).then(u => { img.src = u; }).catch(() => { img.alt = 'Photo not found'; }); });
K.shrink = file => new Promise((res, rej) => { const img = new Image(); img.onload = () => { const m = 1280, k = Math.min(1, m / Math.max(img.width, img.height)), c = document.createElement('canvas'); c.width = img.width * k; c.height = img.height * k; c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); c.toBlob(b => res(b), 'image/jpeg', .72); URL.revokeObjectURL(img.src); }; img.onerror = rej; img.src = URL.createObjectURL(file); });
K.pill = v => `<span class="pill ${v === 'pass' || v === 'fixed' ? 'ok' : v === 'defect' || v === 'major' || v === 'assigned' || v === 'minor' ? 'warn' : 'bad'}">${esc(v)}</span>`;

/* ---------- events: one listener each, actions are registered by name ---------- */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-a]'); if (!el) return;
  const fn = K.actions[el.dataset.a]; if (!fn) return;
  if (el.tagName === 'A') e.preventDefault();
  await fn(el, el.dataset, e);
});
document.addEventListener('change', async e => { const el = e.target, fn = el.dataset && K.changes[el.dataset.a]; if (fn) await fn(el, el.dataset, e); });
document.addEventListener('input', e => { const el = e.target, fn = el.dataset && K.inputs[el.dataset.a]; if (fn) fn(el, el.dataset, e); });

K.actions.out = () => K.signOut();
K.actions.tab = (el, d) => { if (S.ck || S.ho) { if (!confirm('Leave this? Your progress will be lost.')) return; if (K.stopSensors) K.stopSensors(); S.ck = S.ho = null; } K.go(d.v); };
K.actions.sync = () => K.flush();
})();
