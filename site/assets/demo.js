// The mini Walnut on the landing page: a scripted tour (a cursor clicks through the steps)
// that any click on the demo or its step buttons takes over.
(function () {
  var app = document.getElementById('app');
  var playBtn = document.getElementById('app-play');
  if (!app || !playBtn) return;
  var still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var body = app.querySelector('.app-body'), cursor = app.querySelector('.cursor');
  var crumb = document.getElementById('app-crumb');
  var stepBtns = [].slice.call(document.querySelectorAll('.app-steps [data-go]'));
  // each step: what the cursor clicks to get there, and the crumb it leaves
  var STEPS = [
    { id: 'home', target: '.p-tasks .row-t.on', crumb: 'Home' },
    { id: 'open', target: '.row-t[data-node="t-review"]', crumb: 'Home · 2 panels' },
    { id: 'draw', target: '.p-a .m-you', crumb: 'Home · 2 panels' },
    { id: 'file', target: '.p-a .path', crumb: 'Home · Files' },
    { id: 'changed', target: '.p-a [data-tab="changed"]', crumb: 'Home · Changed' },
    { id: 'org', target: '.si[data-go="org"]', crumb: 'Org' }
  ];
  var ORDER = STEPS.map(function (s) { return s.id; });
  var playing = !still, started = false, hover = false, timer = null, idx = 0;

  function setStep(id) {
    idx = ORDER.indexOf(id);
    app.dataset.step = id;
    if (crumb) crumb.textContent = STEPS[idx].crumb;
    stepBtns.forEach(function (b) {
      b.classList.toggle('on', b.dataset.go === id);
      b.setAttribute('aria-pressed', b.dataset.go === id ? 'true' : 'false');
    });
    app.querySelectorAll('.si[data-go]').forEach(function (b) { b.classList.toggle('on', (id === 'org') === (b.dataset.go === 'org')); });
  }
  function pointAt(sel) {
    var target = app.querySelector(sel);
    if (!target || !target.offsetParent) return false;
    var r = target.getBoundingClientRect(), b = body.getBoundingClientRect();
    cursor.style.transform = 'translate(' + (r.left - b.left + Math.min(r.width * .4, 60)) + 'px,' + (r.top - b.top + r.height * .55) + 'px)';
    cursor.classList.add('on');
    return true;
  }
  function tap() { cursor.classList.remove('tap'); void cursor.offsetWidth; cursor.classList.add('tap'); }

  // one step of the tour: move, click, show, wait
  function inView() { var r = app.getBoundingClientRect(); return r.bottom > 0 && r.top < window.innerHeight; }
  function next() {
    clearTimeout(timer);
    if (!playing) return;
    // off screen: stop here, and check() starts it again when the demo is back in view
    if (!inView() || document.hidden) { started = false; cursor.classList.remove('on'); return; }
    // a pointer resting on the demo holds the tour where it is
    if (hover) { timer = setTimeout(next, 600); return; }
    var n = (idx + 1) % STEPS.length, step = STEPS[n];
    // coming back from Org, the cursor clicks Home in the sidebar first
    var sel = step.id === 'home' && app.dataset.step === 'org' ? '.si[data-go="home"]' : step.target;
    var moved = pointAt(sel);
    timer = setTimeout(function () {
      if (!playing) return;
      if (moved) tap();
      setStep(step.id);
      timer = setTimeout(next, step.id === 'draw' ? 3200 : 2600);
    }, moved ? 900 : 200);
  }
  function setPlaying(on) {
    playing = on;
    if (on) started = true;
    playBtn.textContent = playing ? 'Pause' : 'Play';
    playBtn.setAttribute('aria-label', playing ? 'Pause the demo' : 'Play the demo');
    if (playing) next(); else { clearTimeout(timer); cursor.classList.remove('on'); }
  }

  // any click inside the demo takes over from the tour
  function takeOver(e) {
    var go = e.target.closest('[data-go]');
    if (!go) return;
    setPlaying(false);
    setStep(go.dataset.go);
  }
  app.addEventListener('click', takeOver);
  stepBtns.forEach(function (b) { b.addEventListener('click', takeOver); });
  playBtn.addEventListener('click', function () { setPlaying(!playing); });
  // keyboard users take over as soon as they reach into the demo
  app.addEventListener('focusin', function () { if (playing) setPlaying(false); });
  // a mouse moving over the demo holds the tour; still for 2.5s, or gone, and it goes on
  var hoverT = null, lastXY = '';
  app.addEventListener('pointermove', function (e) {
    // WebKit sends a pointermove that did not move after every scroll step
    var xy = e.clientX + ',' + e.clientY;
    if (e.pointerType !== 'mouse' || xy === lastXY) return;
    lastXY = xy;
    hover = true; clearTimeout(hoverT); hoverT = setTimeout(function () { hover = false; }, 2500);
  });
  app.addEventListener('pointerleave', function () { clearTimeout(hoverT); hover = false; });
  if (still) setPlaying(false);

  // start the tour once the demo is on screen, and hold it while the tab is hidden
  function check() {
    if (started || !playing) return;
    var r = app.getBoundingClientRect();
    if (r.top < window.innerHeight * .8 && r.bottom > 0) { started = true; timer = setTimeout(next, 900); }
  }
  window.addEventListener('scroll', check, { passive: true });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) clearTimeout(timer); else if (playing && started) next(); else check();
  });
  setStep('home');
  check();
})();
