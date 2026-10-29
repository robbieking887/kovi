'use strict';
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 16) { console.error('JWT_SECRET (16+ chars) is required'); process.exit(1); }
const PLATFORM_EMAIL = (process.env.PLATFORM_ADMIN_EMAIL || '').toLowerCase();
const CRON_SECRET = process.env.CRON_SECRET || '';
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'Kovi <onboarding@resend.dev>';

const pool = new Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {
  host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME || 'kovi' });
const q = (text, params) => pool.query(text, params);

/* ---------- photo storage: Google Cloud Storage, or a local folder for tests ---------- */
let bucket = null;
const LOCAL_DIR = process.env.LOCAL_PHOTO_DIR || path.join(__dirname, '.photos');
if (process.env.BUCKET) { const { Storage } = require('@google-cloud/storage'); bucket = new Storage().bucket(process.env.BUCKET); }
async function savePhoto(p, buf) { if (bucket) return bucket.file(p).save(buf, { contentType: 'image/jpeg', resumable: false }); const f = path.join(LOCAL_DIR, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); }
function readPhoto(p, res) {
  if (bucket) return bucket.file(p).createReadStream().on('error', () => res.status(404).end()).pipe(res);
  const f = path.join(LOCAL_DIR, p); if (!fs.existsSync(f)) return res.status(404).end(); fs.createReadStream(f).pipe(res);
}

const DEFAULT_CHECKLIST = [
  { id: 'cab', title: 'Cab & lights', secs: 5, walk: false, items: ['Windscreen and wipers', 'Mirrors', 'Horn', 'Dashboard warning lights', 'Seat belt', 'Cab lights and indicators'] },
  { id: 'out', title: 'Walk round vehicle', secs: 12, walk: true, items: ['Tyres and wheel nuts', 'Lights, reflectors and number plates', 'Body, doors and load security', 'Fluid leaks', 'Fuel cap and AdBlue cap'] },
  { id: 'trl', title: 'Trailer / body', secs: 8, walk: false, items: ['Coupling and air lines', 'Landing legs', 'Curtains / doors / tail lift', 'Load restraints'] },
  { id: 'saf', title: 'Safety kit', secs: 5, walk: false, items: ['Fire extinguisher', 'First aid kit', 'Warning triangle', 'Hi-vis and spare bulbs'] }];

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Permissions-Policy': 'geolocation=(self), camera=(self)' }); next(); });
app.use(express.json({ limit: '1mb' }));

