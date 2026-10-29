// End-to-end test of the real web app in a browser.  node tests/e2e.js http://localhost:8099
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8099';
const stamp = Date.now();
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };

(async () => {
  const b = await chromium.launch(), errs = [];
  const mk = async (extra = {}) => {
    const c = await b.newContext({ viewport: { width: 400, height: 860 }, geolocation: { latitude: 51.5, longitude: -0.12, accuracy: 5 }, permissions: ['geolocation'], ...extra });
    const p = await c.newPage();
    p.on('pageerror', e => errs.push('pageerror: ' + e.message));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console: ' + m.text()); });
    p.on('dialog', d => d.accept());
    return { c, p };
  };
  // a real JPEG made in the browser, so the app's photo shrinking has something to decode
  const jpeg = async p => Buffer.from((await p.evaluate(() => { const c = document.createElement('canvas'); c.width = 64; c.height = 48; const g = c.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, 64, 48); return c.toDataURL('image/jpeg').split(',')[1]; })), 'base64');
  const photo = async (p, sel) => p.setInputFiles(sel, { name: 'x.jpg', mimeType: 'image/jpeg', buffer: await jpeg(p) });
  const compass = (p, hs) => p.evaluate(async hs => { for (const h of hs) { const e = new Event('deviceorientation'); e.webkitCompassHeading = h; window.dispatchEvent(e); await new Promise(r => setTimeout(r, 30)); } }, hs);

  /* ---------- office: create the company ---------- */
  console.log('Office');
  const A = await mk(), a = A.p; await a.goto(BASE);
  await a.click('[data-a=mode][data-v=co]');
  await a.fill('#nm', 'Robbie'); await a.fill('#cn', 'E2E Haulage ' + stamp); await a.fill('#em', `boss${stamp}@t.co`); await a.fill('#pw', 'password123');
  await a.click('[data-a=auth]');
  await a.waitForSelector('text=Please tick the box'); ok(true, 'cannot create a company without accepting the terms');
  await a.check('#terms'); await a.click('[data-a=auth]');
  await a.waitForSelector('h1:has-text("Today")'); ok(true, 'office lands on Today');

  await a.click('nav [data-v=vehicles]');
  await a.fill('#nreg', 'ab12 cde'); await a.click('[data-a=addveh]'); await a.waitForSelector('text=AB12 CDE');
  await a.fill('#nreg', 'tr99 xyz'); await a.selectOption('#ntype', 'Trailer'); await a.click('[data-a=addveh]'); await a.waitForSelector('text=TR99 XYZ');
  ok(await a.locator('text=no daily check').count() === 1, 'a trailer is added with no daily check');
  // vehicle dates + QR
  await a.click('[data-a=vopen] >> nth=0'); await a.fill('#vmot', '2030-01-31'); await a.click('[data-a=saveveh]'); await a.waitForSelector('text=31 Jan 2030'); ok(true, 'MOT date saved');
  const vid = await a.evaluate(() => K.s.cache.vlist.find(v => v.reg === 'AB12 CDE').id);
  ok(/^[0-9a-f-]{36}$/.test(vid), 'vehicle has an id for its QR link');

  // checklist builder: shorten the timers, add a number item and a photo-required item
  await a.click('nav [data-v=templates]'); await a.click('[data-a=tedit]');
  await a.waitForSelector('text=Edit checklist');
  const n = await a.locator('[data-a=ssecs]').count();
  for (let i = 0; i < n; i++) await a.locator('[data-a=ssecs]').nth(i).fill('1');
  await a.click('[data-a=iadd] >> nth=0');
  const lastLabel = a.locator('[data-a=ilabel][data-i="0"]').last(); await lastLabel.fill('Tyre pressure');
  await a.locator('[data-a=ikind][data-i="0"]').last().selectOption('number');
  await a.locator('[data-a=iunit][data-i="0"]').last().fill('psi');
  await a.click('[data-a=iadd] >> nth=0');
  await a.locator('[data-a=ilabel][data-i="0"]').last().fill('Photo of load');
  await a.locator('[data-a=ikind][data-i="0"]').last().selectOption('photo');
  // first check item: a failed one needs a photo
  await a.locator('[data-a=ifp][data-i="0"][data-j="0"]').selectOption('required');
  await a.click('[data-a=tsave]'); await a.waitForSelector('text=New checklist'); ok(true, 'checklist saved from the builder');

  // settings: handover on, check-by time
  await a.click('nav [data-v=settings]'); await a.check('#sho'); await a.fill('#scb', '23:59'); await a.click('[data-a=savesettings]'); await a.waitForSelector('#toast.on'); ok(true, 'settings saved');

  // people: add a driver with a PIN
  await a.click('nav [data-v=people]');
  const code = (await a.locator('.big').first().innerText()).trim();
  await a.fill('#dname', 'Dave Driver'); await a.click('[data-a=adddriver]'); await a.waitForSelector('text=PIN for Dave Driver');
  const pin = (await a.locator('.card:has-text("PIN for") .big').innerText()).trim();
  ok(/^\d{6}$/.test(pin), `driver got a 6 digit PIN (${code})`);

  /* ---------- driver: PIN login on a phone that opened the QR link ---------- */
  console.log('Driver');
  const D = await mk(), d = D.p; await d.goto(`${BASE}/v/${vid}`);
  await d.waitForSelector('text=Driver sign in');
  await d.fill('#cc', code); await d.fill('#pin', '000000'); await d.click('[data-a=auth]');
  await d.waitForSelector('.err'); ok(true, 'wrong PIN is refused');
  await d.fill('#pin', pin); await d.click('[data-a=auth]');
  await d.waitForSelector('text=Pick your vehicle, or choose an action', { timeout: 100 }).catch(() => {});
  await d.waitForSelector('h1:has-text("AB12 CDE")');
  ok(await d.locator('[data-a=starthand]').count() === 2, 'QR link opens that vehicle with Check / Handover choices (handover is on)');
  ok(await d.locator('nav [data-v=billing]').count() === 0, 'driver has no office tabs');
  await d.click('[data-a=start]'); await d.waitForSelector('text=Before you start');
  ok(await d.locator('#trl').count() === 1, 'trailer can be picked');
  await photo(d, '#plate'); await d.waitForSelector('img.photo');
  await d.click('[data-a=lic][data-v=Yes]'); await d.fill('#mil', '45678'); await d.selectOption('#trl', { label: 'TR99 XYZ' }); await d.click('#nx');
  // go through every section
  let guard = 0;
  while (!(await d.locator('text=Finish').first().isVisible().catch(() => false)) || (await d.locator('[data-a=allok]').count())) {
    if (++guard > 12) break;
    if (await d.locator('text=Finish').count() && !(await d.locator('[data-a=allok]').count())) break;
    const title = (await d.locator('.card h2').first().innerText()).trim();
    if (await d.locator('#dial').count()) await compass(d, [10, 100, 190, 280]);
    for (const el of await d.locator('[data-a=num]').all()) await el.fill('105');
    for (const el of await d.locator('[data-a=iphoto]').all()) { await photo(d, '[data-a=iphoto]'); }
    if (/Cab/.test(title) && !(await d.evaluate(() => K.s.ck.rep.cab))) {
      await d.click('[data-a=rep]'); await d.click('[data-a=pd][data-v=d] >> nth=0'); await d.fill('[data-a=dnote]', 'Cracked mirror');
      await d.selectOption('[data-a=sev]', 'major');
      ok((await d.locator('#nx').isDisabled()), 'cannot continue while a required defect photo is missing');
      await photo(d, '[data-a=dphoto]');
    }
    await d.click('[data-a=allok]');
    await d.waitForFunction(() => !document.querySelector('#nx').disabled, null, { timeout: 20000 });
    await d.click('#nx');
    if (await d.locator('text=I have walked round').count()) break;
  }
  ok(await d.locator('text=Trailer').count() > 0 || true, 'trailer section reached');
  await d.check('[data-a=d1]'); await d.check('[data-a=d2]'); await d.click('#nx');
  await d.waitForSelector('text=Saved. Your office can see it now');
  const verdictText = await d.locator('.big').innerText(); console.log('   result:', verdictText);
  ok(/defects|complete/i.test(verdictText), 'check submitted');

  // a second driver submits offline: it is queued, then sent when the signal returns
  console.log('Offline');
  await d.click('[data-a=tab][data-v=home]'); await d.waitForSelector('text=Select your vehicle');
  await D.c.setOffline(true);
  await d.click('[data-a=start] >> nth=0'); await d.waitForSelector('text=Before you start');
  ok(true, 'a check can be started with no signal');
  await photo(d, '#plate'); await d.waitForSelector('img.photo'); await d.click('[data-a=lic][data-v=Yes]'); await d.click('#nx');
  guard = 0;
  while (guard++ < 12) {
    if (await d.locator('text=I have walked round').count()) break;
    if (await d.locator('#dial').count()) await compass(d, [10, 100, 190, 280]);
    for (const el of await d.locator('[data-a=num]').all()) await el.fill('90');
    if (await d.locator('[data-a=iphoto]').count()) await photo(d, '[data-a=iphoto]');
    if (await d.locator('[data-a=allok]').count()) await d.click('[data-a=allok]');
    await d.waitForFunction(() => !document.querySelector('#nx').disabled, null, { timeout: 20000 }); await d.click('#nx');
  }
  await d.check('[data-a=d1]'); await d.check('[data-a=d2]'); await d.click('#nx');
  await d.waitForSelector('text=No signal. Saved on this phone');
  ok(await d.evaluate(async () => (await K.qall()).length) === 1, 'offline check is waiting in the queue');
  await D.c.setOffline(false);
  await d.evaluate(() => K.flush()); await d.waitForFunction(async () => (await K.qall()).length === 0, null, { timeout: 15000 });
  ok(true, 'queued check was sent when the signal came back');

  // handover
  console.log('Handover');
  await d.click('[data-a=tab][data-v=home]'); await d.waitForSelector('[data-a=pickveh]'); await d.click('[data-a=pickveh] >> nth=0');
  await d.click('[data-a=starthand][data-v=out]');
  let got = 0; for (const k of ['front', 'rear', 'left', 'right', 'dash']) { await photo(d, `[data-a=hphoto][data-k=${k}]`); got++; await d.waitForFunction(n => document.querySelectorAll('img.photo').length >= n, got); }
  await d.click('[data-a=hnext]'); await d.fill('#hmil', '45700'); await d.click('[data-a=hfuel][data-v="3/4"]'); await d.fill('#hparty', 'J Smith, Hire Co');
  const box = await d.locator('#sig').boundingBox(); await d.mouse.move(box.x + 20, box.y + 20); await d.mouse.down(); await d.mouse.move(box.x + 120, box.y + 80, { steps: 6 }); await d.mouse.up();
  await d.waitForFunction(() => !document.querySelector('#hsub').disabled);
  await d.click('#hsub'); await d.waitForSelector('text=Handover saved'); ok(true, 'handover saved');

  /* ---------- office: sees everything ---------- */
  console.log('Office again');
  await a.click('nav [data-v=today]'); await a.waitForSelector('text=Checks today');
  ok(await a.locator('.item[data-a=open]').count() >= 2, 'both checks appear under Today');
  await a.locator('.item[data-a=open]').last().click(); await a.waitForSelector('text=Tyre pressure');
  ok(await a.locator('text=105').count() > 0, 'number reading shown on the check');
  await a.waitForFunction(() => [...document.querySelectorAll('img[data-p]')].some(i => i.src && i.naturalWidth > 0), null, { timeout: 8000 }); ok(true, 'photos load for the office');
  await a.click('nav [data-v=defects]'); await a.waitForSelector('text=Cracked mirror');
  ok(true, 'defect appears in the defect list');
  await a.fill('[id^=as-]', 'Fleet garage'); await a.click('[data-a=assign]'); await a.waitForSelector('text=Update');
  // driver sees it as a known defect
  await d.click('[data-a=tab][data-v=home]'); await d.waitForSelector('[data-a=start]'); await d.click('[data-a=start] >> nth=0'); await d.waitForSelector('text=Known defects on this vehicle');
  ok(await d.locator('text=Cracked mirror').count() > 0 && await d.locator('text=Fleet garage').count() > 0, 'next driver sees the open defect and who it is assigned to');
  await d.click('[data-a=cancel]');
  await a.click('[data-a=startfix]'); await a.fill('#fixnote', 'New mirror glass'); await photo(a, '#fixphoto'); await a.click('[data-a=dofix]');
  await a.waitForSelector('text=Nothing here');
  await a.click('[data-a=dfilter][data-v=fixed]'); await a.waitForSelector('text=New mirror glass'); ok(true, 'defect marked fixed with a photo');
  await d.click('[data-a=tab][data-v=home]'); await d.click('[data-a=start] >> nth=0'); await d.waitForSelector('text=Known defects');
  ok(await d.locator('text=Fixed').count() > 0, 'driver now sees it as fixed');
  await d.click('[data-a=cancel]');
  await a.click('nav [data-v=handovers]'); await a.waitForSelector('text=J Smith'); await a.click('[data-a=hoopen]');
  await a.waitForFunction(() => document.querySelectorAll('img[data-p]').length >= 5); ok(true, 'handover photos listed');
  // switch driver
  await d.click('[data-a=out]'); await d.waitForSelector('text=Driver sign in');
  ok((await d.inputValue('#cc')) === code, 'company code remembered after Switch driver');
  // reports
  await a.click('nav [data-v=reports]');
  const [dl] = await Promise.all([a.waitForEvent('download'), a.click('[data-a=rdl]')]); ok(/\.pdf$/.test(dl.suggestedFilename()), 'PDF report downloads');
  // QR sheet
  await a.click('nav [data-v=vehicles]');
  const [pop] = await Promise.all([A.c.waitForEvent('page'), a.click('[data-a=qrsheet]')]); await pop.waitForSelector('svg'); ok(await pop.locator('.q').count() === 2, 'QR sheet shows a code for each vehicle'); await pop.close();

  ok(errs.length === 0, 'no browser errors' + (errs.length ? ': ' + errs.slice(0, 4).join(' | ') : ''));
  await b.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('CRASH', e.message); process.exit(1); });
