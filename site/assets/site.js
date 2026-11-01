// The landing page's behaviour: copy buttons, reveal on scroll, the clickable org,
// the machines diagram and the "under the hood" scenes. The mini app lives in demo.js.
(function () {
  var still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var NS = 'http://www.w3.org/2000/svg';

  // copy buttons
  document.querySelectorAll('.copy').forEach(function (btn) {
    if (!navigator.clipboard) { btn.style.display = 'none'; return; }
    btn.addEventListener('click', function () {
      navigator.clipboard.writeText(btn.getAttribute('data-copy')).then(function () {
        btn.textContent = 'Copied'; btn.classList.add('ok');
        setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('ok'); }, 1600);
      }, function () {
        // the browser refused: select the command so a keyboard copy works
        var code = btn.parentNode.querySelector('code'), r = document.createRange();
        r.selectNodeContents(code); var sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
        btn.textContent = 'Press ⌘C';
        setTimeout(function () { btn.textContent = 'Copy'; }, 2400);
      });
    });
  });

  // reveal on scroll; the diagram draws when it shows. A sweep, not an IntersectionObserver:
  // WebKit skips the observer's callback for blocks a fast scroll passes over, and those stayed hidden.
  var pending = [].slice.call(document.querySelectorAll('.rv'));
  function sweep() {
    var line = window.innerHeight * .92;
    pending = pending.filter(function (el) {
      if (el.getBoundingClientRect().top > line) return true;
      el.classList.add('in');
      el.querySelectorAll('.drawing').forEach(function (d) { d.classList.add('go'); });
      return false;
    });
    if (!pending.length) { window.removeEventListener('scroll', sweep); window.removeEventListener('resize', sweep); }
  }
  window.addEventListener('scroll', sweep, { passive: true });
  window.addEventListener('resize', sweep);
  sweep();
  // the head script shows every hidden block again if this file never got this far
  window.walnutReady = true;

  function el(tag, attrs, parent) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function travel(parent, d, cls, dur, delay) {
    if (still) return;
    var c = el('circle', { r: 2.6, class: cls || '' }, parent);
    el('animateMotion', { dur: dur + 's', repeatCount: 'indefinite', path: d, begin: delay + 's' }, c);
  }

  // ---------- the org: every task can be opened; the one that needs you can be answered ----------
  var TASKS = {
    coast: { title: 'Plan the coast weekend', vp: 'Personal VP', host: 'Your Mac', icon: 'laptop', agent: 'Claude Code', state: 'need',
      latest: 'Two cabins are free that weekend. Which one should I book?' },
    car: { title: 'Renew the car registration', vp: 'Personal VP', host: 'Your Mac', icon: 'laptop', agent: 'Claude Code', state: 'work',
      latest: 'Filled in the renewal form from your notes. Waiting for the payment page.' },
    login: { title: 'Fix the login bug in the recipe app', vp: 'Side projects VP', host: 'Dev box', icon: 'server', agent: 'Claude Code', state: 'work',
      latest: 'Found it: the session cookie expires before the redirect. Writing the fix.' },
    blog: { title: 'Blog post: what I learned building it', vp: 'Side projects VP', host: 'Your Mac', icon: 'laptop', agent: 'Claude Code', state: 'work',
      latest: 'Drafted the outline from your project notes. Writing the first section.' },
    review: { title: 'Review the onboarding redesign', vp: 'Work VP', host: 'Dev box', icon: 'server', agent: 'Claude Code', state: 'work',
      latest: 'Read the five new screens. Two notes so far.' },
    demo: { title: 'Prepare the Thursday team demo', vp: 'Work VP', host: 'Cloud VM', icon: 'cloud', agent: 'Codex', state: 'work',
      latest: 'Built the demo script. Recording the walkthrough next.' }
  };
  var org = document.getElementById('org'), detail = document.getElementById('org-detail');
  var needsYou = true;

  function $(id) { return document.getElementById(id); }
  function showTask(key) {
    var t = TASKS[key];
    org.querySelectorAll('button.task').forEach(function (b) {
      b.classList.toggle('sel', b.dataset.task === key);
      b.setAttribute('aria-pressed', b.dataset.task === key ? 'true' : 'false');
    });
    $('d-title').textContent = t.title;
    $('d-vp').textContent = t.vp;
    $('d-host').textContent = t.host;
    $('d-agent').textContent = t.agent;
    detail.querySelector('.d-meta use').setAttribute('href', '#' + t.icon);
    $('d-latest').textContent = t.latest;
    var need = t.state === 'need', badge = $('d-badge');
    badge.className = 'badge' + (need ? '' : ' w');
    badge.innerHTML = '<i class="dot ' + (need ? 'n' : 'w') + '"></i>' + (need ? 'Needs you' : 'Working');
    $('d-opts').hidden = !need;
    if (!need) $('d-other').hidden = true;
    detail.classList.toggle('is-need', need);
    detail.classList.remove('flip'); void detail.offsetWidth; detail.classList.add('flip');
  }
  if (org && detail) safe(function () {
    org.querySelectorAll('button.task').forEach(function (b) {
      b.addEventListener('click', function () { showTask(b.dataset.task); });
    });
    function answer(pick) {
      var t = TASKS.coast;
      t.state = 'work';
      t.latest = 'You answered: ' + pick + '. Booking it now, then adding it to your notes.';
      needsYou = false;
      var row = org.querySelector('[data-task="coast"]');
      row.classList.remove('need');
      row.querySelector('.dot').className = 'dot w';
      row.querySelector('small').textContent = 'Claude Code';
      $('tally-w').textContent = '6';
      $('tally-n-row').style.display = 'none';
      // the mini app's Org page tells the same story
      var mo = $('mo-personal'), ceo = $('mo-ceo');
      if (mo) { mo.className = ''; mo.innerHTML = '<i class="dot w"></i>Booking the cabin'; }
      if (ceo) ceo.textContent = 'The Personal VP is booking the cabin you picked. The Work VP has the demo; Codex is building the script.';
      showTask('coast');
      $('d-latest').focus();
      safe(drawOrg);
    }
    detail.querySelectorAll('.opts .opt[data-answer]').forEach(function (o) {
      o.addEventListener('click', function () { answer(o.dataset.answer.charAt(0).toLowerCase() + o.dataset.answer.slice(1)); });
    });
    // Other… opens a box for the reader's own words
    var other = detail.querySelector('.opt.other'), form = $('d-other');
    other.addEventListener('click', function () {
      form.hidden = false; other.setAttribute('aria-expanded', 'true'); form.querySelector('input').focus();
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = form.querySelector('input').value.trim();
      if (!v) { form.querySelector('input').focus(); return; }
      form.hidden = true; other.setAttribute('aria-expanded', 'false');
      answer('\u201c' + v + '\u201d');
    });
  });

  // connectors, measured from the cards
  function drawOrg() {
    if (!org) return;
    var svg = org.querySelector('svg.links');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (getComputedStyle(svg).display === 'none') return;
    var box = org.getBoundingClientRect();
    function at(name) {
      var r = org.querySelector('[data-node="' + name + '"]').getBoundingClientRect();
      return { cx: r.left - box.left + r.width / 2, top: r.top - box.top, bottom: r.bottom - box.top };
    }
    var you = at('you'), ceo = at('ceo');
    el('path', { d: 'M' + you.cx + ' ' + you.bottom + ' V' + ceo.top, class: needsYou ? 'hot' : '' }, svg);
    ['vp1', 'vp2', 'vp3'].forEach(function (k, i) {
      var v = at(k), midY = (ceo.bottom + v.top) / 2;
      var d = Math.abs(v.cx - ceo.cx) < 2 ? 'M' + ceo.cx + ' ' + ceo.bottom + ' V' + v.top
        : 'M' + ceo.cx + ' ' + ceo.bottom + ' V' + midY + ' H' + v.cx + ' V' + v.top;
      el('path', { d: d, class: i === 0 && needsYou ? 'hot' : '' }, svg);
      travel(svg, d, '', 2.6 + i * .4, i * .7);
    });
    if (!needsYou) return;
    // the one question travels back up to you
    var v1 = at('vp1');
    travel(svg, 'M' + v1.cx + ' ' + v1.top + ' V' + ((ceo.bottom + v1.top) / 2) + ' H' + ceo.cx + ' V' + ceo.bottom +
      ' M' + ceo.cx + ' ' + ceo.top + ' V' + you.bottom, 'up', 3.2, 1.2);
  }

  // ---------- machines: a faint mesh, host positions, links and packets ----------
  var web = document.getElementById('web');
  function drawWeb() {
    if (!web) return;
    var svg = web.querySelector('svg'), mesh = svg.querySelector('.mesh'), links = svg.querySelector('.links'), pks = svg.querySelector('.pks');
    [mesh, links, pks].forEach(function (g) { while (g.firstChild) g.removeChild(g.firstChild); });
    var W = web.clientWidth, H = web.clientHeight, narrow = W < 640;
    if (!W) return;
    var pos = narrow ? [[33, 14], [67, 31], [67, 86], [33, 69]] : null;
    var cx = W / 2, cy = H / 2;
    var seed = 7; function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
    var pts = []; for (var i = 0; i < 26; i++) pts.push([rnd() * W, rnd() * H]);
    pts.forEach(function (p, i) { pts.forEach(function (q, j) {
      if (j <= i) return; var dx = p[0] - q[0], dy = p[1] - q[1];
      if (dx * dx + dy * dy < (narrow ? 9000 : 26000)) el('line', { x1: p[0], y1: p[1], x2: q[0], y2: q[1] }, mesh);
    }); });
    web.querySelectorAll('.host').forEach(function (h, i) {
      var x = (pos ? pos[i][0] : +h.dataset.x) / 100 * W, y = (pos ? pos[i][1] : +h.dataset.y) / 100 * H;
      h.style.left = x + 'px'; h.style.top = y + 'px';
      var mx = (x + cx) / 2 + (y - cy) * .18, my = (y + cy) / 2 - (x - cx) * .18;
      var d = 'M' + cx + ' ' + cy + ' Q' + mx + ' ' + my + ' ' + x + ' ' + y;
      var drop = h.dataset.drop === '1';
      el('path', { d: d, class: 'link' + (drop ? ' drop' : '') }, links);
      if (!drop) travel(pks, d, 'pk', 2.2 + i * .5, i * .4);
    });
    var note = web.querySelector('.drop-note');
    if (narrow) { note.style.left = '50%'; note.style.top = '96%'; } else { note.style.left = '31%'; note.style.top = '66%'; }
  }

  // ---------- under the hood: tabs, one scene each, turning on their own until the reader picks one ----------
  var core = document.getElementById('core');
  var tabs = core ? [].slice.call(core.querySelectorAll('.ct')) : [];
  var scenes = core ? [].slice.call(core.querySelectorAll('.scene')) : [];
  var cap = document.getElementById('core-cap'), strip = core && core.querySelector('.core-tabs');
  var bar = core && core.querySelector('.ct-bar i'), SCENE_MS = 7000, current = 0, auto = !still, hover = false, timer = null, tierTimer = null;
  function startBar() {
    var t = tabs[current];
    // offsetLeft counts from the tab strip's own edge, so a scrolled strip keeps the bar under its tab
    bar.style.transition = 'none'; bar.style.left = (t.offsetLeft - 5) + 'px'; bar.style.width = '0';
    if (auto && !hover) { void bar.offsetWidth; bar.style.transition = 'width ' + SCENE_MS + 'ms linear'; bar.style.width = t.offsetWidth + 'px'; }
  }
  function show(i) {
    current = i;
    tabs.forEach(function (t, k) {
      t.classList.toggle('on', k === i);
      t.setAttribute('aria-selected', k === i ? 'true' : 'false');
      t.tabIndex = k === i ? 0 : -1;
    });
    scenes.forEach(function (s, k) {
      s.classList.remove('on');
      if (k === i) { void s.offsetWidth; s.classList.add('on'); }
    });
    cap.textContent = scenes[i].dataset.cap;
    // on a phone the strip scrolls sideways: bring the chosen tab into it, without moving the page
    var t = tabs[i];
    if (strip.scrollWidth > strip.clientWidth) strip.scrollLeft = t.offsetLeft - (strip.clientWidth - t.offsetWidth) / 2;
    startBar();
    if (scenes[i].dataset.scene === 'hosts') safe(drawWeb);
    clearInterval(tierTimer);
    if (scenes[i].dataset.scene === 'tiers') safe(runTiers);
  }
  function inView(node) { var r = node.getBoundingClientRect(); return r.bottom > 0 && r.top < window.innerHeight; }
  function tick() {
    clearTimeout(timer);
    if (!auto) return;
    timer = setTimeout(function () {
      if (!document.hidden && !hover && inView(core)) show((current + 1) % scenes.length);
      tick();
    }, SCENE_MS);
  }
  // the reader takes over: no more turning, and the caption is read out from now on
  function takeOver() {
    if (!auto) return;
    auto = false; clearTimeout(timer); cap.setAttribute('aria-live', 'polite'); startBar();
  }
  if (core) {
    tabs.forEach(function (t, k) { t.addEventListener('click', function () { takeOver(); show(k); }); });
    strip.addEventListener('keydown', function (e) {
      var k = { ArrowRight: current + 1, ArrowLeft: current - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (k === undefined) return;
      e.preventDefault(); takeOver();
      k = (k + tabs.length) % tabs.length;
      show(k); tabs[k].focus();
    });
    core.addEventListener('focusin', takeOver);
    // a mouse moving over the scenes holds them; when it goes still or leaves, the clock starts again.
    // Movement, not presence: a page scrolled under a resting pointer must keep turning.
    var hoverT = null, lastXY = '';
    function release() { clearTimeout(hoverT); if (!hover) return; hover = false; startBar(); tick(); }
    core.addEventListener('pointermove', function (e) {
      // WebKit sends a pointermove that did not move after every scroll step
      var xy = e.clientX + ',' + e.clientY;
      if (e.pointerType !== 'mouse' || !auto || xy === lastXY) return;
      lastXY = xy;
      if (!hover) { hover = true; clearTimeout(timer); startBar(); }
      clearTimeout(hoverT); hoverT = setTimeout(release, 2500);
    });
    core.addEventListener('pointerleave', release);
  }

  // Focus, Satellite, Parked: the user drags a card between tiers; a task that waits fades out of the list and comes back
  var tiers = document.getElementById('tiers'), tcur = tiers && tiers.querySelector('.tcur');
  var L0 = { focus: ['a', 'b'], sat: ['c', 'd'], park: ['e'] }, L1 = { focus: ['a', 'b', 'd'], sat: ['c'], park: ['e'] };
  var TIER_STEPS = [
    { layout: L0 },
    { layout: L1, drag: 'd' },
    { layout: L1, gone: 'b' },
    { layout: L1, back: 'b' },
    { layout: L0, drag: 'd' }
  ];
  var tierStep = 0;
  function placeTiers(step) {
    var box = tiers.getBoundingClientRect();
    if (!box.width) return;
    var narrow = box.width < 560, top0 = narrow ? 34 : 44, gap = narrow ? 44 : 50;
    Object.keys(step.layout).forEach(function (tier) {
      var col = tiers.querySelector('[data-tier="' + tier + '"]').getBoundingClientRect(), n = 0;
      step.layout[tier].forEach(function (key) {
        var c = tiers.querySelector('[data-card="' + key + '"]'), gone = step.gone === key;
        var x = col.left - box.left + 10, y = col.top - box.top + top0 + n * gap;
        if (!gone) n++;
        c.style.width = (col.width - 20) + 'px';
        c.classList.toggle('gone', gone);
        c.classList.toggle('back', step.back === key);
        var tag = c.querySelector('.tag-w');
        if (gone && !tag) { tag = document.createElement('span'); tag.className = 'tag-w'; tag.textContent = 'waiting on review'; c.appendChild(tag); }
        if (!gone && tag) tag.remove();
        if (gone) return; // it fades where it stood
        if (step.drag === key && tcur && !still) {
          // the pointer picks the card up where it is and carries it across
          tcur.style.transition = 'none'; tcur.style.transform = 'translate(' + ((+c.dataset.x || x) + 40) + 'px,' + ((+c.dataset.y || y) + 18) + 'px)';
          tcur.classList.add('on'); c.classList.add('drag'); void tcur.offsetWidth;
          tcur.style.transition = ''; tcur.style.transform = 'translate(' + (x + 40) + 'px,' + (y + 18) + 'px)';
          setTimeout(function () { c.classList.remove('drag'); tcur.classList.remove('on'); }, 1100);
        }
        c.dataset.x = x; c.dataset.y = y;
        c.style.transform = 'translate(' + x + 'px,' + y + 'px)';
      });
    });
  }
  function runTiers() {
    tierStep = 0; placeTiers(TIER_STEPS[0]);
    if (still) return;
    tierTimer = setInterval(function () {
      tierStep = tierStep % (TIER_STEPS.length - 1) + 1;
      placeTiers(TIER_STEPS[tierStep]);
    }, 2600);
  }

  // ---------- drawing on load, fonts and width changes ----------
  function safe(fn) { try { fn(); } catch (e) { /* the static layout stays */ } }
  function drawAll() { safe(drawOrg); safe(drawWeb); if (tiers) safe(function () { placeTiers({ layout: TIER_STEPS[tierStep].layout, gone: TIER_STEPS[tierStep].gone }); }); }
  // redraw only when a width changes: a phone's address bar resizing the height would restart every pulse
  var widths = { org: 0, web: 0 }, t;
  function onResize() {
    var ow = org ? org.clientWidth : 0, ww = web ? web.clientWidth : 0;
    if (ow === widths.org && ww === widths.web) return;
    widths.org = ow; widths.web = ww;
    drawAll();
  }
  window.addEventListener('resize', function () { clearTimeout(t); t = setTimeout(onResize, 120); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(drawAll);
  window.addEventListener('load', drawAll);
  if (org && detail) safe(function () { showTask('coast'); });
  if (core) { show(0); tick(); }
  drawAll();
})();
