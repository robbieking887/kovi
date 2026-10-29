'use strict';
/* Check templates: sections of items, per company, assignable per vehicle.
   Item kinds:  check  - the driver confirms it (or reports a defect; photo on a defect can be none/optional/required)
                number - the driver types a reading (tyre pressure, hours, fuel level)
                photo  - the driver must take a photo (load, gauge, seal number)
   A section can be for the 'vehicle' or the 'trailer' (trailer sections only appear when a trailer is picked). */

const KINDS = ['check', 'number', 'photo'];
const FAILPHOTO = ['none', 'optional', 'required'];
const bad = (m, status = 400) => Object.assign(new Error(m), { status });

function normItem(i) {
  if (typeof i === 'string') i = { label: i };
  if (!i || typeof i !== 'object') return null;
  const label = String(i.label || '').trim().slice(0, 80); if (!label) return null;
  const kind = KINDS.includes(i.kind) ? i.kind : 'check', o = { label, kind };
  if (kind === 'check') o.failPhoto = FAILPHOTO.includes(i.failPhoto) ? i.failPhoto : 'optional';
  if (kind === 'number') { o.unit = String(i.unit || '').trim().slice(0, 12); o.required = i.required !== false; }
  if (kind === 'photo') o.required = i.required !== false;
  return o;
}
// strict = reject bad input (template editor); loose = clean up whatever a phone sent (check submission)
function normSections(arr, strict = false) {
  if (!Array.isArray(arr)) throw bad('Bad checklist');
  if (arr.length > 15) throw bad('A template can have at most 15 sections');
  const seen = new Set();
  const out = arr.map((s, n) => {
    s = s || {}; let id = String(s.id || '').replace(/[^\w-]/g, '').slice(0, 20) || 's' + n; while (seen.has(id)) id += 'x'; seen.add(id);
    const sec = { id, title: String(s.title || '').trim().slice(0, 60), secs: Math.max(0, Math.min(120, parseInt(s.secs) || 0)), walk: !!s.walk,
      target: s.target === 'trailer' ? 'trailer' : 'vehicle', items: (Array.isArray(s.items) ? s.items : []).map(normItem).filter(Boolean).slice(0, 40) };
    if (strict) { if (!sec.title) throw bad('Every section needs a title'); if (!sec.items.length) throw bad(`Section "${sec.title}" needs at least one item`); }
    return sec;
  });
  if (strict && !out.length) throw bad('Add at least one section');
  return out;
}
const normSettings = s => ({ gps: !(s && s.gps === false) });
const ck = (label, failPhoto = 'optional') => ({ label, kind: 'check', failPhoto });
const sec = (id, title, secs, items, extra = {}) => Object.assign({ id, title, secs, walk: false, target: 'vehicle', items }, extra);

