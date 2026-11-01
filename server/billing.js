'use strict';
// Free trial + card billing with Stripe. Stripe is only used to hold the card and take the money;
// Kovi still works out the invoice itself (vehicle-weeks x price + VAT) and tells Stripe to charge that total.
const crypto = require('crypto');
const { accessOf, GRACE_DAYS } = require('./access');

module.exports = function billing(ctx) {
  const { app, q, wrap, bad, auth, admin, getCompany, mail, audit, dropAccess } = ctx;
  const KEY = process.env.STRIPE_SECRET_KEY || '', WHSEC = process.env.STRIPE_WEBHOOK_SECRET || '';
  const BASE = (process.env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/$/, '');
  const APP = ctx.config.APP_URL;
  const configured = !!KEY;

  /* ---------- tiny Stripe REST client (form encoded, nested keys like metadata[x]) ---------- */
  const enc = (o, pre = '') => Object.entries(o).flatMap(([k, v]) => v == null ? [] : typeof v === 'object' ? enc(v, pre ? `${pre}[${k}]` : k) : [`${encodeURIComponent(pre ? `${pre}[${k}]` : k)}=${encodeURIComponent(v)}`]);
  async function stripe(method, path, params, idem) {
    if (!KEY) throw bad('Card payments are not switched on yet. Please contact us.', 503);
    const body = params && method !== 'GET' ? enc(params).join('&') : undefined, url = BASE + '/v1' + path + (method === 'GET' && params ? '?' + enc(params).join('&') : '');
    const r = await fetch(url, { method, headers: Object.assign({ Authorization: 'Bearer ' + KEY }, body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}, idem ? { 'Idempotency-Key': idem } : {}), body });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error((j.error && j.error.message) || 'Stripe error ' + r.status); e.stripe = j.error || {}; e.status = 502; throw e; }
    return j;
  }
  const money = n => '£' + (+n).toFixed(2);

  async function ensureCustomer(co, email) {
    if (co.stripe_customer_id) return co.stripe_customer_id;
    const c = await stripe('POST', '/customers', { name: co.name, email: co.billing_email || email, metadata: { kovi_company: co.id } }, 'kovi-cust-' + co.id);
    await q('update companies set stripe_customer_id=$1 where id=$2', [c.id, co.id]); return c.id;
  }
  // read the card Stripe now holds for this customer and remember the bare minimum (brand + last 4)
  async function syncCard(co) {
    if (!co.stripe_customer_id) return null;
    const pms = (await stripe('GET', `/customers/${co.stripe_customer_id}/payment_methods`, { type: 'card', limit: 1 })).data;
    if (!pms.length) return null;
    const pm = pms[0];
    await stripe('POST', `/customers/${co.stripe_customer_id}`, { invoice_settings: { default_payment_method: pm.id } });
    await q('update companies set card_brand=$1, card_last4=$2, card_added_at=now() where id=$3', [pm.card.brand, pm.card.last4, co.id]);
    dropAccess(co.id);
    return { brand: pm.card.brand, last4: pm.card.last4 };
  }

  /* ---------- routes the office uses ---------- */
  app.post('/api/billing/card', auth, admin, wrap(async (req, res) => {
    const co = await getCompany(req.user.company_id), cid = await ensureCustomer(co, req.user.email);
    const s = await stripe('POST', '/checkout/sessions', { mode: 'setup', customer: cid, currency: 'gbp', payment_method_types: { 0: 'card' },
      success_url: APP + '/app?card=ok', cancel_url: APP + '/app?card=cancel', metadata: { kovi_company: co.id } });
    res.json({ url: s.url });
  }));
  app.post('/api/billing/card/sync', auth, admin, wrap(async (req, res) => {
    const co = await getCompany(req.user.company_id), c = await syncCard(co);
    if (c) { audit(req, 'card_added', { brand: c.brand, last4: c.last4 }); await pushInvoices(co.id); }
    res.json({ card: c, access: accessOf(await getCompany(co.id)) });
  }));
  app.post('/api/billing/card/remove', auth, admin, wrap(async (req, res) => {
    const co = await getCompany(req.user.company_id);
    if (co.stripe_customer_id) { const pms = (await stripe('GET', `/customers/${co.stripe_customer_id}/payment_methods`, { type: 'card' })).data; for (const pm of pms) await stripe('POST', `/payment_methods/${pm.id}/detach`, {}); }
    await q('update companies set card_brand=null, card_last4=null, card_added_at=null where id=$1', [co.id]); dropAccess(co.id);
    audit(req, 'card_removed', {}); res.json({ ok: true });
  }));

  /* ---------- Stripe tells us what happened (signature checked, replay window 5 minutes) ---------- */
  function verify(raw, header) {
    if (!WHSEC || !raw || !header) return false;
    const p = Object.fromEntries(String(header).split(',').map(x => x.split('=')));
    if (!p.t || !p.v1 || Math.abs(Date.now() / 1000 - +p.t) > 300) return false;
    const want = crypto.createHmac('sha256', WHSEC).update(p.t + '.').update(raw).digest('hex');
    const a = Buffer.from(want), b = Buffer.from(String(p.v1));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  app.post('/api/stripe/webhook', wrap(async (req, res) => {
    if (!verify(req.rawBody, req.get('stripe-signature'))) throw bad('Bad signature', 400);
    const ev = req.body, obj = (ev.data || {}).object || {};
    if (ev.type === 'checkout.session.completed' && obj.mode === 'setup') {
      const co = (await q('select * from companies where stripe_customer_id=$1', [obj.customer])).rows[0];
      if (co) { const c = await syncCard(co); if (c) { audit(null, 'card_added', { brand: c.brand, last4: c.last4 }, { company_id: co.id }); await pushInvoices(co.id); } }
    } else if (ev.type === 'invoice.paid' || ev.type === 'invoice.payment_failed') {
      const kid = obj.metadata && obj.metadata.kovi_invoice;
      const inv = kid ? (await q('select i.*, c.billing_email, c.name cname from invoices i join companies c on c.id=i.company_id where i.id=$1', [kid])).rows[0] : null;
      if (inv && ev.type === 'invoice.paid' && inv.status !== 'paid') await q("update invoices set status='paid', paid_on=current_date, pay_error=null where id=$1", [inv.id]);
      if (inv && ev.type === 'invoice.payment_failed') { await q('update invoices set pay_error=$1 where id=$2', [String((obj.last_finalization_error || {}).message || 'Card payment failed').slice(0, 200), inv.id]); await failedMail(inv); }
    }
    res.json({ received: true });
  }));

  /* ---------- turning Kovi invoices into card charges ---------- */
  async function failedMail(inv) {
    await mail.sendMail({ to: inv.billing_email, subject: `Kovi: card payment for ${inv.number} failed`, text: `We could not take ${money(inv.total)} for invoice ${inv.number} from the card on file for ${inv.cname}.\n\nPlease open Kovi > Billing and add a new card. We will try again straight away.\n${APP}/app` });
  }
  async function pushOne(inv, co) {
    try {
      if (!co.stripe_customer_id) throw new Error('No customer');
      const pence = Math.round(+inv.total * 100); if (pence <= 0) { await q("update invoices set status='paid', paid_on=current_date where id=$1", [inv.id]); return; }
      const idem = 'kovi-inv-' + inv.id;
      const si = await stripe('POST', '/invoices', { customer: co.stripe_customer_id, collection_method: 'charge_automatically', auto_advance: false, description: `Kovi ${inv.number}`, pending_invoice_items_behavior: 'exclude', metadata: { kovi_invoice: inv.id } }, idem + '-i');
      await stripe('POST', '/invoiceitems', { customer: co.stripe_customer_id, invoice: si.id, amount: pence, currency: 'gbp', description: `Kovi ${inv.number}: ${inv.weeks} vehicle-weeks${+inv.vat ? ' incl. VAT' : ''}` }, idem + '-l');
      await q('update invoices set stripe_invoice_id=$1, stripe_pushed_at=now() where id=$2', [si.id, inv.id]);
      await stripe('POST', `/invoices/${si.id}/finalize`, { auto_advance: false }, idem + '-f');
      const paid = await stripe('POST', `/invoices/${si.id}/pay`, {}, idem + '-p');
      if (paid.status === 'paid') await q("update invoices set status='paid', paid_on=current_date, pay_error=null where id=$1", [inv.id]);
    } catch (e) {
      console.error('stripe push', inv.number, e.message);
      await q('update invoices set pay_error=$1 where id=$2', [String(e.message).slice(0, 200), inv.id]);
      await failedMail({ ...inv, billing_email: co.billing_email, cname: co.name });
    }
  }
  // open invoices that have no Stripe invoice yet: charge the card if there is one, otherwise say an invoice is waiting (once)
  // an invoice that already exists in Stripe but failed to charge: try the card again after a new card is added, or every 3 days
  async function retryFailed(onlyCompany) {
    const { rows } = await q("select * from invoices where status='unpaid' and stripe_invoice_id is not null and pay_error is not null" + (onlyCompany ? ' and company_id=$1' : " and stripe_pushed_at < now() - interval '3 days'") + ' limit 50', onlyCompany ? [onlyCompany] : []);
    for (const inv of rows) {
      const co = await getCompany(inv.company_id); if (!co || !co.card_last4) continue;
      await q('update invoices set stripe_pushed_at=now() where id=$1', [inv.id]);
      try {
        const p = await stripe('POST', `/invoices/${inv.stripe_invoice_id}/pay`, {});
        if (p.status === 'paid') await q("update invoices set status='paid', paid_on=current_date, pay_error=null where id=$1", [inv.id]);
      } catch (e) { await q('update invoices set pay_error=$1 where id=$2', [String(e.message).slice(0, 200), inv.id]); if (!onlyCompany) await failedMail({ ...inv, billing_email: co.billing_email, cname: co.name }); }
    }
  }
  async function pushInvoices(onlyCompany) {
    if (configured) await retryFailed(onlyCompany);
    const { rows } = await q("select i.* from invoices i where i.status='unpaid' and i.stripe_invoice_id is null" + (onlyCompany ? ' and i.company_id=$1' : '') + ' order by i.issued_on limit 50', onlyCompany ? [onlyCompany] : []);
    for (const inv of rows) {
      const co = await getCompany(inv.company_id); if (!co) continue;
      if (configured && co.card_last4) await pushOne(inv, co);
      else if (!inv.pay_error) {
        const sent = await mail.sendMail({ to: co.billing_email, subject: `Kovi invoice ${inv.number}: ${money(inv.total)}`, text: `Your Kovi invoice ${inv.number} for ${co.name} is ready: ${inv.weeks} vehicle-weeks, total ${money(inv.total)}${+inv.vat ? ' including VAT' : ''}.\n\nThe easiest way to pay is to add a card in Kovi > Billing, and we will take it automatically each month.\n${APP}/app` });
        if (sent || !mail.enabled) await q("update invoices set pay_error='Waiting for a card' where id=$1", [inv.id]);
      }
    }
  }

  /* ---------- emails around the trial ---------- */
  async function welcome(user, companyName) {
    await mail.sendMail({ to: user.email, subject: 'Welcome to Kovi: your 30 day free trial has started', text: `Hi ${user.full_name},\n\nYour 30 day free trial for ${companyName} is live. No card needed.\n\nQuick start:\n1. Add your vehicles (Vehicles tab) and print their QR codes.\n2. Add your drivers (People tab). They sign in with a 6 digit PIN.\n3. Stick the QR codes in the cabs. Drivers scan, tick, done.\n\nAfter the trial it is £1 per vehicle per week (plus VAT if applicable). Add a card in Billing any time to carry on without a break.\n\n${APP}/app\n\nAny questions, just reply to this email.\nKovi` });
    if (ctx.config.PLATFORM_EMAIL) await mail.sendMail({ to: ctx.config.PLATFORM_EMAIL, subject: `Kovi: new trial, ${companyName}`, text: `${companyName} just signed up (${user.email}). Trial ends in 30 days.` });
  }
  const TRIAL_MAIL = {
    7: ['Your Kovi free trial ends in 7 days', n => `Your free trial for ${n} ends in 7 days.\n\nTo carry on without a break, add a card in Kovi > Billing. You will only be charged £1 per vehicle per week (plus VAT if applicable), monthly in arrears.`],
    1: ['Your Kovi free trial ends tomorrow', n => `Your free trial for ${n} ends tomorrow.\n\nAdd a card in Kovi > Billing to keep going. If you do nothing you get ${GRACE_DAYS} more days, then Kovi pauses until a card is added. Nothing is deleted.`],
    0: ['Your Kovi free trial has ended', n => `The free trial for ${n} has ended. Kovi keeps working for ${GRACE_DAYS} more days, then pauses.\n\nAdd a card in Kovi > Billing to keep going. Nothing is deleted.`],
    [-1]: ['Kovi is paused: add a card to continue', n => `Kovi is now paused for ${n} because the trial ended and there is no card on file.\n\nSign in and add a card in Billing and everything switches back on straight away. Your data is safe.`] };
  async function trialNotices() {
    const { rows } = await q("select * from companies where trial_ends_at is not null and not billing_exempt and card_last4 is null");
    for (const co of rows) {
      const a = accessOf(co), left = (new Date(co.trial_ends_at) - Date.now()) / 864e5;
      const stage = a.state === 'locked' ? -1 : a.state === 'grace' ? 0 : left <= 1 ? 1 : left <= 7 ? 7 : null;
      if (stage === null) continue;
      const got = await q('insert into trial_notices(company_id, stage) values ($1,$2) on conflict do nothing returning 1', [co.id, stage]);
      if (got.rowCount) { const [subject, body] = TRIAL_MAIL[stage]; await mail.sendMail({ to: co.billing_email || co.alert_email, subject, text: `${body(co.name)}\n\n${APP}/app` }); }
    }
  }
  /* ---------- getting started: the checklist in the app and the follow-up emails ---------- */
  async function progress(cid) {
    const r = (await q(`select (select count(*) from vehicles where company_id=$1 and removed_on is null)::int vehicles,
      (select count(*) from users where company_id=$1 and role='driver' and active)::int drivers,
      (select count(*) from checks where company_id=$1)::int checks,
      (select count(*) from defects where company_id=$1)::int defects`, [cid])).rows[0];
    return r;
  }
  app.get('/api/onboarding', auth, admin, wrap(async (req, res) => {
    const co = await getCompany(req.user.company_id), p = await progress(co.id);
    res.json({ dismissed: co.onboarding_dismissed, ...p, has_card: !!co.card_last4, trial: co.trial_ends_at ? accessOf(co) : null });
  }));
  app.post('/api/onboarding/dismiss', auth, admin, wrap(async (req, res) => { await q('update companies set onboarding_dismissed=true where id=$1', [req.user.company_id]); res.json({ ok: true }); }));
  const NEXT = p => p.vehicles === 0 ? ['Add your first vehicle', 'Open Kovi > Vehicles, type the reg and tap Add. It takes 30 seconds.']
    : p.drivers === 0 ? ['Add your drivers', 'Open Kovi > People > Add driver. Each driver gets a 6 digit PIN, no email or password needed. Print the QR codes from Vehicles and stick them in the cabs.']
    : p.checks === 0 ? ['Do your first check', 'Scan a vehicle QR code (or tap Check in the app) and run through it. Most drivers finish in about a minute.']
    : ['Make it yours', 'Open Kovi > Checklists to customise what drivers tick, and Settings to choose who gets alerts and a "who has not checked" reminder.'];
  async function onboardingMail() {
    const { rows } = await q("select * from companies where trial_ends_at is not null and not billing_exempt and not onboarding_dismissed and created_at > now() - interval '30 days'");
    for (const co of rows) {
      const age = (Date.now() - new Date(co.created_at)) / 864e5, stage = age >= 14 ? 103 : age >= 4 ? 102 : age >= 1 ? 101 : null;
      if (!stage || !(co.billing_email || co.alert_email)) continue;
      const got = await q('insert into trial_notices(company_id, stage) values ($1,$2) on conflict do nothing returning 1', [co.id, stage]); if (!got.rowCount) continue;
      const p = await progress(co.id), [title, how] = NEXT(p); let subject, body;
      if (stage === 101) { subject = p.checks ? 'Kovi: nice start. What next?' : 'Kovi: ' + title; body = `Your trial for ${co.name} is under way.\n\nNext step: ${title}.\n${how}`; }
      else if (stage === 102) { subject = p.checks ? 'Kovi: three things worth switching on' : 'Kovi: need a hand getting started?'; body = p.checks ? `You are up and running. Three things worth switching on:\n- Missed-check alerts (Settings): get an email if a vehicle has not been checked by a time you choose.\n- Dates (Vehicles): add MOT, tax and service dates and Kovi reminds you.\n- Your own checklist (Checklists).` : `You have not run a check yet, and that is the whole point of Kovi, so let us help. Just reply to this email and we will get you set up. Otherwise: ${title}. ${how}`; }
      else { subject = `Kovi: halfway through your trial (${p.checks} checks so far)`; body = `Halfway through the trial for ${co.name}: ${p.vehicles} vehicles, ${p.checks} checks done, ${p.defects} defects logged.\n\n${p.checks ? 'To keep it running after the trial, add a card in Kovi > Billing. It is £1 per vehicle per week, charged monthly.' : title + '. ' + how}`; }
      await mail.sendMail({ to: co.billing_email || co.alert_email, subject, text: `${body}\n\n${APP}/app\n\nAny question, just reply to this email.\nKovi` });
    }
  }
  async function tick() { try { await trialNotices(); await onboardingMail(); await pushInvoices(); } catch (e) { console.error('billing tick', e.message); } }

  async function deleteCustomer(id) { if (!configured || !id) return; try { await stripe('DELETE', '/customers/' + id); } catch (e) { console.error('stripe delete', e.message); } }
  ctx.billing = { configured, progress, deleteCustomer, welcome, tick, pushInvoices, syncCard, verify };
};
