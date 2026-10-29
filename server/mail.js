'use strict';
// Email through Resend. If no key is set, alerts still show in the app and nothing is sent.
module.exports = function mail({ RESEND_KEY, MAIL_FROM }) {
  async function sendMail({ to, subject, text, attachments }) {
    if (!RESEND_KEY || !to) return false;
    const body = { from: MAIL_FROM, to: [to], subject, text };
    if (attachments && attachments.length) body.attachments = attachments.map(a => ({ filename: a.filename, content: a.content.toString('base64') }));
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) { console.error('resend', r.status, await r.text()); return false; }
    return true;
  }
  return { sendMail, enabled: !!RESEND_KEY };
};
