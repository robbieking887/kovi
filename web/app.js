(() => {
'use strict';
const sb = supabase.createClient(KOVI.url, KOVI.key, { auth: { persistSession: true, autoRefreshToken: true } });
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gbp = n => '£' + Number(n || 0).toFixed(2);
const dt = s => s ? new Date(s).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const toast = m => { const t = $('#toast'); t.textContent = m; t.classList.add('on'); setTimeout(() => t.classList.remove('on'), 2600); };
const MAX_DIST = 50;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));

let me = null, co = null, view = 'home', tab = null, busy = false, ck = null, errMsg = '', authMode = 'in';
let cache = {};

/* ---------- offline queue (IndexedDB) ---------- */
const idb = () => new Promise((res, rej) => { const r = indexedDB.open('kovi', 1); r.onupgradeneeded = () => r.result.createObjectStore('q', { keyPath: 'id' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const qput = async v => { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction('q', 'readwrite'); t.objectStore('q').put(v); t.oncomplete = res; t.onerror = () => rej(t.error); }); };
const qall = async () => { const d = await idb(); return new Promise(res => { const r = d.transaction('q').objectStore('q').getAll(); r.onsuccess = () => res(r.result); }); };
const qdel = async id => { const d = await idb(); return new Promise(res => { const t = d.transaction('q', 'readwrite'); t.objectStore('q').delete(id); t.oncomplete = res; }); };

async function submitRow(row, photos) {
  for (const p of photos) {
    const { error } = await sb.storage.from('check-photos').upload(p.path, p.blob, { contentType: 'image/jpeg', upsert: true });
    if (error) throw error;
  }
  const { error } = await sb.from('checks').upsert(row, { onConflict: 'id', ignoreDuplicates: true });
  if (error) throw error;
}
async function flush() {
  if (!navigator.onLine || !me) return;
  let n = 0;
  for (const q of await qall()) { try { await submitRow(q.row, q.photos); await qdel(q.id); n++; } catch (e) { console.warn('sync failed', e); break; } }
  if (n) { toast(n + ' saved check' + (n > 1 ? 's' : '') + ' synced'); cache = {}; render(); }
}
window.addEventListener('online', flush);

/* ---------- sensors ---------- */
const sens = { pos: null, heading: null, watch: null, on: false };
async function startSensors() {
  if (sens.on) return; sens.on = true;
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') await DeviceOrientationEvent.requestPermission();
  } catch (e) {}
  const h = e => {
    if (typeof e.webkitCompassHeading === 'number') sens.heading = e.webkitCompassHeading;
    else if (e.absolute && e.alpha != null) sens.heading = (360 - e.alpha) % 360;
    else if (e.alpha != null) sens.heading = (360 - e.alpha) % 360;
    onSensor();
  };
  window.addEventListener('deviceorientationabsolute', h, true);
  window.addEventListener('deviceorientation', h, true);
  if (navigator.geolocation) sens.watch = navigator.geolocation.watchPosition(p => { sens.pos = p.coords; onSensor(); }, () => {}, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
}
function stopSensors() { if (sens.watch != null) navigator.geolocation.clearWatch(sens.watch); sens.watch = null; sens.on = false; sens.pos = null; }
const dist = (a, b) => { const R = 6371000, r = x => x * Math.PI / 180, dLa = r(b.latitude - a.latitude), dLo = r(b.longitude - a.longitude); const x = Math.sin(dLa / 2) ** 2 + Math.cos(r(a.latitude)) * Math.cos(r(b.latitude)) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
function onSensor() {
  if (!ck) return;
  if (sens.pos) {
    if (!ck.pos0 && sens.pos.accuracy < 80) ck.pos0 = { latitude: sens.pos.latitude, longitude: sens.pos.longitude, accuracy: sens.pos.accuracy };
    if (ck.pos0) ck.maxDist = Math.max(ck.maxDist, dist(ck.pos0, sens.pos));
  }
  const sec = curSection();
  if (sec && sec.walk && sens.heading != null) {
    if (ck.h0 == null) ck.h0 = sens.heading;
    ck.sectors.add(Math.floor(((sens.heading - ck.h0 + 360) % 360) / 90));
    const d = $('#dial'); if (d) d.innerHTML = dialSvg();
    const c = $('#cov'); if (c) c.textContent = ck.sectors.size + '/4 sides';
    gate();
  }
  const g = $('#gps'); if (g) g.textContent = gpsText();
}
const gpsText = () => !navigator.geolocation ? 'No GPS on this device' : !sens.pos ? 'Finding GPS…' : 'GPS ±' + Math.round(sens.pos.accuracy) + ' m' + (ck && ck.pos0 ? ' · ' + Math.round(sens.pos ? dist(ck.pos0, sens.pos) : 0) + ' m from vehicle' : '');
const dialSvg = () => { let s = '<svg viewBox="-75 -75 150 150">'; for (let i = 0; i < 4; i++) { const a0 = i * 90 - 90, a1 = a0 + 90, p = a => [65 * Math.cos(a * Math.PI / 180), 65 * Math.sin(a * Math.PI / 180)]; const [x0, y0] = p(a0 + 2), [x1, y1] = p(a1 - 2); s += `<path d="M${x0} ${y0}A65 65 0 0 1 ${x1} ${y1}" stroke="${ck.sectors.has(i) ? '#12a150' : '#98a2b3'}" stroke-width="10" fill="none" stroke-linecap="round"/>`; } return s + '</svg>'; };

/* ---------- auth + boot ---------- */
async function loadMe() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { me = null; co = null; return; }
  const { data: p } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
  me = p || { id: session.user.id, company_id: null, email: session.user.email, role: 'driver' };
  if (me.company_id) { const { data: c } = await sb.from('companies').select('*').eq('id', me.company_id).maybeSingle(); co = c; }
}
async function run(fn) { if (busy) return; busy = true; errMsg = ''; try { await fn(); } catch (e) { errMsg = e.message || String(e); } busy = false; render(); }

/* ---------- render ---------- */
const isAdmin = () => me && me.role === 'admin';
function shell(body) {
  const tabs = [];
  if (me.is_platform_admin) tabs.push(['platform', 'Platform']);
  if (co) { tabs.push(['home', 'Check'], ['hist', 'My checks']); if (isAdmin()) tabs.push(['today', 'Today'], ['alerts', 'Alerts'], ['vehicles', 'Vehicles'], ['people', 'People'], ['checklist', 'Checklist'], ['billing', 'Billing']); }
  return `<header><b>KOVI</b><small>${esc(co ? co.name : '')}</small><span class="sp"></span><small>${esc(me.full_name || me.email)}</small><button class="b sec sm" data-a="out" style="color:#fff;border-color:#ffffff55">Sign out</button></header>
  <nav>${tabs.map(t => `<button data-a="tab" data-v="${t[0]}" class="${view === t[0] ? 'on' : ''}">${t[1]}${t[0] === 'alerts' && cache.openAlerts ? ' (' + cache.openAlerts + ')' : ''}</button>`).join('')}</nav>
  <main>${errMsg ? `<div class="err">${esc(errMsg)}</div>` : ''}${body}</main>`;
}
function authView() {
  const f = authMode;
  return `<header><b>KOVI</b><small>Fleet walkaround checks</small></header><main>
  <div class="card"><h1>${f === 'in' ? 'Sign in' : f === 'co' ? 'Set up your company' : 'Join as a driver'}</h1>
  ${errMsg ? `<div class="err">${esc(errMsg)}</div>` : ''}
  ${f !== 'in' ? `<label>Your name</label><input id="nm" autocomplete="name">` : ''}
  ${f === 'co' ? `<label>Company name</label><input id="cn">` : ''}
  ${f === 'dr' ? `<label>Company code (ask your manager)</label><input id="cc" autocapitalize="characters">` : ''}
  <label>Email</label><input id="em" type="email" autocomplete="email">
  <label>Password</label><input id="pw" type="password" autocomplete="${f === 'in' ? 'current-password' : 'new-password'}">
  <button class="b full" data-a="auth">${f === 'in' ? 'Sign in' : 'Create account'}</button></div>
  <p class="mut" style="text-align:center">${f !== 'in' ? '<a href="#" data-a="mode" data-v="in">I already have a login</a><br>' : ''}${f !== 'co' ? '<a href="#" data-a="mode" data-v="co">Company owner? Create your company</a><br>' : ''}${f !== 'dr' ? '<a href="#" data-a="mode" data-v="dr">Driver? Join with a company code</a>' : ''}</p></main>`;
}
async function render() {
  const app = $('#app');
  if (!me) { app.innerHTML = authView(); return; }
  if (!co && !me.is_platform_admin) { app.innerHTML = shell('<div class="card"><h2>No company yet</h2><p>Sign out and create or join a company.</p></div>'); return; }
  if (ck && view === 'check') { app.innerHTML = shell(checkView()); gate(); return; }
  let body = '';
  try { body = await ({ home: homeView, hist: histView, today: todayView, alerts: alertsView, vehicles: vehiclesView, people: peopleView, checklist: checklistView, billing: billingView, platform: platformView }[view] || homeView)(); } catch (e) { body = `<div class="err">${esc(e.message)}</div>`; }
  app.innerHTML = shell(body);
  if (isAdmin()) sb.from('alerts').select('id', { count: 'exact', head: true }).eq('resolved', false).then(r => { const n = r.count || 0; if (n !== cache.openAlerts) { cache.openAlerts = n; const b = document.querySelector('nav [data-v="alerts"]'); if (b) b.textContent = 'Alerts' + (n ? ' (' + n + ')' : ''); } });
}

/* ---------- driver ---------- */
async function vehicles() { const { data } = await sb.from('vehicles').select('*').eq('company_id', co.id).is('removed_on', null).order('reg'); return data || []; }
async function homeView() {
  const vs = await vehicles(); const q = (await qall()).length;
  return `<h1>Select your vehicle</h1>${q ? `<div class="warn">${q} check${q > 1 ? 's' : ''} saved on this phone, waiting for signal. <a href="#" data-a="sync">Try now</a></div>` : ''}
  <input id="vq" placeholder="Search reg…" data-a="filter">
  <div class="card" id="vlist">${vs.length ? vs.map(v => `<div class="item vi" data-reg="${esc(v.reg)}"><div class="t"><b>${esc(v.reg)}</b><div class="mut">${esc(v.type)}</div></div><button class="b sm" data-a="start" data-id="${v.id}">Start check</button></div>`).join('') : '<p class="mut">No vehicles yet. ' + (isAdmin() ? 'Add one under Vehicles.' : 'Ask your manager to add vehicles.') + '</p>'}</div>`;
}
const curSection = () => ck && typeof ck.step === 'number' && ck.step >= 1 && ck.step <= co.checklist.length ? co.checklist[ck.step - 1] : null;
function checkView() {
  const secs = co.checklist, n = secs.length + 2, i = ck.step === 'fin' ? n - 1 : ck.step, pct = Math.round(i / (n - 1) * 100);
  let h = `<div class="row"><h1 style="flex:1">${esc(ck.vehicle.reg)}</h1><button class="b sec sm n" data-a="cancel">Cancel</button></div><div class="prog"><i style="width:${pct}%"></i></div><div class="mut" id="gps">${gpsText()}</div>`;
  if (ck.step === 0) {
    h += `<div class="card"><h2>Before you start</h2>
    <label>1. Photo of the reg plate (required)</label><input type="file" accept="image/*" capture="environment" id="plate" data-a="plate">${ck.plateUrl ? `<img class="photo" src="${ck.plateUrl}">` : ''}
    <label>2. Licence & CPC valid?</label><div class="seg">${['Yes', 'No', 'N/A'].map(x => `<button data-a="lic" data-v="${x}" class="${ck.licence === x ? 'on ' + (x === 'No' ? 'd' : 'p') : ''}">${x}</button>`).join('')}</div>
    <label style="display:block;margin-top:10px">3. Mileage</label><input id="mil" inputmode="numeric" value="${esc(ck.mileage)}">
    </div><button class="b full" data-a="next" id="nx">Start walkaround</button>`;
  } else if (ck.step === 'fin') {
    h += `<div class="card"><h2>Finish</h2><label>Extra photos (optional)</label><input type="file" accept="image/*" capture="environment" data-a="xphoto">${ck.extra.map(u => `<img class="photo" src="${u.url}">`).join('')}
    <label style="display:block;margin-top:10px">Notes</label><textarea id="notes" rows="3">${esc(ck.notes)}</textarea>
    <label style="display:flex;gap:8px;align-items:flex-start;font-weight:400;color:var(--ink)"><input type="checkbox" style="width:auto;margin:3px 0" data-a="d1" ${ck.d1 ? 'checked' : ''}>I have walked round and checked this vehicle myself.</label>
    <label style="display:flex;gap:8px;align-items:flex-start;font-weight:400;color:var(--ink)"><input type="checkbox" style="width:auto;margin:3px 0" data-a="d2" ${ck.d2 ? 'checked' : ''}>I have reported every defect I found.</label></div>
    <button class="b full" data-a="submit" id="nx" ${ck.d1 && ck.d2 ? '' : 'disabled'}>Submit check</button>`;
  } else {
    const s = secs[ck.step - 1], r = ck.res[s.id];
    h += `<div class="card"><h2>${esc(s.title)}</h2>${s.walk ? `<p class="mut">Walk all the way round the vehicle. Keep your phone with you.</p><div class="dial" id="dial">${dialSvg()}</div><p style="text-align:center" class="mut" id="cov">${ck.sectors.size}/4 sides</p>` : ''}
    <button class="b sec full" data-a="allok" style="margin-bottom:8px">✓ Everything OK in this section</button>
    ${s.items.map((it, j) => { const st = r[j]; return `<div class="item" style="flex-wrap:wrap"><div class="t">${esc(it)}</div><div class="seg" style="width:150px"><button data-a="pd" data-j="${j}" data-v="p" class="${st && st.ok ? 'on p' : ''}">Pass</button><button data-a="pd" data-j="${j}" data-v="d" class="${st && !st.ok ? 'on d' : ''}">Defect</button></div>
      ${st && !st.ok ? `<div style="width:100%"><select data-a="sev" data-j="${j}"><option ${st.sev === 'minor' ? 'selected' : ''} value="minor">Minor (monitor)</option><option ${st.sev === 'major' ? 'selected' : ''} value="major">Major (fix soon)</option><option ${st.sev === 'danger' ? 'selected' : ''} value="danger">Dangerous (do not drive)</option></select><input placeholder="What is wrong? (required)" value="${esc(st.note)}" data-a="dnote" data-j="${j}"><input type="file" accept="image/*" capture="environment" data-a="dphoto" data-j="${j}">${st.url ? `<img class="photo" src="${st.url}">` : ''}</div>` : ''}</div>`; }).join('')}</div>
    <div class="warn" id="lock"></div><button class="b full" data-a="next" id="nx" disabled>Next</button>`;
  }
  return h;
}
function gate() {
  if (!ck) return; const nx = $('#nx'); if (!nx) return;
  if (ck.step === 0) { nx.disabled = !(ck.plate && ck.licence); return; }
  if (ck.step === 'fin') return;
  const s = secs(), r = ck.res[s.id], left = Math.max(0, Math.ceil((ck.lockUntil - Date.now()) / 1000));
  let why = '';
  if (left > 0) why = `Take your time: ${left}s left on this page.`;
  else if (r.some(x => !x)) why = 'Mark every item Pass or Defect (or use "Everything OK").';
  else if (r.some(x => x && !x.ok && !(x.note || '').trim())) why = 'Describe each defect.';
  else if (s.walk && ck.sectors.size < 4 && sens.heading != null) why = 'Keep walking round the vehicle — ' + ck.sectors.size + '/4 sides.';
  const L = $('#lock'); if (L) { L.style.display = why ? '' : 'none'; L.textContent = why; }
  nx.disabled = !!why;
  if (left > 0 && !ck.tm) ck.tm = setTimeout(() => { ck.tm = null; gate(); }, 500);
}
const secs = () => co.checklist[ck.step - 1];
function enterStep(n) { ck.step = n; if (typeof n === 'number' && n >= 1) { const s = co.checklist[n - 1]; ck.lockUntil = Date.now() + (s.secs || 0) * 1000; if (!ck.res[s.id]) ck.res[s.id] = s.items.map(() => null); } }
function shrink(file) { return new Promise((res, rej) => { const img = new Image(); img.onload = () => { const m = 1280, k = Math.min(1, m / Math.max(img.width, img.height)), c = document.createElement('canvas'); c.width = img.width * k; c.height = img.height * k; c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); c.toBlob(b => res(b), 'image/jpeg', .72); URL.revokeObjectURL(img.src); }; img.onerror = rej; img.src = URL.createObjectURL(file); }); }

async function submitCheck() {
  const ended = Date.now(), secsTaken = Math.round((ended - ck.t0) / 1000), flags = [];
  if (!ck.plate) flags.push('no_plate');
  if (!ck.pos0) flags.push('no_gps'); else if (ck.maxDist > MAX_DIST) flags.push('far');
  if (sens.heading == null || ck.sectors.size < 4) flags.push('no_walk');
  const minTotal = Math.max(co.min_total_secs || 0, co.checklist.reduce((a, s) => a + (s.secs || 0), 0));
  if (secsTaken < minTotal) flags.push('too_fast');
  const defects = [], results = {}, photos = [];
  const base = `${co.id}/${ck.id}/`;
  photos.push({ path: base + 'plate.jpg', blob: ck.plate });
  ck.extra.forEach((x, i) => photos.push({ path: base + 'extra' + i + '.jpg', blob: x.blob }));
  co.checklist.forEach(s => { results[s.id] = ck.res[s.id].map((x, j) => {
    if (!x.ok) { let p = null; if (x.blob) { p = base + s.id + '-' + j + '.jpg'; photos.push({ path: p, blob: x.blob }); } defects.push({ section: s.title, item: s.items[j], severity: x.sev || 'minor', note: x.note, photo: p }); }
    return x.ok ? 1 : 0; }); });
  const row = { id: ck.id, company_id: co.id, vehicle_id: ck.vehicle.id, driver_id: me.id, started_at: new Date(ck.t0).toISOString(), finished_at: new Date(ended).toISOString(),
    start_lat: ck.pos0 && ck.pos0.latitude, start_lng: ck.pos0 && ck.pos0.longitude, start_acc: ck.pos0 && ck.pos0.accuracy, end_lat: sens.pos && sens.pos.latitude, end_lng: sens.pos && sens.pos.longitude,
    distance_m: Math.round(ck.maxDist), heading_coverage: ck.sectors.size, duration_secs: secsTaken, plate_photo: base + 'plate.jpg', licence: ck.licence, mileage: parseInt(ck.mileage) || null,
    results, defects, notes: ck.notes, flags, verdict: flags.length ? 'flagged' : defects.length ? 'defect' : 'pass' };
  let saved = true;
  try { if (!navigator.onLine) throw new Error('offline'); await submitRow(row, photos); } catch (e) { saved = false; await qput({ id: row.id, row, photos }); }
  const out = { row, saved }; stopSensors(); ck = null; view = 'result'; cache.result = out;
}
function resultView() {
  const { row, saved } = cache.result, f = { no_gps: 'No GPS fix', far: 'Moved too far from the vehicle', no_walk: 'Compass did not show a full walk round', too_fast: 'Finished faster than the minimum time', no_plate: 'No plate photo' };
  return `<div class="card" style="text-align:center"><div class="big" style="color:${row.verdict === 'pass' ? 'var(--ok)' : row.verdict === 'defect' ? 'var(--warn)' : 'var(--bad)'}">${row.verdict === 'pass' ? '✓ Check complete' : row.verdict === 'defect' ? '⚠ Check complete with defects' : '⚠ Check flagged'}</div>
  <p class="mut">${saved ? 'Saved. Your office can see it now.' : 'No signal. Saved on this phone and will upload automatically.'}</p>
  ${row.flags.length ? `<div class="warn" style="text-align:left">The office has been told:<br>${row.flags.map(x => '• ' + f[x]).join('<br>')}</div>` : ''}
  ${row.defects.length ? `<p>${row.defects.length} defect(s) reported</p>` : ''}<button class="b full" data-a="tab" data-v="home">Done</button></div>`;
}
async function histView() {
  const { data } = await sb.from('checks').select('*, vehicles(reg)').eq('driver_id', me.id).order('started_at', { ascending: false }).limit(30);
  return `<h1>My checks</h1><div class="card">${(data || []).map(c => `<div class="item"><div class="t"><b>${esc(c.vehicles && c.vehicles.reg)}</b><div class="mut">${dt(c.started_at)}</div></div>${pill(c.verdict)}</div>`).join('') || '<p class="mut">None yet.</p>'}</div>`;
}
const pill = v => `<span class="pill ${v === 'pass' ? 'ok' : v === 'defect' ? 'warn' : 'bad'}">${v}</span>`;

/* ---------- admin ---------- */
async function todayView() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const [vs, cs] = await Promise.all([vehicles(), sb.from('checks').select('*, vehicles(reg), profiles(full_name)').gte('started_at', start.toISOString()).order('started_at', { ascending: false })]);
  const checks = cs.data || [], done = new Set(checks.map(c => c.vehicle_id)), missing = vs.filter(v => !done.has(v.id));
  const open = cache.open;
  return `<h1>Today</h1><div class="grid"><div class="card"><div class="big">${done.size}/${vs.length}</div><div class="mut">vehicles checked</div></div><div class="card"><div class="big">${checks.filter(c => c.verdict !== 'pass' && !c.fixed).length}</div><div class="mut">need attention</div></div></div>
  ${missing.length ? `<div class="card"><h2>Not checked yet</h2><p class="mut">${missing.map(v => esc(v.reg)).join(', ')}</p></div>` : ''}
  <div class="card"><h2>Checks</h2>${checks.map(c => `<div class="item" style="flex-wrap:wrap"><div class="t" data-a="open" data-id="${c.id}"><b>${esc(c.vehicles.reg)}</b> · ${esc(c.profiles && c.profiles.full_name)}<div class="mut">${dt(c.started_at)} · ${c.duration_secs}s · ${c.heading_coverage}/4 sides · ${c.distance_m} m${c.fixed ? ' · fixed' : ''}</div></div>${pill(c.verdict)}
  ${open === c.id ? `<div style="width:100%" class="mut">${(c.flags || []).map(f => '<div>⚑ ' + esc(f) + '</div>').join('')}${(c.defects || []).map(d => `<div><b>${esc(d.severity)}</b> ${esc(d.section)} – ${esc(d.item)}: ${esc(d.note)} ${d.photo ? `<a href="#" data-a="photo" data-p="${esc(d.photo)}">photo</a>` : ''}</div>`).join('')}<div><a href="#" data-a="photo" data-p="${esc(c.plate_photo)}">Reg photo</a> ${c.start_lat ? `· <a target="_blank" rel="noopener" href="https://www.google.com/maps?q=${c.start_lat},${c.start_lng}">Map</a>` : ''} ${c.notes ? '· ' + esc(c.notes) : ''}</div>${c.verdict !== 'pass' && !c.fixed ? `<button class="b sm" data-a="fix" data-id="${c.id}">Mark as fixed</button>` : ''}</div>` : ''}</div>`).join('') || '<p class="mut">No checks yet today.</p>'}</div>`;
}
async function alertsView() {
  const { data } = await sb.from('alerts').select('*').order('created_at', { ascending: false }).limit(60);
  return `<h1>Alerts</h1><div class="card">${(data || []).map(a => `<div class="item"><div class="t" style="${a.resolved ? 'opacity:.5' : ''}">${esc(a.message)}<div class="mut">${dt(a.created_at)}</div></div>${a.resolved ? '' : `<button class="b sm sec" data-a="resolve" data-id="${a.id}">Done</button>`}</div>`).join('') || '<p class="mut">All quiet.</p>'}</div>`;
}
async function vehiclesView() {
  const { data } = await sb.from('vehicles').select('*').eq('company_id', co.id).order('reg');
  const act = (data || []).filter(v => !v.removed_on);
  return `<h1>Vehicles</h1><div class="card"><div class="row"><input id="reg" placeholder="Reg e.g. AB12 CDE" autocapitalize="characters"><select id="vt" class="n" style="width:auto">${['Truck', 'Lorry', 'Van', 'Car', 'Trailer', 'Other'].map(t => `<option>${t}</option>`).join('')}</select></div><button class="b full" data-a="addveh">Add vehicle (£${co.weekly_price}/week)</button><p class="mut">Billed per week started, from the day you add it. Remove it any time to stop the charge.</p></div>
  <div class="card"><h2>${act.length} active</h2>${act.map(v => `<div class="item"><div class="t"><b>${esc(v.reg)}</b><div class="mut">${esc(v.type)} · added ${v.added_on}</div></div><button class="b sm sec" data-a="rmveh" data-id="${v.id}">Remove</button></div>`).join('')}</div>`;
}
async function peopleView() {
  const { data } = await sb.from('profiles').select('*').eq('company_id', co.id).order('full_name');
  return `<h1>People</h1><div class="card"><h2>Driver sign-up code</h2><div class="big" style="letter-spacing:3px">${esc(co.join_code)}</div><p class="mut">Give this to each driver. They open the app, tap "Driver? Join with a company code", and make their own login. Everyone here is free.</p></div>
  <div class="card">${(data || []).map(p => `<div class="item"><div class="t"><b>${esc(p.full_name)}</b>${p.id === me.id ? ' (you)' : ''}<div class="mut">${esc(p.email)} · ${p.role}${p.active ? '' : ' · disabled'}</div></div>${p.id === me.id ? '' : `<button class="b sm sec" data-a="role" data-id="${p.id}" data-v="${p.role === 'admin' ? 'driver' : 'admin'}">Make ${p.role === 'admin' ? 'driver' : 'admin'}</button><button class="b sm sec" data-a="active" data-id="${p.id}" data-v="${!p.active}">${p.active ? 'Disable' : 'Enable'}</button>`}</div>`).join('')}</div>`;
}
async function checklistView() {
  return `<h1>Checklist</h1>${co.checklist.map((s, i) => `<div class="card"><div class="row"><input data-a="stitle" data-i="${i}" value="${esc(s.title)}"><label class="n" style="white-space:nowrap">Min secs <input type="number" data-a="ssecs" data-i="${i}" value="${s.secs}" style="width:70px;display:inline-block"></label></div>
  ${s.items.map((t, j) => `<div class="item"><div class="t">${esc(t)}</div><button class="b sm sec" data-a="delitem" data-i="${i}" data-j="${j}">✕</button></div>`).join('')}
  <div class="row"><input id="ni${i}" placeholder="Add item"><button class="b sm n" data-a="additem" data-i="${i}">Add</button></div></div>`).join('')}
  <div class="card"><h2>Emails & billing</h2><label>Send alerts to</label><input id="ae" type="email" value="${esc(co.alert_email)}"><label>Invoices to</label><input id="be" type="email" value="${esc(co.billing_email)}"><label>Minimum total check time (seconds)</label><input id="mt" type="number" value="${co.min_total_secs}"><button class="b full" data-a="savesettings">Save settings</button></div>`;
}
async function billingView() {
  const [{ data: u }, { data: inv }] = await Promise.all([sb.rpc('usage_now'), sb.from('invoices').select('*').order('period', { ascending: false })]);
  const sub = u.subtotal, vat = u.vat_on ? Math.round(sub * u.vat_rate * 100) / 100 : 0;
  return `<h1>Billing</h1><div class="card"><h2>This month so far</h2><table class="tbl"><tr><th>Vehicle</th><th class="r">Weeks</th><th class="r">£</th></tr>${u.rows.map(r => `<tr><td>${esc(r.reg)}<div class="mut">${r.added}${r.removed ? ' → ' + r.removed : ''}</div></td><td class="r">${r.weeks}</td><td class="r">${(r.weeks * u.price).toFixed(2)}</td></tr>`).join('')}<tr><td>Subtotal</td><td class="r">${u.weeks}</td><td class="r">${sub.toFixed(2)}</td></tr>${u.vat_on ? `<tr><td>VAT ${u.vat_rate * 100}%</td><td></td><td class="r">${vat.toFixed(2)}</td></tr>` : ''}<tr><th>Total</th><th></th><th class="r">${(sub + vat).toFixed(2)}</th></tr></table><p class="mut">£${u.price} per vehicle per week. Any week started counts as a full week. Invoiced monthly in arrears.</p></div>
  <div class="card"><h2>Invoices</h2>${(inv || []).map(i => `<div class="item"><div class="t"><b>${i.number}</b><div class="mut">${i.period.slice(0, 7)} · ${i.weeks} vehicle-weeks · due ${i.due_on}</div></div><div>${gbp(i.total)}</div><span class="pill ${i.status === 'paid' ? 'ok' : 'warn'}">${i.status}</span><button class="b sm sec" data-a="printinv" data-id="${i.id}">View</button></div>`).join('') || '<p class="mut">First invoice is raised on the 1st of next month.</p>'}</div>`;
}
async function platformView() {
  const [{ data: cos }, { data: inv }] = await Promise.all([sb.from('companies').select('*').order('created_at'), sb.from('invoices').select('*, companies(name)').order('period', { ascending: false })]);
  return `<h1>Platform</h1><div class="card"><h2>Monthly billing</h2><p class="mut">Runs automatically on the 1st. You can run last month now (safe to repeat).</p><button class="b" data-a="runbill">Generate last month's invoices</button></div>
  <div class="card"><h2>${(cos || []).length} customers</h2>${(cos || []).map(c => `<div class="item"><div class="t"><b>${esc(c.name)}</b><div class="mut">${esc(c.billing_email)}</div></div></div>`).join('')}</div>
  <div class="card"><h2>Invoices</h2>${(inv || []).map(i => `<div class="item"><div class="t"><b>${i.number}</b> ${esc(i.companies && i.companies.name)}<div class="mut">${i.period.slice(0, 7)}</div></div><div>${gbp(i.total)}</div>${i.status === 'unpaid' ? `<button class="b sm" data-a="markpaid" data-id="${i.id}">Mark paid</button>` : '<span class="pill ok">paid</span>'}</div>`).join('')}</div>`;
}
async function printInv(id) {
  const { data: i } = await sb.from('invoices').select('*').eq('id', id).single();
  const w = window.open('', '_blank'); if (!w) return toast('Allow pop-ups to view the invoice');
  w.document.write(`<title>${i.number}</title><body style="font:15px system-ui;max-width:640px;margin:30px auto"><h1>Invoice ${i.number}</h1><p><b>${esc(co.name)}</b><br>Period ${i.period.slice(0, 7)} · Issued ${i.issued_on} · Due ${i.due_on}</p><table width="100%" cellpadding="6" style="border-collapse:collapse"><tr style="border-bottom:1px solid #000"><th align=left>Vehicle</th><th>Weeks</th><th align=right>£</th></tr>${i.lines.map(l => `<tr><td>${esc(l.reg)} (${esc(l.type)})</td><td align=center>${l.weeks}</td><td align=right>${Number(l.amount).toFixed(2)}</td></tr>`).join('')}</table><p align=right>Subtotal ${gbp(i.subtotal)}<br>VAT ${gbp(i.vat)}<br><b>Total ${gbp(i.total)}</b></p><p>Status: ${i.status}</p><script>print()<\/script>`);
  w.document.close();
}

