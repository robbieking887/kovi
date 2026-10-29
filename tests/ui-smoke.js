const { chromium } = require('playwright');
const path = '/home/claude/kovi/web';
const fake = `
window.__ins=[];window.__up=[];
const CL=[{id:'cab',title:'Cab',secs:1,walk:false,items:['Mirrors','Horn']},{id:'out',title:'Walk round',secs:1,walk:true,items:['Tyres','Lights']},{id:'fin2',title:'Safety',secs:1,walk:false,items:['Extinguisher']}];
const co={id:'c1',name:'Test Haulage',join_code:'ABCD1234',checklist:CL,min_total_secs:0,weekly_price:1,alert_email:'a@b.c',billing_email:'a@b.c'};
const me={id:'u1',company_id:'c1',full_name:'Robbie',email:'r@x.co',role:'admin',active:true};
const T={profiles:[me],companies:[co],vehicles:[{id:'v1',company_id:'c1',reg:'AB12 CDE',type:'Truck',added_on:'2026-10-01',removed_on:null}],checks:[],alerts:[],invoices:[]};
function q(t){let rows=T[t];const o={select(){return o},eq(){return o},is(){return o},gte(){return o},order(){return o},limit(){return o},
maybeSingle(){return Promise.resolve({data:rows[0]||null})},single(){return Promise.resolve({data:rows[0]})},
update(){return o},insert(r){window.__ins.push([t,r]);return Promise.resolve({error:null})},upsert(r){window.__ins.push([t,r]);return Promise.resolve({error:null})},
then(res){return Promise.resolve({data:rows,count:rows.length,error:null}).then(res)}};return o}
window.supabase={createClient(){return{auth:{getSession:async()=>({data:{session:{user:{id:'u1',email:'r@x.co'}}}}),signOut:async()=>{},onAuthStateChange(){}},
from:q,rpc:async(n)=>n==='usage_now'?{data:{rows:[{reg:'AB12 CDE',type:'Truck',added:'2026-10-01',removed:null,weeks:5}],weeks:5,subtotal:5,vat_on:true,vat_rate:0.2,price:1}}:{data:1},
storage:{from(){return{upload:async(p,b)=>{window.__up.push(p);return{error:null}},createSignedUrl:async()=>({data:null})}}}}}};`;
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 400, height: 860 }, geolocation: { latitude: 51.5, longitude: -0.12, accuracy: 5 }, permissions: ['geolocation'] });
  const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error' && !/ERR_|Failed to load/.test(m.text())) errs.push(m.text()); });
  await p.route('**/supabase.min.js', r => r.fulfill({ contentType: 'text/javascript', body: fake }));
  await p.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: 'window.KOVI={url:"x",key:"y"}' }));
  await p.route('https://t.test/**', r => { const f = r.request().url().replace('https://t.test/', ''); const fs = require('fs'); const fp = path + '/' + (f || 'index.html'); r.fulfill({ contentType: f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html', body: fs.readFileSync(fp) }); });
  await p.goto('https://t.test/index.html'); await p.waitForSelector('text=Select your vehicle');
  console.log('home ok, vehicle shown:', await p.locator('.vi').count());
  await p.click('[data-a=start]'); await p.waitForTimeout(800); console.log('BODY', (await p.locator('body').innerText()).slice(0,300), errs);  await p.waitForSelector('text=Before you start');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await p.setInputFiles('#plate', { name: 'p.png', mimeType: 'image/png', buffer: png }); await p.waitForSelector('img.photo');
  await p.click('[data-a=lic][data-v=Yes]'); await p.fill('#mil', '1234'); await p.click('#nx');
  // section 1
  await p.click('[data-a=allok]'); await p.waitForFunction(() => !document.querySelector('#nx').disabled, null, { timeout: 5000 }); await p.click('#nx');
  // walk section: sweep compass
  await p.click('[data-a=allok]');
  for (const h of [10, 100, 190, 280]) { await p.evaluate(h => { const e = new Event('deviceorientation'); e.webkitCompassHeading = h; window.dispatchEvent(e); }, h); await p.waitForTimeout(50); }
  console.log('coverage text:', await p.locator('#cov').innerText());
  await p.waitForFunction(() => !document.querySelector('#nx').disabled, null, { timeout: 5000 }); await p.click('#nx');
  // third: one defect
  await p.click('[data-a=pd][data-v=d]'); await p.fill('[data-a=dnote]', 'Cracked'); await p.waitForTimeout(1200);
  console.log('next disabled with defect noted:', await p.locator('#nx').isDisabled()); await p.click('#nx');
  await p.check('[data-a=d1]'); await p.check('[data-a=d2]'); await p.click('#nx');
  await p.waitForSelector('text=Saved');
  console.log('RESULT:', (await p.locator('.big').innerText()), '|', (await p.locator('.warn').innerText().catch(() => 'no flags')).replace(/\n/g, ' '));
  const ins = await p.evaluate(() => window.__ins.filter(x => x[0] === 'checks')[0][1]);
  console.log('row flags:', ins.flags, 'verdict', ins.verdict, 'defects', ins.defects.length, 'cov', ins.heading_coverage, 'gps', !!ins.start_lat, 'uploads', await p.evaluate(() => window.__up.length));
  for (const t of ['today', 'alerts', 'vehicles', 'people', 'checklist', 'billing', 'hist']) { await p.evaluate(t => document.querySelector('nav [data-v=' + t + ']').click(), t); await p.waitForTimeout(250); const h = await p.locator('main h1').first().innerText().catch(() => 'NO H1'); console.log(t, '->', h); }
  await p.screenshot({ path: 'billing.png' });
  console.log('ERRORS:', errs.length ? errs : 'none');
  await b.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
