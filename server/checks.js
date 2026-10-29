'use strict';
const { normSections } = require('./templates');
const UUID = /^[0-9a-f-]{36}$/i, SEV = ['minor', 'major', 'danger'];
const FLAG_TEXT = { no_gps: 'no GPS fix, could not confirm location', far: 'moved more than 50 m from the vehicle during the check', no_walk: 'compass shows they did not walk all the way round', too_fast: 'check finished faster than the minimum time', no_plate: 'no reg plate photo' };
// everything except the (large) checklist snapshot, which is only sent when one check is opened
const COLS = 'c.id,c.company_id,c.vehicle_id,c.trailer_id,c.driver_id,c.started_at,c.finished_at,c.start_lat,c.start_lng,c.start_acc,c.end_lat,c.end_lng,c.distance_m,c.heading_coverage,c.duration_secs,c.plate_photo,c.licence,c.mileage,c.results,c.defects,c.notes,c.flags,c.verdict,c.fixed,c.template_id';
const JOIN = 'from checks c join vehicles v on v.id=c.vehicle_id left join vehicles t on t.id=c.trailer_id join users u on u.id=c.driver_id';
const SEL = `select ${COLS}, v.reg, t.reg as trailer_reg, u.full_name ${JOIN}`;

module.exports = function checks(ctx) {
  const { app, express, q, wrap, bad, auth, admin, getCompany, savePhoto, readPhoto } = ctx;

  app.post('/api/photos/:id/:name', auth, express.raw({ type: '*/*', limit: '6mb' }), wrap(async (req, res) => {
    if (!UUID.test(req.params.id) || !/^[\w.-]{1,40}$/.test(req.params.name)) throw bad('Bad photo path');
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad('Empty photo');
    await savePhoto(`${req.user.company_id}/${req.params.id}/${req.params.name}`, req.body); res.json({ ok: true });
  }));
  app.get('/api/photo', auth, admin, wrap(async (req, res) => {
    const p = String(req.query.p || ''); if (!p.startsWith(req.user.company_id + '/') || p.includes('..')) throw bad('Not allowed', 403);
    res.set('Content-Type', 'image/jpeg'); res.set('Cache-Control', 'private, max-age=3600'); readPhoto(p, res);
  }));

  app.post('/api/checks', auth, wrap(async (req, res) => {
    const b = req.body || {}, u = req.user, co = await getCompany(u.company_id);
    if (!co) throw bad('No company');
    if (!UUID.test(b.id || '')) throw bad('Bad check id');
    const v = (await q('select id, reg, company_id, template_id from vehicles where id=$1 and company_id=$2', [b.vehicle_id, u.company_id])).rows[0]; if (!v) throw bad('Unknown vehicle');
    let trailer = null;
    if (b.trailer_id) { trailer = (await q('select id, reg from vehicles where id=$1 and company_id=$2 and id<>$3', [b.trailer_id, u.company_id, v.id])).rows[0]; if (!trailer) throw bad('Unknown trailer'); }
    let sections;
    if (Array.isArray(b.checklist)) sections = normSections(b.checklist); else { const t = await ctx.tpl.forVehicle(v); sections = t ? t.sections : []; }
    if (!trailer) sections = sections.filter(s => s.target !== 'trailer');

    const flags = [...new Set((Array.isArray(b.flags) ? b.flags : []).filter(f => FLAG_TEXT[f]))];
    const minTotal = Math.max(co.min_total_secs || 0, sections.reduce((a, s) => a + (s.secs || 0), 0));
    const dur = Math.max(0, Math.min(86400, parseInt(b.duration_secs) || 0));
    if (dur < minTotal && !flags.includes('too_fast')) flags.push('too_fast');
    const defects = (Array.isArray(b.defects) ? b.defects : []).slice(0, 100).map(d => ({
      section: String(d.section || '').slice(0, 60), item: String(d.item || '').slice(0, 80), severity: SEV.includes(d.severity) ? d.severity : 'minor',
      note: String(d.note || '').slice(0, 500), target: d.target === 'trailer' ? 'trailer' : 'vehicle',
      photo: typeof d.photo === 'string' && d.photo.startsWith(`${u.company_id}/${b.id}/`) && !d.photo.includes('..') ? d.photo : null })).filter(d => d.item);
    const verdict = flags.length ? 'flagged' : defects.length ? 'defect' : 'pass';
    const n = x => (Number.isFinite(+x) && x !== null && x !== '' ? +x : null);
    const ins = await q(`insert into checks(id,company_id,vehicle_id,trailer_id,driver_id,started_at,finished_at,start_lat,start_lng,start_acc,end_lat,end_lng,distance_m,heading_coverage,duration_secs,plate_photo,licence,mileage,results,defects,notes,flags,verdict,template_id,checklist)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) on conflict (id) do nothing returning id`,
      [b.id, u.company_id, v.id, trailer && trailer.id, u.id, b.started_at || new Date(), b.finished_at || new Date(), n(b.start_lat), n(b.start_lng), n(b.start_acc), n(b.end_lat), n(b.end_lng), n(b.distance_m), n(b.heading_coverage), dur,
        `${u.company_id}/${b.id}/plate.jpg`, String(b.licence || '').slice(0, 5), n(b.mileage), JSON.stringify(b.results || {}), JSON.stringify(defects), String(b.notes || '').slice(0, 2000), flags, verdict,
        UUID.test(b.template_id || '') ? b.template_id : null, JSON.stringify(sections)]);
    if (ins.rowCount) {
      const alerts = flags.map(f => ['verification', `${u.full_name} on ${v.reg}: ${FLAG_TEXT[f]}`]);
      let fresh = 0;
      for (const d of defects) {
        const target = d.target === 'trailer' && trailer ? trailer : v;
        const r = await q(`insert into defects(company_id,vehicle_id,check_id,section,item,severity,note,photo,reported_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          on conflict (vehicle_id, section, item) where status <> 'fixed' do update set seen_count = defects.seen_count + 1, last_seen_at = now(),
            severity = case when array_position(array['minor','major','danger'], excluded.severity) > array_position(array['minor','major','danger'], defects.severity) then excluded.severity else defects.severity end,
            note = coalesce(nullif(excluded.note, ''), defects.note)
          returning (xmax = 0) as inserted`, [u.company_id, target.id, b.id, d.section, d.item, d.severity, d.note, d.photo, u.id]);
        if (r.rows[0].inserted) { fresh++; if (d.severity === 'danger') alerts.push(['danger', `DANGEROUS DEFECT on ${target.reg}, do not drive: ${d.item}${d.note ? ' - ' + d.note : ''} (reported by ${u.full_name})`]); }
      }
      const nonDanger = defects.filter(d => d.severity !== 'danger').length;
      if (fresh && nonDanger) alerts.push(['defect', `${u.full_name} reported ${fresh} new defect(s) on ${v.reg}${trailer ? ' / ' + trailer.reg : ''}`]);
      for (const [kind, message] of alerts) await q('insert into alerts(company_id,check_id,kind,message) values ($1,$2,$3,$4)', [u.company_id, b.id, kind, message]);
      if (alerts.length) ctx.sendAlerts().catch(e => console.error('email', e.message));
    }
    res.json({ ok: true, verdict });
  }));

  // drivers only ever see their own last 7 days; admins see all time
  app.get('/api/checks/mine', auth, wrap(async (req, res) => res.json((await q(`${SEL} where c.driver_id=$1 and c.started_at > now() - interval '7 days' order by c.started_at desc limit 100`, [req.user.id])).rows)));
  app.get('/api/checks/today', auth, admin, wrap(async (req, res) => {
    const day = String(req.query.since || '').slice(0, 30);
    res.json((await q(`${SEL} where c.company_id=$1 and c.started_at >= $2 order by c.started_at desc`, [req.user.company_id, day || new Date(Date.now() - 864e5)])).rows);
  }));
  app.get('/api/checks', auth, admin, wrap(async (req, res) => {
    const { from, to, vehicle, driver, verdict } = req.query, p = [req.user.company_id]; let w = 'c.company_id=$1';
    if (from) { p.push(from); w += ` and c.started_at >= $${p.length}`; } if (to) { p.push(to + 'T23:59:59'); w += ` and c.started_at <= $${p.length}`; }
    if (vehicle) { p.push(vehicle); w += ` and (c.vehicle_id = $${p.length} or c.trailer_id = $${p.length})`; } if (driver) { p.push(driver); w += ` and c.driver_id = $${p.length}`; }
    if (verdict) { p.push(verdict); w += ` and c.verdict = $${p.length}`; }
    res.json((await q(`${SEL} where ${w} order by c.started_at desc limit 300`, p)).rows);
  }));
  app.get('/api/checks/:id', auth, admin, wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) throw bad('Not found', 404);
    const c = (await q(`select c.checklist, ${COLS}, v.reg, t.reg as trailer_reg, u.full_name ${JOIN} where c.id=$1 and c.company_id=$2`, [req.params.id, req.user.company_id])).rows[0];
    if (!c) throw bad('Not found', 404); res.json(c);
  }));
  // for flagged (unverified) checks: the office marks them as reviewed. Defects have their own life cycle (see defects.js).
  app.post('/api/checks/:id/fix', auth, admin, wrap(async (req, res) => { await q('update checks set fixed=true where id=$1 and company_id=$2', [req.params.id, req.user.company_id]); res.json({ ok: true }); }));
};
module.exports.FLAG_TEXT = FLAG_TEXT;