const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => { if (!e.status) console.error(e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Server error' }); });
const bad = (m, status = 400) => Object.assign(new Error(m), { status });

/* ---------- auth ---------- */
const attempts = new Map();
function throttle(key, max = 10) { const now = Date.now(), a = (attempts.get(key) || []).filter(t => now - t < 15 * 60e3); if (a.length >= max) throw bad('Too many attempts. Try again in 15 minutes.', 429); a.push(now); attempts.set(key, a); }
const sign = u => jwt.sign({ sub: u.id }, SECRET, { expiresIn: '30d' });
const isPlatform = u => !!PLATFORM_EMAIL && u.email.toLowerCase() === PLATFORM_EMAIL;
async function auth(req, res, next) {
  try {
    const h = req.get('authorization') || '', t = h.startsWith('Bearer ') ? h.slice(7) : req.query.t;
    const { sub } = jwt.verify(t, SECRET);
    const { rows } = await q('select * from users where id=$1', [sub]);
    if (!rows[0] || !rows[0].active) throw new Error('x');
    req.user = rows[0]; next();
  } catch (e) { res.status(401).json({ error: 'Please sign in' }); }
}
const admin = (req, res, next) => req.user.role === 'admin' && req.user.company_id ? next() : res.status(403).json({ error: 'Admins only' });
const platform = (req, res, next) => isPlatform(req.user) ? next() : res.status(403).json({ error: 'Not allowed' });
const pub = u => ({ id: u.id, email: u.email, full_name: u.full_name, role: u.role, company_id: u.company_id, is_platform_admin: isPlatform(u) });
const getCompany = async id => (await q('select * from companies where id=$1', [id])).rows[0] || null;

app.post('/api/signup', wrap(async (req, res) => {
  const { email, password, name, mode, company, code } = req.body || {};
  throttle('s' + req.ip, 40);
  if (!/^\S+@\S+\.\S+$/.test(email || '')) throw bad('Enter a valid email');
  if (!password || password.length < 8) throw bad('Password must be 8+ characters');
  if (!name || !name.trim()) throw bad('Enter your name');
  const client = await pool.connect();
  try {
    await client.query('begin');
    let cid, role;
    if (mode === 'co') {
      if (!company || !company.trim()) throw bad('Enter your company name');
      cid = (await client.query('insert into companies(name, alert_email, billing_email, checklist) values ($1,$2,$2,$3) returning id', [company.trim(), email.trim(), JSON.stringify(DEFAULT_CHECKLIST)])).rows[0].id; role = 'admin';
    } else {
      const c = (await client.query('select id from companies where join_code=$1', [String(code || '').trim().toUpperCase()])).rows[0];
      if (!c) throw bad('Company code not found'); cid = c.id; role = 'driver';
    }
    const hash = await bcrypt.hash(password, 10);
    let u;
    try { u = (await client.query('insert into users(email,password_hash,company_id,full_name,role) values ($1,$2,$3,$4,$5) returning *', [email.trim(), hash, cid, name.trim(), role])).rows[0]; }
    catch (e) { if (e.code === '23505') throw bad('That email already has a login. Sign in instead.', 409); throw e; }
    await client.query('commit');
    res.json({ token: sign(u) });
  } catch (e) { await client.query('rollback').catch(() => {}); throw e; } finally { client.release(); }
}));
app.post('/api/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  throttle('l' + req.ip + (email || ''));
  const u = (await q('select * from users where lower(email)=lower($1)', [String(email || '').trim()])).rows[0];
  if (!u || !u.active || !(await bcrypt.compare(String(password || ''), u.password_hash))) throw bad('Wrong email or password', 401);
  res.json({ token: sign(u) });
}));
app.get('/api/me', auth, wrap(async (req, res) => res.json({ me: pub(req.user), co: req.user.company_id ? await getCompany(req.user.company_id) : null })));

/* ---------- vehicles ---------- */
app.get('/api/vehicles', auth, wrap(async (req, res) => res.json((await q('select * from vehicles where company_id=$1 and removed_on is null order by reg', [req.user.company_id])).rows)));
app.get('/api/vehicles/all', auth, admin, wrap(async (req, res) => res.json((await q('select * from vehicles where company_id=$1 order by reg', [req.user.company_id])).rows)));
app.post('/api/vehicles', auth, admin, wrap(async (req, res) => {
  const reg = String(req.body.reg || '').trim().toUpperCase(); if (!reg) throw bad('Enter a reg');
  if ((await q('select 1 from vehicles where company_id=$1 and reg=$2 and removed_on is null', [req.user.company_id, reg])).rowCount) throw bad(reg + ' is already added');
  await q('insert into vehicles(company_id,reg,type) values ($1,$2,$3)', [req.user.company_id, reg, String(req.body.type || 'Truck').slice(0, 20)]); res.json({ ok: true });
}));
app.post('/api/vehicles/:id/remove', auth, admin, wrap(async (req, res) => { await q('update vehicles set removed_on=current_date where id=$1 and company_id=$2 and removed_on is null', [req.params.id, req.user.company_id]); res.json({ ok: true }); }));

