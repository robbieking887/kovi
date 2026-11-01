// Sales page: send people who are already signed in (or inside the phone app) straight to the app, and run the demo tabs.
(function () {
  var qs = location.search, hash = location.hash;
  var inApp = /KoviApp/.test(navigator.userAgent), signedIn = false;
  try { signedIn = !!localStorage.getItem('kovi_t'); } catch (e) {}
  // old links (password reset, card return, QR codes) still land on the app
  if (location.pathname === '/' && (inApp || signedIn || /^#reset=/.test(hash) || /[?&]card=/.test(qs))) { location.replace('/app' + qs + hash); return; }
  var steps = [].slice.call(document.querySelectorAll('.step')), shots = [].slice.call(document.querySelectorAll('.shot')), cur = 0, timer;
  function show(i) { cur = i; steps.forEach(function (s, k) { s.classList.toggle('on', k === i); }); shots.forEach(function (s, k) { s.classList.toggle('on', k === i); }); }
  function auto() { clearInterval(timer); if (matchMedia('(prefers-reduced-motion: reduce)').matches) return; timer = setInterval(function () { show((cur + 1) % steps.length); }, 4500); }
  steps.forEach(function (s, i) { s.addEventListener('click', function () { show(i); auto(); }); });
  auto();
  // enquiry form
  var f = document.getElementById('leadform');
  if (f) f.addEventListener('submit', function (e) {
    e.preventDefault(); var msg = document.getElementById('leadmsg'), btn = f.querySelector('button'), d = {};
    [].forEach.call(f.elements, function (x) { if (x.name) d[x.name] = x.value; }); d.source = location.pathname;
    btn.disabled = true; msg.textContent = 'Sending...'; msg.className = 'leadmsg';
    fetch('/api/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (r) { if (r.ok) { f.reset(); msg.textContent = 'Thanks. We will get back to you soon, usually the same working day.'; msg.className = 'leadmsg good'; } else { msg.textContent = (r.j && r.j.error) || 'Something went wrong. Please try again.'; msg.className = 'leadmsg bad'; btn.disabled = false; } })
      .catch(function () { msg.textContent = 'Could not send. Please email hello@kovifleet.co.uk.'; msg.className = 'leadmsg bad'; btn.disabled = false; });
  });
  // which button people press, so we know what works (counts only, sent to our own server, no cookies)
  [].forEach.call(document.querySelectorAll('[data-cta]'), function (a) { a.addEventListener('click', function () { try { navigator.sendBeacon('/api/hit?c=' + encodeURIComponent(a.dataset.cta)); } catch (e) {} }); });
})();
