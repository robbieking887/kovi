'use strict';
const fs = require('fs'), path = require('path');
// Legal pages live in server/legal/*.html as plain fragments. {{PLACEHOLDERS}} are filled from environment variables
// (LEGAL_NAME, LEGAL_ADDRESS, LEGAL_EMAIL, COMPANY_NUMBER, ICO_NUMBER, GOVERNING_LAW). Until they are set the
// placeholder shows highlighted, so nobody can miss that it still needs filling in.
const PAGES = [['terms', 'Terms of Service'], ['data-processing', 'Data Processing Terms'], ['privacy', 'Privacy Policy'], ['driver-notice', 'Driver privacy notice']];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
module.exports = function legal(ctx) {
  const vars = () => ({
    NAME: process.env.LEGAL_NAME || '[YOUR COMPANY NAME]', ADDRESS: process.env.LEGAL_ADDRESS || '[YOUR REGISTERED ADDRESS]', EMAIL: process.env.LEGAL_EMAIL || '[YOUR CONTACT EMAIL]',
    COMPANY_NO: process.env.COMPANY_NUMBER || '[COMPANY NUMBER, if you are a limited company]', ICO: process.env.ICO_NUMBER || '[ICO REGISTRATION NUMBER]',
    LAW: process.env.GOVERNING_LAW || 'Scotland', VERSION: ctx.config.TERMS_VERSION });
  const render = (key, title) => {
    const file = path.join(__dirname, 'legal', key + '.html'); if (!fs.existsSync(file)) return null;
    const v = vars(), body = fs.readFileSync(file, 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => k in v ? (/^\[/.test(v[k]) ? `<mark>${esc(v[k])}</mark>` : esc(v[k])) : m);
    return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} - Kovi</title>
<style>:root{color-scheme:light dark}body{font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:0 auto;padding:20px 18px 60px;color:#101828;background:#fff}@media(prefers-color-scheme:dark){body{background:#0b1118;color:#f2f4f7}a{color:#f5b301}}
h1{font-size:28px;margin:.4em 0 .2em}h2{font-size:20px;margin:1.6em 0 .4em}h3{font-size:16px;margin:1.2em 0 .2em}table{border-collapse:collapse;width:100%;font-size:14px;margin:12px 0}td,th{border:1px solid #98a2b366;padding:6px 8px;text-align:left;vertical-align:top}
mark{background:#fde68a;color:#451a03;padding:0 3px;border-radius:3px}nav{font-size:14px;margin-bottom:14px}nav a{margin-right:12px}.meta{color:#667085;font-size:14px}</style></head><body>
<nav><a href="/">Back to Kovi</a>${PAGES.map(([k, t]) => `<a href="/legal/${k}">${esc(t)}</a>`).join('')}</nav>${body}</body></html>`;
  };
  ctx.app.get('/legal', (req, res) => res.redirect('/legal/terms'));
  ctx.app.get('/legal/:page', (req, res) => {
    const p = PAGES.find(x => x[0] === req.params.page), html = p && render(p[0], p[1]);
    if (!html) return res.status(404).send('Not found');
    res.set('Cache-Control', 'public, max-age=300').type('html').send(html);
  });
};
module.exports.PAGES = PAGES;
