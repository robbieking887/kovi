'use strict';
const PDFDocument = require('pdfkit');
const TZ = 'Europe/London', DATE = /^\d{4}-\d{2}-\d{2}$/;
const DOW = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function londonParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, dow: DOW[p.weekday] };
}
const dayNum = s => Math.round(Date.parse(s + 'T00:00:00Z') / 864e5);
const addDays = (s, n) => new Date((dayNum(s) + n) * 864e5).toISOString().slice(0, 10);
const isoDow = s => ((new Date(s + 'T12:00:00Z').getUTCDay() + 6) % 7) + 1;
const fmtDate = s => new Date((s instanceof Date ? londonParts(s).date : String(s).slice(0, 10)) + 'T12:00:00Z').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
const REMINDERS = [['mot_due', 'MOT'], ['tax_due', 'Vehicle tax'], ['service_due', 'Service'], ['pmi_due', 'Safety inspection (PMI)']];
const STAGES = [30, 14, 7, 1, 0];

module.exports = function jobs(ctx) {
  const { app, q, wrap, bad, auth, admin, mail } = ctx;

  /* ---------- "who hasn't checked" ---------- */
  async function missedChecks(now) {
    let n = 0;
    const { rows } = await q('select * from companies where check_by is not null and missed_alerted_on is distinct from $1::date', [now.date]);
    for (const co of rows) {
      if (!co.check_days.includes(String(now.dow)) || now.time < String(co.check_by).slice(0, 5)) continue;
      await q('update companies set missed_alerted_on=$1 where id=$2', [now.date, co.id]);
      const missing = (await q(`select v.reg from vehicles v where v.company_id=$1 and v.removed_on is null and v.daily_check and v.added_on <= $2::date
        and not exists (select 1 from checks c where (c.vehicle_id=v.id or c.trailer_id=v.id) and (c.started_at at time zone '${TZ}')::date = $2::date) order by v.reg`, [co.id, now.date])).rows.map(r => r.reg);
      if (!missing.length) continue;
      await q('insert into alerts(company_id,kind,message) values ($1,$2,$3)', [co.id, 'missed', `${missing.length} vehicle${missing.length > 1 ? 's' : ''} not checked by ${String(co.check_by).slice(0, 5)}: ${missing.join(', ')}`]); n++;
    }
    return n;
  }

  /* ---------- MOT / tax / service / PMI reminders ---------- */
  async function reminders(now) {
    let n = 0;
    const { rows } = await q('select id from companies where reminders_on is distinct from $1::date', [now.date]);
    if (now.time < '07:00') return 0;
    for (const co of rows) {
      await q('update companies set reminders_on=$1 where id=$2', [now.date, co.id]);
      const vs = (await q('select id, reg, mot_due::text, tax_due::text, service_due::text, pmi_due::text from vehicles where company_id=$1 and removed_on is null and (mot_due is not null or tax_due is not null or service_due is not null or pmi_due is not null) order by reg', [co.id])).rows;
      const lines = [];
      for (const v of vs) for (const [col, label] of REMINDERS) {
        if (!v[col]) continue;
        const days = dayNum(v[col]) - dayNum(now.date);
        let stage;
        if (days < 0) stage = -(1 + Math.floor((-days - 1) / 7)); else if (days > 30) continue; else stage = Math.min(...STAGES.filter(s => days <= s));
        const fresh = await q('insert into reminders_sent(vehicle_id,kind,due,stage,sent_on) values ($1,$2,$3,$4,$5) on conflict do nothing', [v.id, col, v[col], stage, now.date]);
        if (!fresh.rowCount) continue;
        lines.push(`${v.reg}: ${label} ${days < 0 ? 'OVERDUE by ' + -days + ' day' + (-days > 1 ? 's' : '') : days === 0 ? 'due TODAY' : 'due in ' + days + ' day' + (days > 1 ? 's' : '')} (${fmtDate(v[col])})`);
      }
      if (lines.length) { await q('insert into alerts(company_id,kind,message) values ($1,$2,$3)', [co.id, 'reminder', lines.join('\n')]); n++; }
    }
    return n;
  }

  /* ---------- weekly PDF report ---------- */
  async function reportData(co, from, to) {
    const vehicles = (await q('select id, reg, type, added_on::text, removed_on::text, daily_check from vehicles where company_id=$1 and added_on <= $3::date and (removed_on is null or removed_on >= $2::date) order by reg', [co.id, from, to])).rows;
    const checks = (await q(`select c.id, c.vehicle_id, c.trailer_id, c.started_at, c.verdict, c.flags, c.defects, u.full_name, (c.started_at at time zone '${TZ}')::date::text as day from checks c join users u on u.id=c.driver_id where c.company_id=$1 and (c.started_at at time zone '${TZ}')::date between $2::date and $3::date order by c.started_at`, [co.id, from, to])).rows;
    const defects = (await q(`select d.*, v.reg from defects d join vehicles v on v.id=d.vehicle_id where d.company_id=$1 and (d.status <> 'fixed' or (d.created_at at time zone '${TZ}')::date between $2::date and $3::date or (d.fixed_at at time zone '${TZ}')::date between $2::date and $3::date) order by array_position(array['danger','major','minor'], d.severity), d.created_at`, [co.id, from, to])).rows;
    const days = []; for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    const rows = vehicles.map(v => {
      const done = new Set(checks.filter(c => c.vehicle_id === v.id || c.trailer_id === v.id).map(c => c.day));
      const expected = v.daily_check ? days.filter(d => co.check_days.includes(String(isoDow(d))) && d >= v.added_on && (!v.removed_on || d <= v.removed_on)) : [];
      return { reg: v.reg, type: v.type, checks: checks.filter(c => c.vehicle_id === v.id || c.trailer_id === v.id).length, expected: expected.length, missed: expected.filter(d => !done.has(d)) };
    });
    return { vehicles, checks, defects, rows };
  }

  function buildReport(co, from, to, data) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Kovi report ${from} to ${to}`, Author: 'Kovi' } });
      const chunks = []; doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
      const L = 40, W = 515, ink = '#101828', mut = '#667085', gold = '#f5b301';
      const room = h => { if (doc.y + h > 780) doc.addPage(); };
      const h2 = t => { room(60); doc.moveDown(0.8).font('Helvetica-Bold').fontSize(13).fillColor(ink).text(t, L); doc.moveTo(L, doc.y + 2).lineTo(L + 60, doc.y + 2).lineWidth(2).strokeColor(gold).stroke(); doc.moveDown(0.6); };
      const table = (cols, rows) => {
        const draw = (cells, bold) => {
          const hs = cells.map((c, i) => doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).heightOfString(String(c), { width: cols[i][1] - 6 }));
          const h = Math.max(...hs) + 6; room(h + 2); const y = doc.y; let x = L;
          cells.forEach((c, i) => { doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(bold ? mut : ink).text(String(c), x + 3, y + 3, { width: cols[i][1] - 6 }); x += cols[i][1]; });
          doc.y = y + h; doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.4).strokeColor('#e4e7ec').stroke();
        };
        draw(cols.map(c => c[0]), true); rows.forEach(r => draw(r, false));
      };
      const { vehicles, checks, defects, rows } = data;
      doc.rect(0, 0, 595, 70).fill('#0f1720'); doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20).text('KOVI', L, 24); doc.font('Helvetica').fontSize(10).fillColor('#cbd5e1').text('Vehicle check report', L + 70, 30);
      doc.y = 90; doc.fillColor(ink).font('Helvetica-Bold').fontSize(16).text(co.name, L); doc.font('Helvetica').fontSize(10).fillColor(mut).text(`${fmtDate(from)} to ${fmtDate(to)}   |   Generated ${fmtDate(londonParts().date)}`, L);
      const expected = rows.reduce((a, r) => a + r.expected, 0), missed = rows.reduce((a, r) => a + r.missed.length, 0);
      const raised = defects.filter(d => d.created_at && londonParts(new Date(d.created_at)).date >= from && londonParts(new Date(d.created_at)).date <= to).length;
      const fixed = defects.filter(d => d.fixed_at && londonParts(new Date(d.fixed_at)).date >= from && londonParts(new Date(d.fixed_at)).date <= to).length, open = defects.filter(d => d.status !== 'fixed').length;
      h2('Summary');
      table([['', 300], ['', 215]], [['Checks completed', checks.length], ['Checks expected (vehicle-days)', expected], ['Completion', expected ? Math.round((expected - missed) / expected * 100) + '%' : 'n/a'], ['Checks flagged (not verified)', checks.filter(c => c.verdict === 'flagged').length],
        ['Defects reported', raised], ['Defects fixed', fixed], ['Defects still open', open]]);
      h2('By vehicle');
      table([['Vehicle', 90], ['Type', 80], ['Checks', 55], ['Expected', 60], ['Missed', 50], ['Days missed', 180]], rows.map(r => [r.reg, r.type, r.checks, r.expected, r.missed.length, r.missed.slice(0, 8).map(d => fmtDate(d).slice(0, 6)).join(', ') + (r.missed.length > 8 ? ' +' + (r.missed.length - 8) + ' more' : '')]));
      h2('Defects');
      if (!defects.length) doc.font('Helvetica').fontSize(9).fillColor(mut).text('No defects reported or open in this period.', L);
      else table([['Reported', 62], ['Vehicle', 66], ['Defect', 150], ['Severity', 50], ['Status', 55], ['Fixed / notes', 132]], defects.map(d => [fmtDate(d.created_at).slice(0, 6), d.reg, `${d.item}${d.note ? ' - ' + d.note : ''}`, d.severity, d.status + (d.assigned_to && d.status === 'assigned' ? ' (' + d.assigned_to + ')' : ''), d.status === 'fixed' ? `${fmtDate(d.fixed_at).slice(0, 6)}${d.fix_note ? ' - ' + d.fix_note : ''}` : (d.seen_count > 1 ? 'reported ' + d.seen_count + ' times' : '')]));
      const flagged = checks.filter(c => c.verdict === 'flagged');
      h2('Checks that could not be verified');
      if (!flagged.length) doc.font('Helvetica').fontSize(9).fillColor(mut).text('None.', L);
      else table([['Date', 62], ['Vehicle', 70], ['Driver', 110], ['Reason', 273]], flagged.map(c => [fmtDate(c.day).slice(0, 6), (vehicles.find(v => v.id === c.vehicle_id) || {}).reg || '', c.full_name, (c.flags || []).map(f => ({ no_gps: 'no GPS fix', far: 'moved away from the vehicle', no_walk: 'no full walk round shown on compass', too_fast: 'finished too quickly', no_plate: 'no plate photo' }[f] || f)).join('; ')]));
      doc.moveDown(1.2); room(40); doc.font('Helvetica').fontSize(7.5).fillColor(mut).text('GPS and compass readings show that a phone moved around a vehicle; they do not prove every item was checked. The operator remains responsible for the roadworthiness of its vehicles and for keeping these records for as long as the law requires.', L, doc.y, { width: W });
      doc.end();
    });
  }

  async function weeklyReports(now) {
    if (now.dow !== 1 || now.time < '07:00' || !mail.enabled) return 0;
    const to = addDays(now.date, -1), from = addDays(now.date, -7); let n = 0;
    for (const co of (await q('select * from companies where weekly_report and alert_email is not null and report_sent_to is distinct from $1::date', [to])).rows) {
      const pdf = await buildReport(co, from, to, await reportData(co, from, to));
      const ok = await mail.sendMail({ to: co.alert_email, subject: `Kovi weekly report: ${co.name}, ${fmtDate(from)} to ${fmtDate(to)}`, text: `Your weekly vehicle check report is attached.\n\n${co.name}\n${fmtDate(from)} to ${fmtDate(to)}\n\nYou can turn this email off in Kovi under Settings.`, attachments: [{ filename: `kovi-report-${from}-to-${to}.pdf`, content: pdf }] });
      if (ok) { await q('update companies set report_sent_to=$1 where id=$2', [to, co.id]); n++; }
    }
    return n;
  }

  ctx.runTick = async (nowDate = new Date()) => {
    const now = londonParts(nowDate), out = { at: now };
    out.missed = await missedChecks(now); out.reminders = await reminders(now); out.reports = await weeklyReports(now);
    if (out.missed || out.reminders) ctx.sendAlerts().catch(e => console.error('email', e.message));
    return out;
  };
  // Cloud Scheduler calls this every 15 minutes
  app.post('/api/cron/tick', wrap(async (req, res) => {
    if (!ctx.config.CRON_SECRET || req.get('x-cron-secret') !== ctx.config.CRON_SECRET) throw bad('No', 403);
    const t = ctx.config.TEST_MODE && req.get('x-test-now') ? new Date(req.get('x-test-now')) : new Date();
    res.json(await ctx.runTick(t));
  }));

  app.get('/api/report.pdf', auth, admin, wrap(async (req, res) => {
    const co = await ctx.getCompany(req.user.company_id), today = londonParts().date;
    const to = DATE.test(req.query.to || '') ? req.query.to : today, from = DATE.test(req.query.from || '') ? req.query.from : addDays(to, -6);
    if (from > to) throw bad('The start date is after the end date');
    if (dayNum(to) - dayNum(from) > 92) throw bad('Pick a period of 3 months or less');
    const pdf = await buildReport(co, from, to, await reportData(co, from, to));
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="kovi-report-${from}-to-${to}.pdf"`, 'Cache-Control': 'private, no-store' }); res.send(pdf);
  }));
};
module.exports.londonParts = londonParts;
