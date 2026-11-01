/* Kovi web app: start-up. */
(async () => {
  const K = window.K, S = K.s;
  S.authMode = K.lsGet('kovi_code') ? 'pin' : 'in';
  const rs = location.hash.match(/^#reset=([0-9a-f]{64})$/);                 // password reset link from the email
  if (rs) { K.setToken(''); S.resetToken = rs[1]; S.authMode = 'reset'; history.replaceState(null, '', '/'); }
  const back = new URLSearchParams(location.search).get('card');             // coming back from Stripe's card page
  if (back) history.replaceState(null, '', location.pathname);
  try { if (back === 'ok' && K.token) { await K.api('POST', '/api/billing/card/sync'); } } catch (e) {}
  try { await K.loadMe(); } catch (e) { S.err = 'No signal and nothing saved on this phone yet.'; }
  if (S.me) { S.view = K.isAdmin() && !S.deep ? 'today' : 'home'; if (back && K.isAdmin()) { S.view = 'billing'; K.toast(back === 'ok' ? 'Card saved. Thank you!' : 'Card not added'); } if (S.deep) { try { await K.openDeep(); } catch (e) {} } K.flush(true); }
  else if (S.deep) S.authMode = 'pin';   // a scanned QR code is nearly always a driver; sign in, then the vehicle opens
  K.render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