/* ---------- events ---------- */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-a]'); if (!el) return; const a = el.dataset.a, d = el.dataset;
  if (el.tagName === 'A') e.preventDefault();
  if (['filter', 'plate', 'xphoto', 'dphoto', 'sev', 'dnote', 'd1', 'd2', 'stitle', 'ssecs'].includes(a) && el.tagName !== 'BUTTON' && a !== 'd1' && a !== 'd2') return;
  if (a === 'd1' || a === 'd2') return;
  if (a === 'mode') { authMode = d.v; errMsg = ''; return render(); }
  if (a === 'auth') return run(doAuth);
  if (a === 'out') { await sb.auth.signOut(); me = co = null; ck = null; cache = {}; return render(); }
  if (a === 'tab') { view = d.v; errMsg = ''; cache.open = null; return render(); }
  if (a === 'sync') return flush();
  if (a === 'start') return run(async () => {
    const v = (await vehicles()).find(x => x.id === d.id); await startSensors();
    ck = { vehicle: v, id: uuid(), t0: Date.now(), step: 0, pos0: null, maxDist: 0, sectors: new Set(), h0: null, res: {}, defects: [], extra: [], mileage: '', notes: '' }; view = 'check'; onSensor();
  });
  if (a === 'cancel') { if (confirm('Cancel this check?')) { stopSensors(); ck = null; view = 'home'; render(); } return; }
  if (a === 'lic') { ck.licence = d.v; return render(); }
  if (a === 'allok') { const s = secs(); ck.res[s.id] = s.items.map(() => ({ ok: true })); return render(); }
  if (a === 'pd') { const s = secs(), j = +d.j; ck.res[s.id][j] = d.v === 'p' ? { ok: true } : { ok: false, sev: 'minor', note: '' }; return render(); }
  if (a === 'next') return run(async () => {
    if (ck.step === 0) { ck.mileage = $('#mil').value; enterStep(1); }
    else if (ck.step === co.checklist.length) { enterStep('fin'); }
    else enterStep(ck.step + 1);
    ck.tm = null; onSensor();
  });
  if (a === 'submit') { ck.notes = $('#notes').value; return run(submitCheck); }
  if (a === 'open') { cache.open = cache.open === d.id ? null : d.id; return render(); }
  if (a === 'fix') return run(async () => { const { error } = await sb.from('checks').update({ fixed: true }).eq('id', d.id); if (error) throw error; });
  if (a === 'resolve') return run(async () => { const { error } = await sb.from('alerts').update({ resolved: true }).eq('id', d.id); if (error) throw error; });
  if (a === 'photo') { const { data } = await sb.storage.from('check-photos').createSignedUrl(d.p, 300); if (data) window.open(data.signedUrl, '_blank'); else toast('Photo not found'); return; }
  if (a === 'addveh') return run(async () => { const reg = $('#reg').value.trim().toUpperCase(); if (!reg) throw new Error('Enter a reg'); const { error } = await sb.from('vehicles').insert({ company_id: co.id, reg, type: $('#vt').value }); if (error) throw error; toast(reg + ' added'); });
  if (a === 'rmveh') return run(async () => { if (!confirm('Remove this vehicle? Billing for it stops after the week already started.')) return; const { error } = await sb.from('vehicles').update({ removed_on: new Date().toISOString().slice(0, 10) }).eq('id', d.id); if (error) throw error; });
  if (a === 'role') return run(async () => { const { error } = await sb.from('profiles').update({ role: d.v }).eq('id', d.id); if (error) throw error; });
  if (a === 'active') return run(async () => { const { error } = await sb.from('profiles').update({ active: d.v === 'true' }).eq('id', d.id); if (error) throw error; });
  if (['additem', 'delitem', 'savesettings'].includes(a)) return run(async () => {
    const cl = JSON.parse(JSON.stringify(co.checklist)); const upd = {};
    if (a === 'additem') { const v = $('#ni' + d.i).value.trim(); if (!v) return; cl[+d.i].items.push(v); upd.checklist = cl; }
    if (a === 'delitem') { cl[+d.i].items.splice(+d.j, 1); upd.checklist = cl; }
    if (a === 'savesettings') { upd.alert_email = $('#ae').value.trim(); upd.billing_email = $('#be').value.trim(); upd.min_total_secs = parseInt($('#mt').value) || 0; }
    const { error } = await sb.from('companies').update(upd).eq('id', co.id); if (error) throw error; Object.assign(co, upd); toast('Saved');
  });
  if (a === 'printinv') return printInv(d.id);
  if (a === 'runbill') return run(async () => { const { data, error } = await sb.rpc('generate_invoices'); if (error) throw error; toast(data + ' invoice(s) created'); });
  if (a === 'markpaid') return run(async () => { const { error } = await sb.from('invoices').update({ status: 'paid', paid_on: new Date().toISOString().slice(0, 10) }).eq('id', d.id); if (error) throw error; });
});
document.addEventListener('change', async e => {
  const el = e.target, a = el.dataset.a, d = el.dataset; if (!a) return;
  if (a === 'plate' && el.files[0]) { ck.plate = await shrink(el.files[0]); ck.plateUrl = URL.createObjectURL(ck.plate); render(); }
  if (a === 'xphoto' && el.files[0]) { const b = await shrink(el.files[0]); ck.extra.push({ blob: b, url: URL.createObjectURL(b) }); render(); }
  if (a === 'dphoto' && el.files[0]) { const b = await shrink(el.files[0]), x = ck.res[secs().id][+d.j]; x.blob = b; x.url = URL.createObjectURL(b); render(); }
  if (a === 'sev') ck.res[secs().id][+d.j].sev = el.value;
  if (a === 'd1' || a === 'd2') { ck[a] = el.checked; const b = $('#nx'); if (b) b.disabled = !(ck.d1 && ck.d2); }
  if (a === 'stitle' || a === 'ssecs') { const cl = JSON.parse(JSON.stringify(co.checklist)); if (a === 'stitle') cl[+d.i].title = el.value; else cl[+d.i].secs = parseInt(el.value) || 0; const { error } = await sb.from('companies').update({ checklist: cl }).eq('id', co.id); if (error) toast(error.message); else { co.checklist = cl; toast('Saved'); } }
});
document.addEventListener('input', e => {
  const el = e.target, a = el.dataset.a;
  if (a === 'dnote') { ck.res[secs().id][+el.dataset.j].note = el.value; gate(); }
  if (a === 'filter') { const q = el.value.toLowerCase().replace(/\s/g, ''); document.querySelectorAll('.vi').forEach(r => r.style.display = r.dataset.reg.toLowerCase().replace(/\s/g, '').includes(q) ? '' : 'none'); }
});

