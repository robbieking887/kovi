'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// Everything about keeping a login safe, plus a company's right to take its data or leave.
module.exports = function account(ctx) {
  const { app, q, wrap, bad, auth, admin, pool, mail, audit, sign, throttle, tooManyFails, noteFail, sec } = ctx;
  const APP = ctx.config.APP_URL;

  /* ---------- confirm email (single use link, 3 days, only the hash is stored) ---------- */
  async function sendVerify(u) {
    if (!u.email || u.email_verified_at) return;
    const token = crypto.randomBytes(32).toString('hex');
    await q("update users set verify_hash=$1, verify_expires=now() + interval '3 days' where id=$2", [sec.sha256(token), u.id]);
    await mail.sendMail({ to: u.email, subject: 'Confirm your email for Kovi', text: `Hi ${u.full_name || ''},\n\nPlease confirm your email address so we know it is really you:\n${APP}/app#verify=${token}\n\nThe link works for 3 days. If you did not sign up to Kovi you can ignore this email.\nKovi` });
  }
  ctx.sendVerify = sendVerify;
  app.post('/api/auth/verify', wrap(async (req, res) => {
    throttle('v' + req.ip, ctx.config.TEST_MODE ? 500 : 30);
    const t = String((req.body || {}).token || ''); if (!/^[0-9a-f]{64}$/.test(t)) throw bad('This confirmation link is not valid.', 400);
    const u = (await q('update users set email_verified_at=now(), verify_hash=null, verify_expires=null where verify_hash=$1 and verify_expires > now() returning id, company_id', [sec.sha256(t)])).rows[0];
    if (!u) throw bad('This confirmation link has expired or was already used. Sign in and ask for a new one.', 400);
    audit(req, 'email_verified', {}, u); res.json({ ok: true });
  }));
  app.post('/api/auth/verify/resend', auth, wrap(async (req, res) => {
    throttle('vr' + req.user.id, ctx.config.TEST_MODE ? 500 : 5);
    await sendVerify(req.user); res.json({ ok: true });
  }));

  /* ---------- forgot / reset password (single use, 1 hour, only the hash is stored) ---------- */
  app.post('/api/auth/forgot', wrap(async (req, res) => {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    throttle('f' + req.ip, 10); if (email) throttle('fe' + email, 3);
    const u = email ? (await q('select * from users where lower(email)=$1', [email])).rows[0] : null;
    if (u && u.active && u.password_hash) {
      const token = crypto.randomBytes(32).toString('hex');
      await q("insert into password_resets(token_hash, user_id, expires_at) values ($1,$2, now() + interval '1 hour')", [sec.sha256(token), u.id]);
      await mail.sendMail({ to: u.email, subject: 'Reset your Kovi password', text: `Hi ${u.full_name || ''},\n\nUse this link within 1 hour to choose a new password:\n${APP}/app#reset=${token}\n\nIf you did not ask for this you can ignore this email. Your password has not changed.\nKovi` });
      audit(req, 'reset_requested', {}, u);
      if (ctx.config.TEST_MODE) return res.json({ ok: true, dev_token: token });   // tests only: there is no inbox to read
    }
    res.json({ ok: true });      // same answer whether or not the email exists
  }));
  app.post('/api/auth/reset', wrap(async (req, res) => {
    const { token, password } = req.body || {};
    if (tooManyFails('r' + req.ip, 10)) throw bad('Too many attempts. Try again later.', 429);
    const r = (await q('select * from password_resets where token_hash=$1 and used_at is null and expires_at > now()', [sec.sha256(String(token || ''))])).rows[0];
    if (!r) { noteFail('r' + req.ip); throw bad('This reset link has expired or was already used. Ask for a new one.', 400); }
    const u = (await q('select * from users where id=$1', [r.user_id])).rows[0];
    const pb = sec.passwordProblem(password, u.email); if (pb) throw bad(pb);
    await q('update users set password_hash=$1, token_version=token_version+1 where id=$2', [await bcrypt.hash(password, 12), u.id]);
    await q('update password_resets set used_at=now() where user_id=$1 and used_at is null', [u.id]);
    audit(req, 'password_reset', {}, u);
    const fresh = (await q('select * from users where id=$1', [u.id])).rows[0];
    res.json({ token: sign(fresh) });
  }));

  /* ---------- while signed in ---------- */
  app.post('/api/account/password', auth, wrap(async (req, res) => {
    const { current, password } = req.body || {};
    if (!req.user.password_hash) throw bad('This login uses a PIN, so there is no password to change');
    if (tooManyFails('cp' + req.user.id, 5)) throw bad('Too many wrong tries. Try again in 15 minutes.', 429);
    if (!(await bcrypt.compare(String(current || ''), req.user.password_hash))) { noteFail('cp' + req.user.id); throw bad('Your current password is wrong', 401); }
    const pb = sec.passwordProblem(password, req.user.email); if (pb) throw bad(pb);
    const u = (await q('update users set password_hash=$1, token_version=token_version+1 where id=$2 returning *', [await bcrypt.hash(password, 12), req.user.id])).rows[0];
    audit(req, 'password_changed', {}); res.json({ token: sign(u) });
  }));
  app.post('/api/account/signout-all', auth, wrap(async (req, res) => {
    const u = (await q('update users set token_version=token_version+1 where id=$1 returning *', [req.user.id])).rows[0];
    audit(req, 'signed_out_everywhere', {}); res.json({ token: sign(u) });
  }));
  app.get('/api/account/security-log', auth, admin, wrap(async (req, res) => res.json((await q(
    `select a.at, a.action, a.detail, a.ip, coalesce(u.full_name, u.email) as who from audit_log a left join users u on u.id=a.user_id where a.company_id=$1 order by a.at desc limit 60`, [req.user.company_id])).rows)));

  /* ---------- take your data / delete everything ---------- */
  app.get('/api/account/export', auth, admin, wrap(async (req, res) => {
    const cid = req.user.company_id, one = async (sql) => (await q(sql, [cid])).rows;
    const out = { exported_at: new Date().toISOString(), note: 'Photos are not included in this file. Ask us if you need them.',
      company: (await q('select id, name, alert_email, billing_email, weekly_price, vat_on, vat_rate, created_at, trial_ends_at from companies where id=$1', [cid])).rows[0],
      people: await one('select id, email, full_name, role, active from users where company_id=$1'),
      vehicles: await one('select * from vehicles where company_id=$1'), checks: await one('select * from checks where company_id=$1 order by 1'),
      defects: await one('select * from defects where company_id=$1'), handovers: await one('select * from handovers where company_id=$1'),
      alerts: await one('select * from alerts where company_id=$1'), templates: await one('select * from templates where company_id=$1'),
      invoices: await one('select * from invoices where company_id=$1') };
    audit(req, 'data_exported', {});
    res.set({ 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="kovi-export.json"' }); res.send(JSON.stringify(out, null, 1));
  }));
  app.post('/api/account/delete', auth, admin, wrap(async (req, res) => {
    const { password, confirm_name } = req.body || {};
    if (tooManyFails('del' + req.user.id, 5)) throw bad('Too many wrong tries. Try again in 15 minutes.', 429);
    const co = await ctx.getCompany(req.user.company_id);
    if (!req.user.password_hash || !(await bcrypt.compare(String(password || ''), req.user.password_hash))) { noteFail('del' + req.user.id); throw bad('Your password is wrong', 401); }
    if (String(confirm_name || '').trim().toLowerCase() !== co.name.trim().toLowerCase()) throw bad('Type the company name exactly to confirm');
    const client = await pool.connect();
    try {
      await client.query('begin');
      // tax rules mean we keep invoices for 6 years; everything else goes
      const cols = (await client.query("select column_name from information_schema.columns where table_name='invoices' order by ordinal_position")).rows.map(r => '"' + r.column_name + '"');
      await client.query(`insert into invoice_archive(${cols.join(',')}, company_name) select ${cols.map(c => 'i.' + c).join(',')}, $2 from invoices i where i.company_id=$1`, [co.id, co.name]);
      await client.query('delete from audit_log where company_id=$1', [co.id]);
      await client.query('delete from companies where id=$1', [co.id]);
      await client.query('commit');
    } catch (e) { await client.query('rollback').catch(() => {}); throw e; } finally { client.release(); }
    ctx.dropAccess(co.id);
    await ctx.deletePhotos(co.id).catch(e => console.error('photo delete', e.message));
    if (ctx.billing) await ctx.billing.deleteCustomer(co.stripe_customer_id);
    await mail.sendMail({ to: req.user.email, subject: 'Your Kovi account has been deleted', text: `The Kovi account for ${co.name} and all its vehicles, checks, photos and people have been deleted. We keep only invoices, for 6 years, as tax law requires.\n\nThank you for trying Kovi.` });
    res.json({ ok: true });
  }));
};
