// Generates the public marketing site (SEO pages) into web/.site/<path>/index.html plus sitemap.xml, robots.txt, llms.txt.
//   node site/build.js        (run after editing anything in site/content-*.js)
const fs = require('fs'), path = require('path');
const ORIGIN = 'https://kovifleet.co.uk', OUT = path.join(__dirname, '..', 'web', '.site'), WEB = path.join(__dirname, '..', 'web');
const TODAY = process.env.BUILD_DATE || new Date().toISOString().slice(0, 10);
const pages = [].concat(...['features', 'industries', 'guides', 'misc', 'legal', 'safety'].map(n => require('./content-' + n)));
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const GROUPS = { 'hgv-walkaround-check-guide': 'Daily checks', 'daily-vehicle-check-checklist-uk': 'Daily checks', 'van-daily-check-checklist': 'Daily checks', 'trailer-walkaround-check-guide': 'Daily checks', 'tyre-checks-for-lorries-and-vans': 'Daily checks', 'common-walkaround-check-mistakes': 'Daily checks', 'how-to-roll-out-daily-checks-to-drivers': 'Daily checks', 'driver-defect-reporting-guide': 'Daily checks', 'how-long-to-keep-walkaround-check-records': 'Legal requirements', 'pmi-vs-daily-walkaround-check': 'Legal requirements', 'how-to-choose-a-vehicle-check-app': 'Running a fleet' };
for (const p of pages) if (!p.group && p.path.startsWith('/guides/')) p.group = GROUPS[p.path.split('/')[2]];
const GORDER = ['Daily checks', 'Safety', 'Legal requirements', 'Running a fleet'];
const CL = require('./checklists-data');
const PDF = require('./pdfs');
const clPages = CL.filter(c => !c.pdfOnly).map(c => ({ path: '/checklists/' + c.slug, kind: 'guide', kicker: 'Checklist', nav: c.short || c.title, title: c.title + ' Checklist (Free PDF)', desc: c.desc, h1: c.title + ' checklist', lead: c.intro, dl: '/downloads/' + c.slug + '.pdf',
  body: (c.sections.map(([h, items]) => `<h2>${esc(h)}</h2><ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`).join('') || '') + (c.form ? '<h2>How to use it</h2><ol><li>The driver fills in the top section and describes what is wrong.</li><li>Tick a severity and say if a photo was taken.</li><li>Hand it to the office, who record the action and sign it off.</li><li>File it with the vehicle record.</li></ol>' : '') + `<h2>Do it on your phone instead</h2><p>Paper gets lost and nobody sees it until later. <a href="/features/custom-vehicle-check-templates">Build this as a Kovi template</a> in a few minutes: drivers scan a QR code, tick through it and the office sees defects with photos straight away. Free for 30 days.</p><p class="fine">This is a general checklist. Add anything your manufacturer's handbook, site rules or operator licence requires.</p>`,
  faq: c.faq || [], related: ['/checklists', '/guides/daily-vehicle-check-checklist-uk', '/features/defect-reporting-with-photos'] }));
pages.push(...clPages);
for (const c of CL.filter(c => c.pdfOnly)) { const t = pages.find(p => p.path === c.forPath); if (t) t.dl = '/downloads/' + c.slug + '.pdf'; }
const byPath = Object.fromEntries(pages.map(p => [p.path, p]));
const NAV = [['/why-kovi', 'Why Kovi'], ['/features', 'Features'], ['/industries', 'Who it\'s for'], ['/guides', 'Guides'], ['/pricing', 'Pricing']];
const SECTION_NAMES = { features: 'Features', industries: 'Industries', guides: 'Guides', checklists: 'Checklists', compare: 'Compare' };

const header = () => `<header class="top"><div class="wrap bar"><a class="logo" href="/">KOVI</a><span class="sp"></span>
<nav class="nav" aria-label="Main">${NAV.map(n => `<a href="${n[0]}">${n[1]}</a>`).join('')}</nav>
<a class="signin" href="/app">Sign in</a><a class="btn sm" href="/app?start=trial" data-cta="nav">Start free trial</a></div></header>`;
const col = (title, prefix, max = 99) => `<div><h4>${title}</h4>${pages.filter(p => p.path.startsWith(prefix) && p.path !== prefix).slice(0, max).map(p => `<a href="${p.path}">${esc(p.nav || p.h1)}</a>`).join('')}${max < 99 ? `<a href="${prefix.slice(0, -1)}"><b>All ${title.toLowerCase()} →</b></a>` : ''}</div>`;
const footer = () => `<footer class="foot"><div class="wrap fgrid">
<div><b class="flogo">KOVI</b><p>Daily vehicle walkaround checks for UK fleets. £1 per vehicle per week. 30 days free.</p><a class="btn sm" href="/app?start=trial" data-cta="footer">Start free trial</a></div>
${col('Features', '/features/')}${col('Who it\'s for', '/industries/')}${col('Guides', '/guides/', 7)}${col('Checklists', '/checklists/', 7)}
<div><h4>Kovi</h4><a href="/pricing">Pricing</a><a href="/why-kovi">Why Kovi</a><a href="/how-it-works">How it works</a><a href="/faq">FAQ</a><a href="/security">Security and data</a><a href="/about">About</a><a href="/contact">Contact</a><a href="/compare/paper-vs-digital-vehicle-checks">Paper vs digital</a><a href="/app">Sign in</a><a href="/legal/terms">Terms</a><a href="/legal/privacy">Privacy</a><a href="/legal/driver-notice">Driver notice</a></div>
</div><div class="wrap copy">© ${new Date().getFullYear()} Kovi. Kovi helps you record and manage vehicle checks. You remain responsible for your own legal compliance.</div></footer>`;