async function doAuth() {
  const em = $('#em').value.trim(), pw = $('#pw').value;
  if (!em || pw.length < 6) throw new Error('Enter your email and a password of 6+ characters');
  if (authMode === 'in') { const { error } = await sb.auth.signInWithPassword({ email: em, password: pw }); if (error) throw error; }
  else {
    const nm = $('#nm').value.trim(); if (!nm) throw new Error('Enter your name');
    if (authMode === 'co' && !$('#cn').value.trim()) throw new Error('Enter your company name');
    if (authMode === 'dr' && !$('#cc').value.trim()) throw new Error('Enter your company code');
    const { data, error } = await sb.auth.signUp({ email: em, password: pw }); if (error) throw error;
    if (!data.session) { const r = await sb.auth.signInWithPassword({ email: em, password: pw }); if (r.error) throw new Error('Account created. Check your email to confirm it, then sign in.'); }
    const r = authMode === 'co' ? await sb.rpc('create_company', { p_name: $('#cn').value.trim(), p_full_name: nm }) : await sb.rpc('join_company', { p_code: $('#cc').value, p_full_name: nm });
    if (r.error) throw r.error;
  }
  await loadMe(); view = me.is_platform_admin && !co ? 'platform' : 'home'; flush();
}

const origRender = render;
render = async function () { if (view === 'result' && cache.result) { $('#app').innerHTML = shell(resultView()); return; } return origRender(); };
setInterval(() => { if (ck && typeof ck.step === 'number') gate(); }, 1000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
sb.auth.onAuthStateChange(() => {});
loadMe().then(() => { if (me && me.is_platform_admin && !co) view = 'platform'; render(); flush(); });
})();