const SAFETY = sec('saf', 'Safety kit', 5, [ck('Fire extinguisher'), ck('First aid kit'), ck('Warning triangle'), ck('Hi-vis and spare bulbs')]);
const PRESETS = {
  hgv: { name: 'HGV tractor and trailer', desc: 'Cab, walk round, trailer and safety kit. The trailer part only appears when the driver picks a trailer.', sections: [
    sec('cab', 'Cab and controls', 6, [ck('Windscreen, wipers and washers'), ck('Mirrors and cameras'), ck('Horn'), ck('Dashboard warning lights'), ck('Seat belt'), ck('Steering'), ck('Brakes and air pressure'), ck('Cab lights and indicators')]),
    sec('out', 'Walk round vehicle', 12, [ck('Tyres and wheel nuts'), ck('Lights, reflectors and number plates'), ck('Body, doors and load security'), ck('Fluid leaks (oil, fuel, coolant)'), ck('Fuel and AdBlue caps'), ck('Mudguards and spray suppression'), ck('Exhaust')], { walk: true }),
    sec('trl', 'Trailer', 8, [ck('Coupling, air lines and electrical connection'), ck('Landing legs'), ck('Trailer tyres and wheel nuts'), ck('Trailer lights and reflectors'), ck('Curtains, doors and tail lift'), ck('Load restraints')], { target: 'trailer' }),
    SAFETY] },
  rigid: { name: 'Rigid lorry', desc: 'HGV without a trailer.', sections: [
    sec('cab', 'Cab and controls', 6, [ck('Windscreen, wipers and washers'), ck('Mirrors and cameras'), ck('Horn'), ck('Dashboard warning lights'), ck('Seat belt'), ck('Steering'), ck('Brakes and air pressure'), ck('Cab lights and indicators')]),
    sec('out', 'Walk round vehicle', 12, [ck('Tyres and wheel nuts'), ck('Lights, reflectors and number plates'), ck('Body, doors and load security'), ck('Tail lift or ramp'), ck('Fluid leaks (oil, fuel, coolant)'), ck('Fuel and AdBlue caps'), ck('Mudguards and spray suppression')], { walk: true }), SAFETY] },
  van: { name: 'Van', desc: 'Light commercial vehicle up to 3.5 tonnes.', sections: [
    sec('cab', 'Cab', 4, [ck('Windscreen, wipers and washers'), ck('Mirrors'), ck('Horn'), ck('Dashboard warning lights'), ck('Seat belt'), ck('Brakes and steering')]),
    sec('out', 'Walk round vehicle', 10, [ck('Tyres and wheel nuts'), ck('Lights and number plates'), ck('Body damage'), ck('Fluid leaks')], { walk: true }),
    sec('load', 'Load area', 4, [ck('Load secure'), ck('Doors and locks'), ck('Tools and equipment secure')]),
    sec('saf', 'Safety kit', 3, [ck('Fire extinguisher'), ck('First aid kit'), ck('Warning triangle')])] },
  car: { name: 'Car or pool vehicle', desc: 'Quick check for company cars and pool vehicles.', sections: [
    sec('inside', 'Inside', 4, [ck('Windscreen and wipers'), ck('Warning lights'), ck('Horn'), ck('Seat belts')]),
    sec('out', 'Walk round vehicle', 8, [ck('Tyres'), ck('Lights and indicators'), ck('Bodywork damage'), ck('Mirrors')], { walk: true })] },
  minibus: { name: 'Minibus', desc: 'Passenger vehicle including exits, belts and lift.', sections: [
    sec('cab', 'Driver area', 5, [ck('Windscreen, wipers and washers'), ck('Mirrors'), ck('Horn'), ck('Warning lights'), ck('Brakes and steering')]),
    sec('out', 'Walk round vehicle', 10, [ck('Tyres and wheel nuts'), ck('Lights and number plates'), ck('Bodywork damage'), ck('Fluid leaks')], { walk: true }),
    sec('pax', 'Passenger area', 6, [ck('Seats and seat belts'), ck('Emergency exits and hammer'), ck('Wheelchair ramp or lift'), ck('Interior lights'), ck('Floor and steps clear')]),
    sec('saf', 'Safety kit', 4, [ck('Fire extinguisher'), ck('First aid kit'), ck('Warning triangle'), ck('Fire blanket / body fluid kit')])] },
  forklift: { name: 'Forklift / plant', desc: 'Counterbalance or telehandler. GPS check is off by default (indoors).', settings: { gps: false }, sections: [
    sec('prep', 'Before you start', 4, [ck('Seat belt or restraint'), ck('Horn, lights and beacon'), ck('Brakes and steering'), ck('Parking brake'), { label: 'Hour meter reading', kind: 'number', unit: 'hrs', required: true }]),
    sec('out', 'Walk round machine', 8, [ck('Forks and carriage'), ck('Mast and chains'), ck('Hydraulic hoses and leaks'), ck('Tyres and wheels'), ck('Guards and load backrest'), ck('Battery or fuel / gas')], { walk: true })] },
  trailer: { name: 'Trailer only', desc: 'For checking a trailer on its own, away from the tractor unit.', sections: [
    sec('trl', 'Trailer', 8, [ck('Coupling, air lines and electrical connection'), ck('Landing legs'), ck('Tyres and wheel nuts'), ck('Lights, reflectors and number plates'), ck('Curtains, doors and tail lift'), ck('Floor and body condition')], { walk: true })] },
  blank: { name: 'Blank', desc: 'Start from nothing and build your own.', sections: [sec('s1', 'Checks', 5, [ck('First item')], { walk: true })] },
};
const presetSections = key => JSON.parse(JSON.stringify((PRESETS[key] || PRESETS.hgv).sections));
const presetSettings = key => normSettings((PRESETS[key] || {}).settings);

