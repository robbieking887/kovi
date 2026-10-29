// API-level test of every server feature. Needs a running server started with TEST_MODE=1 and CRON_SECRET=cronsecret:
//   node tests/api.js http://localhost:8099
const BASE = process.argv[2] || 'http://localhost:8099', CRON = process.env.CRON_SECRET || 'cronsecret';
const stamp = Date.now(); let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ', m); } else { failed++; console.log('  FAIL', m); } };
const uid = () => crypto.randomUUID();
async function call(method, url, { token, body, ip, headers } = {}) {
  const r = await fetch(BASE + url, { method, headers: Object.assign({}, token ? { Authorization: 'Bearer ' + token } : {}, ip ? { 'X-Forwarded-For': ip } : {}, body ? { 'Content-Type': 'application/json' } : {}, headers), body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || ''; const data = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { s: r.status, d: data };
}
(async () => {
  console.log('signup + templates'); 
  let r = await call('POST', '/api/signup', { body: { email: `o${stamp}@t.co`, password: 'password123', name: 'Boss', mode: 'co', company: 'API Haulage ' + stamp } });
  ok(r.s === 400, 'company signup without accepting terms is refused');
  r = await call('POST', '/api/signup', { body: { email: `o${stamp}@t.co`, password: 'password123', name: 'Boss', mode: 'co', company: 'API Haulage ' + stamp, accept_terms: true } });
  ok(r.s === 200 && r.d.token, 'company signup with terms accepted'); const A = r.d.token;
  r = await call('GET', '/api/me', { token: A }); const co = r.d.co; ok(co.join_code && co.alert_email, 'admin sees full company settings');
  r = await call('GET', '/api/templates', { token: A }); ok(r.d.length === 1 && r.d[0].is_default && r.d[0].sections.length === 4, 'new company has a default template'); const T0 = r.d[0];
  ok(T0.sections.find(s => s.target === 'trailer'), 'default template has a trailer section');

  console.log('vehicles'); 
  await call('POST', '/api/vehicles', { token: A, body: { reg: 'ab12 cde', type: 'Tractor unit' } });
  await call('POST', '/api/vehicles', { token: A, body: { reg: 'tr 001', type: 'Trailer' } });
  await call('POST', '/api/vehicles', { token: A, body: { reg: 'sp 99', type: 'Van' } });
  r = await call('GET', '/api/vehicles', { token: A }); const V = Object.fromEntries(r.d.map(v => [v.reg, v]));
  ok(V['AB12 CDE'].daily_check === true && V['TR 001'].daily_check === false, 'trailers are not expected to be checked daily by default');
  ok(!!V['AB12 CDE'].mot_due === false, 'vehicle starts with no MOT date');

  console.log('PIN drivers');
  r = await call('POST', '/api/people/driver', { token: A, body: { name: 'Dave' } }); ok(/^\d{6}$/.test(r.d.pin), 'admin creates a driver and gets a 6 digit PIN'); const PIN = r.d.pin, DAVE = r.d.id;
  r = await call('POST', '/api/people/driver', { token: A, body: { name: 'Sue' } }); const PIN2 = r.d.pin; ok(PIN2 !== PIN, 'every driver gets a different PIN');
  r = await call('POST', '/api/login-pin', { body: { code: co.join_code, pin: '999999' }, ip: '10.1.1.1' }); ok(r.s === 401, 'wrong PIN is refused');
  r = await call('POST', '/api/login-pin', { body: { code: 'NOPE', pin: PIN }, ip: '10.1.1.1' }); ok(r.s === 401, 'wrong company code is refused');
  r = await call('POST', '/api/login-pin', { body: { code: co.join_code.toLowerCase(), pin: PIN }, ip: '10.1.1.2' }); ok(r.s === 200 && r.d.token, 'right code + PIN signs in (code is not case sensitive)'); const D = r.d.token;
  r = await call('GET', '/api/me', { token: D }); ok(r.d.me.full_name === 'Dave' && r.d.me.role === 'driver', 'PIN driver is a driver');
  ok(!r.d.co.billing_email && !r.d.co.join_code, 'drivers do not get billing email or settings');
  r = await call('GET', '/api/people', { token: D }); ok(r.s === 403, 'drivers cannot list people');
  r = await call('POST', '/api/people/' + DAVE, { token: A, body: { role: 'admin' } }); ok(r.s === 400, 'a PIN-only driver cannot be made admin');
  r = await call('POST', '/api/people/' + DAVE + '/pin', { token: A }); const NEWPIN = r.d.pin; ok(NEWPIN !== PIN, 'PIN reset gives a new PIN');
  r = await call('POST', '/api/login-pin', { body: { code: co.join_code, pin: PIN }, ip: '10.1.1.3' }); ok(r.s === 401, 'the old PIN stops working');
  await call('POST', '/api/people/' + DAVE, { token: A, body: { active: false } });
  r = await call('POST', '/api/login-pin', { body: { code: co.join_code, pin: NEWPIN }, ip: '10.1.1.3' }); ok(r.s === 401, 'a disabled driver cannot sign in');
  r = await call('GET', '/api/me', { token: D }); ok(r.s === 401, 'a disabled driver is signed out everywhere');
  await call('POST', '/api/people/' + DAVE, { token: A, body: { active: true } });
  r = await call('POST', '/api/login-pin', { body: { code: co.join_code, pin: NEWPIN }, ip: '10.1.1.4' }); const D2 = r.d.token;

  console.log('checks with trailer, defects, snapshots');
  const sec = T0.sections, results = {}; sec.forEach(s => results[s.id] = s.items.map(() => 1));
  const cid = uid();
  const defects = [{ section: 'Walk round vehicle', item: 'Tyres and wheel nuts', severity: 'major', note: 'Nearside front tread low', target: 'vehicle' },
    { section: 'Trailer', item: 'Landing legs', severity: 'danger', note: 'Left leg will not wind', target: 'trailer' }];
  const mk = (id, extra = {}) => Object.assign({ id, vehicle_id: V['AB12 CDE'].id, trailer_id: V['TR 001'].id, started_at: new Date(Date.now() - 90e3).toISOString(), finished_at: new Date().toISOString(), start_lat: 51.5, start_lng: -0.12, start_acc: 5, end_lat: 51.5, end_lng: -0.12, distance_m: 3, heading_coverage: 4, duration_secs: 90, licence: 'Yes', mileage: 1000, results, defects, notes: '', flags: [], template_id: T0.id, checklist: sec }, extra);
  r = await call('POST', '/api/checks', { token: D2, body: mk(cid) }); ok(r.s === 200 && r.d.verdict === 'defect', 'driver submits a check with a trailer and two defects');
  r = await call('POST', '/api/checks', { token: D2, body: mk(cid) }); ok(r.s === 200, 'sending the same check twice is harmless');
  r = await call('GET', '/api/defects', { token: A }); ok(r.d.length === 2, 'two defect records were created (not duplicated by the resend)');
  const dTrailer = r.d.find(d => d.item === 'Landing legs'), dTyre = r.d.find(d => d.item === 'Tyres and wheel nuts');
  ok(dTrailer.reg === 'TR 001' && dTyre.reg === 'AB12 CDE', 'the trailer defect belongs to the trailer, the tyre to the tractor');
  ok(r.d[0].severity === 'danger', 'dangerous defects sort first');
  r = await call('GET', '/api/alerts', { token: A }); ok(r.d.some(a => a.kind === 'danger' && /do not drive/.test(a.message) && /TR 001/.test(a.message)), 'a dangerous defect raises a do-not-drive alert');
  ok(r.d.some(a => a.kind === 'defect'), 'the other defect raises a normal alert');
  r = await call('GET', '/api/checks/' + cid, { token: A }); ok(r.d.trailer_reg === 'TR 001' && r.d.checklist.length === 4, 'the check keeps the trailer and a snapshot of the checklist used');
  r = await call('GET', '/api/checks?vehicle=' + V['TR 001'].id, { token: A }); ok(r.d.length === 1, 'the trailer history includes checks done with it');
  r = await call('GET', '/api/checks', { token: A }); ok(!('checklist' in r.d[0]), 'the history list does not carry the heavy snapshot');
  const before = (await call('GET', '/api/alerts', { token: A })).d.length;
  r = await call('POST', '/api/checks', { token: D2, body: mk(uid(), { defects: [defects[0]] }) });
  r = await call('GET', '/api/defects', { token: A }); ok(r.d.length === 2 && r.d.find(d => d.item === 'Tyres and wheel nuts').seen_count === 2, 'the same fault reported again is one defect, seen twice');
  ok((await call('GET', '/api/alerts', { token: A })).d.length === before, 'a repeat report does not raise another alert');
  r = await call('GET', '/api/vehicles/' + V['AB12 CDE'].id + '/defects', { token: D2 }); ok(r.d.length === 1 && r.d[0].item === 'Tyres and wheel nuts', 'the next driver sees the open defect on that vehicle');
  r = await call('GET', '/api/defects', { token: D2 }); ok(r.s === 403, 'drivers cannot open the defect list');
  const other = (await call('POST', '/api/signup', { body: { email: `x${stamp}@t.co`, password: 'password123', name: 'Other', mode: 'co', company: 'Other ' + stamp, accept_terms: true } })).d.token;
  r = await call('GET', '/api/vehicles/' + V['AB12 CDE'].id + '/defects', { token: other }); ok(r.d.length === 0, 'another company cannot see this vehicle defects');
  r = await call('POST', '/api/defects/' + dTyre.id + '/fix', { token: other, body: {} }); ok(r.s === 404, 'another company cannot fix this defect');

  console.log('defect loop');
  r = await call('POST', '/api/defects/' + dTyre.id + '/assign', { token: A, body: { assigned_to: 'Workshop' } }); ok(r.s === 200, 'assign to the workshop');
  r = await call('GET', '/api/defects', { token: A }); ok(r.d.find(d => d.id === dTyre.id).status === 'assigned', 'status shows assigned');
  r = await call('POST', '/api/defects/' + dTyre.id + '/fix', { token: A, body: { note: 'New tyre fitted', photo: false } }); ok(r.s === 200, 'mark fixed with a note');
  r = await call('GET', '/api/defects', { token: A }); ok(r.d.length === 1, 'fixed defects leave the active list');
  r = await call('GET', '/api/vehicles/' + V['AB12 CDE'].id + '/defects', { token: D2 }); ok(r.d.length === 1 && r.d[0].status === 'fixed' && r.d[0].fix_note === 'New tyre fitted', 'the next driver is told it was fixed, and how');
  r = await call('GET', '/api/defects?status=fixed', { token: A }); ok(r.d.length === 1 && r.d[0].fixed_by_name === 'Boss', 'history shows who fixed it');
  r = await call('POST', '/api/defects/' + dTyre.id + '/reopen', { token: A }); ok(r.s === 200, 'a defect can be reopened');
  r = await call('GET', '/api/defects/count', { token: A }); ok(r.d.n === 2, 'open count is back to 2');
  await call('POST', '/api/defects/' + dTyre.id + '/fix', { token: A, body: {} });
  // fixed once, new report creates a fresh defect record
  await call('POST', '/api/checks', { token: D2, body: mk(uid(), { defects: [defects[0]] }) });
  r = await call('GET', '/api/defects?status=all', { token: A }); ok(r.d.filter(d => d.item === 'Tyres and wheel nuts').length === 2, 'after a fix, the same fault again is a new defect');

  console.log('flagged checks + offline snapshot');
  r = await call('POST', '/api/checks', { token: D2, body: mk(uid(), { defects: [], flags: ['far', 'bogus'], duration_secs: 1 }) }); ok(r.d.verdict === 'flagged', 'unverified checks are flagged');
  r = await call('GET', '/api/alerts', { token: A }); ok(r.d.some(a => a.kind === 'verification' && /50 m/.test(a.message)), 'flag alert is raised'); ok(!r.d.some(a => /bogus/.test(a.message)), 'unknown flags are ignored');

  console.log('custom templates, number + photo items, per-vehicle assignment');
  r = await call('GET', '/api/presets', { token: A }); ok(r.d.length >= 6, 'presets are offered');
  r = await call('POST', '/api/templates', { token: A, body: { preset: 'forklift', name: 'Warehouse forklift' } }); ok(r.s === 200 && r.d.settings.gps === false, 'forklift preset has GPS check off'); const TF = r.d;
  ok(TF.sections.some(s => s.items.some(i => i.kind === 'number' && i.unit === 'hrs')), 'forklift preset has a number item (hour meter)');
  const edited = JSON.parse(JSON.stringify(TF.sections)); edited[0].items.push({ label: 'Photo of load', kind: 'photo' }, { label: 'Tyre pressure', kind: 'number', unit: 'psi' }, { label: 'Brakes', kind: 'check', failPhoto: 'required' }); edited.push({ id: 'new', title: 'Trailer extras', secs: 3, walk: false, target: 'trailer', items: ['Seals fitted'] });
  r = await call('PUT', '/api/templates/' + TF.id, { token: A, body: { name: 'Warehouse forklift', sections: edited, settings: { gps: false } } }); ok(r.s === 200 && r.d.sections.length === 3, 'template edits are saved');
  ok(r.d.sections[2].items[0].kind === 'check' && r.d.sections[2].target === 'trailer', 'plain-text items are upgraded and trailer target is kept');
  r = await call('PUT', '/api/templates/' + TF.id, { token: A, body: { name: 'x', sections: [{ title: 'Empty', items: [] }] } }); ok(r.s === 400, 'a section with no items is refused');
  r = await call('PUT', '/api/templates/' + TF.id, { token: D2, body: { name: 'x', sections: edited } }); ok(r.s === 403, 'drivers cannot edit templates');
  r = await call('POST', '/api/vehicles/' + V['SP 99'].id, { token: A, body: { template_id: TF.id } }); ok(r.s === 200, 'assign the forklift template to a vehicle');
  r = await call('POST', '/api/vehicles/' + V['SP 99'].id, { token: A, body: { template_id: uid() } }); ok(r.s === 400, 'cannot assign a template that is not yours');
  r = await call('DELETE', '/api/templates/' + T0.id, { token: A }); ok(r.s === 400, 'the default template cannot be deleted');
  r = await call('POST', '/api/templates/' + TF.id + '/default', { token: A }); ok(r.s === 200, 'make another template the default');
  r = await call('GET', '/api/templates', { token: A }); ok(r.d.filter(t => t.is_default).length === 1 && r.d[0].id === TF.id, 'exactly one default');
  r = await call('DELETE', '/api/templates/' + T0.id, { token: A }); ok(r.s === 200, 'the old one can now be deleted');
  r = await call('GET', '/api/vehicles', { token: A }); ok(r.d.find(v => v.reg === 'AB12 CDE').template_id === null, 'vehicles that used the deleted template fall back to the default');
  r = await call('GET', '/api/templates', { token: other }); ok(r.d.length === 1 && r.d[0].id !== TF.id, 'other companies never see your templates');

  console.log('handovers');
  const hid = uid();
  r = await call('POST', '/api/handovers', { token: D2, body: { id: hid, vehicle_id: V['SP 99'].id, kind: 'out', mileage: 5000, fuel: 'Full', other_party: '', photos: [{ name: 'front.jpg', label: 'Front' }] } }); ok(r.s === 400, 'a handover needs the other person named');
  r = await call('POST', '/api/handovers', { token: D2, body: { id: hid, vehicle_id: V['SP 99'].id, kind: 'out', lat: 51.5, lng: -0.1, acc: 8, mileage: 5000, fuel: 'Full', other_party: 'Hire Co Ltd, J Smith', notes: 'Scratch on rear door', signature: true, photos: [{ name: 'front.jpg', label: 'Front' }, { name: '../evil.jpg', label: 'x' }] } }); ok(r.s === 200 && r.d.created, 'a handover record is saved');
  r = await call('GET', '/api/handovers', { token: A }); ok(r.d.length === 1 && r.d[0].photos.length === 1 && r.d[0].full_name === 'Sue' || r.d[0].full_name === 'Dave', 'office lists handovers, unsafe photo names dropped'); ok(r.d[0].reg === 'SP 99', 'handover shows the vehicle');
  r = await call('GET', '/api/handovers', { token: D2 }); ok(r.s === 403, 'drivers cannot browse handover records');

  console.log('settings + missed-check alerts');
  r = await call('PUT', '/api/company', { token: A, body: { check_by: '25:99' } }); ok(r.s === 400, 'a bad time is refused');
  r = await call('PUT', '/api/company', { token: A, body: { check_by: '09:00', check_days: '1234567', weekly_report: false, handover_on: true } }); ok(r.s === 200 && r.d.co.check_by === '09:00' && r.d.co.handover_on === true, 'settings saved');
  const tick = (iso) => call('POST', '/api/cron/tick', { headers: { 'x-cron-secret': CRON, 'x-test-now': iso } });
  r = await call('POST', '/api/cron/tick', { headers: { 'x-cron-secret': 'wrong' } }); ok(r.s === 403, 'the scheduler endpoint needs the secret');
  r = await tick('2026-10-29T08:00:00Z'); r = await call('GET', '/api/alerts', { token: A }); ok(!r.d.some(a => a.kind === 'missed'), 'nothing is raised before the deadline');
  r = await tick('2026-10-29T12:00:00Z'); r = await call('GET', '/api/alerts', { token: A }); const missed = r.d.filter(a => a.kind === 'missed');
  ok(missed.length === 1 && /SP 99/.test(missed[0].message) && !/TR 001/.test(missed[0].message), 'after the deadline, unchecked vehicles are listed (trailers are not expected daily)');
  ok(!/AB12 CDE/.test(missed[0].message), 'a vehicle that was checked is not listed');
  await tick('2026-10-29T13:00:00Z'); r = await call('GET', '/api/alerts', { token: A }); ok(r.d.filter(a => a.kind === 'missed').length === 1, 'it only alerts once per day');
  await call('PUT', '/api/company', { token: A, body: { check_by: '' } }); r = await call('GET', '/api/me', { token: A }); ok(r.d.co.check_by === '', 'the alert can be switched off');

  console.log('MOT / tax / service reminders');
  const day = n => new Date(Date.parse('2026-10-30T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  await call('POST', '/api/vehicles/' + V['AB12 CDE'].id, { token: A, body: { mot_due: day(5), tax_due: day(-3), service_due: day(90) } });
  r = await call('POST', '/api/vehicles/' + V['AB12 CDE'].id, { token: A, body: { mot_due: 'soon' } }); ok(r.s === 400, 'a bad date is refused');
  r = await tick('2026-10-30T05:00:00Z'); r = await call('GET', '/api/alerts', { token: A }); ok(!r.d.some(a => a.kind === 'reminder'), 'reminders wait until 07:00');
  await tick('2026-10-30T09:00:00Z'); r = await call('GET', '/api/alerts', { token: A }); const rem = r.d.find(a => a.kind === 'reminder');
  ok(rem && /MOT due in 5 days/.test(rem.message) && /Vehicle tax OVERDUE by 3 days/.test(rem.message), 'upcoming and overdue dates are reported');
  ok(rem && !/Service/.test(rem.message), 'dates more than 30 days away are not reported');
  await tick('2026-10-31T09:00:00Z'); r = await call('GET', '/api/alerts', { token: A }); ok(r.d.filter(a => a.kind === 'reminder').length === 1, 'the next day nothing new is sent for the same stage');
  await tick('2026-11-03T09:00:00Z'); r = await call('GET', '/api/alerts', { token: A }); ok(r.d.filter(a => a.kind === 'reminder').length === 2 && /MOT due in 1 day/.test(r.d.find(a => a.kind === 'reminder').message), 'the 1-day-before reminder fires');

  console.log('PDF report');
  r = await call('GET', '/api/report.pdf?from=2026-10-20&to=2026-10-29', { token: A }); ok(r.s === 200 && r.d.slice(0, 4).toString() === '%PDF' && r.d.length > 2500, 'the report is a real PDF (' + r.d.length + ' bytes)');
  require('fs').writeFileSync('/tmp/kovi-report.pdf', r.d);
  r = await call('GET', '/api/report.pdf?from=2026-01-01&to=2026-12-31', { token: A }); ok(r.s === 400, 'periods over 3 months are refused');
  r = await call('GET', '/api/report.pdf', { token: D2 }); ok(r.s === 403, 'drivers cannot download reports');

  console.log('billing + price + platform');
  r = await call('GET', '/api/billing', { token: A }); ok(r.d.usage.rows.length === 3 && r.d.usage.price === 1, 'billing counts trailers as vehicles at the price');
  r = await call('POST', '/api/signup', { body: { email: 'owner@kovi.test', password: 'password123', name: 'Owner', mode: 'co', company: 'Platform Co', accept_terms: true } }); if (r.s !== 200) r = await call('POST', '/api/login', { body: { email: 'owner@kovi.test', password: 'password123' } }); const P = r.d.token;
  r = await call('GET', '/api/platform', { token: P }); const mine = r.d.companies.find(c => c.name === 'API Haulage ' + stamp); ok(!!mine && mine.terms_version, 'platform owner sees customers and which terms they accepted');
  r = await call('POST', '/api/platform/companies/' + mine.id + '/price', { token: P, body: { weekly_price: 1.5 } }); ok(r.s === 200, 'platform owner can set a customer price');
  r = await call('POST', '/api/platform/companies/' + mine.id + '/price', { token: A, body: { weekly_price: 0 } }); ok(r.s === 403, 'customers cannot');
  r = await call('GET', '/api/billing', { token: A }); ok(r.d.usage.price === 1.5, 'the new price applies');

  console.log('PIN guessing is rate limited, without locking out other IPs');
  let last; for (let i = 0; i < 17; i++) last = await call('POST', '/api/login-pin', { body: { code: co.join_code, pin: '55' + String(1000 + i).slice(-4) }, ip: '10.7.7.7' });
  ok(last.s === 429, 'after repeated wrong PINs from one address it is blocked');
  r = await call('POST', '/api/login-pin', { body: { code: co.join_code, pin: NEWPIN }, ip: '10.8.8.8' }); ok(r.s === 200, 'a driver at another address can still sign in');

  console.log(`\n${pass} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
