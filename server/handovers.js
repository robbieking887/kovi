'use strict';
const UUID = /^[0-9a-f-]{36}$/i, FUEL = ['Empty', '1/4', '1/2', '3/4', 'Full'];
// Hire / handover records: who took the vehicle, when, where, and what it looked like (photos are stored under company/handoverId/).
module.exports = function handovers(ctx) {
  const { app, q, wrap, bad, auth, admin } = ctx;
  const n = x => (Number.isFinite(+x) && x !== null && x !== '' ? +x : null);

  app.post('/api/handovers', auth, wrap(async (req, res) => {
    const b = req.body || {}, u = req.user;
    if (!UUID.test(b.id || '')) throw bad('Bad id');
    if (!['out', 'in'].includes(b.kind)) throw bad('Bad kind');
    const v = (await q('select id from vehicles where id=$1 and company_id=$2', [b.vehicle_id, u.company_id])).rows[0]; if (!v) throw bad('Unknown vehicle');
    const party = String(b.other_party || '').trim().slice(0, 100); if (!party) throw bad('Enter who it was handed ' + (b.kind === 'out' ? 'to' : 'back by'));
    const photos = (Array.isArray(b.photos) ? b.photos : []).slice(0, 20).map(p => ({ name: String((p || {}).name || ''), label: String((p || {}).label || '').slice(0, 40) })).filter(p => /^[\w.-]{1,40}$/.test(p.name));
    if (!photos.length) throw bad('Add the photos');
    const sig = b.signature ? 'signature.jpg' : null;
    const r = await q(`insert into handovers(id,company_id,vehicle_id,user_id,kind,started_at,finished_at,lat,lng,acc,mileage,fuel,other_party,notes,photos,signature)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) on conflict (id) do nothing returning id`,
      [b.id, u.company_id, v.id, u.id, b.kind, b.started_at || new Date(), b.finished_at || new Date(), n(b.lat), n(b.lng), n(b.acc), n(b.mileage), FUEL.includes(b.fuel) ? b.fuel : null, party, String(b.notes || '').slice(0, 2000), JSON.stringify(photos), sig]);
    res.json({ ok: true, created: !!r.rowCount });
  }));

  const SEL = 'select h.*, v.reg, u.full_name from handovers h join vehicles v on v.id=h.vehicle_id join users u on u.id=h.user_id';
  app.get('/api/handovers', auth, admin, wrap(async (req, res) => {
    const p = [req.user.company_id]; let w = 'h.company_id=$1';
    if (UUID.test(req.query.vehicle || '')) { p.push(req.query.vehicle); w += ` and h.vehicle_id=$${p.length}`; }
    res.json((await q(`${SEL} where ${w} order by h.created_at desc limit 100`, p)).rows);
  }));
};
module.exports.FUEL = FUEL;
