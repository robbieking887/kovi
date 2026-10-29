/* Kovi web app: the office side. Today, alerts, defects, history, vehicles, people, checklists, handovers, reports, settings, billing, platform. */
(() => {
'use strict';
const K = window.K, S = K.s, $ = K.$, esc = K.esc, api = K.api, gbp = K.gbp;

K.tabs.unshift({ id: 'today', label: 'Today', admin: true });
K.tabs.push(
  { id: 'alerts', label: 'Alerts', admin: true }, { id: 'defects', label: 'Defects', admin: true }, { id: 'history', label: 'History', admin: true },
  { id: 'vehicles', label: 'Vehicles', admin: true }, { id: 'people', label: 'People', admin: true }, { id: 'templates', label: 'Checklists', admin: true },
  { id: 'handovers', label: 'Handovers', admin: true, when: () => S.co && S.co.handover_on }, { id: 'reports', label: 'Reports', admin: true },
  { id: 'settings', label: 'Settings', admin: true }, { id: 'billing', label: 'Billing', admin: true }, { id: 'platform', label: 'Platform', platform: true });

const FLAG = { no_gps: 'No GPS fix', far: 'Moved too far from the vehicle', no_walk: 'No full walk round shown by the compass', too_fast: 'Finished too fast', no_plate: 'No plate photo' };
const val = id => { const e = $(id); return e ? e.value.trim() : ''; };
const dayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); };
const checkRow = c => `<div class="item" data-a="open" data-id="${c.id}" style="cursor:pointer"><div class="t"><b>${esc(c.reg)}${c.trailer_reg ? ' + ' + esc(c.trailer_reg) : ''}</b><div class="mut">${esc(c.full_name)} · ${K.dt(c.started_at)}${c.flags && c.flags.length ? ' · ' + c.flags.map(f => FLAG[f] || f).join(', ') : ''}</div></div>${K.pill(c.verdict)}${c.verdict !== 'pass' && c.fixed ? K.pill('fixed') : ''}</div>`;

/* ================= today ================= */
K.views.today = async function () {
  const [checks, vs] = await Promise.all([api('GET', '/api/checks/today?since=' + encodeURIComponent(dayStart())), K.vehicles()]);
  const done = new Set(); checks.forEach(c => { done.add(c.vehicle_id); if (c.trailer_id) done.add(c.trailer_id); });
  const missing = vs.filter(v => v.daily_check && !done.has(v.id));
  const co = S.co;
  return `<h1>Today</h1>
  ${co.check_by ? `<p class="mut">You will be alerted if vehicles are not checked by ${esc(co.check_by)}.</p>` : `<p class="mut">Set a "check by" time in Settings to be alerted when vehicles have not been checked.</p>`}
  <div class="card"><h2>Not checked yet <span class="pill ${missing.length ? 'warn' : 'ok'}">${missing.length}</span></h2>${missing.map(v => `<div class="item"><div class="t"><b>${esc(v.reg)}</b> <span class="mut">${esc(v.type)}</span></div></div>`).join('') || '<p class="mut">Every vehicle has been checked today.</p>'}</div>
  <div class="card"><h2>Checks today <span class="pill">${checks.length}</span></h2>${checks.map(checkRow).join('') || '<p class="mut">None yet.</p>'}</div>`;
};
K.actions.open = (el, d) => { S.cache.back = S.view; S.cache.open = d.id; S.view = 'detail'; K.render(); };

