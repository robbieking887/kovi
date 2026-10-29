'use strict';
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 16) { console.error('JWT_SECRET (16+ chars) is required'); process.exit(1); }
const PLATFORM_EMAIL = (process.env.PLATFORM_ADMIN_EMAIL || '').toLowerCase();
const CRON_SECRET = process.env.CRON_SECRET || '';
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const TEST_MODE = process.env.TEST_MODE === '1';
const TERMS_VERSION = '2026-10-29';
const mail = require('./mail')({ RESEND_KEY: process.env.RESEND_API_KEY || '', MAIL_FROM: process.env.MAIL_FROM || 'Kovi <onboarding@resend.dev>' });

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

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Permissions-Policy': 'geolocation=(self), camera=(self)' }); next(); });
app.use(express.json({ limit: '1mb' }));

const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => { if (!e.status) console.error(e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Server error' }); });
const bad = (m, status = 400) => Object.assign(new Error(m), { status });

/* ---------- auth ---------- */
const attempts = new Map(), fails = new Map();
const recent = a => (a || []).filter(t => Date.now() - t < 15 * 60e3);
function throttle(key, max = 10) { const a = recent(attempts.get(key)); if (a.length >= max) throw bad('Too many attempts. Try again in 15 minutes.', 429); a.push(Date.now()); attempts.set(key, a); }
// PIN logins only count FAILURES, so one bad actor cannot lock a whole depot out by guessing
const tooManyFails = (key, max) => recent(fails.get(key)).length >= max;
const noteFail = key => { const a = recent(fails.get(key)); a.push(Date.now()); fails.set(key, a); };
setInterval(() => { for (const m of [attempts, fails]) for (const [k, v] of m) if (!recent(v).length) m.delete(k); }, 10 * 60e3).unref();

const sign = u => jwt.sign({ sub: u.id }, SECRET, { expiresIn: '30d' });
const isPlatform = u => !!PLATFORM_EMAIL && (u.email || '').toLowerCase() === PLATFORM_EMAIL;
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
// drivers get only what the app needs; admins also get the settings
const coView = (co, isAdmin) => {
  if (!co) return null;
  const base = { id: co.id, name: co.name, min_total_secs: co.min_total_secs, handover_on: co.handover_on };
  return isAdmin ? { ...base, join_code: co.join_code, alert_email: co.alert_email, billing_email: co.billing_email, weekly_price: co.weekly_price, vat_on: co.vat_on, vat_rate: co.vat_rate,
    check_by: co.check_by ? String(co.check_by).slice(0, 5) : '', check_days: co.check_days, weekly_report: co.weekly_report } : base;
};

const pinHmac = (cid, pin) => crypto.createHmac('sha256', SECRET).update(cid + ':' + pin).digest('hex');
async function newPin(cid) {
  for (let i = 0; i < 80; i++) {
    const pin = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    if (/^(\d)\1{5}$/.test(pin) || '0123456789876543210'.includes(pin)) continue;   // no 111111, 123456, 654321 ...
    const h = pinHmac(cid, pin);
    if (!(await q('select 1 from users where company_id=$1 and pin_hmac=$2', [cid, h])).rowCount) return { pin, h };
  }
  throw bad('Could not make a PIN, please try again', 500);
}

app.post('/api/signup', wrap(async (req, res) => {
  const { email, password, name, mode, company, code, accept_terms } = req.body || {};
  throttle('s' + req.ip, 40);
  if (!/^\S+@\S+\.\S+$/.test(email || '')) throw bad('Enter a valid email');
  if (!password || password.length < 8) throw bad('Password must be 8+ characters');
  if (!name || !name.trim()) throw bad('Enter your name');
  if (mode === 'co' && accept_terms !== true) throw bad('Please tick the box to accept the Terms and Data Processing Terms');
  const client = await pool.connect();
  try {
    await client.query('begin');
    let cid, role;
    if (mode === 'co') {
      if (!company || !company.trim()) throw bad('Enter your company name');
      cid = (await client.query('insert into companies(name, alert_email, billing_email, terms_accepted_at, terms_version) values ($1,$2,$2,now(),$3) returning id', [company.trim(), email.trim(), TERMS_VERSION])).rows[0].id; role = 'admin';
      await ctx.tpl.ensureDefault(cid, client);
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
  if (!u || !u.active || !u.password_hash || !(await bcrypt.compare(String(password || ''), u.password_hash))) throw bad('Wrong email or password', 401);
  res.json({ token: sign(u) });
}));
app.post('/api/login-pin', wrap(async (req, res) => {
  const code = String((req.body || {}).code || '').trim().toUpperCase(), pin = String((req.body || {}).pin || '');
  if (tooManyFails('ip:' + req.ip, 15) || tooManyFails('code:' + code, 100)) throw bad('Too many wrong tries. Wait 15 minutes, or ask your manager.', 429);
  const fail = () => { noteFail('ip:' + req.ip); noteFail('code:' + code); return bad('Wrong company code or PIN', 401); };
  if (!/^\d{6}$/.test(pin)) throw bad('Enter your 6 digit PIN');
  const co = (await q('select id from companies where join_code=$1', [code])).rows[0]; if (!co) throw fail();
  const u = (await q('select * from users where company_id=$1 and pin_hmac=$2', [co.id, pinHmac(co.id, pin)])).rows[0];
  if (!u || !u.active) throw fail();
  res.json({ token: sign(u) });
}));
app.get('/api/me', auth, wrap(async (req, res) => res.json({ me: pub(req.user), co: coView(req.user.company_id ? await getCompany(req.user.company_id) : null, req.user.role === 'admin') })));

/* ---------- vehicles ---------- */
const DATE = /^\d{4}-\d{2}-\d{2}$/, UUID = /^[0-9a-f-]{36}$/i;
const dateOrNull = v => { if (v === '' || v == null) return null; if (!DATE.test(v) || isNaN(Date.parse(v))) throw bad('Dates must look like 2026-12-31'); return v; };
const VSEL = `select id, company_id, reg, type, added_on, removed_on, template_id, daily_check, mot_due::text, tax_due::text, service_due::text, pmi_due::text from vehicles`;
app.get('/api/vehicles', auth, wrap(async (req, res) => res.json((await q(`${VSEL} where company_id=$1 and removed_on is null order by reg`, [req.user.company_id])).rows)));
app.get('/api/vehicles/all', auth, admin, wrap(async (req, res) => res.json((await q(`${VSEL} where company_id=$1 order by reg`, [req.user.company_id])).rows)));
async function ownTemplate(cid, id) { if (!id) return null; if (!UUID.test(id) || !(await q('select 1 from templates where id=$1 and company_id=$2', [id, cid])).rowCount) throw bad('Template not found'); return id; }
app.post('/api/vehicles', auth, admin, wrap(async (req, res) => {
  const b = req.body || {}, reg = String(b.reg || '').trim().toUpperCase(); if (!reg) throw bad('Enter a reg');
  if ((await q('select 1 from vehicles where company_id=$1 and reg=$2 and removed_on is null', [req.user.company_id, reg])).rowCount) throw bad(reg + ' is already added');
  const type = String(b.type || 'Truck').slice(0, 30);
  await q('insert into vehicles(company_id,reg,type,template_id,daily_check) values ($1,$2,$3,$4,$5)', [req.user.company_id, reg, type, await ownTemplate(req.user.company_id, b.template_id), typeof b.daily_check === 'boolean' ? b.daily_check : type !== 'Trailer']); res.json({ ok: true });
}));
app.post('/api/vehicles/:id', auth, admin, wrap(async (req, res) => {
  const b = req.body || {}, sets = [], p = [];
  const add = (col, val) => { p.push(val); sets.push(`${col}=$${p.length}`); };
  if ('type' in b) add('type', String(b.type || 'Truck').slice(0, 30));
  if ('template_id' in b) add('template_id', await ownTemplate(req.user.company_id, b.template_id));
  if ('daily_check' in b) add('daily_check', !!b.daily_check);
  for (const k of ['mot_due', 'tax_due', 'service_due', 'pmi_due']) if (k in b) add(k, dateOrNull(b[k]));
  if (!sets.length) return res.json({ ok: true });
  p.push(req.params.id, req.user.company_id);
  const r = await q(`update vehicles set ${sets.join(',')} where id=$${p.length - 1} and company_id=$${p.length}`, p);
  if (!r.rowCount) throw bad('Vehicle not found', 404); res.json({ ok: true });
}));
app.post('/api/vehicles/:id/remove', auth, admin, wrap(async (req, res) => { await q('update vehicles set removed_on=current_date where id=$1 and company_id=$2 and removed_on is null', [req.params.id, req.user.company_id]); res.json({ ok: true }); }));

/* ---------- alerts ---------- */
app.get('/api/alerts', auth, admin, wrap(async (req, res) => res.json((await q('select * from alerts where company_id=$1 order by created_at desc limit 100', [req.user.company_id])).rows)));
app.get('/api/alerts/count', auth, admin, wrap(async (req, res) => res.json({ n: +(await q('select count(*) from alerts where company_id=$1 and not resolved', [req.user.company_id])).rows[0].count })));
app.post('/api/alerts/:id/resolve', auth, admin, wrap(async (req, res) => { await q('update alerts set resolved=true where id=$1 and company_id=$2', [req.params.id, req.user.company_id]); res.json({ ok: true }); }));
const SUBJECT = { defect: 'defect reported', danger: 'DANGEROUS defect, do not drive', verification: 'check not verified', missed: 'vehicles not checked', reminder: 'vehicle dates due' };
async function sendAlerts() {
  if (!mail.enabled) return;
  const { rows } = await q('select a.id, a.message, a.kind, a.created_at, c.name, c.alert_email from alerts a join companies c on c.id=a.company_id where not a.emailed order by a.created_at limit 50');
  for (const a of rows) {
    if (!a.alert_email) { await q('update alerts set emailed=true where id=$1', [a.id]); continue; }
    const ok = await mail.sendMail({ to: a.alert_email, subject: `Kovi: ${SUBJECT[a.kind] || 'alert'}`, text: `${a.message}\n\n${a.name} · ${new Date(a.created_at).toLocaleString('en-GB', { timeZone: 'Europe/London' })}\n${APP_URL ? 'Open Kovi: ' + APP_URL : 'Open Kovi to see more.'}` });
    if (ok) await q('update alerts set emailed=true where id=$1', [a.id]);
  }
}

/* ---------- people + settings ---------- */
app.get('/api/people', auth, admin, wrap(async (req, res) => res.json((await q('select id,email,full_name,role,active,(pin_hmac is not null) as has_pin from users where company_id=$1 order by full_name', [req.user.company_id])).rows)));
// a driver who logs in with the company code and a 6 digit PIN: no email, no password. The PIN is shown once.
app.post('/api/people/driver', auth, admin, wrap(async (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 80); if (!name) throw bad("Enter the driver's name");
  const { pin, h } = await newPin(req.user.company_id);
  const u = (await q("insert into users(company_id, full_name, role, pin_hmac) values ($1,$2,'driver',$3) returning id", [req.user.company_id, name, h])).rows[0];
  res.json({ id: u.id, name, pin });
}));
app.post('/api/people/:id/pin', auth, admin, wrap(async (req, res) => {
  const u = (await q('select id, full_name from users where id=$1 and company_id=$2', [req.params.id, req.user.company_id])).rows[0]; if (!u) throw bad('Person not found', 404);
  const { pin, h } = await newPin(req.user.company_id);
  await q('update users set pin_hmac=$1 where id=$2', [h, u.id]); res.json({ id: u.id, name: u.full_name, pin });
}));
app.post('/api/people/:id', auth, admin, wrap(async (req, res) => {
  if (req.params.id === req.user.id) throw bad("You can't change your own access");
  const { role, active } = req.body || {};
  if (role && !['driver', 'admin'].includes(role)) throw bad('Bad role');
  if (role === 'admin' && (await q('select 1 from users where id=$1 and company_id=$2 and email is null', [req.params.id, req.user.company_id])).rowCount) throw bad('Admins need an email and password. Ask them to sign up with the company code first.');
  await q('update users set role=coalesce($1,role), active=coalesce($2,active) where id=$3 and company_id=$4', [role || null, typeof active === 'boolean' ? active : null, req.params.id, req.user.company_id]); res.json({ ok: true });
}));
app.put('/api/company', auth, admin, wrap(async (req, res) => {
  const b = req.body || {}, cur = await getCompany(req.user.company_id), mailOk = /^\S+@\S+\.\S+$/;
  for (const k of ['alert_email', 'billing_email']) if (b[k] && !mailOk.test(b[k])) throw bad('That email address does not look right');
  let checkBy = cur.check_by ? String(cur.check_by).slice(0, 5) : null;
  if ('check_by' in b) { if (!b.check_by) checkBy = null; else if (/^([01]\d|2[0-3]):[0-5]\d$/.test(b.check_by)) checkBy = b.check_by; else throw bad('Time must look like 09:00'); }
  let days = cur.check_days;
  if ('check_days' in b) { days = [...new Set(String(b.check_days).split('').filter(d => /[1-7]/.test(d)))].sort().join(''); if (!days) throw bad('Pick at least one day'); }
  await q('update companies set alert_email=$1, billing_email=$2, min_total_secs=$3, check_by=$4, check_days=$5, weekly_report=$6, handover_on=$7 where id=$8',
    [b.alert_email ?? cur.alert_email, b.billing_email ?? cur.billing_email, b.min_total_secs != null ? Math.max(0, Math.min(3600, parseInt(b.min_total_secs) || 0)) : cur.min_total_secs,
      checkBy, days, typeof b.weekly_report === 'boolean' ? b.weekly_report : cur.weekly_report, typeof b.handover_on === 'boolean' ? b.handover_on : cur.handover_on, cur.id]);
  res.json({ co: coView(await getCompany(cur.id), true) });
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
  companies: (await q(`select c.id, c.name, c.billing_email, c.weekly_price, c.created_at, c.terms_version, (select count(*) from users u where u.company_id=c.id) people, (select count(*) from vehicles v where v.company_id=c.id and v.removed_on is null) vehicles from companies c order by created_at`)).rows,
  invoices: (await q('select i.*, c.name as company from invoices i join companies c on c.id=i.company_id order by period desc, number desc')).rows })));
app.post('/api/platform/run-billing', auth, platform, wrap(async (req, res) => res.json({ n: (await q('select generate_invoices($1) n', [req.body.month || lastMonth()])).rows[0].n })));
app.post('/api/platform/invoices/:id/paid', auth, platform, wrap(async (req, res) => { await q("update invoices set status='paid', paid_on=current_date where id=$1", [req.params.id]); res.json({ ok: true }); }));
// the platform owner can set what a customer pays per vehicle per week (default 1)
app.post('/api/platform/companies/:id/price', auth, platform, wrap(async (req, res) => {
  const p = +(req.body || {}).weekly_price; if (!(p >= 0 && p <= 100)) throw bad('Enter a price between 0 and 100');
  await q('update companies set weekly_price=$1 where id=$2', [p, req.params.id]); res.json({ ok: true });
}));
// Cloud Scheduler hits this on the 1st of each month
app.post('/api/cron/invoices', wrap(async (req, res) => {
  if (!CRON_SECRET || req.get('x-cron-secret') !== CRON_SECRET) throw bad('No', 403);
  res.json({ n: (await q('select generate_invoices($1) n', [lastMonth()])).rows[0].n });
}));
app.get('/healthz', (req, res) => res.send('ok'));

/* ---------- feature modules ---------- */
const ctx = { app, express, pool, q, wrap, bad, auth, admin, platform, getCompany, savePhoto, readPhoto, mail, sendAlerts, config: { CRON_SECRET, APP_URL, TEST_MODE, TERMS_VERSION } };
require('./templates')(ctx);
require('./checks')(ctx);
require('./defects')(ctx);
require('./handovers')(ctx);
require('./jobs')(ctx);
require('./legal')(ctx);

/* ---------- static app ---------- */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use(express.static(path.join(__dirname, '..', 'web'), { setHeaders: (res, p) => { if (/sw\.js$|index\.html$/.test(p)) res.set('Cache-Control', 'no-cache'); } }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'web', 'index.html')));

(async () => {
  await q(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  await ctx.migrateTemplates();
  app.listen(PORT, () => console.log('Kovi listening on', PORT));
})().catch(e => { console.error('startup failed', e); process.exit(1); });
