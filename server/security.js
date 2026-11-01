'use strict';
const crypto = require('crypto');

// Browser protections. Scripts may only come from our own files; nothing on the page can be framed, sniffed or sent elsewhere.
const CSP = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self'", "connect-src 'self'",
  "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "manifest-src 'self'", "worker-src 'self'"].join('; ');
function headers(req, res, next) {
  res.set({
    'Content-Security-Policy': CSP,
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'geolocation=(self), camera=(self), microphone=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin' });
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
}

// simple per-IP request budget for the whole API, so one address cannot hammer it
function globalLimit(max = 600, windowMs = 60e3) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.t > windowMs) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    const now = Date.now(); let h = hits.get(req.ip);
    if (!h || now - h.t > windowMs) h = { t: now, n: 0 };
    h.n++; hits.set(req.ip, h);
    if (h.n > max) return res.status(429).json({ error: 'Too many requests. Slow down and try again in a minute.' });
    next();
  };
}

const COMMON = new Set(['password', 'password1', 'password12', 'password123', '1234567890', '12345678910', 'qwertyuiop', 'letmein123', 'welcome123', 'iloveyou12', 'abcd123456', 'admin12345', 'kovi123456']);
function passwordProblem(pw, email) {
  pw = String(pw || '');
  if (pw.length < 10) return 'Password must be 10 or more characters';
  if (pw.length > 200) return 'Password is too long';
  const low = pw.toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/.test(pw)) return 'That password is too easy to guess. Pick something harder';
  if (email && low === String(email).toLowerCase()) return 'Your password can not be your email address';
  return null;
}

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
module.exports = { headers, globalLimit, passwordProblem, sha256, CSP };
