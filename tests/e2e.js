// End-to-end test against a running server: node tests/e2e.js http://localhost:8099
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8099';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const stamp = Date.now();
(async () => {
  const b = await chromium.launch(); const errs = [];
  const mk = async () => { const c = await b.newContext({ viewport: { width: 400, height: 860 }, geolocation: { latitude: 51.5, longitude: -0.12, accuracy: 5 }, permissions: ['geolocation'], serviceWorkers: 'block' }); const p = await c.newPage(); p.on('pageerror', e => errs.push(e.message)); return p; };
  const admin = await mk(); await admin.goto(BASE);
  await admin.click('[data-a=mode][data-v=co]'); await admin.fill('#nm', 'Robbie'); await admin.fill('#cn', 'E2E Haulage ' + stamp); await admin.fill('#em', `boss${stamp}@t.co`); await admin.fill('#pw', 'password123'); await admin.click('[data-a=auth]');
  await admin.waitForSelector('text=Select your vehicle');
  await admin.click('nav [data-v=vehicles]'); await admin.fill('#reg', 'ab12 cde'); await admin.click('[data-a=addveh]'); await admin.waitForSelector('text=1 active');
  await admin.click('nav [data-v=people]'); const code = (await admin.locator('.big').first().innerText()).trim(); console.log('driver code', code);
  // driver on own login
  const drv = await mk(); await drv.goto(BASE);
  await drv.click('[data-a=mode][data-v=dr]'); await drv.fill('#nm', 'Dave'); await drv.fill('#cc', code); await drv.fill('#em', `dave${stamp}@t.co`); await drv.fill('#pw', 'password123'); await drv.click('[data-a=auth]');
  await drv.waitForSelector('text=AB12 CDE');
  console.log('driver sees admin tabs?', await drv.locator('nav [data-v=billing]').count());
  await drv.click('[data-a=start]'); await drv.waitForSelector('text=Before you start');
  await drv.setInputFiles('#plate', { name: 'p.png', mimeType: 'image/png', buffer: png }); await drv.waitForSelector('img.photo');
  await drv.click('[data-a=lic][data-v=Yes]'); await drv.fill('#mil', '1234'); await drv.click('#nx');
  const sections = await drv.evaluate(() => 0);
  for (let i = 0; i < 4; i++) {
    if (i === 1) for (const h of [10, 100, 190, 280]) { await drv.evaluate(h => { const e = new Event('deviceorientation'); e.webkitCompassHeading = h; window.dispatchEvent(e); }, h); await drv.waitForTimeout(60); }
    if (i === 2) { await drv.click('[data-a=rep]'); await drv.click('[data-a=pd][data-v=d]'); await drv.fill('[data-a=dnote]', 'Cracked mirror'); }
    await drv.click('[data-a=allok]'); await drv.waitForFunction(() => !document.querySelector('#nx').disabled, null, { timeout: 30000 }); await drv.click('#nx');
  }
  await drv.check('[data-a=d1]'); await drv.check('[data-a=d2]'); await drv.click('#nx'); await drv.waitForSelector('text=Your office can see it now');
  console.log('driver result:', (await drv.locator('.big').innerText()), '|', await drv.locator('.warn').innerText().catch(() => 'no flags'));
  // admin sees it
  await admin.click('nav [data-v=today]'); await admin.waitForSelector('text=Dave'); console.log('admin today shows Dave:', true);
  await admin.click('nav [data-v=alerts]'); await admin.waitForSelector('text=Dave on AB12 CDE'); console.log('alerts:', (await admin.locator('.item .t').allInnerTexts()).map(x => x.split('\n')[0]));
  await admin.click('nav [data-v=all]'); await admin.waitForSelector('text=1 check(s)');
  await admin.click('nav [data-v=today]'); await admin.click('[data-a=open]'); await admin.waitForSelector('text=Reg photo');
  const photo = await admin.evaluate(async () => { const t = localStorage.getItem('kovi_t'); const m = document.querySelector('[data-a=photo]').dataset.p; const r = await fetch('/api/photo?p=' + encodeURIComponent(m), { headers: { Authorization: 'Bearer ' + t } }); return [r.status, (await r.blob()).size]; });
  console.log('admin can fetch plate photo [status,bytes]:', photo);
  const dphoto = await drv.evaluate(async () => { const t = localStorage.getItem('kovi_t'); const r = await fetch('/api/photo?p=x', { headers: { Authorization: 'Bearer ' + t } }); return r.status; });
  console.log('driver blocked from photos:', dphoto);
  await drv.click('nav [data-v=hist]'); await drv.waitForSelector('text=last 7 days'); console.log('driver history rows:', await drv.locator('.item').count());
  await admin.click('nav [data-v=billing]'); await admin.waitForSelector('text=This month so far'); console.log('billing:', (await admin.locator('.tbl').innerText()).replace(/\s+/g, ' ').slice(0, 160));
  console.log('ERRORS:', errs.length ? errs : 'none'); await b.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