function crumbs(p) {
  const parts = p.path.split('/').filter(Boolean), list = [['Home', '/']];
  if (parts.length > 1) { const hub = '/' + parts[0]; list.push([SECTION_NAMES[parts[0]] || parts[0], byPath[hub] ? hub : null]); }
  if (p.path !== '/') list.push([p.nav || p.h1, p.path]);
  return list;
}
function schema(p, url) {
  const g = [], bc = crumbs(p).filter(c => c[1] || c === crumbs(p).slice(-1)[0]);
  g.push({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: bc.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c[0], item: ORIGIN + (c[1] || p.path) })) });
  g.push({ '@context': 'https://schema.org', '@type': 'Organization', name: 'Kovi', url: ORIGIN, logo: ORIGIN + '/icon-512.png' });
  if (p.kind === 'guide') g.push({ '@context': 'https://schema.org', '@type': 'Article', headline: p.h1, description: p.desc, datePublished: p.published || '2026-11-01', dateModified: TODAY, mainEntityOfPage: url, author: { '@type': 'Organization', name: 'Kovi' }, publisher: { '@type': 'Organization', name: 'Kovi', logo: { '@type': 'ImageObject', url: ORIGIN + '/icon-512.png' } }, image: ORIGIN + '/og.png' });
  if (p.kind === 'feature' || p.kind === 'industry' || p.path === '/pricing') g.push({ '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'Kovi', applicationCategory: 'BusinessApplication', operatingSystem: 'Web, iOS, Android', url: ORIGIN, description: 'Daily vehicle walkaround check software for UK fleets.', offers: { '@type': 'Offer', price: '1.00', priceCurrency: 'GBP', description: 'Per vehicle per week. 30 day free trial, no card needed.' } });
  if (p.faq && p.faq.length) g.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: p.faq.map(f => ({ '@type': 'Question', name: f[0], acceptedAnswer: { '@type': 'Answer', text: f[1] } })) });
  return g.map(x => `<script type="application/ld+json">${JSON.stringify(x)}</script>`).join('\n');
}
const related = p => {
  const list = (p.related || []).map(x => byPath[x]).filter(Boolean);
  if (!list.length) return '';
  return `<section class="rel"><h2>Related</h2><div class="relgrid">${list.map(r => `<a class="relcard" href="${r.path}"><b>${esc(r.nav || r.h1)}</b><span>${esc(r.desc)}</span></a>`).join('')}</div></section>`;
};
const card = r => `<a class="relcard" href="${r.path}"><b>${esc(r.nav || r.h1)}</b><span>${esc(r.desc)}</span></a>`;
const hubList = p => { if (!p.hub) return ''; const items = pages.filter(x => x.path.startsWith(p.hub) && x.path !== p.hub);
  if (!items.some(x => x.group)) return `<div class="relgrid hub">${items.map(card).join('')}</div>`;
  return GORDER.map(g => { const l = items.filter(x => x.group === g); return l.length ? `<h2>${g}</h2><div class="relgrid hub">${l.map(card).join('')}</div>` : ''; }).join(''); };
const faqHtml = p => p.faq && p.faq.length ? `<section class="faq"><h2>Questions</h2>${p.faq.map(f => `<details><summary>${esc(f[0])}</summary><p>${esc(f[1])}</p></details>`).join('')}</section>` : '';
const cta = p => p.nocta ? '' : `<section class="final"><div class="wrap c"><h2>Try Kovi free for 30 days</h2><p class="lead">No card needed. Set up in five minutes. £1 per vehicle per week after that.</p><a class="btn big" href="/app?start=trial" data-cta="${esc(p.path.replace(/\W+/g, '-').slice(1) || 'home')}">Start your free trial</a></div></section>`;

