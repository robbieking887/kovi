// Launch-readiness tests: security, 30 day trial, locking, card + Stripe (against a fake Stripe), password reset, export, delete.
//   server must run with TEST_MODE=1 STRIPE_SECRET_KEY=sk_test_fake STRIPE_WEBHOOK_SECRET=whsec_test STRIPE_API_BASE=http://localhost:8098
//   node tests/launch.js http://localhost:8099
const http = require('http'), crypto = require('crypto');
const BASE = process.argv[2] || 'http://localhost:8099', stamp = Date.now(); let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ', m); } else { failed++; console.log('  FAIL', m); } };
const sql = q => require('child_process').execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', 'kovi', '-tAc', q]).toString().trim();
async function call(method, url, { token, body, ip, headers, raw } = {}) {
  const r = await fetch(BASE + url, { method, headers: Object.assign({}, token ? { Authorization: 'Bearer ' + token } : {}, ip ? { 'X-Forwarded-For': ip } : {}, body ? { 'Content-Type': 'application/json' } : {}, headers), body: raw || (body ? JSON.stringify(body) : undefined) });
  const ct = r.headers.get('content-type') || ''; const data = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { s: r.status, d: data, h: r.headers };
}
/* ---- fake Stripe ---- */
const fake = { card: false, failPay: false, log: [] };
const stripeSrv = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    fake.log.push(req.method + ' ' + req.url + ' ' + b);
    const send = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const u = req.url;
    if (u === '/v1/customers' && req.method === 'POST') return send({ id: 'cus_' + Math.random().toString(36).slice(2, 8) });
    if (u === '/v1/checkout/sessions') return send({ id: 'cs_1', url: 'http://localhost:8098/pay' });
    if (/payment_methods/.test(u) && req.method === 'GET') return send({ data: fake.card ? [{ id: 'pm_1', card: { brand: 'visa', last4: '4242' } }] : [] });
    if (/\/payment_methods\/.*detach/.test(u)) { fake.card = false; return send({}); }
    if (u === '/v1/invoices') return send({ id: 'in_' + fake.log.length, status: 'draft' });
    if (u === '/v1/invoiceitems') return send({ id: 'ii_1' });
    if (/finalize/.test(u)) return send({ status: 'open' });
    if (/\/pay$/.test(u)) return fake.failPay ? send({ error: { message: 'Your card was declined.' } }, 402) : send({ status: 'paid' });
    send({});
  });
}).listen(8098);
const hook = (obj, type, secret = 'whsec_test', t = Math.floor(Date.now() / 1000)) => { const raw = JSON.stringify({ type, data: { object: obj } }); return { raw, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=` + crypto.createHmac('sha256', secret).update(t + '.' + raw).digest('hex') } }; };
const PW = 'correct-horse-9';

(async () => {
  console.log('browser protections');
  let r = await call('GET', '/'); const csp = r.h.get('content-security-policy') || '';
  ok(/script-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp) && /strict-transport/i.test([...r.h.keys()].join()), 'pages carry a strict CSP and HSTS');
  r = await call('GET', '/api/vehicles'); ok(r.h.get('cache-control') === 'no-store', 'API answers are never cached');
  r = await call('GET', '/.well-known/security.txt'); ok(r.s === 200 && /Contact:/.test(r.d.toString()), 'security.txt is published');

  console.log('sign up + password rules');
  const email = `t${stamp}@t.co`, co = 'Launch Haulage ' + stamp;
  const su = b => call('POST', '/api/signup', { body: Object.assign({ email, name: 'Boss', mode: 'co', company: co, accept_terms: true, password: PW }, b) });
  r = await su({ password: 'password123' }); ok(r.s === 400, 'a common password is refused');
  r = await su({ password: 'short1' }); ok(r.s === 400, 'a short password is refused');
  r = await su({}); ok(r.s === 200, 'strong password signs up'); const A = r.d.token;
  r = await call('GET', '/api/me', { token: A }); ok(r.d.co.access.state === 'trial' && r.d.co.access.days_left === 30, 'new company starts a 30 day trial');
  r = await call('GET', '/api/me?t=' + A); ok(r.s === 401, 'a token in the URL is not accepted');

  console.log('login lockout + reset + sign out everywhere');
  for (let i = 0; i < 8; i++) r = await call('POST', '/api/login', { body: { email, password: 'wrong-wrong-' + i }, ip: '10.1.1.' + i });
  r = await call('POST', '/api/login', { body: { email, password: PW }, ip: '10.1.1.99' }); ok(r.s === 429, '8 wrong passwords lock that email for a while, even from a new address');
  const email2 = `u${stamp}@t.co`; r = await call('POST', '/api/signup', { body: { email: email2, password: PW, name: 'Two', mode: 'co', company: 'Two ' + stamp, accept_terms: true } }); let B = r.d.token;
  r = await call('POST', '/api/auth/forgot', { body: { email: 'nobody@nowhere.co' } }); ok(r.s === 200 && !r.d.dev_token, 'forgot password gives the same answer for unknown emails');
  r = await call('POST', '/api/auth/forgot', { body: { email: email2 } }); const tok = r.d.dev_token; ok(!!tok, 'a reset link is created');
  r = await call('POST', '/api/auth/reset', { body: { token: tok, password: 'weak' } }); ok(r.s === 400, 'reset enforces the password rules');
  r = await call('POST', '/api/auth/reset', { body: { token: tok, password: 'brand-new-pass-7' } }); ok(r.s === 200 && r.d.token, 'reset sets a new password'); const B2 = r.d.token;
  r = await call('GET', '/api/me', { token: B }); ok(r.s === 401, 'the old session is signed out by a reset');
  r = await call('POST', '/api/auth/reset', { body: { token: tok, password: 'another-pass-8' } }); ok(r.s === 400, 'a reset link works once only');
  r = await call('POST', '/api/login', { body: { email: email2, password: 'brand-new-pass-7' } }); ok(r.s === 200, 'new password signs in');
  r = await call('POST', '/api/account/password', { token: B2, body: { current: 'wrong', password: 'next-pass-phrase-1' } }); ok(r.s === 401, 'changing password needs the current one');
  r = await call('POST', '/api/account/password', { token: B2, body: { current: 'brand-new-pass-7', password: 'next-pass-phrase-1' } }); ok(r.s === 200, 'password can be changed'); const B3 = r.d.token;
  r = await call('GET', '/api/me', { token: B2 }); ok(r.s === 401, 'other sessions drop when it changes');
  r = await call('POST', '/api/account/signout-all', { token: B3 }); ok(r.s === 200, 'sign out everywhere works'); r = await call('GET', '/api/me', { token: B3 }); ok(r.s === 401, '... and kills the old token');
  r = await call('POST', '/api/login', { body: { email: email2, password: 'next-pass-phrase-1' } }); const B4 = r.d.token;
  r = await call('GET', '/api/account/security-log', { token: B4 }); ok(r.d.length >= 3 && r.d.some(x => x.action === 'password_reset'), 'the security log records it');

  console.log('trial ends -> grace -> locked -> card');
  const H = { token: A }; r = await call('POST', '/api/vehicles', { ...H, body: { reg: 'AB12 CDE', type: 'Truck' } }); ok(r.s === 200, 'vehicles work during the trial');
  sql(`update companies set trial_ends_at = now() - interval '2 days' where name = '${co}'`);
  r = await call('GET', '/api/me', H); ok(r.d.co.access.state === 'grace', 'two days after the trial: grace period, still working');
  r = await call('POST', '/api/vehicles', { ...H, body: { reg: 'ZZ99 ZZZ' } }); ok(r.s === 200, 'grace still allows work');
  sql(`update companies set trial_ends_at = now() - interval '40 days' where name = '${co}'`);
  r = await call('GET', '/api/vehicles', H); ok(r.s === 402 && r.d.locked, 'after trial + grace, the app is paused (402)');
  r = await call('GET', '/api/me', H); ok(r.s === 200 && r.d.co.access.state === 'locked', 'but sign-in and /me still work');
  r = await call('GET', '/api/billing', H); ok(r.s === 200, 'and Billing is reachable so they can pay');
  r = await call('POST', '/api/billing/card', H); ok(r.s === 200 && /localhost:8098/.test(r.d.url), 'card set-up link comes from Stripe');
  r = await call('POST', '/api/billing/card/sync', H); ok(r.s === 200 && !r.d.card, 'no card yet: still locked');
  fake.card = true;
  const cust = sql(`select stripe_customer_id from companies where name = '${co}'`);
  let w = hook({ mode: 'setup', customer: cust }, 'checkout.session.completed', 'wrong-secret'); r = await call('POST', '/api/stripe/webhook', { raw: w.raw, headers: w.headers }); ok(r.s === 400, 'a webhook with a bad signature is rejected');
  w = hook({ mode: 'setup', customer: cust }, 'checkout.session.completed', 'whsec_test', Math.floor(Date.now() / 1000) - 3600); r = await call('POST', '/api/stripe/webhook', { raw: w.raw, headers: w.headers }); ok(r.s === 400, 'an old (replayed) webhook is rejected');
  w = hook({ mode: 'setup', customer: cust }, 'checkout.session.completed'); r = await call('POST', '/api/stripe/webhook', { raw: w.raw, headers: w.headers }); ok(r.s === 200, 'a signed webhook is accepted');
 
  r = await call('GET', '/api/vehicles', H); ok(r.s === 200, 'the card unlocks the app straight away');
  r = await call('GET', '/api/me', H); ok(r.d.co.access.state === 'active' && r.d.co.access.card_last4 === '4242', 'state is active, card shown as visa 4242');

  console.log('monthly billing charges the card');
  sql(`update vehicles set added_on = date_trunc('month', current_date)::date where company_id = (select id from companies where name='${co}')`);
  const month = new Date().toISOString().slice(0, 8) + '01';
  r = await call('POST', '/api/signup', { body: { email: 'owner@kovi.test', password: PW, name: 'Owner', mode: 'co', company: 'Platform Co', accept_terms: true } }); if (r.s !== 200) r = await call('POST', '/api/login', { body: { email: 'owner@kovi.test', password: PW } }); const P = r.d.token;
  r = await call('POST', '/api/platform/run-billing', { token: P, body: { month } }); ok(r.s === 200 && r.d.n >= 1, 'billing run makes invoices');
  r = await call('GET', '/api/billing', H); const inv = r.d.invoices[0];
  ok(inv && inv.status === 'paid' && !inv.pay_error, 'the invoice was charged to the card and marked paid');
  ok(fake.log.some(l => /invoiceitems/.test(l) && new RegExp('amount=' + Math.round(inv.total * 100)).test(l)), 'Stripe was asked for exactly the invoice total in pence');
  const before = fake.log.length; r = await call('POST', '/api/platform/run-billing', { token: P, body: { month } }); ok(!fake.log.slice(before).some(l => /invoiceitems/.test(l)), 'running again never charges twice');

  console.log('failed payments');
  sql(`insert into invoices(company_id, number, period, lines, weeks, subtotal, vat, total) select id, 'KOVI-TEST-${stamp}', '2026-01-01', '[]', 5, 5, 1, 6 from companies where name='${co}'`);
  fake.failPay = true; r = await call('POST', '/api/platform/run-billing', { token: P, body: { month } });
  r = await call('GET', '/api/billing', H); const f = r.d.invoices.find(i => i.number === 'KOVI-TEST-' + stamp); ok(f && f.status === 'unpaid' && /declined/.test(f.pay_error), 'a declined card leaves the invoice open with the reason');
  fake.failPay = false; r = await call('POST', '/api/billing/card/sync', H); r = await call('GET', '/api/billing', H); ok(r.d.invoices.find(i => i.number === 'KOVI-TEST-' + stamp).status === 'paid', 'adding/re-saving a card retries the failed invoice and it is paid');
  sql(`update invoices set status='unpaid', paid_on=null where number='KOVI-TEST-${stamp}'`); w = hook({ metadata: { kovi_invoice: sql(`select id from invoices where number='KOVI-TEST-${stamp}'`) } }, 'invoice.paid'); r = await call('POST', '/api/stripe/webhook', { raw: w.raw, headers: w.headers });
  r = await call('GET', '/api/billing', H); ok(r.d.invoices.find(i => i.number === 'KOVI-TEST-' + stamp).status === 'paid', 'invoice.paid webhook marks it paid');

  console.log('platform controls');
  const mine = (await call('GET', '/api/platform', { token: P })).d.companies.find(c => c.name === 'Two ' + stamp);
  r = await call('POST', `/api/platform/companies/${mine.id}/trial`, { token: P, body: { days: 14 } }); ok(r.s === 200, 'owner can extend a trial');
  r = await call('POST', `/api/platform/companies/${mine.id}/exempt`, { token: P, body: { exempt: true } }); ok(r.s === 200, 'owner can switch billing off for a company');
  r = await call('POST', `/api/platform/companies/${mine.id}/trial`, { token: B4, body: { days: 14 } }); ok(r.s === 403, 'customers can not');

  console.log('export + delete');
  r = await call('GET', '/api/account/export', H); ok(r.s === 200 && r.d.vehicles.length === 2 && !JSON.stringify(r.d).includes('password_hash'), 'export contains the data and no password hashes');
  r = await call('POST', '/api/account/delete', { ...H, body: { password: 'nope', confirm_name: co } }); ok(r.s === 401, 'delete needs the password');
  r = await call('POST', '/api/account/delete', { ...H, body: { password: PW, confirm_name: 'Wrong Name' } }); ok(r.s === 400, 'delete needs the company name typed');
  r = await call('POST', '/api/account/delete', { ...H, body: { password: PW, confirm_name: co } }); ok(r.s === 200, 'company deleted');
  r = await call('GET', '/api/me', H); ok(r.s === 401, 'its logins stop working');
  ok(sql(`select count(*) from companies where name='${co}'`) === '0' && +sql(`select count(*) from invoice_archive where company_name='${co}'`) >= 2, 'all data gone, invoices kept in the 6 year archive');
  ok(fake.log.some(l => /^DELETE \/v1\/customers/.test(l)), 'the Stripe customer (and card) is deleted too');

  console.log(`\n${pass} passed, ${failed} failed`); stripeSrv.close(); process.exit(failed ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