/* ---------- checks ---------- */
const FLAG_TEXT = { no_gps: 'no GPS fix, could not confirm location', far: 'moved more than 50 m from the vehicle during the check', no_walk: 'compass shows they did not walk all the way round', too_fast: 'check finished faster than the minimum time', no_plate: 'no reg plate photo' };
app.post('/api/photos/:checkId/:name', auth, express.raw({ type: '*/*', limit: '6mb' }), wrap(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.checkId) || !/^[\w.-]{1,40}$/.test(req.params.name)) throw bad('Bad photo path');
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad('Empty photo');
  await savePhoto(`${req.user.company_id}/${req.params.checkId}/${req.params.name}`, req.body); res.json({ ok: true });
}));
app.get('/api/photo', auth, admin, wrap(async (req, res) => {
  const p = String(req.query.p || ''); if (!p.startsWith(req.user.company_id + '/') || p.includes('..')) throw bad('Not allowed', 403);
  res.set('Content-Type', 'image/jpeg'); res.set('Cache-Control', 'private, max-age=3600'); readPhoto(p, res);
}));
app.post('/api/checks', auth, wrap(async (req, res) => {
  const b = req.body || {}, u = req.user, co = await getCompany(u.company_id);
  if (!co) throw bad('No company');
  if (!/^[0-9a-f-]{36}$/i.test(b.id || '')) throw bad('Bad check id');
  const v = (await q('select id, reg from vehicles where id=$1 and company_id=$2', [b.vehicle_id, u.company_id])).rows[0]; if (!v) throw bad('Unknown vehicle');
  const flags = [...new Set((Array.isArray(b.flags) ? b.flags : []).filter(f => FLAG_TEXT[f]))];
  const minTotal = Math.max(co.min_total_secs || 0, co.checklist.reduce((a, s) => a + (s.secs || 0), 0));
  const dur = Math.max(0, Math.min(86400, parseInt(b.duration_secs) || 0));
  if (dur < minTotal && !flags.includes('too_fast')) flags.push('too_fast');
  const defects = Array.isArray(b.defects) ? b.defects.slice(0, 100) : [];
  const verdict = flags.length ? 'flagged' : defects.length ? 'defect' : 'pass';
  const n = x => (Number.isFinite(+x) && x !== null && x !== '' ? +x : null);
  const ins = await q(`insert into checks(id,company_id,vehicle_id,driver_id,started_at,finished_at,start_lat,start_lng,start_acc,end_lat,end_lng,distance_m,heading_coverage,duration_secs,plate_photo,licence,mileage,results,defects,notes,flags,verdict)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) on conflict (id) do nothing returning id`,
    [b.id, u.company_id, v.id, u.id, b.started_at || new Date(), b.finished_at || new Date(), n(b.start_lat), n(b.start_lng), n(b.start_acc), n(b.end_lat), n(b.end_lng), n(b.distance_m), n(b.heading_coverage), dur,
      `${u.company_id}/${b.id}/plate.jpg`, String(b.licence || '').slice(0, 5), n(b.mileage), JSON.stringify(b.results || {}), JSON.stringify(defects), String(b.notes || '').slice(0, 2000), flags, verdict]);
  if (ins.rowCount) {
    const msgs = flags.map(f => ['verification', `${u.full_name} on ${v.reg}: ${FLAG_TEXT[f]}`]);
    if (defects.length) msgs.push(['defect', `${u.full_name} reported ${defects.length} defect(s) on ${v.reg}`]);
    for (const [kind, message] of msgs) await q('insert into alerts(company_id,check_id,kind,message) values ($1,$2,$3,$4)', [u.company_id, b.id, kind, message]);
    if (msgs.length) sendAlerts().catch(e => console.error('email', e.message));
  }
  res.json({ ok: true, verdict });
}));
// drivers only ever see their own last 7 days; admins see all time
app.get('/api/checks/mine', auth, wrap(async (req, res) => res.json((await q(`select c.*, v.reg from checks c join vehicles v on v.id=c.vehicle_id where c.driver_id=$1 and c.started_at > now() - interval '7 days' order by c.started_at desc limit 100`, [req.user.id])).rows)));
app.get('/api/checks/today', auth, admin, wrap(async (req, res) => {
  const day = String(req.query.since || '').slice(0, 30);
  res.json((await q(`select c.*, v.reg, u.full_name from checks c join vehicles v on v.id=c.vehicle_id join users u on u.id=c.driver_id where c.company_id=$1 and c.started_at >= $2 order by c.started_at desc`, [req.user.company_id, day || new Date(Date.now() - 864e5)])).rows);
}));
app.get('/api/checks', auth, admin, wrap(async (req, res) => {
  const { from, to, vehicle, driver, verdict } = req.query, p = [req.user.company_id]; let w = 'c.company_id=$1';
  if (from) { p.push(from); w += ` and c.started_at >= $${p.length}`; } if (to) { p.push(to + 'T23:59:59'); w += ` and c.started_at <= $${p.length}`; }
  if (vehicle) { p.push(vehicle); w += ` and c.vehicle_id = $${p.length}`; } if (driver) { p.push(driver); w += ` and c.driver_id = $${p.length}`; }
  if (verdict) { p.push(verdict); w += ` and c.verdict = $${p.length}`; }
  res.json((await q(`select c.*, v.reg, u.full_name from checks c join vehicles v on v.id=c.vehicle_id join users u on u.id=c.driver_id where ${w} order by c.started_at desc limit 300`, p)).rows);
}));
app.post('/api/checks/:id/fix', auth, admin, wrap(async (req, res) => { await q('update checks set fixed=true where id=$1 and company_id=$2', [req.params.id, req.user.company_id]); res.json({ ok: true }); }));