function render(p) {
  const url = ORIGIN + (p.path === '/' ? '/' : p.path), title = p.title.includes('Kovi') ? p.title : p.title + ' | Kovi';
  const bc = crumbs(p), nav = bc.length > 1 ? `<nav class="crumbs wrap" aria-label="Breadcrumb">${bc.map((c, i) => i < bc.length - 1 && c[1] ? `<a href="${c[1]}">${esc(c[0])}</a>` : `<span>${esc(c[0])}</span>`).join(' › ')}</nav>` : '';
  const meta = p.kind === 'guide' ? `<p class="meta">Updated ${new Date(TODAY).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} · ${Math.max(2, Math.round(p.body.replace(/<[^>]+>/g, ' ').split(/\s+/).length / 220))} min read</p>` : '';
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title><meta name="description" content="${esc(p.desc)}"><link rel="canonical" href="${url}">
<meta name="robots" content="index,follow,max-image-preview:large"><meta name="theme-color" content="#0f1720"><meta name="color-scheme" content="light dark">
<meta property="og:site_name" content="Kovi"><meta property="og:locale" content="en_GB"><meta property="og:type" content="${p.kind === 'guide' ? 'article' : 'website'}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(p.desc)}"><meta property="og:url" content="${url}"><meta property="og:image" content="${ORIGIN}/og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(p.desc)}"><meta name="twitter:image" content="${ORIGIN}/og.png">
<link rel="icon" href="/icon.svg"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/manifest.webmanifest">
<link rel="stylesheet" href="/landing.css"><link rel="stylesheet" href="/site.css">
${schema(p, url)}
</head><body>
${header()}
<main><section class="phead"><div class="wrap narrowish"><p class="eyebrow">${esc(p.kicker || '')}</p><h1>${esc(p.h1)}</h1>${p.lead ? `<p class="lead">${esc(p.lead)}</p>` : ''}${meta}${p.dl ? `<p><a class="btn big" href="${p.dl}" download data-cta="dl">Download the printable PDF</a></p>` : ''}${p.hero ? `<p><a class="btn big" href="/app?start=trial" data-cta="hero-${esc(p.path.replace(/\W+/g, '-').slice(1))}">Start your 30-day free trial</a></p><p class="fine light">No card needed · £1 per vehicle per week after</p>` : ''}</div></section>
${nav}
<article class="wrap narrowish prose">${p.body}${hubList(p)}${p.img ? `<figure class="shotfig"><img src="${p.img}" alt="${esc(p.imgAlt || '')}" loading="lazy" width="390" height="800"><figcaption>Example data</figcaption></figure>` : ''}${faqHtml(p)}${related(p)}</article>
</main>
${cta(p)}
${footer()}
<script src="/landing.js"></script></body></html>`;
}

fs.rmSync(OUT, { recursive: true, force: true });
const urls = [];
for (const p of pages) {
  const dir = path.join(OUT, p.path === '/' ? '' : p.path); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), render(p)); urls.push(p);
}
const notFound = render({ path: '/404', title: 'Page not found', desc: 'That page does not exist.', h1: 'Page not found', kicker: '404', lead: 'The page you wanted has moved or never existed.', body: '<p><a href="/">Go to the Kovi home page</a>, or look through our <a href="/guides">guides</a> and <a href="/features">features</a>.</p>', kind: 'page' }).replace('<meta name="robots" content="index,follow,max-image-preview:large">', '<meta name="robots" content="noindex">');
fs.writeFileSync(path.join(OUT, '404.html'), notFound);
const home = { path: '/', lastmod: TODAY, prio: '1.0' };
const prio = p => p.path === '/pricing' ? '0.9' : p.path.split('/').length === 2 ? '0.8' : p.kind === 'guide' ? '0.7' : '0.6';
fs.writeFileSync(path.join(WEB, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>${ORIGIN}/</loc><lastmod>${TODAY}</lastmod><priority>1.0</priority></url>\n${urls.filter(p => p.path !== '/').map(p => `<url><loc>${ORIGIN}${p.path}</loc><lastmod>${TODAY}</lastmod><priority>${prio(p)}</priority></url>`).join('\n')}\n</urlset>\n`);
fs.writeFileSync(path.join(WEB, 'robots.txt'), `User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /api/\nDisallow: /v/\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
fs.writeFileSync(path.join(WEB, 'llms.txt'), `# Kovi\n> Kovi is daily vehicle walkaround check software for UK fleets. Drivers scan a QR code on the vehicle, complete the check on their phone and report defects with photos. Offices see every check, defect and missed vehicle live. £1 per vehicle per week, 30 day free trial with no card.\n\n${urls.map(p => `- [${p.nav || p.h1}](${ORIGIN}${p.path}): ${p.desc}`).join('\n')}\n`);
fs.writeFileSync(path.join(OUT, '_urls.json'), JSON.stringify(urls.map(p => p.path)));
(async () => { fs.mkdirSync(path.join(WEB, 'downloads'), { recursive: true }); for (const c of CL) await PDF(c, path.join(WEB, 'downloads', c.slug + '.pdf')); console.log(urls.length + ' pages, ' + CL.length + ' PDFs, sitemap, robots, llms.txt written'); })();