/* ================= one check, in full ================= */
K.views.detail = async function () {
  const c = await api('GET', '/api/checks/' + S.cache.open);
  const secs = c.checklist || [], res = c.results || {};
  const ph = p => p ? `<img class="photo" data-p="${esc(p)}" alt="">` : '';
  const sev = x => x.severity === 'danger' ? 'bad' : x.severity === 'major' ? 'warn' : '';
  return `<button class="b sec sm" data-a="tab" data-v="${S.cache.back || 'today'}">← Back</button>
  <h1 style="margin-top:10px">${esc(c.reg)}${c.trailer_reg ? ' + ' + esc(c.trailer_reg) : ''} ${K.pill(c.verdict)}</h1>
  <div class="card"><p><b>${esc(c.full_name)}</b> · ${K.dt(c.started_at)} · ${Math.round((c.duration_secs || 0) / 60 * 10) / 10} min${c.mileage ? ' · ' + c.mileage.toLocaleString('en-GB') + ' miles' : ''}</p>
  <p class="mut">Licence/CPC: ${esc(c.licence || '?')} · Compass: ${c.heading_coverage ?? '?'}/4 sides · Moved ${Math.round(c.distance_m || 0)} m${c.start_lat ? ` · <a href="https://www.google.com/maps?q=${c.start_lat},${c.start_lng}" target="_blank" rel="noopener">Map</a> (±${Math.round(c.start_acc || 0)} m)` : ''}</p>
  ${c.flags && c.flags.length ? `<div class="warn">${c.flags.map(f => '• ' + esc(FLAG[f] || f)).join('<br>')}</div>${c.fixed ? '<p class="mut">Reviewed by the office.</p>' : `<button class="b sec sm" data-a="reviewed" data-id="${c.id}">Mark as reviewed</button>`}` : ''}
  ${c.notes ? `<p>Notes: ${esc(c.notes)}</p>` : ''}${ph(c.plate_photo)}</div>
  ${(c.defects || []).length ? `<div class="card"><h2>Defects</h2>${c.defects.map(x => `<div class="item" style="flex-wrap:wrap"><div class="t"><b>${esc(x.item)}</b> <span class="mut">${esc(x.section)}${x.target === 'trailer' ? ' (trailer)' : ''}</span><div>${esc(x.note || '')}</div></div><span class="pill ${sev(x)}">${esc(x.severity)}</span>${x.photo ? `<div style="width:100%">${ph(x.photo)}</div>` : ''}</div>`).join('')}</div>` : ''}
  ${secs.map(s => { const r = res[s.id] || []; const rows = s.items.map((it, j) => {
      const v = r[j];
      if (it.kind === 'number') return `<tr><td>${esc(it.label)}</td><td class="r"><b>${v == null ? '-' : esc(v)}</b> ${esc(it.unit || '')}</td></tr>`;
      if (it.kind === 'photo') return `<tr><td>${esc(it.label)}</td><td class="r">${v ? `<img class="photo" style="max-height:90px;width:auto" data-p="${esc(v)}" alt="">` : '-'}</td></tr>`;
      return `<tr><td>${esc(it.label)}</td><td class="r">${v === 1 ? '<span class="pill ok">OK</span>' : v === 0 ? '<span class="pill bad">Defect</span>' : '-'}</td></tr>`; }).join('');
    return `<div class="card"><h2>${esc(s.title)}${s.target === 'trailer' ? ' (trailer)' : ''}</h2><table class="tbl">${rows}</table></div>`; }).join('')}`;
};
K.actions.reviewed = (el, d) => K.run(async () => { await api('POST', '/api/checks/' + d.id + '/fix'); });

/* ================= alerts ================= */
K.views.alerts = async function () {
  const rows = await api('GET', '/api/alerts');
  return `<h1>Alerts</h1><div class="card">${rows.map(a => `<div class="item"><div class="t"${a.resolved ? ' style="opacity:.55"' : ''}>${esc(a.message)}<div class="mut">${K.dt(a.created_at)} · ${esc(a.kind)}</div></div>${a.check_id ? `<button class="b sec sm" data-a="open" data-id="${a.check_id}">View</button>` : ''}${a.resolved ? '' : `<button class="b sm" data-a="resolve" data-id="${a.id}">Done</button>`}</div>`).join('') || '<p class="mut">No alerts.</p>'}</div>`;
};
K.actions.resolve = (el, d) => K.run(async () => { await api('POST', '/api/alerts/' + d.id + '/resolve'); S.cache.openAlerts = 0; });

/* ================= defects: raise, assign, fix, driver sees "fixed" ================= */
K.views.defects = async function () {
  const f = S.cache.dfilter || 'active', rows = await api('GET', '/api/defects?status=' + f);
  const fx = S.cache.fixing;
  const chip = (v, l) => `<button data-a="dfilter" data-v="${v}" class="${f === v ? 'on p' : ''}">${l}</button>`;
  return `<h1>Defects</h1><div class="seg" style="margin-bottom:12px">${chip('active', 'Open')}${chip('fixed', 'Fixed')}</div>
  ${rows.map(d => `<div class="card" style="${d.severity === 'danger' && d.status !== 'fixed' ? 'border-color:var(--bad)' : ''}">
    <div class="row"><b style="flex:1">${esc(d.reg)} · ${esc(d.item)}</b>${K.pill(d.status === 'fixed' ? 'fixed' : d.severity)}</div>
    <div class="mut">${esc(d.section)} · reported ${K.dt(d.created_at)} by ${esc(d.reported_by_name || '?')}${d.seen_count > 1 ? ` · seen ${d.seen_count} times` : ''}</div>
    ${d.note ? `<p>${esc(d.note)}</p>` : ''}${d.photo ? `<img class="photo" data-p="${esc(d.photo)}" alt="">` : ''}
    ${d.status === 'fixed' ? `<p class="mut">Fixed ${K.dt(d.fixed_at)} by ${esc(d.fixed_by_name || '?')}${d.fix_note ? ': ' + esc(d.fix_note) : ''}</p>${d.fix_photo ? `<img class="photo" data-p="${esc(d.fix_photo)}" alt="">` : ''}<button class="b sec sm" data-a="reopen" data-id="${d.id}">Not really fixed: reopen</button>`
    : fx === d.id ? `<div class="card" style="margin-top:8px"><label>What was done?</label><input id="fixnote" placeholder="e.g. replaced bulb"><label>Photo of the repair (optional)</label><input type="file" accept="image/*" capture="environment" id="fixphoto"><div class="row"><button class="b grn" data-a="dofix" data-id="${d.id}">Mark fixed</button><button class="b sec" data-a="cancelfix">Cancel</button></div></div>`
    : `<div class="row" style="margin-top:8px"><input id="as-${d.id}" placeholder="Assign to (mechanic, garage…)" value="${esc(d.assigned_to || '')}" style="margin:0"><button class="b sec sm n" data-a="assign" data-id="${d.id}">${d.assigned_to ? 'Update' : 'Assign'}</button><button class="b grn sm n" data-a="startfix" data-id="${d.id}">Fixed</button></div>`}
  </div>`).join('') || '<div class="card"><p class="mut">Nothing here.</p></div>'}`;
};
K.actions.dfilter = (el, d) => { S.cache.dfilter = d.v; S.cache.fixing = null; K.render(); };
K.actions.assign = (el, d) => K.run(async () => { await api('POST', `/api/defects/${d.id}/assign`, { assigned_to: val('#as-' + d.id) }); });
K.actions.startfix = (el, d) => { S.cache.fixing = d.id; K.render(); };
K.actions.cancelfix = () => { S.cache.fixing = null; K.render(); };
K.actions.dofix = (el, d) => K.run(async () => {
  const f = $('#fixphoto') && $('#fixphoto').files[0];
  if (f) await api('POST', `/api/photos/${d.id}/fix.jpg`, null, await K.shrink(f));
  await api('POST', `/api/defects/${d.id}/fix`, { note: val('#fixnote'), photo: !!f }); S.cache.fixing = null; S.cache.openDefects = 0;
});
K.actions.reopen = (el, d) => K.run(async () => { await api('POST', `/api/defects/${d.id}/reopen`); });