/* ---------- alerts ---------- */
app.get('/api/alerts', auth, admin, wrap(async (req, res) => res.json((await q('select * from alerts where company_id=$1 order by created_at desc limit 100', [req.user.company_id])).rows)));
app.get('/api/alerts/count', auth, admin, wrap(async (req, res) => res.json({ n: +(await q('select count(*) from alerts where company_id=$1 and not resolved', [req.user.company_id])).rows[0].count })));
app.post('/api/alerts/:id/resolve', auth, admin, wrap(async (req, res) => { await q('update alerts set resolved=true where id=$1 and company_id=$2', [req.params.id, req.user.company_id]); res.json({ ok: true }); }));
async function sendAlerts() {
  if (!RESEND_KEY) return;
  const { rows } = await q('select a.id, a.message, a.kind, a.created_at, c.name, c.alert_email from alerts a join companies c on c.id=a.company_id where not a.emailed order by a.created_at limit 50');
  for (const a of rows) {
    if (!a.alert_email) { await q('update alerts set emailed=true where id=$1', [a.id]); continue; }
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [a.alert_email], subject: `Kovi alert: ${a.kind === 'defect' ? 'defect reported' : 'check not verified'}`, text: `${a.message}\n\n${a.name} · ${new Date(a.created_at).toLocaleString('en-GB', { timeZone: 'Europe/London' })}\nOpen Kovi to see the check.` }) });
    if (r.ok) await q('update alerts set emailed=true where id=$1', [a.id]); else console.error('resend', await r.text());
  }
}

