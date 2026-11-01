// Draws the printable checklist PDFs with pdfkit (A4, with tick boxes and signature lines)
const PDFDocument = require('./../server/node_modules/pdfkit/js/pdfkit.js');
const fs = require('fs');
const ACC = '#f5b301', NAVY = '#0f1720', GREY = '#586373';
function header(d, title) {
  d.rect(0, 0, d.page.width, 54).fill(NAVY);
  d.fillColor(ACC).font('Helvetica-Bold').fontSize(18).text('KOVI', 40, 18, { characterSpacing: 3, continued: false });
  d.fillColor('#ffffff').fontSize(13).text(title, 40, 20, { align: 'right', width: d.page.width - 80 });
  d.fillColor(NAVY).font('Helvetica').fontSize(10);
}
function footer(d) {
  const y = d.page.height - 40;
  d.fillColor(GREY).fontSize(8).text('General checklist. Adapt to your vehicles and follow your own safety rules and current DVSA / HSE guidance.', 40, y - 10, { width: d.page.width - 80, align: 'center' });
  d.fillColor(NAVY).fontSize(9).font('Helvetica-Bold').text('Do this on your phone in a minute: free 30 day trial at kovifleet.co.uk (no card)', 40, y + 4, { width: d.page.width - 80, align: 'center' });
}
function fields(d, labels, y) {
  const w = (d.page.width - 80) / labels.length;
  labels.forEach((l, i) => { const x = 40 + i * w; d.fillColor(GREY).font('Helvetica').fontSize(8).text(l.toUpperCase(), x, y, { width: w - 10 }); d.moveTo(x, y + 24).lineTo(x + w - 10, y + 24).strokeColor('#aab2bd').lineWidth(0.7).stroke(); });
  return y + 36;
}
module.exports = function make(c, file) {
  return new Promise((res, rej) => {
    const d = new PDFDocument({ size: 'A4', margins: { top: 40, left: 40, right: 40, bottom: 0 }, info: { Title: c.title + ' | Kovi', Author: 'Kovi' } });
    const out = fs.createWriteStream(file); d.pipe(out); out.on('finish', res); out.on('error', rej);
    header(d, c.title);
    let y = 70;
    if (c.form) {
      y = fields(d, ['Vehicle reg', 'Date', 'Time', 'Mileage'], y);
      y = fields(d, ['Driver name', 'Location', 'Trailer (if any)'], y + 6);
      d.fillColor(NAVY).font('Helvetica-Bold').fontSize(11).text('What is wrong?', 40, y + 8); y += 26;
      for (let i = 0; i < 4; i++) { d.moveTo(40, y + 18 * i + 14).lineTo(d.page.width - 40, y + 18 * i + 14).strokeColor('#cfd6df').stroke(); }
      y += 82;
      d.font('Helvetica-Bold').fontSize(11).text('Severity (circle one)', 40, y);
      ['Dangerous: do not drive', 'Major: fix before next journey', 'Minor: fix soon', 'Advisory: watch'].forEach((t, i) => { d.roundedRect(40 + i * 130, y + 20, 122, 26, 5).strokeColor('#aab2bd').stroke(); d.font('Helvetica').fontSize(8).fillColor(NAVY).text(t, 46 + i * 130, y + 28, { width: 112 }); });
      y += 66; d.font('Helvetica-Bold').fontSize(11).text('Photo taken?   Yes    No', 40, y); y += 24;
      d.text('Reported to', 40, y); d.moveTo(120, y + 12).lineTo(300, y + 12).strokeColor('#aab2bd').stroke(); d.text('Time', 320, y); d.moveTo(355, y + 12).lineTo(450, y + 12).stroke(); y += 34;
      d.fillColor(NAVY).text('Action taken by the office / workshop', 40, y); y += 18;
      for (let i = 0; i < 4; i++) { d.moveTo(40, y + 18 * i + 14).lineTo(d.page.width - 40, y + 18 * i + 14).strokeColor('#cfd6df').stroke(); }
      y += 90; y = fields(d, ['Fixed by', 'Date fixed', 'Signed off by'], y);
      footer(d); d.end(); return;
    }
    y = fields(d, ['Vehicle reg', 'Date', 'Driver', 'Mileage / hours'], y);
    d.fillColor(GREY).font('Helvetica').fontSize(8).text('Tick OK or mark a defect. Report every defect to the office before driving.', 40, y - 4); y += 10;
    for (const [h, items] of c.sections) {
      if (y + 30 + items.length * 20 > d.page.height - 90) { footer(d); d.addPage(); header(d, c.title); y = 70; }
      d.rect(40, y, d.page.width - 80, 18).fill('#eef0f3');
      d.fillColor(NAVY).font('Helvetica-Bold').fontSize(10).text(h, 46, y + 5);
      d.fillColor(GREY).fontSize(8).text('OK', d.page.width - 100, y + 5).text('DEFECT', d.page.width - 76, y + 5);
      y += 22;
      for (const it of items) {
        d.fillColor(NAVY).font('Helvetica').fontSize(9.5).text(it, 46, y + 3, { width: d.page.width - 160 });
        d.rect(d.page.width - 102, y + 1, 13, 13).strokeColor('#8a94a3').lineWidth(0.8).stroke();
        d.rect(d.page.width - 66, y + 1, 13, 13).stroke();
        y += 20;
      }
      y += 6;
    }
    d.fillColor(NAVY).font('Helvetica-Bold').fontSize(10).text('Defects found (what, where, how bad)', 40, y); y += 14;
    for (let i = 0; i < 3; i++) { d.moveTo(40, y + 16 * i + 12).lineTo(d.page.width - 40, y + 16 * i + 12).strokeColor('#cfd6df').stroke(); }
    y += 56; fields(d, ['Driver signature', 'Reported to', 'Time']  , Math.min(y, d.page.height - 120));
    footer(d); d.end();
  });
};