/* ================= history ================= */
K.views.history = async function () {
  const f = S.cache.hf || {}, vs = await api('GET', '/api/vehicles/all'), people = await api('GET', '/api/people');
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const rows = await api('GET', '/api/checks' + (qs ? '?' + qs : ''));
  const opt = (arr, key, lab, cur) => arr.map(x => `<option value="${x[key]}" ${cur === x[key] ? 'selected' : ''}>${esc(lab(x))}</option>`).join('');
  return `<h1>History</h1><div class="card"><div class="grid"><div><label>From</label><input type="date" id="hf-from" value="${esc(f.from || '')}"></div><div><label>To</label><input type="date" id="hf-to" value="${esc(f.to || '')}"></div>
  <div><label>Vehicle</label><select id="hf-vehicle"><option value="">All</option>${opt(vs, 'id', x => x.reg, f.vehicle)}</select></div>
  <div><label>Driver</label><select id="hf-driver"><option value="">All</option>${opt(people, 'id', x => x.full_name || x.email, f.driver)}</select></div>
  <div><label>Result</label><select id="hf-verdict"><option value="">All</option>${['pass', 'defect', 'flagged'].map(v => `<option ${f.verdict === v ? 'selected' : ''}>${v}</option>`).join('')}</select></div></div>
  <button class="b full" data-a="hfilter">Filter</button></div>
  <div class="card">${rows.map(checkRow).join('') || '<p class="mut">No checks found.</p>'}${rows.length >= 300 ? '<p class="mut">Showing the latest 300. Narrow the dates to see more.</p>' : ''}</div>`;
};
K.actions.hfilter = () => { S.cache.hf = { from: val('#hf-from'), to: val('#hf-to'), vehicle: val('#hf-vehicle'), driver: val('#hf-driver'), verdict: val('#hf-verdict') }; K.render(); };