module.exports = function templates(ctx) {
  const { app, q, wrap, auth, admin } = ctx;
  const clean = t => ({ ...t, sections: normSections(t.sections), settings: normSettings(t.settings) });

  ctx.tpl = {
    async ensureDefault(companyId, client) {
      const run = (client || { query: q }).query.bind(client || { query: q });
      const have = (await run('select id from templates where company_id=$1 limit 1', [companyId])).rows[0];
      if (have) return have.id;
      return (await run('insert into templates(company_id,name,sections,settings,is_default) values ($1,$2,$3,$4,true) returning id', [companyId, PRESETS.hgv.name, JSON.stringify(presetSections('hgv')), JSON.stringify(presetSettings('hgv'))])).rows[0].id;
    },
    async forVehicle(vehicle) {
      let t = vehicle.template_id && (await q('select * from templates where id=$1 and company_id=$2', [vehicle.template_id, vehicle.company_id])).rows[0];
      if (!t) t = (await q('select * from templates where company_id=$1 order by is_default desc, created_at limit 1', [vehicle.company_id])).rows[0];
      return t ? clean(t) : null;
    },
  };

  // old single-checklist companies become one default template (runs once; safe to repeat)
  ctx.migrateTemplates = async () => {
    const { rows } = await q('select c.id, c.checklist from companies c where not exists (select 1 from templates t where t.company_id=c.id)');
    for (const c of rows) {
      let s = []; try { s = normSections(Array.isArray(c.checklist) ? c.checklist : []).filter(x => x.items.length); } catch (e) {}
      if (!s.length) s = presetSections('hgv');
      await q('insert into templates(company_id,name,sections,is_default) values ($1,$2,$3,true)', [c.id, 'Standard checklist', JSON.stringify(s)]);
    }
  };

  app.get('/api/templates', auth, wrap(async (req, res) => {
    await ctx.tpl.ensureDefault(req.user.company_id);
    res.json((await q('select * from templates where company_id=$1 order by is_default desc, name', [req.user.company_id])).rows.map(clean));
  }));
  app.get('/api/presets', auth, admin, wrap(async (req, res) => res.json(Object.entries(PRESETS).map(([key, p]) => ({ key, name: p.name, desc: p.desc })))));
  app.post('/api/templates', auth, admin, wrap(async (req, res) => {
    const b = req.body || {}, cid = req.user.company_id;
    if ((await q('select count(*) from templates where company_id=$1', [cid])).rows[0].count >= 20) throw bad('You can have up to 20 templates');
    let sections, settings, name = String(b.name || '').trim().slice(0, 60);
    if (b.copy_of) {
      const src = (await q('select * from templates where id=$1 and company_id=$2', [b.copy_of, cid])).rows[0]; if (!src) throw bad('Template not found', 404);
      sections = src.sections; settings = src.settings; name = name || src.name + ' (copy)';
    } else { const k = PRESETS[b.preset] ? b.preset : 'blank'; sections = presetSections(k); settings = presetSettings(k); name = name || PRESETS[k].name; }
    const t = (await q('insert into templates(company_id,name,sections,settings) values ($1,$2,$3,$4) returning *', [cid, name, JSON.stringify(sections), JSON.stringify(settings)])).rows[0];
    res.json(clean(t));
  }));
  app.put('/api/templates/:id', auth, admin, wrap(async (req, res) => {
    const b = req.body || {}, name = String(b.name || '').trim().slice(0, 60); if (!name) throw bad('Give the template a name');
    const sections = normSections(b.sections, true);
    const r = await q('update templates set name=$1, sections=$2, settings=$3, updated_at=now() where id=$4 and company_id=$5 returning *', [name, JSON.stringify(sections), JSON.stringify(normSettings(b.settings)), req.params.id, req.user.company_id]);
    if (!r.rows[0]) throw bad('Template not found', 404);
    res.json(clean(r.rows[0]));
  }));
  app.post('/api/templates/:id/default', auth, admin, wrap(async (req, res) => {
    const c = await ctx.pool.connect();
    try {
      await c.query('begin');
      if (!(await c.query('select 1 from templates where id=$1 and company_id=$2', [req.params.id, req.user.company_id])).rowCount) throw bad('Template not found', 404);
      await c.query('update templates set is_default=false where company_id=$1', [req.user.company_id]);
      await c.query('update templates set is_default=true where id=$1', [req.params.id]);
      await c.query('commit'); res.json({ ok: true });
    } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
  }));
  app.delete('/api/templates/:id', auth, admin, wrap(async (req, res) => {
    const t = (await q('select is_default from templates where id=$1 and company_id=$2', [req.params.id, req.user.company_id])).rows[0];
    if (!t) throw bad('Template not found', 404); if (t.is_default) throw bad('Make another template the default first');
    await q('delete from templates where id=$1', [req.params.id]); res.json({ ok: true });
  }));
};
module.exports.normSections = normSections;
module.exports.presetSections = presetSections;
module.exports.presetSettings = presetSettings;
module.exports.PRESETS = PRESETS;