/* ---------- people + settings ---------- */
app.get('/api/people', auth, admin, wrap(async (req, res) => res.json((await q('select id,email,full_name,role,active from users where company_id=$1 order by full_name', [req.user.company_id])).rows)));
app.post('/api/people/:id', auth, admin, wrap(async (req, res) => {
  if (req.params.id === req.user.id) throw bad("You can't change your own access");
  const { role, active } = req.body || {};
  if (role && !['driver', 'admin'].includes(role)) throw bad('Bad role');
  await q('update users set role=coalesce($1,role), active=coalesce($2,active) where id=$3 and company_id=$4', [role || null, typeof active === 'boolean' ? active : null, req.params.id, req.user.company_id]); res.json({ ok: true });
}));
app.put('/api/company', auth, admin, wrap(async (req, res) => {
  const b = req.body || {}, cur = await getCompany(req.user.company_id);
  let cl = cur.checklist;
  if (b.checklist) {
    if (!Array.isArray(b.checklist) || b.checklist.length > 12) throw bad('Bad checklist');
    cl = b.checklist.map(s => ({ id: String(s.id).slice(0, 20), title: String(s.title || '').slice(0, 60), secs: Math.max(0, Math.min(120, parseInt(s.secs) || 0)), walk: !!s.walk, items: (s.items || []).map(i => String(i).slice(0, 80)).slice(0, 40) }));
  }
  await q('update companies set alert_email=$1, billing_email=$2, min_total_secs=$3, checklist=$4 where id=$5',
    [b.alert_email ?? cur.alert_email, b.billing_email ?? cur.billing_email, b.min_total_secs != null ? Math.max(0, parseInt(b.min_total_secs) || 0) : cur.min_total_secs, JSON.stringify(cl), cur.id]);
  res.json({ co: await getCompany(cur.id) });
}));

/* ---------- billing ---------- */
app.get('/api/billing', auth, admin, wrap(async (req, res) => {
  const co = await getCompany(req.user.company_id);
  const rows = (await q(`select reg, type, added_on as added, removed_on as removed, weeks_in_month(added_on, removed_on, current_date) as weeks from vehicles where company_id=$1 order by reg`, [co.id])).rows.filter(r => r.weeks > 0);
  const weeks = rows.reduce((a, r) => a + r.weeks, 0);
  res.json({ usage: { rows, weeks, subtotal: weeks * +co.weekly_price, vat_on: co.vat_on, vat_rate: +co.vat_rate, price: +co.weekly_price }, invoices: (await q('select * from invoices where company_id=$1 order by period desc', [co.id])).rows });
}));
app.get('/api/invoices/:id', auth, admin, wrap(async (req, res) => { const i = (await q('select * from invoices where id=$1 and company_id=$2', [req.params.id, req.user.company_id])).rows[0]; if (!i) throw bad('Not found', 404); res.json(i); }));
const lastMonth = () => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 10); };
app.get('/api/platform', auth, platform, wrap(async (req, res) => res.json({
  companies: (await q(`select c.*, (select count(*) from users u where u.company_id=c.id) people, (select count(*) from vehicles v where v.company_id=c.id and v.removed_on is null) vehicles from companies c order by created_at`)).rows,
  invoices: (await q('select i.*, c.name as company from invoices i join companies c on c.id=i.company_id order by period desc, number desc')).rows })));
app.post('/api/platform/run-billing', auth, platform, wrap(async (req, res) => res.json({ n: (await q('select generate_invoices($1) n', [req.body.month || lastMonth()])).rows[0].n })));
app.post('/api/platform/invoices/:id/paid', auth, platform, wrap(async (req, res) => { await q("update invoices set status='paid', paid_on=current_date where id=$1", [req.params.id]); res.json({ ok: true }); }));
// Cloud Scheduler hits this on the 1st of each month
app.post('/api/cron/invoices', wrap(async (req, res) => {
  if (!CRON_SECRET || req.get('x-cron-secret') !== CRON_SECRET) throw bad('No', 403);
  res.json({ n: (await q('select generate_invoices($1) n', [lastMonth()])).rows[0].n });
}));
app.get('/healthz', (req, res) => res.send('ok'));

/* ---------- static app ---------- */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use(express.static(path.join(__dirname, '..', 'web'), { setHeaders: (res, p) => { if (/sw\.js$|index\.html$/.test(p)) res.set('Cache-Control', 'no-cache'); } }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'web', 'index.html')));

(async () => {
  await q(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  app.listen(PORT, () => console.log('Kovi listening on', PORT));
})().catch(e => { console.error('startup failed', e); process.exit(1); });
