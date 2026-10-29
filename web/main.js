/* Kovi web app: start-up. */
(async () => {
  const K = window.K, S = K.s;
  S.authMode = K.lsGet('kovi_code') ? 'pin' : 'in';
  try { await K.loadMe(); } catch (e) { S.err = 'No signal and nothing saved on this phone yet.'; }
  if (S.me) { S.view = K.isAdmin() && !S.deep ? 'today' : 'home'; if (S.deep) { try { await K.openDeep(); } catch (e) {} } K.flush(true); }
  else if (S.deep) S.authMode = 'pin';   // a scanned QR code is nearly always a driver; sign in, then the vehicle opens
  K.render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
