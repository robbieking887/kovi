/* Kovi web app: sign-in, the driver's check, and handovers. */
(() => {
'use strict';
const K = window.K, S = K.s, $ = K.$, esc = K.esc, api = K.api;
const MAX_DIST = 150;   // metres. Phone GPS drifts a lot beside big vehicles and in yards, so this is deliberately generous

K.tabs.push({ id: 'home', label: 'Check' }, { id: 'hist', label: 'My checks' });

/* ================= sign in ================= */
K.authView = function () {
  const m = S.authMode, F = S.form || {}, code = F.cc || K.lsGet('kovi_code') || '';
  const tabs = m === 'pin' || m === 'in' ? `<div class="seg" style="margin-bottom:12px"><button data-a="mode" data-v="pin" class="${m === 'pin' ? 'on p' : ''}">Driver</button><button data-a="mode" data-v="in" class="${m === 'in' ? 'on p' : ''}">Office</button></div>` : '';
  const form = {
    pin: `<h1>Driver sign in</h1><label>Company code</label><input id="cc" autocapitalize="characters" autocomplete="off" value="${esc(code)}" placeholder="e.g. D65B307B"><label>Your 6 digit PIN</label><input id="pin" type="password" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="••••••">`,
    in: `<h1>Office sign in</h1><label>Email</label><input id="em" type="email" autocomplete="email"><label>Password</label><input id="pw" type="password" autocomplete="current-password">`,
    co: `<h1>Set up your company</h1><label>Your name</label><input id="nm" autocomplete="name"><label>Company name</label><input id="cn"><label>Email</label><input id="em" type="email" autocomplete="email"><label>Password (8+ characters)</label><input id="pw" type="password" autocomplete="new-password">
      <label style="display:flex;gap:8px;align-items:flex-start;font-weight:400;color:var(--ink);margin:6px 0 12px"><input type="checkbox" id="terms" style="width:auto;margin:3px 0">I agree to the <a href="/legal/terms" target="_blank" rel="noopener">Terms of Service</a> and <a href="/legal/data-processing" target="_blank" rel="noopener">Data Processing Terms</a>, and I will tell my drivers about the <a href="/legal/driver-notice" target="_blank" rel="noopener">Driver privacy notice</a>.</label>`,
    dr: `<h1>Join as a driver</h1><p class="mut">Your manager can give you a PIN instead, which is quicker. Use this if they gave you a company code only.</p><label>Your name</label><input id="nm" autocomplete="name"><label>Company code</label><input id="cc" autocapitalize="characters" value="${esc(code)}"><label>Email</label><input id="em" type="email" autocomplete="email"><label>Password (8+ characters)</label><input id="pw" type="password" autocomplete="new-password">` }[m];
  return `<header><b>KOVI</b><small>Fleet walkaround checks</small></header><main>${tabs}<div class="card">${S.err ? `<div class="err">${esc(S.err)}</div>` : ''}${form}
  <button class="b full" data-a="auth">${m === 'co' || m === 'dr' ? 'Create account' : 'Sign in'}</button></div>
  <p class="mut" style="text-align:center">${m === 'co' || m === 'dr' ? '<a href="#" data-a="mode" data-v="pin">Back to sign in</a><br>' : ''}${m !== 'co' ? '<a href="#" data-a="mode" data-v="co">Company owner? Create your company</a><br>' : ''}${m !== 'dr' ? '<a href="#" data-a="mode" data-v="dr">Driver with a company code but no PIN?</a>' : ''}</p>${K.foot()}</main>`;
};
K.actions.mode = (el, d) => { S.authMode = d.v; S.err = ''; K.render(); };
K.actions.auth = () => K.run(async () => {
  S.form = {}; document.querySelectorAll('#app input').forEach(e => { if (e.id) S.form[e.id] = e.type === 'checkbox' ? e.checked : e.value; });
  const m = S.authMode, v = id => { const e = $(id); return e ? e.value.trim() : ''; };
  let r;
  if (m === 'pin') {
    if (!v('#cc')) throw new Error('Enter your company code'); if (!/^\d{6}$/.test(v('#pin'))) throw new Error('Your PIN is 6 digits');
    r = await api('POST', '/api/login-pin', { code: v('#cc'), pin: v('#pin') }); K.lsSet('kovi_code', v('#cc').toUpperCase());
  } else if (m === 'in') {
    if (!v('#em') || $('#pw').value.length < 8) throw new Error('Enter your email and password (8+ characters)');
    r = await api('POST', '/api/login', { email: v('#em'), password: $('#pw').value });
  } else {
    if (!v('#em') || $('#pw').value.length < 8) throw new Error('Enter your email and a password of 8+ characters');
    if (m === 'co' && !$('#terms').checked) throw new Error('Please tick the box to accept the terms');
    r = await api('POST', '/api/signup', { email: v('#em'), password: $('#pw').value, mode: m, name: v('#nm'), company: m === 'co' ? v('#cn') : '', code: m === 'dr' ? v('#cc') : '', accept_terms: m === 'co' ? true : undefined });
  }
  K.setToken(r.token); S.form = null; await K.loadMe(); S.view = K.isAdmin() ? 'today' : 'home'; K.flush(true);
  if (S.deep) await openDeep();
});
document.addEventListener('keydown', e => { if (e.key === 'Enter' && !S.me && e.target.matches('input:not([type=checkbox])')) K.actions.auth(); });

/* ================= QR deep link: /v/<vehicle id> ================= */
const dm = location.pathname.match(/^\/v\/([0-9a-f-]{36})\/?$/i); if (dm) S.deep = dm[1];
async function openDeep() {
  const id = S.deep; S.deep = null; if (!id) return;
  history.replaceState(null, '', '/');
  const v = (await K.vehicles()).find(x => x.id === id);
  if (!v) { K.toast('That vehicle is not on your account'); return; }
  if (S.co.handover_on) { S.cache.pick = v; S.view = 'pick'; } else await startCheck(v.id);
}
K.openDeep = openDeep;

/* ================= home: pick a vehicle ================= */
K.views.home = async function () {
  const vs = await K.vehicles(), queued = (await K.qall()).length; S.queue = queued;
  const ho = S.co.handover_on;
  return `<h1>Select your vehicle</h1>${queued ? `<div class="warn">${queued} item${queued > 1 ? 's' : ''} saved on this phone, waiting for signal. <a href="#" data-a="sync">Send now</a></div>` : ''}
  <input id="vq" placeholder="Search reg…" data-a="filter" autocomplete="off">
  <div class="card" id="vlist">${vs.length ? vs.map(v => `<div class="item vi" data-reg="${esc(v.reg)}"><div class="t"><b>${esc(v.reg)}</b><div class="mut">${esc(v.type)}</div></div>
    <button class="b sm" data-a="start" data-id="${v.id}">Start check</button>${ho ? `<button class="b sm sec" data-a="pickveh" data-id="${v.id}">Handover</button>` : ''}</div>`).join('') : '<p class="mut">No vehicles yet. ' + (K.isAdmin() ? 'Add one under Vehicles.' : 'Ask your manager to add vehicles.') + '</p>'}</div>`;
};
K.inputs.filter = el => { const q = el.value.toLowerCase().replace(/\s/g, ''); document.querySelectorAll('.vi').forEach(r => r.style.display = r.dataset.reg.toLowerCase().replace(/\s/g, '').includes(q) ? '' : 'none'); };
K.views.pick = async function () {
  const v = S.cache.pick; if (!v) return K.views.home();
  return `<h1>${esc(v.reg)}</h1><p class="mut">${esc(v.type)}. What do you want to do?</p><div class="card">
  <button class="b full" data-a="start" data-id="${v.id}">Daily check</button>
  <button class="b sec full" style="margin-top:10px" data-a="starthand" data-id="${v.id}" data-v="out">Hand over (vehicle going out)</button>
  <button class="b sec full" style="margin-top:10px" data-a="starthand" data-id="${v.id}" data-v="in">Take back (vehicle returned)</button></div>`;
};
K.actions.pickveh = (el, d) => K.run(async () => { S.cache.pick = (await K.vehicles()).find(x => x.id === d.id); S.view = 'pick'; });

/* ================= sensors: GPS and compass, only while a check is open ================= */
const sens = { pos: null, heading: null, watch: null, on: false };
async function startSensors() {
  if (sens.on) return; sens.on = true; sens.pos = null; sens.heading = null;
  try { if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') await DeviceOrientationEvent.requestPermission(); } catch (e) {}
  const h = e => {
    if (typeof e.webkitCompassHeading === 'number') sens.heading = e.webkitCompassHeading;
    else if (e.alpha != null) sens.heading = (360 - e.alpha) % 360;
    onSensor();
  };
  sens.h = h; window.addEventListener('deviceorientationabsolute', h, true); window.addEventListener('deviceorientation', h, true);
  if (navigator.geolocation) {
    // ask for a precise fix first; if the phone cannot give one (indoors, cold start, cab roof), fall back to a rough one rather than none
    const ok = p => { sens.pos = p.coords; onSensor(); };
    const rough = () => { if (sens.watch != null) navigator.geolocation.clearWatch(sens.watch); sens.watch = navigator.geolocation.watchPosition(ok, () => {}, { enableHighAccuracy: false, maximumAge: 30000, timeout: 30000 }); };
    sens.watch = navigator.geolocation.watchPosition(ok, e => { if (e.code !== 1 && !sens.pos) rough(); }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 });
    setTimeout(() => { if (sens.on && !sens.pos) rough(); }, 8000);
  }
}
K.stopSensors = function () {
  if (sens.watch != null) navigator.geolocation.clearWatch(sens.watch); sens.watch = null;
  if (sens.h) { window.removeEventListener('deviceorientationabsolute', sens.h, true); window.removeEventListener('deviceorientation', sens.h, true); sens.h = null; }
  sens.on = false; sens.pos = null;
};
const dist = (a, b) => { const R = 6371000, r = x => x * Math.PI / 180, dLa = r(b.latitude - a.latitude), dLo = r(b.longitude - a.longitude); const x = Math.sin(dLa / 2) ** 2 + Math.cos(r(a.latitude)) * Math.cos(r(b.latitude)) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
const needGps = () => S.ck && S.ck.tpl.settings.gps !== false;
function onSensor() {
  const ck = S.ck; if (!ck) return;
  if (sens.pos) {
    if (!ck.pos0 && sens.pos.accuracy < 200) ck.pos0 = { latitude: sens.pos.latitude, longitude: sens.pos.longitude, accuracy: sens.pos.accuracy };
    if (ck.pos0) ck.maxDist = Math.max(ck.maxDist, dist(ck.pos0, sens.pos));
  }
  const sec = curSection();
  if (sec && sec.walk && sens.heading != null) {
    if (ck.h0 == null) ck.h0 = sens.heading;
    ck.sectors.add(Math.floor(((sens.heading - ck.h0 + 360) % 360) / 90));
    const d = $('#dial'); if (d) d.innerHTML = dialSvg();
    const c = $('#cov'); if (c) c.textContent = ck.sectors.size + '/4 sides';
    K.gate();
  }
  const g = $('#gps'); if (g) g.textContent = gpsText();
}
const gpsText = () => !needGps() ? '' : !navigator.geolocation ? 'No GPS on this device' : !sens.pos ? 'Finding GPS…' : 'GPS ±' + Math.round(sens.pos.accuracy) + ' m' + (S.ck && S.ck.pos0 ? ' · ' + Math.round(dist(S.ck.pos0, sens.pos)) + ' m from vehicle' : '');
const dialSvg = () => { let s = '<svg viewBox="-75 -75 150 150">'; for (let i = 0; i < 4; i++) { const a0 = i * 90 - 90, a1 = a0 + 90, p = a => [65 * Math.cos(a * Math.PI / 180), 65 * Math.sin(a * Math.PI / 180)]; const [x0, y0] = p(a0 + 2), [x1, y1] = p(a1 - 2); s += `<path d="M${x0} ${y0}A65 65 0 0 1 ${x1} ${y1}" stroke="${S.ck.sectors.has(i) ? '#12a150' : '#98a2b3'}" stroke-width="10" fill="none" stroke-linecap="round"/>`; } return s + '</svg>'; };

/* ================= the check ================= */
const activeSections = ck => ck.tpl.sections.filter(s => s.target !== 'trailer' || ck.trailer);
const curSection = () => { const ck = S.ck; return ck && typeof ck.step === 'number' && ck.step >= 1 && ck.step <= ck.sections.length ? ck.sections[ck.step - 1] : null; };
const checkIdx = s => s.items.map((it, j) => it.kind === 'check' ? j : -1).filter(j => j >= 0);

async function startCheck(vehicleId) {
  const vs = await K.vehicles(), v = vs.find(x => x.id === vehicleId); if (!v) throw new Error('Vehicle not found');
  const tpls = await K.templates(), tpl = tpls.find(t => t.id === v.template_id) || tpls.find(t => t.is_default) || tpls[0];
  if (!tpl) throw new Error('No checklist has been set up yet. Ask your manager.');
  const defects = await K.vehicleDefects(v.id), trailers = vs.filter(x => x.type === 'Trailer' && x.id !== v.id);
  await startSensors();
  S.ck = { vehicle: v, tpl, trailers, defects, trailer: null, sections: [], id: K.uuid(), t0: Date.now(), step: 0, pos0: null, maxDist: 0, sectors: new Set(), h0: null, res: {}, conf: {}, rep: {}, extra: [], mileage: '', notes: '', licence: '', plate: null };
  S.ck.sections = activeSections(S.ck); S.view = 'check'; onSensor();
}
K.actions.start = (el, d) => K.run(() => startCheck(d.id));
K.actions.cancel = () => { if (confirm('Cancel this check?')) { K.stopSensors(); S.ck = null; S.view = 'home'; K.render(); } };

K.checkView = function () {
  const ck = S.ck, secs = ck.sections, n = secs.length + 2, i = ck.step === 'fin' ? n - 1 : ck.step, pct = Math.round(i / (n - 1) * 100);
  let h = `<div class="row"><h1 style="flex:1">${esc(ck.vehicle.reg)}${ck.trailer ? ' + ' + esc(ck.trailer.reg) : ''}</h1><button class="b sec sm n" data-a="cancel">Cancel</button></div><div class="prog"><i style="width:${pct}%"></i></div><div class="mut" id="gps">${gpsText()}</div>`;
  if (ck.step === 0) {
    const open = ck.defects.filter(x => x.status !== 'fixed'), fixed = ck.defects.filter(x => x.status === 'fixed');
    if (open.length || fixed.length) h += `<div class="card" style="border-color:${open.some(x => x.severity === 'danger') ? 'var(--bad)' : 'var(--line)'}"><h2>Known defects on this vehicle</h2>
      ${open.some(x => x.severity === 'danger') ? '<div class="err">A dangerous defect is open. Read it before you drive, and speak to your manager.</div>' : ''}
      ${open.map(x => `<div class="item"><div class="t"><b>${esc(x.item)}</b>${x.note ? ' · ' + esc(x.note) : ''}<div class="mut">${esc(x.section)} · ${K.dt(x.created_at)}${x.assigned_to ? ' · with ' + esc(x.assigned_to) : ''}</div></div>${K.pill(x.severity)}</div>`).join('')}
      ${fixed.map(x => `<div class="item"><div class="t"><b>${esc(x.item)}</b><div class="mut">Fixed ${K.dt(x.fixed_at)}${x.fix_note ? ' · ' + esc(x.fix_note) : ''}</div></div>${K.pill('fixed')}</div>`).join('')}
      ${open.length ? '<p class="mut">You do not need to report these again unless they have got worse.</p>' : ''}</div>`;
    const hasTrl = ck.tpl.sections.some(s => s.target === 'trailer');
    h += `<div class="card"><h2>Before you start</h2>
    <label>1. Photo of the reg plate (required)</label><input type="file" accept="image/*" capture="environment" id="plate" data-a="plate">${ck.plateUrl ? `<img class="photo" src="${ck.plateUrl}">` : ''}
    <label>2. Licence and CPC valid?</label><div class="seg">${['Yes', 'No', 'N/A'].map(x => `<button data-a="lic" data-v="${x}" class="${ck.licence === x ? 'on ' + (x === 'No' ? 'd' : 'p') : ''}">${x}</button>`).join('')}</div>
    <label style="display:block;margin-top:10px">3. Mileage</label><input id="mil" inputmode="numeric" value="${esc(ck.mileage)}">
    ${hasTrl && ck.trailers.length ? `<label>4. Trailer</label><select id="trl" data-a="trailer"><option value="">No trailer</option>${ck.trailers.map(t => `<option value="${t.id}" ${ck.trailer && ck.trailer.id === t.id ? 'selected' : ''}>${esc(t.reg)}</option>`).join('')}</select>` : ''}
    </div><button class="b full" data-a="next" id="nx">Start walkaround</button>`;
  } else if (ck.step === 'fin') {
    h += `<div class="card"><h2>Finish</h2><label>Extra photos (optional)</label><input type="file" accept="image/*" capture="environment" data-a="xphoto">${ck.extra.map(u => `<img class="photo" src="${u.url}">`).join('')}
    <label style="display:block;margin-top:10px">Notes</label><textarea id="notes" rows="3">${esc(ck.notes)}</textarea>
    <label style="display:flex;gap:8px;align-items:flex-start;font-weight:400;color:var(--ink)"><input type="checkbox" style="width:auto;margin:3px 0" data-a="d1" ${ck.d1 ? 'checked' : ''}>I have walked round and checked this vehicle myself.</label>
    <label style="display:flex;gap:8px;align-items:flex-start;font-weight:400;color:var(--ink)"><input type="checkbox" style="width:auto;margin:3px 0" data-a="d2" ${ck.d2 ? 'checked' : ''}>I have reported every defect I found.</label></div>
    <button class="b full" data-a="submit" id="nx" ${ck.d1 && ck.d2 ? '' : 'disabled'}>Submit check</button>`;
  } else {
    const s = secs[ck.step - 1], r = ck.res[s.id], rep = ck.rep[s.id], ci = checkIdx(s), nd = ci.filter(j => r[j] && !r[j].ok).length;
    h += `<div class="card"><h2>${esc(s.title)}${s.target === 'trailer' ? ' <span class="pill">trailer</span>' : ''}</h2>${s.walk ? `<p class="mut">Walk all the way round the vehicle. Keep your phone with you.</p><div class="dial" id="dial">${dialSvg()}</div><p style="text-align:center" class="mut" id="cov">${ck.sectors.size}/4 sides</p>` : ''}
    ${s.items.map((it, j) => it.kind === 'number' ? `<label>${esc(it.label)}${it.unit ? ' (' + esc(it.unit) + ')' : ''}${it.required ? '' : ' (optional)'}</label><input inputmode="decimal" data-a="num" data-j="${j}" value="${esc((r[j] || {}).v ?? '')}">`
      : it.kind === 'photo' ? `<label>${esc(it.label)}${it.required ? '' : ' (optional)'}</label><input type="file" accept="image/*" capture="environment" data-a="iphoto" data-j="${j}">${r[j] && r[j].url ? `<img class="photo" src="${r[j].url}">` : ''}` : '').join('')}
    ${ci.length ? `<p style="margin:10px 0 4px"><b>Have you checked:</b></p>
    ${rep ? '' : `<ul style="margin:0 0 12px;padding-left:20px">${ci.map(j => `<li>${esc(s.items[j].label)}</li>`).join('')}</ul>`}
    ${rep ? ci.map(j => { const it = s.items[j], st = r[j]; return `<div class="item" style="flex-wrap:wrap"><div class="t">${esc(it.label)}</div><div class="seg" style="width:150px"><button data-a="pd" data-j="${j}" data-v="p" class="${!st || st.ok ? 'on p' : ''}">OK</button><button data-a="pd" data-j="${j}" data-v="d" class="${st && !st.ok ? 'on d' : ''}">Defect</button></div>
      ${st && !st.ok ? `<div style="width:100%"><select data-a="sev" data-j="${j}"><option ${st.sev === 'minor' ? 'selected' : ''} value="minor">Minor (monitor)</option><option ${st.sev === 'major' ? 'selected' : ''} value="major">Major (fix soon)</option><option ${st.sev === 'danger' ? 'selected' : ''} value="danger">Dangerous (do not drive)</option></select><input placeholder="What is wrong? (required)" value="${esc(st.note)}" data-a="dnote" data-j="${j}">
        ${it.failPhoto !== 'none' ? `<label>Photo of the defect${it.failPhoto === 'required' ? ' (required)' : ''}</label><input type="file" accept="image/*" capture="environment" data-a="dphoto" data-j="${j}">${st.url ? `<img class="photo" src="${st.url}">` : ''}` : ''}</div>` : ''}</div>`; }).join('') : ''}
    ${ck.conf[s.id] ? `<div class="pill ${nd ? 'warn' : 'ok'}" style="margin:6px 0">${nd ? nd + ' defect(s) noted' : '✓ Confirmed all OK'}</div>` : `<button class="b grn full" data-a="allok">${rep ? '✓ Confirm — everything else is OK' : '✓ Yes, all checked and OK'}</button>`}
    ${rep ? '' : `<button class="b sec full" data-a="rep" style="margin-top:8px">Something is not right</button>`}` : ''}</div>
    <div class="warn" id="lock"></div><button class="b full" data-a="next" id="nx" disabled>${ck.step === secs.length ? 'Finish' : 'Next'}</button>`;
  }
  return h;
};
// why the Next button is still locked, or '' when the driver can go on
function whyLocked(s) {
  const ck = S.ck, r = ck.res[s.id], left = Math.max(0, Math.ceil((ck.lockUntil - Date.now()) / 1000));
  if (left > 0) return `Take your time: ${left}s left on this page.`;
  for (let j = 0; j < s.items.length; j++) {
    const it = s.items[j], x = r[j];
    if (it.kind === 'number' && it.required && !(x && x.v !== '' && Number.isFinite(+x.v))) return `Enter: ${it.label}.`;
    if (it.kind === 'photo' && it.required && !(x && x.blob)) return `Take the photo: ${it.label}.`;
  }
  if (checkIdx(s).length && !ck.conf[s.id]) return 'Tap the green button to confirm this section.';
  for (const j of checkIdx(s)) { const x = r[j], it = s.items[j]; if (x && !x.ok) { if (!(x.note || '').trim()) return 'Describe each defect.'; if (it.failPhoto === 'required' && !x.blob) return `A photo is needed for: ${it.label}.`; } }
  if (s.walk && ck.sectors.size < 4 && sens.heading != null) return 'Keep walking round the vehicle — ' + ck.sectors.size + '/4 sides.';
  return '';
}
K.gate = function () {
  const ck = S.ck; if (!ck) return; const nx = $('#nx'); if (!nx) return;
  if (ck.step === 0) { nx.disabled = !(ck.plate && ck.licence); return; }
  if (ck.step === 'fin') return;
  const s = curSection(); if (!s) return; const why = whyLocked(s);
  const L = $('#lock'); if (L) { L.style.display = why ? '' : 'none'; L.textContent = why; }
  nx.disabled = !!why;
  if (/Take your time/.test(why) && !ck.tm) ck.tm = setTimeout(() => { ck.tm = null; K.gate(); }, 500);
};
setInterval(() => { if (S.ck && typeof S.ck.step === 'number') K.gate(); }, 1000);
function enterStep(n) {
  const ck = S.ck; ck.step = n;
  if (typeof n === 'number' && n >= 1) {
    const s = ck.sections[n - 1]; ck.lockUntil = Date.now() + (s.secs || 0) * 1000;
    if (!ck.res[s.id]) ck.res[s.id] = s.items.map(it => it.kind === 'number' ? { v: '' } : null);
  }
}
const itemOf = j => curSection().items[+j];
K.actions.lic = (el, d) => { S.ck.licence = d.v; K.render(); };
K.actions.allok = () => { const s = curSection(), r = S.ck.res[s.id]; checkIdx(s).forEach(j => { r[j] = r[j] || { ok: true }; }); S.ck.conf[s.id] = true; K.render(); };
K.actions.rep = () => { S.ck.rep[curSection().id] = true; K.render(); };
K.actions.pd = (el, d) => { const s = curSection(); S.ck.res[s.id][+d.j] = d.v === 'p' ? { ok: true } : { ok: false, sev: 'minor', note: '' }; S.ck.conf[s.id] = false; K.render(); };
K.actions.next = () => K.run(async () => {
  const ck = S.ck;
  if (ck.step === 0) { ck.mileage = $('#mil').value; const t = $('#trl'); ck.trailer = t && t.value ? ck.trailers.find(x => x.id === t.value) : null; ck.sections = activeSections(ck); enterStep(1); if (!ck.sections.length) enterStep('fin'); }
  else if (ck.step === ck.sections.length) enterStep('fin');
  else enterStep(ck.step + 1);
  ck.tm = null; onSensor();
});
K.actions.submit = () => { S.ck.notes = $('#notes').value; return K.run(submitCheck); };
K.changes.plate = async (el) => { if (el.files[0]) { S.ck.plate = await K.shrink(el.files[0]); S.ck.plateUrl = URL.createObjectURL(S.ck.plate); K.render(); } };
K.changes.trailer = el => { S.ck.mileage = $('#mil').value; S.ck.trailer = el.value ? S.ck.trailers.find(x => x.id === el.value) : null; };
K.changes.xphoto = async el => { if (el.files[0]) { const b = await K.shrink(el.files[0]); S.ck.extra.push({ blob: b, url: URL.createObjectURL(b) }); K.render(); } };
K.changes.dphoto = async (el, d) => { if (el.files[0]) { const b = await K.shrink(el.files[0]), x = S.ck.res[curSection().id][+d.j]; x.blob = b; x.url = URL.createObjectURL(b); K.render(); } };
K.changes.iphoto = async (el, d) => { if (el.files[0]) { const b = await K.shrink(el.files[0]); S.ck.res[curSection().id][+d.j] = { blob: b, url: URL.createObjectURL(b) }; K.render(); } };
K.changes.sev = (el, d) => { S.ck.res[curSection().id][+d.j].sev = el.value; };
K.changes.d1 = K.changes.d2 = (el, d) => { S.ck[d.a] = el.checked; const b = $('#nx'); if (b) b.disabled = !(S.ck.d1 && S.ck.d2); };
K.inputs.dnote = (el, d) => { S.ck.res[curSection().id][+d.j].note = el.value; K.gate(); };
K.inputs.num = (el, d) => { S.ck.res[curSection().id][+d.j] = { v: el.value.trim() }; K.gate(); };

async function submitCheck() {
  const ck = S.ck, ended = Date.now(), secsTaken = Math.round((ended - ck.t0) / 1000), flags = [], secs = ck.sections;
  if (!ck.plate) flags.push('no_plate');
  if (needGps()) { if (!ck.pos0) flags.push('no_gps'); else if (ck.maxDist > MAX_DIST) flags.push('far'); }
  if (secs.some(s => s.walk) && (sens.heading == null || ck.sectors.size < 4)) flags.push('no_walk');
  const minTotal = Math.max(S.co.min_total_secs || 0, secs.reduce((a, s) => a + (s.secs || 0), 0));
  if (secsTaken < minTotal) flags.push('too_fast');
  const defects = [], results = {}, photos = [], base = `${S.co.id}/${ck.id}/`;
  photos.push({ name: 'plate.jpg', blob: ck.plate });
  ck.extra.forEach((x, i) => photos.push({ name: 'extra' + i + '.jpg', blob: x.blob }));
  secs.forEach(s => { results[s.id] = s.items.map((it, j) => {
    const x = ck.res[s.id][j];
    if (it.kind === 'number') return x && x.v !== '' && Number.isFinite(+x.v) ? +x.v : null;
    if (it.kind === 'photo') { if (!(x && x.blob)) return null; const nm = s.id + '-' + j + '.jpg'; photos.push({ name: nm, blob: x.blob }); return base + nm; }
    if (x && !x.ok) { let p = null; if (x.blob) { const nm = s.id + '-' + j + '.jpg'; p = base + nm; photos.push({ name: nm, blob: x.blob }); } defects.push({ section: s.title, item: it.label, severity: x.sev || 'minor', note: x.note, photo: p, target: s.target }); return 0; }
    return 1; }); });
  const row = { id: ck.id, vehicle_id: ck.vehicle.id, trailer_id: ck.trailer ? ck.trailer.id : null, template_id: ck.tpl.id, checklist: secs, started_at: new Date(ck.t0).toISOString(), finished_at: new Date(ended).toISOString(),
    start_lat: ck.pos0 && ck.pos0.latitude, start_lng: ck.pos0 && ck.pos0.longitude, start_acc: ck.pos0 && ck.pos0.accuracy, end_lat: sens.pos && sens.pos.latitude, end_lng: sens.pos && sens.pos.longitude,
    distance_m: Math.round(ck.maxDist), heading_coverage: ck.sectors.size, duration_secs: secsTaken, licence: ck.licence, mileage: parseInt(ck.mileage) || null,
    results, defects, notes: ck.notes, flags };
  row.verdict = flags.length ? 'flagged' : defects.length ? 'defect' : 'pass';
  const item = { id: row.id, kind: 'check', row, photos, tok: K.token };
  let saved = true;
  try { if (!navigator.onLine) { const e = new Error('offline'); e.offline = true; throw e; } await K.sendItem(item); }
  catch (e) { if (!e.offline && e.status && e.status < 500 && e.status !== 401) throw e; saved = false; await K.qput(item); }
  K.stopSensors(); S.ck = null; S.view = 'result'; S.cache.result = { row, saved, kind: 'check' };
}
K.views.result = async function () {
  const { row, saved, kind } = S.cache.result || {};
  if (!row) return K.views.home();
  if (kind === 'handover') return `<div class="card" style="text-align:center"><div class="big" style="color:var(--ok)">✓ Handover saved</div><p class="mut">${saved ? 'Saved. Your office can see it now.' : 'No signal. Saved on this phone and will upload automatically.'}</p><button class="b full" data-a="tab" data-v="home">Done</button></div>`;
  const f = { no_gps: 'No GPS fix', far: 'Moved too far from the vehicle', no_walk: 'Compass did not show a full walk round', too_fast: 'Finished faster than the minimum time', no_plate: 'No plate photo' };
  return `<div class="card" style="text-align:center"><div class="big" style="color:${row.verdict === 'pass' ? 'var(--ok)' : row.verdict === 'defect' ? 'var(--warn)' : 'var(--bad)'}">${row.verdict === 'pass' ? '✓ Check complete' : row.verdict === 'defect' ? '⚠ Check complete with defects' : '⚠ Check flagged'}</div>
  <p class="mut">${saved ? 'Saved. Your office can see it now.' : 'No signal. Saved on this phone and will upload automatically.'}</p>
  ${row.flags.length ? `<div class="warn" style="text-align:left">The office has been told:<br>${row.flags.map(x => '• ' + f[x]).join('<br>')}</div>` : ''}
  ${row.defects.length ? `<p>${row.defects.length} defect(s) reported</p>` : ''}<button class="b full" data-a="tab" data-v="home">Done</button></div>`;
};

/* ================= my checks (last 7 days) ================= */
K.views.hist = async function () {
  const data = await api('GET', '/api/checks/mine');
  return `<h1>My checks</h1><p class="mut">Your last 7 days. Your manager can see the full history.</p><div class="card">${(data || []).map(c => `<div class="item"><div class="t"><b>${esc(c.reg)}${c.trailer_reg ? ' + ' + esc(c.trailer_reg) : ''}</b><div class="mut">${K.dt(c.started_at)}</div></div>${K.pill(c.verdict)}</div>`).join('') || '<p class="mut">None yet.</p>'}</div>`;
};

/* ================= handover: photos and details when a vehicle goes out or comes back ================= */
const SLOTS = [['front', 'Front', true], ['rear', 'Rear', true], ['left', 'Driver side', true], ['right', 'Passenger side', true], ['dash', 'Dashboard (mileage and fuel)', true], ['inside', 'Inside', false]];
const FUEL = ['Empty', '1/4', '1/2', '3/4', 'Full'];
K.actions.starthand = (el, d) => K.run(async () => {
  const v = (await K.vehicles()).find(x => x.id === d.id); if (!v) throw new Error('Vehicle not found');
  S.ho = { vehicle: v, kind: d.v, id: K.uuid(), t0: Date.now(), step: 0, slots: {}, extra: [], mileage: '', fuel: '', party: '', notes: '', sig: null }; S.view = 'handover';
});
K.handoverView = function () {
  const ho = S.ho, out = ho.kind === 'out';
  const head = `<div class="row"><h1 style="flex:1">${esc(ho.vehicle.reg)}</h1><button class="b sec sm n" data-a="hcancel">Cancel</button></div><p class="mut">${out ? 'Handing the vehicle over' : 'Taking the vehicle back'}. Photos are stamped with the time and place.</p>`;
  if (ho.step === 0) {
    const have = SLOTS.filter(s => s[2]).every(s => ho.slots[s[0]]);
    return head + `<div class="card"><h2>Photos</h2><div class="grid">${SLOTS.map(([k, label, req]) => `<div><label>${esc(label)}${req ? '' : ' (optional)'}</label><input type="file" accept="image/*" capture="environment" data-a="hphoto" data-k="${k}">${ho.slots[k] ? `<img class="photo" style="max-height:110px" src="${ho.slots[k].url}">` : ''}</div>`).join('')}</div>
    <label style="display:block;margin-top:10px">Damage or anything else (optional)</label><input type="file" accept="image/*" capture="environment" data-a="hextra">${ho.extra.map(x => `<img class="photo" style="max-height:110px" src="${x.url}">`).join('')}</div>
    <button class="b full" data-a="hnext" ${have ? '' : 'disabled'}>Next</button>`;
  }
  return head + `<div class="card"><h2>Details</h2><label>Mileage</label><input id="hmil" inputmode="numeric" value="${esc(ho.mileage)}" data-a="hfield" data-f="mileage">
    <label>Fuel</label><div class="seg">${FUEL.map(f => `<button data-a="hfuel" data-v="${f}" class="${ho.fuel === f ? 'on p' : ''}">${f}</button>`).join('')}</div>
    <label style="display:block;margin-top:10px">${out ? 'Handed to (name and company)' : 'Handed back by (name and company)'}</label><input id="hparty" value="${esc(ho.party)}" data-a="hfield" data-f="party">
    <label>Notes (scratches, missing items…)</label><textarea rows="3" data-a="hfield" data-f="notes">${esc(ho.notes)}</textarea>
    <label>Signature of the person ${out ? 'taking' : 'returning'} the vehicle</label><canvas id="sig" class="sig" width="600" height="220"></canvas><button class="b sec sm" data-a="sigclear">Clear signature</button></div>
    <button class="b full" data-a="hsubmit" id="hsub" ${ho.mileage && ho.fuel && ho.party.trim() && ho.sig ? '' : 'disabled'}>Save handover</button><button class="b sec full" style="margin-top:8px" data-a="hback">Back to photos</button>`;
};
const hoReady = () => { const b = $('#hsub'); if (b) b.disabled = !(S.ho.mileage && S.ho.fuel && S.ho.party.trim() && S.ho.sig); };
K.actions.hcancel = () => { if (confirm('Cancel this handover?')) { S.ho = null; S.view = 'home'; K.render(); } };
K.actions.hnext = () => { S.ho.step = 1; K.render(); };
K.actions.hback = () => { S.ho.step = 0; K.render(); };
K.actions.hfuel = (el, d) => { S.ho.fuel = d.v; K.render(); };
K.inputs.hfield = (el, d) => { S.ho[d.f] = el.value; hoReady(); };
K.changes.hphoto = async (el, d) => { if (el.files[0]) { const b = await K.shrink(el.files[0]); S.ho.slots[d.k] = { blob: b, url: URL.createObjectURL(b) }; K.render(); } };
K.changes.hextra = async el => { if (el.files[0]) { const b = await K.shrink(el.files[0]); S.ho.extra.push({ blob: b, url: URL.createObjectURL(b) }); K.render(); } };
K.actions.sigclear = () => { S.ho.sig = null; S.ho.sigUrl = null; const c = $('#sig'); c.getContext('2d').clearRect(0, 0, c.width, c.height); hoReady(); };
// signature pad: draws with finger or mouse; the picture is kept so a re-render does not lose it
K.after = function () {
  const c = $('#sig'); if (!c || !S.ho) return; const g = c.getContext('2d'); g.lineWidth = 4; g.lineCap = 'round'; g.strokeStyle = '#101828';
  if (S.ho.sigUrl) { const im = new Image(); im.onload = () => g.drawImage(im, 0, 0); im.src = S.ho.sigUrl; }
  let down = false, last = null;
  const pt = e => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * c.width / r.width, (e.clientY - r.top) * c.height / r.height]; };
  c.style.touchAction = 'none';
  c.onpointerdown = e => { down = true; last = pt(e); c.setPointerCapture(e.pointerId); };
  c.onpointermove = e => { if (!down) return; const p = pt(e); g.beginPath(); g.moveTo(last[0], last[1]); g.lineTo(p[0], p[1]); g.stroke(); last = p; };
  c.onpointerup = c.onpointercancel = () => { if (!down) return; down = false; S.ho.sigUrl = c.toDataURL(); const o = document.createElement('canvas'); o.width = c.width; o.height = c.height; const og = o.getContext('2d'); og.fillStyle = '#fff'; og.fillRect(0, 0, o.width, o.height); og.drawImage(c, 0, 0); o.toBlob(b => { S.ho.sig = b; hoReady(); }, 'image/jpeg', .8); };
};
const where = () => new Promise(res => { if (!navigator.geolocation) return res(null); navigator.geolocation.getCurrentPosition(p => res(p.coords), () => res(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 20000 }); });
K.actions.hsubmit = () => K.run(async () => {
  const ho = S.ho, pos = await where(), photos = [], labels = [];
  SLOTS.forEach(([k, label]) => { if (ho.slots[k]) { photos.push({ name: k + '.jpg', blob: ho.slots[k].blob }); labels.push({ name: k + '.jpg', label }); } });
  ho.extra.forEach((x, i) => { photos.push({ name: 'extra' + i + '.jpg', blob: x.blob }); labels.push({ name: 'extra' + i + '.jpg', label: 'Extra ' + (i + 1) }); });
  photos.push({ name: 'signature.jpg', blob: ho.sig });
  const row = { id: ho.id, vehicle_id: ho.vehicle.id, kind: ho.kind, started_at: new Date(ho.t0).toISOString(), finished_at: new Date().toISOString(), lat: pos && pos.latitude, lng: pos && pos.longitude, acc: pos && pos.accuracy,
    mileage: parseInt(ho.mileage) || null, fuel: ho.fuel, other_party: ho.party.trim(), notes: ho.notes, photos: labels, signature: true };
  const item = { id: row.id, kind: 'handover', row, photos, tok: K.token };
  let saved = true;
  try { if (!navigator.onLine) { const e = new Error('offline'); e.offline = true; throw e; } await K.sendItem(item); }
  catch (e) { if (!e.offline && e.status && e.status < 500 && e.status !== 401) throw e; saved = false; await K.qput(item); }
  S.ho = null; S.view = 'result'; S.cache.result = { row, saved, kind: 'handover' };
});
})();
