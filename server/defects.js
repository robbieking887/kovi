'use strict';
const UUID = /^[0-9a-f-]{36}$/i;
// defect life cycle: open -> assigned -> fixed (and back, if it was not really fixed)
module.exports = function defects(ctx) {
  const { app, q, wrap, bad, auth, admin } = ctx;
  const SEL = `select d.*, v.reg, v.type as vehicle_type, ru.full_name as reported_by_name, fu.full_name as fixed_by_name from defects d join vehicles v on v.id=d.vehicle_id left join users ru on ru.id=d.reported_by left join users fu on fu.id=d.fixed_by`;
  const check = id => { if (!UUID.test(id)) throw bad('Not found', 404); };

  app.get('/api/defects', auth, admin, wrap(async (req, res) => {
    const p = [req.user.company_id]; let w = 'd.company_id=$1';
    const s = String(req.query.status || 'active');
    if (s === 'active') w += " and d.status <> 'fixed'"; else if (s === 'fixed') w += " and d.status = 'fixed'";
    if (UUID.test(req.query.vehicle || '')) { p.push(req.query.vehicle); w += ` and d.vehicle_id=$${p.length}`; }
    res.json((await q(`${SEL} where ${w} order by (d.status='fixed'), array_position(array['danger','major','minor'], d.severity), d.created_at desc limit 300`, p)).rows);
  }));
  app.get('/api/defects/count', auth, admin, wrap(async (req, res) => res.json({ n: +(await q("select count(*) from defects where company_id=$1 and status <> 'fixed'", [req.user.company_id])).rows[0].count })));

  // what the next driver sees before they start: open defects on this vehicle, and what was fixed this week
  app.get('/api/vehicles/:id/defects', auth, wrap(async (req, res) => {
    check(req.params.id);
    res.json((await q(`select id, section, item, severity, note, status, assigned_to, fixed_at, fix_note, created_at, seen_count from defects where company_id=$1 and vehicle_id=$2 and (status <> 'fixed' or fixed_at > now() - interval '7 days') order by (status='fixed'), array_position(array['danger','major','minor'], severity), created_at desc`, [req.user.company_id, req.params.id])).rows);
  }));

  app.post('/api/defects/:id/assign', auth, admin, wrap(async (req, res) => {
    check(req.params.id); const to = String((req.body || {}).assigned_to || '').trim().slice(0, 80);
    const r = await q(`update defects set assigned_to=$1::text, assigned_at=case when $1::text is null then null else now() end, status=case when $1::text is null then 'open' else 'assigned' end where id=$2 and company_id=$3 and status <> 'fixed' returning id`, [to || null, req.params.id, req.user.company_id]);
    if (!r.rowCount) throw bad('Defect not found, or already fixed', 404); res.json({ ok: true });
  }));
  app.post('/api/defects/:id/fix', auth, admin, wrap(async (req, res) => {
    check(req.params.id); const b = req.body || {};
    const photo = b.photo ? `${req.user.company_id}/${req.params.id}/fix.jpg` : null;
    const r = await q(`update defects set status='fixed', fixed_at=now(), fixed_by=$1, fix_note=$2, fix_photo=coalesce($3, fix_photo) where id=$4 and company_id=$5 and status <> 'fixed' returning check_id`,
      [req.user.id, String(b.note || '').slice(0, 500), photo, req.params.id, req.user.company_id]);
    if (!r.rowCount) throw bad('Defect not found, or already fixed', 404);
    if (r.rows[0].check_id) await q(`update checks c set fixed=true where c.id=$1 and not exists (select 1 from defects d where d.check_id=c.id and d.status <> 'fixed')`, [r.rows[0].check_id]);
    res.json({ ok: true });
  }));
  app.post('/api/defects/:id/reopen', auth, admin, wrap(async (req, res) => {
    check(req.params.id);
    try {
      const r = await q(`update defects set status='open', assigned_to=null, assigned_at=null, fixed_at=null, fixed_by=null where id=$1 and company_id=$2 and status='fixed' returning check_id`, [req.params.id, req.user.company_id]);
      if (!r.rowCount) throw bad('Defect not found', 404);
      if (r.rows[0].check_id) await q('update checks set fixed=false where id=$1', [r.rows[0].check_id]);
    } catch (e) { if (e.code === '23505') throw bad('The same defect has been reported again since. Fix that one instead.', 409); throw e; }
    res.json({ ok: true });
  }));
};