/* ================= vehicles + QR codes ================= */
const qrUrl = v => location.origin + '/v/' + v.id;
const qrSvg = (v, size) => { const q = qrcode(0, 'M'); q.addData(qrUrl(v)); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }).replace('<svg', `<svg width="${size}" height="${size}"`); };
const dueCell = (label, id, v) => `<div><label>${label}</label><input type="date" id="${id}" value="${esc(v || '')}"></div>`;
K.views.vehicles = async function () {
  const [vs, tpls] = await Promise.all([api('GET', '/api/vehicles'), api('GET', '/api/templates')]);
  S.cache.vlist = vs; const open = S.cache.vopen;
  const types = ['Truck', 'Rigid', 'Van', 'Car', 'Minibus', 'Forklift', 'Trailer'];
  return `<h1>Vehicles</h1><p class="mut">${vs.length} vehicle${vs.length === 1 ? '' : 's'} · ${gbp(vs.length * S.co.weekly_price)} a week${S.co.vat_on ? ' + VAT' : ''}. Trailers count as vehicles.</p>
  <div class="card"><h2>Add a vehicle</h2><div class="row"><input id="nreg" placeholder="Reg" autocapitalize="characters" style="margin:0"><select id="ntype" style="margin:0">${types.map(t => `<option>${t}</option>`).join('')}</select></div><button class="b full" style="margin-top:10px" data-a="addveh">Add</button></div>
  ${vs.length ? '<button class="b sec full" style="margin-bottom:12px" data-a="qrsheet">Print QR codes for all vehicles</button>' : ''}
  <div class="card">${vs.map(v => `<div class="item" style="flex-wrap:wrap"><div class="t"><b>${esc(v.reg)}</b> <span class="mut">${esc(v.type)}${v.daily_check ? '' : ' · no daily check'}</span>${[['MOT', v.mot_due], ['Tax', v.tax_due], ['Service', v.service_due], ['PMI', v.pmi_due]].filter(x => x[1]).map(x => `<div class="mut">${x[0]} ${K.d(x[1])}</div>`).join('')}</div>
    <button class="b sec sm" data-a="vopen" data-id="${v.id}">${open === v.id ? 'Close' : 'Edit'}</button>
    ${open === v.id ? `<div style="width:100%"><div class="grid">
      <div><label>Type</label><select id="vt">${types.map(t => `<option ${v.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div><label>Checklist</label><select id="vtpl"><option value="">Company default</option>${tpls.map(t => `<option value="${t.id}" ${v.template_id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
      ${dueCell('MOT due', 'vmot', v.mot_due)}${dueCell('Tax due', 'vtax', v.tax_due)}${dueCell('Service due', 'vsvc', v.service_due)}${dueCell('Safety inspection (PMI) due', 'vpmi', v.pmi_due)}</div>
      <label style="display:flex;gap:8px;align-items:center;font-weight:400;color:var(--ink)"><input type="checkbox" id="vdaily" style="width:auto;margin:0" ${v.daily_check ? 'checked' : ''}>Needs a daily check (counts towards "who hasn't checked")</label>
      <div class="row" style="margin-top:10px"><button class="b" data-a="saveveh" data-id="${v.id}">Save</button><button class="b sec" data-a="qrone" data-id="${v.id}">QR code</button><button class="b red n" data-a="rmveh" data-id="${v.id}">Remove</button></div></div>` : ''}</div>`).join('') || '<p class="mut">Add your first vehicle above.</p>'}</div>`;
};
K.actions.vopen = (el, d) => { S.cache.vopen = S.cache.vopen === d.id ? null : d.id; K.render(); };
K.actions.addveh = () => K.run(async () => { if (!val('#nreg')) throw new Error('Enter a reg'); await api('POST', '/api/vehicles', { reg: val('#nreg'), type: $('#ntype').value }); S.cache = Object.assign(S.cache, { openAlerts: S.cache.openAlerts }); K.cacheSet('vehicles', null); });
K.actions.saveveh = (el, d) => K.run(async () => {
  await api('POST', '/api/vehicles/' + d.id, { type: $('#vt').value, template_id: $('#vtpl').value || null, mot_due: $('#vmot').value, tax_due: $('#vtax').value, service_due: $('#vsvc').value, pmi_due: $('#vpmi').value, daily_check: $('#vdaily').checked });
  S.cache.vopen = null; K.toast('Saved');
});
K.actions.rmveh = (el, d) => { if (!confirm('Remove this vehicle? Its past checks are kept.')) return; return K.run(async () => { await api('POST', `/api/vehicles/${d.id}/remove`); S.cache.vopen = null; }); };
function printPage(title, inner) {
  const w = window.open('', '_blank'); if (!w) { K.toast('Allow pop-ups to print'); return; }
  w.document.write(`<!doctype html><title>${esc(title)}</title><style>body{font:16px system-ui,sans-serif;margin:16px}.q{display:inline-block;width:240px;margin:8px;padding:12px;border:2px solid #101828;border-radius:12px;text-align:center;page-break-inside:avoid}.q b{display:block;font-size:26px;letter-spacing:2px;margin-top:4px}.q small{color:#555}@media print{button{display:none}}</style><button onclick="print()">Print</button><div>${inner}</div>`);
  w.document.close();
}
const qrCard = v => `<div class="q">${qrSvg(v, 200)}<b>${esc(v.reg)}</b><small>Scan to start your check · KOVI</small></div>`;
K.actions.qrone = (el, d) => printPage('QR code', qrCard(S.cache.vlist.find(v => v.id === d.id)));
K.actions.qrsheet = () => printPage('QR codes', S.cache.vlist.map(qrCard).join(''));

/* ================= people: drivers sign in with a PIN ================= */
K.views.people = async function () {
  const ps = await api('GET', '/api/people'), pin = S.cache.newpin;
  return `<h1>People</h1>
  <div class="card"><h2>Company code</h2><p class="big" style="letter-spacing:2px">${esc(S.co.join_code)}</p><p class="mut">Drivers type this and their own 6 digit PIN to sign in. No email or password needed, and several drivers can share one phone.</p></div>
  ${pin ? `<div class="card" style="border-color:var(--ok)"><h2>PIN for ${esc(pin.name)}</h2><p class="big" style="letter-spacing:6px">${esc(pin.pin)}</p><p class="mut">Write it down or tell them now. For security it is not shown again. You can always make a new one.</p><button class="b sec sm" data-a="clearpin">Done</button></div>` : ''}
  <div class="card"><h2>Add a driver</h2><input id="dname" placeholder="Driver's name"><button class="b full" data-a="adddriver">Add and make a PIN</button></div>
  <div class="card">${ps.map(p => `<div class="item"><div class="t"${p.active ? '' : ' style="opacity:.5"'}><b>${esc(p.full_name || p.email)}</b>${p.id === S.me.id ? ' (you)' : ''}<div class="mut">${p.role === 'admin' ? 'Office' : 'Driver'} · ${p.has_pin ? 'PIN' : p.email ? esc(p.email) : ''}${p.active ? '' : ' · switched off'}</div></div>
    ${p.id !== S.me.id ? `<button class="b sec sm" data-a="newpin" data-id="${p.id}">New PIN</button><button class="b sec sm" data-a="toggleactive" data-id="${p.id}" data-v="${p.active ? 0 : 1}">${p.active ? 'Switch off' : 'Switch on'}</button>${p.email ? `<button class="b sec sm" data-a="setrole" data-id="${p.id}" data-v="${p.role === 'admin' ? 'driver' : 'admin'}">${p.role === 'admin' ? 'Make driver' : 'Make office'}</button>` : ''}` : ''}</div>`).join('')}</div>`;
};
K.actions.adddriver = () => K.run(async () => { const r = await api('POST', '/api/people/driver', { name: val('#dname') }); S.cache.newpin = r; });
K.actions.newpin = (el, d) => { if (!confirm('Make a new PIN? The old one stops working.')) return; return K.run(async () => { S.cache.newpin = await api('POST', `/api/people/${d.id}/pin`); }); };
K.actions.clearpin = () => { S.cache.newpin = null; K.render(); };
K.actions.toggleactive = (el, d) => K.run(async () => { await api('POST', '/api/people/' + d.id, { active: d.v === '1' }); });
K.actions.setrole = (el, d) => K.run(async () => { await api('POST', '/api/people/' + d.id, { role: d.v }); });

/* ================= checklist builder ================= */
K.views.templates = async function () {
  const e = S.cache.tedit;
  if (e) return builder(e);
  const [ts, presets] = await Promise.all([api('GET', '/api/templates'), api('GET', '/api/presets')]);
  const vs = await api('GET', '/api/vehicles');
  return `<h1>Checklists</h1><p class="mut">Each vehicle uses the checklist you give it, or the company default. Build your own, or start from a ready-made one.</p>
  <div class="card">${ts.map(t => `<div class="item"><div class="t"><b>${esc(t.name)}</b> ${t.is_default ? '<span class="pill ok">default</span>' : ''}<div class="mut">${t.sections.length} sections · ${t.sections.reduce((a, s) => a + s.items.length, 0)} items · used by ${vs.filter(v => v.template_id === t.id || (t.is_default && !v.template_id)).length} vehicles</div></div>
    <button class="b sec sm" data-a="tedit" data-id="${t.id}">Edit</button><button class="b sec sm" data-a="tcopy" data-id="${t.id}">Copy</button>${t.is_default ? '' : `<button class="b sec sm" data-a="tdefault" data-id="${t.id}">Make default</button>`}</div>`).join('')}</div>
  <div class="card"><h2>New checklist</h2><label>Start from</label><select id="tpreset">${presets.map(p => `<option value="${p.key}">${esc(p.name)}${p.desc ? ' – ' + esc(p.desc) : ''}</option>`).join('')}</select><input id="tname" placeholder="Name (optional)"><button class="b full" data-a="tnew">Create</button></div>`;
};
K.actions.tnew = () => K.run(async () => { const t = await api('POST', '/api/templates', { preset: $('#tpreset').value, name: val('#tname') }); S.cache.tedit = t; });
K.actions.tcopy = (el, d) => K.run(async () => { S.cache.tedit = await api('POST', '/api/templates', { copy_of: d.id }); });
K.actions.tdefault = (el, d) => K.run(async () => { await api('POST', `/api/templates/${d.id}/default`); });
K.actions.tedit = (el, d) => K.run(async () => { S.cache.tedit = (await api('GET', '/api/templates')).find(t => t.id === d.id); });
const FP = { none: 'No photo', optional: 'Photo optional', required: 'Photo required' };
function builder(t) {
  return `<button class="b sec sm" data-a="tclose">← All checklists</button><h1 style="margin-top:10px">Edit checklist</h1>
  <div class="card"><label>Name</label><input id="bname" value="${esc(t.name)}" data-a="bname">
  <label style="display:flex;gap:8px;align-items:center;font-weight:400;color:var(--ink)"><input type="checkbox" style="width:auto;margin:0" ${t.settings.gps !== false ? 'checked' : ''} data-a="bgps">Use GPS during the check (turn off for indoor sites such as depots or warehouses)</label></div>
  ${t.sections.map((s, i) => `<div class="card"><div class="row"><input value="${esc(s.title)}" data-a="stitle" data-i="${i}" placeholder="Section title" style="margin:0"><button class="b sec sm n" data-a="smove" data-i="${i}" data-v="-1" ${i ? '' : 'disabled'}>↑</button><button class="b sec sm n" data-a="smove" data-i="${i}" data-v="1" ${i < t.sections.length - 1 ? '' : 'disabled'}>↓</button><button class="b red sm n" data-a="sdel" data-i="${i}">✕</button></div>
    <div class="grid" style="margin-top:8px"><div><label>Minimum seconds on this page</label><input type="number" min="0" max="120" value="${s.secs}" data-a="ssecs" data-i="${i}"></div>
    <div><label>For</label><select data-a="starget" data-i="${i}"><option value="vehicle" ${s.target !== 'trailer' ? 'selected' : ''}>The vehicle</option><option value="trailer" ${s.target === 'trailer' ? 'selected' : ''}>The trailer</option></select></div></div>
    <label style="display:flex;gap:8px;align-items:center;font-weight:400;color:var(--ink)"><input type="checkbox" style="width:auto;margin:0" ${s.walk ? 'checked' : ''} data-a="swalk" data-i="${i}">Driver must walk round the vehicle on this page (compass)</label>
    ${s.items.map((it, j) => `<div class="item" style="flex-wrap:wrap;padding:8px 0"><input value="${esc(it.label)}" data-a="ilabel" data-i="${i}" data-j="${j}" style="flex:1;margin:0;min-width:160px">
      <select data-a="ikind" data-i="${i}" data-j="${j}" style="width:auto;margin:0"><option value="check" ${it.kind === 'check' ? 'selected' : ''}>Tick</option><option value="number" ${it.kind === 'number' ? 'selected' : ''}>Number</option><option value="photo" ${it.kind === 'photo' ? 'selected' : ''}>Photo</option></select>
      <button class="b sec sm n" data-a="imove" data-i="${i}" data-j="${j}" data-v="-1" ${j ? '' : 'disabled'}>↑</button><button class="b sec sm n" data-a="imove" data-i="${i}" data-j="${j}" data-v="1" ${j < s.items.length - 1 ? '' : 'disabled'}>↓</button><button class="b red sm n" data-a="idel" data-i="${i}" data-j="${j}">✕</button>
      ${it.kind === 'check' ? `<select data-a="ifp" data-i="${i}" data-j="${j}" style="width:auto;margin:4px 0 0"><option value="none" ${it.failPhoto === 'none' ? 'selected' : ''}>If it fails: no photo</option><option value="optional" ${it.failPhoto === 'optional' ? 'selected' : ''}>If it fails: photo optional</option><option value="required" ${it.failPhoto === 'required' ? 'selected' : ''}>If it fails: photo required</option></select>` : ''}
      ${it.kind === 'number' ? `<input placeholder="Unit (psi, hours…)" value="${esc(it.unit || '')}" data-a="iunit" data-i="${i}" data-j="${j}" style="width:150px;margin:4px 0 0"><label style="display:flex;gap:6px;align-items:center;margin:4px 0 0"><input type="checkbox" style="width:auto;margin:0" ${it.required !== false ? 'checked' : ''} data-a="ireq" data-i="${i}" data-j="${j}">Required</label>` : ''}
      ${it.kind === 'photo' ? `<label style="display:flex;gap:6px;align-items:center;margin:4px 0 0"><input type="checkbox" style="width:auto;margin:0" ${it.required !== false ? 'checked' : ''} data-a="ireq" data-i="${i}" data-j="${j}">Required</label>` : ''}</div>`).join('')}
    <button class="b sec sm" data-a="iadd" data-i="${i}" style="margin-top:8px">+ Add item</button></div>`).join('')}
  <button class="b sec full" data-a="sadd" style="margin-bottom:12px">+ Add section</button>
  <div class="row"><button class="b full" data-a="tsave">Save checklist</button>${t.is_default ? '' : '<button class="b red n" data-a="tdelete">Delete</button>'}</div>`;
}
const T = () => S.cache.tedit, sec = el => T().sections[+el.dataset.i], item = el => sec(el).items[+el.dataset.j];
const mv = (arr, i, d) => { const k = i + d; if (k < 0 || k >= arr.length) return; [arr[i], arr[k]] = [arr[k], arr[i]]; };
K.actions.tclose = () => { if (confirm('Leave without saving changes?')) { S.cache.tedit = null; K.render(); } };
K.inputs.bname = el => { T().name = el.value; };
K.changes.bgps = el => { T().settings.gps = el.checked; };
K.inputs.stitle = el => { sec(el).title = el.value; };
K.inputs.ssecs = el => { sec(el).secs = parseInt(el.value) || 0; };
K.changes.starget = el => { sec(el).target = el.value; };
K.changes.swalk = el => { sec(el).walk = el.checked; };
K.inputs.ilabel = el => { item(el).label = el.value; };
K.inputs.iunit = el => { item(el).unit = el.value; };
K.changes.ireq = el => { item(el).required = el.checked; };
K.changes.ifp = el => { item(el).failPhoto = el.value; };
K.changes.ikind = el => { const it = item(el); it.kind = el.value; if (it.kind === 'check') it.failPhoto = it.failPhoto || 'optional'; else if (it.required === undefined) it.required = true; K.render(); };
K.actions.smove = (el, d) => { mv(T().sections, +d.i, +d.v); K.render(); };
K.actions.sdel = (el, d) => { if (confirm('Delete this section?')) { T().sections.splice(+d.i, 1); K.render(); } };
K.actions.sadd = () => { T().sections.push({ id: 's' + Date.now().toString(36), title: 'New section', secs: 0, walk: false, target: 'vehicle', items: [{ label: 'New item', kind: 'check', failPhoto: 'optional' }] }); K.render(); };
K.actions.imove = (el, d) => { mv(sec(el).items, +d.j, +d.v); K.render(); };
K.actions.idel = (el, d) => { sec(el).items.splice(+d.j, 1); K.render(); };
K.actions.iadd = (el, d) => { sec(el).items.push({ label: 'New item', kind: 'check', failPhoto: 'optional' }); K.render(); };
K.actions.tsave = () => K.run(async () => {
  const t = T(); const r = await api('PUT', '/api/templates/' + t.id, { name: t.name, sections: t.sections.filter(s => s.items.length || s.title), settings: t.settings });
  S.cache.tedit = null; K.cacheSet('templates', null); K.toast('Saved. Drivers get it next time they start a check.');
});
K.actions.tdelete = () => { if (!confirm('Delete this checklist? Vehicles using it go back to the default. Past checks keep their record.')) return; return K.run(async () => { await api('DELETE', '/api/templates/' + T().id); S.cache.tedit = null; }); };

/* ================= handovers ================= */
K.views.handovers = async function () {
  const rows = await api('GET', '/api/handovers'), open = S.cache.hoopen;
  return `<h1>Handovers</h1><p class="mut">Photos, mileage and a signature each time a vehicle goes out or comes back, stamped with the time and place.</p>
  ${rows.map(h => `<div class="card"><div class="row"><div><b>${esc(h.reg)}</b> ${h.kind === 'out' ? '<span class="pill warn">out</span>' : '<span class="pill ok">back</span>'}<div class="mut">${K.dt(h.finished_at || h.created_at)} · recorded by ${esc(h.full_name)} · ${h.kind === 'out' ? 'to' : 'from'} ${esc(h.other_party || '?')}</div>
    <div class="mut">${h.mileage != null ? h.mileage.toLocaleString('en-GB') + ' miles · ' : ''}fuel ${esc(h.fuel || '?')}${h.lat ? ` · <a href="https://www.google.com/maps?q=${h.lat},${h.lng}" target="_blank" rel="noopener">Map</a> (±${Math.round(h.acc || 0)} m)` : ' · no location'}</div></div><button class="b sec sm n" data-a="hoopen" data-id="${h.id}">${open === h.id ? 'Hide' : 'Photos'}</button></div>
    ${h.notes ? `<p>${esc(h.notes)}</p>` : ''}
    ${open === h.id ? `<div class="grid">${(h.photos || []).map(p => `<div><label>${esc(p.label)}</label><img class="photo" data-p="${esc(h.company_id + '/' + h.id + '/' + p.name)}" alt=""></div>`).join('')}${h.signature ? `<div><label>Signature</label><img class="photo" style="background:#fff;object-fit:contain" data-p="${esc(h.company_id + '/' + h.id + '/signature.jpg')}" alt=""></div>` : ''}</div>` : ''}</div>`).join('') || '<div class="card"><p class="mut">None yet.</p></div>'}`;
};
K.actions.hoopen = (el, d) => { S.cache.hoopen = S.cache.hoopen === d.id ? null : d.id; K.render(); };

/* ================= reports ================= */
K.views.reports = async function () {
  const to = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
  return `<h1>Reports</h1><div class="card"><h2>PDF report</h2><p class="mut">Every check, defect and missed check for the period. Keep it for DVSA, insurers or your operator's licence file.${S.co.weekly_report ? ' A report for the last 7 days is also emailed to your alert email address every Monday.' : ''}</p>
  <div class="grid"><div><label>From</label><input type="date" id="rfrom" value="${from}"></div><div><label>To</label><input type="date" id="rto" value="${to}"></div></div><button class="b full" data-a="rdl">Download PDF</button></div>`;
};
K.actions.rdl = () => K.run(async () => { const f = val('#rfrom'), t = val('#rto'); await K.download(`/api/report.pdf?from=${f}&to=${t}`, `kovi-report-${f}-to-${t}.pdf`); });

/* ================= settings ================= */
const DAYS = [['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['7', 'Sun']];
K.views.settings = async function () {
  const c = S.co;
  return `<h1>Settings</h1><div class="card"><h2>Email</h2><label>Send alerts and weekly reports to</label><input id="sa" type="email" value="${esc(c.alert_email || '')}"><label>Send invoices to</label><input id="sb" type="email" value="${esc(c.billing_email || '')}">
  <label style="display:flex;gap:8px;align-items:center;font-weight:400;color:var(--ink)"><input type="checkbox" id="swr" style="width:auto;margin:0" ${c.weekly_report ? 'checked' : ''}>Email me a PDF report every Monday</label></div>
  <div class="card"><h2>Who hasn't checked?</h2><p class="mut">If any vehicle that needs a daily check has not been checked by this time, you get an alert listing them.</p>
  <label>Check by (leave empty to switch off)</label><input id="scb" type="time" value="${esc(c.check_by || '')}"><label>On these days</label><div class="seg">${DAYS.map(([n, l]) => `<button data-a="sday" data-v="${n}" class="${c.check_days.includes(n) ? 'on p' : ''}" style="padding:8px 0">${l}</button>`).join('')}</div></div>
  <div class="card"><h2>Checks</h2><label>Minimum time for a whole check (seconds, 0 = none)</label><input id="smin" type="number" min="0" max="3600" value="${c.min_total_secs || 0}">
  <label style="display:flex;gap:8px;align-items:center;font-weight:400;color:var(--ink)"><input type="checkbox" id="sho" style="width:auto;margin:0" ${c.handover_on ? 'checked' : ''}>Turn on hire / handover records (before and after photos)</label></div>
  <button class="b full" data-a="savesettings">Save settings</button>
  <div class="card" style="margin-top:12px"><h2>Legal</h2><p class="mut"><a href="/legal/terms" target="_blank" rel="noopener">Terms of Service</a> · <a href="/legal/data-processing" target="_blank" rel="noopener">Data Processing Terms</a> · <a href="/legal/privacy" target="_blank" rel="noopener">Privacy Notice</a> · <a href="/legal/driver-notice" target="_blank" rel="noopener">Driver privacy notice</a></p><p class="mut">Please give your drivers the driver notice. It explains what the app records.</p></div>`;
};
K.actions.sday = (el, d) => { el.classList.toggle('on'); el.classList.toggle('p'); };
K.actions.savesettings = () => K.run(async () => {
  const days = [...document.querySelectorAll('[data-a="sday"].on')].map(b => b.dataset.v).join('');
  const r = await api('PUT', '/api/company', { alert_email: val('#sa'), billing_email: val('#sb'), weekly_report: $('#swr').checked, check_by: val('#scb'), check_days: days, min_total_secs: parseInt(val('#smin')) || 0, handover_on: $('#sho').checked });
  S.co = r.co; K.toast('Saved');
});

/* ================= billing ================= */
K.views.billing = async function () {
  const b = await api('GET', '/api/billing'), u = b.usage, vat = u.vat_on ? Math.round(u.subtotal * u.vat_rate * 100) / 100 : 0;
  return `<h1>Billing</h1><div class="card"><h2>This month so far</h2><p>${u.weeks} vehicle-weeks × ${gbp(u.price)} = <b>${gbp(u.subtotal)}</b>${u.vat_on ? ` + VAT ${gbp(vat)} = <b>${gbp(u.subtotal + vat)}</b>` : ''}</p>
  <p class="mut">Each vehicle is charged for every 7-day block that starts in the month, from the day you add it. Remove a vehicle and charging stops.</p>
  <table class="tbl"><tr><th>Vehicle</th><th class="r">Weeks</th><th class="r">Amount</th></tr>${u.rows.map(r => `<tr><td>${esc(r.reg)} <span class="mut">${esc(r.type)}</span></td><td class="r">${r.weeks}</td><td class="r">${gbp(r.weeks * u.price)}</td></tr>`).join('')}</table></div>
  <div class="card"><h2>Invoices</h2>${b.invoices.map(i => `<div class="item"><div class="t"><b>${esc(i.number)}</b><div class="mut">${new Date(i.period).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })} · due ${K.d(i.due_on)}</div></div><b>${gbp(i.total)}</b>${K.pill(i.status === 'paid' ? 'fixed' : i.status === 'unpaid' ? 'minor' : 'void')}</div>`).join('') || '<p class="mut">Your first invoice is created at the start of next month.</p>'}</div>
  <p class="mut">Invoices are sent by email. Payment details are on each invoice.</p>`;
};

/* ================= platform owner ================= */
K.views.platform = async function () {
  const p = await api('GET', '/api/platform'), mrr = p.companies.reduce((a, c) => a + c.vehicles * c.weekly_price * 52 / 12, 0);
  return `<h1>Platform</h1><div class="card"><div class="grid"><div><div class="big">${p.companies.length}</div><div class="mut">companies</div></div><div><div class="big">${gbp(mrr)}</div><div class="mut">approx. per month before VAT</div></div></div><button class="b sec full" style="margin-top:10px" data-a="runbilling">Create last month's invoices</button></div>
  <div class="card"><h2>Companies</h2>${p.companies.map(c => `<div class="item" style="flex-wrap:wrap"><div class="t"><b>${esc(c.name)}</b><div class="mut">${c.vehicles} vehicles · ${c.people} people · terms ${esc(c.terms_version || 'not accepted')}</div></div>
    <input id="pr-${c.id}" type="number" step="0.01" min="0" max="100" value="${c.weekly_price}" style="width:90px;margin:0"><button class="b sec sm" data-a="setprice" data-id="${c.id}">Set £/week</button></div>`).join('')}</div>
  <div class="card"><h2>Invoices</h2>${p.invoices.map(i => `<div class="item"><div class="t"><b>${esc(i.number)}</b> ${esc(i.company)}<div class="mut">${gbp(i.total)} · ${i.status}</div></div>${i.status === 'unpaid' ? `<button class="b sm" data-a="markpaid" data-id="${i.id}">Mark paid</button>` : K.pill('fixed')}</div>`).join('') || '<p class="mut">None.</p>'}</div>`;
};
K.actions.runbilling = () => K.run(async () => { const r = await api('POST', '/api/platform/run-billing', {}); K.toast(r.n + ' invoice(s) created'); });
K.actions.setprice = (el, d) => K.run(async () => { await api('POST', `/api/platform/companies/${d.id}/price`, { weekly_price: +val('#pr-' + d.id) }); K.toast('Price updated'); });
K.actions.markpaid = (el, d) => K.run(async () => { await api('POST', `/api/platform/invoices/${d.id}/paid`); });
})();
