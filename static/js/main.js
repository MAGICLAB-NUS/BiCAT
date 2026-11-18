/* BiCAT project page interactions. All numbers come from the manuscript tables. */
(function () {
  'use strict';
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var V = './static/videos/';

  /* ---------------- reveal on scroll ---------------- */
  var revealIO = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add('in-view'); revealIO.unobserve(e.target); }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  document.querySelectorAll('.reveal').forEach(function (el) { revealIO.observe(el); });

  /* ---------------- autoplay videos only while visible ---------------- */
  function loadVideo(v) {
    if (!v.getAttribute('src') && v.dataset.src) { v.src = v.dataset.src; v.load(); }
  }
  /* Playback speed. Some browsers (notably Safari) reset playbackRate to 1 when a video
     loads, starts playing or seeks, so the wanted rate is stored on the element and
     re-applied on those events and by a light watchdog while videos play. */
  function applyRate(v) {
    var r = v._rate || 1;
    if (Math.abs(v.defaultPlaybackRate - r) > 0.01) v.defaultPlaybackRate = r;
    if (Math.abs(v.playbackRate - r) > 0.01) v.playbackRate = r;
  }
  function setRate(v, r) {
    v._rate = r;
    if (!v._rateHooked) {
      v._rateHooked = true;
      ['loadedmetadata', 'loadeddata', 'canplay', 'play', 'playing', 'seeked', 'ratechange'].forEach(function (ev) {
        v.addEventListener(ev, function () { applyRate(v); });
      });
    }
    applyRate(v);
  }
  setInterval(function () {
    document.querySelectorAll('video').forEach(function (v) { if (v._rate && !v.paused) applyRate(v); });
  }, 400);
  var autoIO = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      var v = e.target;
      if (e.isIntersecting) {
        loadVideo(v);
        if (reduceMotion) return;
        setRate(v, 2);
        var p = v.play(); if (p && p.catch) p.catch(function () {});
      } else if (!v.paused) { v.pause(); }
    });
  }, { threshold: 0.25 });
  document.querySelectorAll('video.auto').forEach(function (v) {
    v.addEventListener('loadedmetadata', function () { setRate(v, 2); });
    autoIO.observe(v);
  });

  /* ---------------- BiCAT idea card: draw causal cross-arm links ---------------- */
  function drawLinks() {
    document.querySelectorAll('.tokviz[data-links]').forEach(function (box) {
      var old = box.querySelector('svg.links'); if (old) old.remove();
      var rows = box.querySelectorAll('.tokrow');
      var top = rows[0].querySelectorAll('.tok'), bot = rows[1].querySelectorAll('.tok');
      var bb = box.getBoundingClientRect();
      var ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('class', 'links');
      svg.setAttribute('viewBox', '0 0 ' + bb.width + ' ' + bb.height);
      // tokens animate in with a transform, so measure from layout offsets instead of rects
      function c(el) { return { x: el.offsetLeft + el.offsetWidth / 2, t: el.offsetTop, b: el.offsetTop + el.offsetHeight }; }
      for (var i = 0; i < top.length; i++) {
        var a = c(top[i]);
        [i, i - 1].forEach(function (k) {
          if (k < 0) return;
          var z = c(bot[k]), ln = document.createElementNS(ns, 'line');
          ln.setAttribute('x1', a.x); ln.setAttribute('y1', a.b + 2); ln.setAttribute('x2', z.x); ln.setAttribute('y2', z.t - 2);
          svg.appendChild(ln);
        });
      }
      box.insertBefore(svg, box.firstChild);
    });
  }
  drawLinks();
  var rz; window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(drawLinks, 150); });

  /* ---------------- hero teaser video ---------------- */
  (function () {
    var v = document.getElementById('hero-video'); if (!v) return;
    var userPaused = false;
    var frame = v.parentNode, playBtn = document.getElementById('hv-play'), soundBtn = document.getElementById('hv-sound');
    function sync() {
      frame.classList.toggle('hv-paused', v.paused);
      playBtn.setAttribute('aria-label', v.paused ? 'Play video' : 'Pause video');
      soundBtn.setAttribute('aria-pressed', v.muted ? 'false' : 'true');
      soundBtn.setAttribute('aria-label', v.muted ? 'Turn sound on' : 'Turn sound off');
    }
    function toggle() { if (v.paused) { var p = v.play(); if (p && p.catch) p.catch(function () {}); } else v.pause(); }
    playBtn.addEventListener('click', toggle);
    v.addEventListener('click', toggle);
    soundBtn.addEventListener('click', function () {
      v.muted = !v.muted;
      if (!v.muted && v.paused) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
      sync();
    });
    ['play', 'pause', 'volumechange'].forEach(function (e) { v.addEventListener(e, sync); });
    if (reduceMotion) v.pause();

    /* progress bar: thin while it loops; hover / drag to scrub, then it keeps playing */
    var scrub = document.getElementById('hv-scrub');
    var fill = scrub.querySelector('.hv-fill'), thumb = scrub.querySelector('.hv-thumb'), buf = scrub.querySelector('.hv-buffer');
    var hoverT = scrub.querySelector('.hv-hover-time'), curEl = document.getElementById('hv-cur'), durEl = document.getElementById('hv-dur');
    var dragging = false, wasPlaying = false, blobSwapped = false, raf = 0;
    function fmt(t) { t = Math.max(0, t || 0); var m = Math.floor(t / 60), s = Math.floor(t % 60); return m + ':' + (s < 10 ? '0' : '') + s; }
    function paint(t) {
      var d = v.duration || 0, f = d ? Math.min(1, t / d) : 0;
      fill.style.width = (f * 100) + '%'; thumb.style.left = (f * 100) + '%';
      curEl.textContent = fmt(t);
      scrub.setAttribute('aria-valuenow', Math.round(t)); scrub.setAttribute('aria-valuetext', fmt(t) + ' of ' + fmt(d));
    }
    function paintBuffer() {
      var d = v.duration; if (!d || !v.buffered.length) return;
      buf.style.width = (v.buffered.end(v.buffered.length - 1) / d * 100) + '%';
    }
    function loop() { if (!dragging) paint(v.currentTime); raf = requestAnimationFrame(loop); }
    v.addEventListener('loadedmetadata', function () { durEl.textContent = fmt(v.duration); scrub.setAttribute('aria-valuemax', Math.round(v.duration)); paint(v.currentTime); });
    v.addEventListener('progress', paintBuffer);
    v.addEventListener('play', function () { cancelAnimationFrame(raf); raf = requestAnimationFrame(loop); });
    v.addEventListener('pause', function () { cancelAnimationFrame(raf); paint(v.currentTime); });

    // Seeking needs HTTP range requests. Simple local servers (python -m http.server) don't
    // support them, so if the video turns out not to be seekable we load it once as a blob.
    function ensureSeekable() {
      if (blobSwapped || !v.duration) return;
      var s = v.seekable, ok = s.length && s.end(s.length - 1) >= v.duration - 0.5 && s.start(0) <= 0.5;
      if (ok) return;
      blobSwapped = true;
      var t = v.currentTime, playing = !v.paused;
      fetch(v.currentSrc || v.src).then(function (r) { return r.blob(); }).then(function (b) {
        v.src = URL.createObjectURL(b);
        v.addEventListener('loadedmetadata', function once() { v.removeEventListener('loadedmetadata', once); v.currentTime = t; if (playing) v.play().catch(function () {}); });
      }).catch(function () {});
    }
    function timeAt(ev) {
      var r = scrub.getBoundingClientRect(), f = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      return { f: f, t: f * (v.duration || 0) };
    }
    function seek(t) { try { v.currentTime = t; } catch (e) {} paint(t); }
    scrub.addEventListener('pointerenter', ensureSeekable);
    scrub.addEventListener('pointermove', function (ev) {
      var p = timeAt(ev); hoverT.style.left = (p.f * 100) + '%'; hoverT.textContent = fmt(p.t);
      if (dragging) seek(p.t);
    });
    scrub.addEventListener('pointerdown', function (ev) {
      ev.preventDefault(); ev.stopPropagation(); ensureSeekable();
      dragging = true; wasPlaying = !v.paused; frame.classList.add('scrubbing');
      scrub.setPointerCapture(ev.pointerId);
      var p = timeAt(ev); hoverT.style.left = (p.f * 100) + '%'; hoverT.textContent = fmt(p.t);
      v.pause(); seek(p.t);
    });
    function endDrag() {
      if (!dragging) return; dragging = false; frame.classList.remove('scrubbing');
      if (wasPlaying || !userPaused) { var pr = v.play(); if (pr && pr.catch) pr.catch(function () {}); }
    }
    scrub.addEventListener('pointerup', endDrag);
    scrub.addEventListener('pointercancel', endDrag);
    scrub.addEventListener('click', function (ev) { ev.stopPropagation(); });
    scrub.addEventListener('keydown', function (ev) {
      var step = { ArrowLeft: -5, ArrowRight: 5, ArrowDown: -5, ArrowUp: 5 }[ev.key];
      if (ev.key === 'Home') { ensureSeekable(); seek(0); ev.preventDefault(); }
      else if (ev.key === 'End') { ensureSeekable(); seek(v.duration - 0.1); ev.preventDefault(); }
      else if (step) { ensureSeekable(); seek(Math.min(v.duration, Math.max(0, v.currentTime + step))); ev.preventDefault(); }
    });
    if (v.readyState >= 1) { durEl.textContent = fmt(v.duration); scrub.setAttribute('aria-valuemax', Math.round(v.duration)); }
    if (!v.paused) raf = requestAnimationFrame(loop);
    // pause when scrolled away (saves battery), resume when back unless the visitor paused it
    playBtn.addEventListener('click', function () { userPaused = v.paused; });
    v.addEventListener('click', function () { userPaused = v.paused; });
    new IntersectionObserver(function (en) {
      if (en[0].isIntersecting) { if (!userPaused && !reduceMotion && v.paused) { var p = v.play(); if (p && p.catch) p.catch(function () {}); } }
      else if (!v.paused) v.pause();
    }, { threshold: 0.2 }).observe(v);
    sync();
  })();

  /* ---------------- hero kittens: rest on top of "B" and "T" ---------------- */
  function placeKits() {
    var stage = document.getElementById('title-stage'), h1 = document.getElementById('hero-title');
    if (!stage || !h1 || !h1.firstChild) return;
    var txt = h1.firstChild, sb = stage.getBoundingClientRect();
    function box(i) { var r = document.createRange(); r.setStart(txt, i); r.setEnd(txt, i + 1); return r.getBoundingClientRect(); }
    var B = box(0), T = box(4), l = stage.querySelector('.kit-l'), r = stage.querySelector('.kit-r');
    if (l) l.style.left = (B.left - sb.left + B.width * 0.47 - l.offsetWidth * 0.5) + 'px';
    if (r) { r.style.right = 'auto'; r.style.left = (T.left - sb.left + T.width * 0.5 - r.offsetWidth * 0.5) + 'px'; }
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(placeKits); else placeKits();
  window.addEventListener('load', placeKits);
  window.addEventListener('resize', placeKits);

  /* ---------------- method step 1 opens the YAM mirror demo below the cards ---------------- */
  (function () {
    var card = document.querySelector('[aria-controls="step-panel-mirror"]');
    var panel = document.getElementById('step-panel-mirror');
    if (!card || !panel) return;
    var inner = panel.querySelector('.step-panel-inner'), closeBtn = panel.querySelector('.step-panel-close');
    function setOpen(open) {
      if (open === panel.classList.contains('is-open')) return;
      card.setAttribute('aria-expanded', open ? 'true' : 'false');
      panel.setAttribute('aria-hidden', open ? 'false' : 'true');
      if (open) {
        panel.classList.add('is-open');
        panel.style.height = inner.scrollHeight + 'px';
        window.dispatchEvent(new Event('bicat:mirror-open'));
        var done = function (e) {
          if (e.target !== panel) return;
          panel.removeEventListener('transitionend', done);
          if (panel.classList.contains('is-open')) panel.style.height = 'auto';
        };
        panel.addEventListener('transitionend', done);
        setTimeout(function () {
          var r = panel.getBoundingClientRect();
          if (r.bottom > window.innerHeight) window.scrollBy({ top: Math.min(r.top - 80, r.bottom - window.innerHeight + 24), behavior: reduceMotion ? 'auto' : 'smooth' });
        }, 380);
      } else {
        panel.style.height = inner.scrollHeight + 'px';
        void panel.offsetHeight;                 // commit the start height before animating to 0
        panel.classList.remove('is-open');
        panel.style.height = '0px';
      }
    }
    card.addEventListener('click', function () { setOpen(!panel.classList.contains('is-open')); });
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!panel.classList.contains('is-open')); }
    });
    closeBtn.addEventListener('click', function () { setOpen(false); card.focus({ preventScroll: true }); });
  })();

  /* ---------------- tooltip ---------------- */
  var tip = document.getElementById('tooltip');
  function showTip(html, ev) {
    tip.innerHTML = html; tip.classList.add('show');
    var x = ev.clientX + 14, y = ev.clientY + 14;
    var w = tip.offsetWidth, h = tip.offsetHeight;
    if (x + w > window.innerWidth - 8) x = ev.clientX - w - 14;
    if (y + h > window.innerHeight - 8) y = ev.clientY - h - 14;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  function hideTip() { tip.classList.remove('show'); }
  function bindTip(el, html) {
    el.addEventListener('mousemove', function (ev) { showTip(html, ev); });
    el.addEventListener('mouseleave', hideTip);
  }

  /* ================= REAL-WORLD COMPARISON ================= */
  var METHODS = { bicat: 'BiCAT (ours)', oat: 'OAT<sup>sing</sup>', fast: 'FAST' };
  var TASKS = [
    { id: 'so101_block', robot: 'Bimanual SO-101', short: 'SO-101', name: 'Block', desc: 'Put the block into the box, then hand the box over.', shape: 'land', sr: { bicat: 25, oat: 19, fast: 3 } },
    { id: 'g1_bottle', robot: 'Unitree G1', short: 'G1', name: 'Bottle', desc: 'Move the bottle to the left.', shape: 'port', sr: { bicat: 24, oat: 13, fast: 6 } },
    { id: 'g1_plate', robot: 'Unitree G1', short: 'G1', name: 'Bowl', desc: 'Push the plate to the center, then place the bowl on it.', shape: 'port', sr: { bicat: 21, oat: 15, fast: 7 } },
    { id: 'yam_pen', robot: 'Bimanual YAM', short: 'YAM', name: 'Pen', desc: 'Grasp the marker and its cap, then close the marker.', shape: 'land', sr: { bicat: 8, oat: 5, fast: 0 } },
    { id: 'yam_box', robot: 'Bimanual YAM', short: 'YAM', name: 'Box', desc: 'Put all the metal parts in the box, then move the box forward.', shape: 'land', sr: { bicat: 14, oat: 7, fast: 1 } },
    { id: 'yam_bottle', robot: 'Bimanual YAM', short: 'YAM', name: 'Bottle', desc: 'Put all bottles in the dustbin.', shape: 'land', sr: { bicat: 21, oat: 15, fast: 8 } }
  ];
  var ORDER = ['bicat', 'oat', 'fast'];
  var rate = 2, current = null;

  var tabs = document.getElementById('task-tabs');
  var grid = document.getElementById('cmp-grid');
  var playBtn = document.getElementById('btn-play');

  TASKS.forEach(function (t, i) {
    var b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', 'tab'); b.id = 'tab-' + t.id;
    b.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
    b.innerHTML = '<span class="robot">' + t.short + '</span>' + t.name;
    b.addEventListener('click', function () { selectTask(i, true); });
    tabs.appendChild(b);
  });
  tabs.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    var idx = TASKS.indexOf(current) + (e.key === 'ArrowRight' ? 1 : -1);
    idx = (idx + TASKS.length) % TASKS.length;
    selectTask(idx, true); tabs.children[idx].focus();
  });

  function vids() { return Array.prototype.slice.call(grid.querySelectorAll('video')); }
  function updatePlayBtn() {
    var anyPlaying = vids().some(function (v) { return !v.paused && !v.ended; });
    playBtn.querySelector('span').textContent = anyPlaying ? 'Pause all' : 'Play all';
    playBtn.querySelector('svg').innerHTML = anyPlaying
      ? '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>'
      : '<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>';
  }

  function selectTask(i, autoplay) {
    var t = TASKS[i]; current = t;
    Array.prototype.forEach.call(tabs.children, function (b, j) { b.setAttribute('aria-selected', j === i ? 'true' : 'false'); });
    document.getElementById('cmp').setAttribute('aria-labelledby', 'tab-' + t.id);
    document.getElementById('cmp-robot').textContent = t.robot;
    document.getElementById('cmp-title').textContent = t.name;
    document.getElementById('cmp-desc').textContent = t.desc;
    document.getElementById('cmp-note').textContent = '';

    var bars = document.getElementById('cmp-bars'); bars.innerHTML = '';
    ORDER.forEach(function (m) {
      var row = document.createElement('div');
      row.className = 'sr-row ' + (m === 'bicat' ? 'ours' : m);
      row.innerHTML = '<span class="name">' + METHODS[m].replace(' (ours)', '') + '</span><span class="sr-track"><span class="sr-fill"></span></span><span class="val">' + t.sr[m] + '/25</span>';
      bars.appendChild(row);
      bindTip(row, '<b>' + METHODS[m] + '</b><br>' + t.sr[m] + ' of 25 trials succeeded (' + Math.round(t.sr[m] / 25 * 100) + '%)');
      requestAnimationFrame(function () { requestAnimationFrame(function () {
        row.querySelector('.sr-fill').style.width = (t.sr[m] / 25 * 100) + '%';
      }); });
    });

    vids().forEach(function (v) { v.pause(); v.removeAttribute('src'); v.load(); });
    grid.className = 'cmp-grid ' + t.shape;
    grid.innerHTML = '';
    ORDER.forEach(function (m) {
      var f = document.createElement('figure');
      f.className = 'vcard' + (m === 'bicat' ? ' ours' : '');
      var file = t.id + '_' + m;
      f.innerHTML =
        '<div class="media">' +
          '<span class="chip">' + METHODS[m] + '</span>' +
          '<video muted playsinline preload="metadata" poster="' + V + 'posters/' + file + '.jpg" src="' + V + 'rollouts/' + file + '.mp4" aria-label="' + METHODS[m].replace(/<[^>]+>/g, '') + ' rollout, ' + t.robot + ' ' + t.name + ' task"></video>' +
          (m === 'bicat'
            ? '<span class="done-badge success"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>Success</span>'
            : '<span class="done-badge failed"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>Failed</span>') +
          '<div class="vprog"><i></i></div>' +
        '</div>' +
        '<figcaption class="vlabel"><span class="m">' + METHODS[m] + '</span><span class="s">' + t.sr[m] + '/25 success</span></figcaption>';
      grid.appendChild(f);
      var v = f.querySelector('video'), bar = f.querySelector('.vprog i');
      setRate(v, rate);
      v.addEventListener('loadedmetadata', function () { setRate(v, rate); });
      v.addEventListener('timeupdate', function () { if (v.duration) bar.style.width = (v.currentTime / v.duration * 100) + '%'; });
      v.addEventListener('ended', function () { f.classList.add('ended'); updatePlayBtn(); });
      v.addEventListener('play', function () { f.classList.remove('ended'); updatePlayBtn(); });
      v.addEventListener('pause', updatePlayBtn);
      v.addEventListener('click', function () { if (v.paused) v.play(); else v.pause(); });
    });
    updatePlayBtn();
    if (autoplay && !reduceMotion) restartAll();
  }

  function restartAll() {
    vids().forEach(function (v) {
      v.currentTime = 0; setRate(v, rate);
      var p = v.play(); if (p && p.catch) p.catch(function () {});
    });
  }
  playBtn.addEventListener('click', function () {
    var list = vids();
    var anyPlaying = list.some(function (v) { return !v.paused && !v.ended; });
    if (anyPlaying) { list.forEach(function (v) { v.pause(); }); }
    else if (list.every(function (v) { return v.ended; })) { restartAll(); }
    else { list.forEach(function (v) { if (!v.ended) { setRate(v, rate); var p = v.play(); if (p && p.catch) p.catch(function () {}); } }); }
  });
  document.getElementById('btn-restart').addEventListener('click', restartAll);
  document.querySelectorAll('#speed button').forEach(function (b) {
    b.addEventListener('click', function () {
      rate = parseFloat(b.dataset.rate);
      document.querySelectorAll('#speed button').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      vids().forEach(function (v) { setRate(v, rate); });
    });
  });

  selectTask(0, false);
  // start the first comparison once it scrolls into view
  var cmpIO = new IntersectionObserver(function (entries) {
    if (entries[0].isIntersecting) { cmpIO.disconnect(); if (!reduceMotion) restartAll(); }
  }, { threshold: 0.35 });
  cmpIO.observe(document.getElementById('cmp'));
  // pause the comparison when it leaves the screen
  new IntersectionObserver(function (entries) {
    if (!entries[0].isIntersecting) vids().forEach(function (v) { v.pause(); });
  }, { threshold: 0 }).observe(document.getElementById('cmp'));

  /* ---------------- overall + latency bars ---------------- */
  function bigBars(el, rows, max, fmt, tipFmt) {
    rows.forEach(function (r) {
      var d = document.createElement('div');
      d.className = 'big-row ' + r.cls;
      d.innerHTML = '<span class="name">' + r.name + '</span><span class="track"><span class="fill"></span></span><span class="val">' + fmt(r) + '</span>';
      el.appendChild(d);
      bindTip(d, tipFmt(r));
      var io = new IntersectionObserver(function (en) {
        if (en[0].isIntersecting) { io.disconnect(); d.querySelector('.fill').style.width = (r.v / max * 100) + '%'; }
      }, { threshold: 0.4 });
      io.observe(d);
    });
  }
  bigBars(document.getElementById('overall-bars'), [
    { name: 'BiCAT', cls: 'ours', v: 113 }, { name: 'OAT<sup>sing</sup>', cls: 'oat', v: 74 }, { name: 'FAST', cls: 'fast', v: 25 }
  ], 150, function (r) { return r.v + '<small>/150</small>'; },
  function (r) { return '<b>' + r.name + '</b><br>' + r.v + ' of 150 trials (' + (r.v / 150 * 100).toFixed(1) + '%)'; });
  bigBars(document.getElementById('latency-bars'), [
    { name: 'BiCAT', cls: 'ours', v: 91.7, sd: 1.3 }, { name: 'OAT<sup>sing</sup>', cls: 'oat', v: 251.6, sd: 5.1 }, { name: 'FAST', cls: 'fast', v: 434.1, sd: 103.6 }
  ], 540, function (r) { return r.v + '<small> ms</small>'; },
  function (r) { return '<b>' + r.name + '</b><br>' + r.v + ' ± ' + r.sd + ' ms per action chunk'; });

  /* ================= SIMULATION ================= */
  var SIM_TASKS = [
    ['Shake bottle horizontally', 'single'], ['Place container plate', 'single'],
    ['Stack blocks two', 'loose'], ['Dump bin bigbin', 'loose'], ['Stack bowls three', 'loose'], ['Pick dual bottles', 'loose'],
    ['Hand over mic', 'tight'], ['Place bread skillet', 'tight'], ['Place dual shoes', 'tight'], ['Put bottles dustbin', 'tight']
  ];
  var SIM = [
    ['Bin', [67, 30, 0, 0, 0, 0, 5, 0, 0, 0]],
    ['FAST', [70, 25, 15, 27, 9, 11, 52, 13, 1, 0]],
    ['QueST', [96, 92, 43, 69, 55, 12, 90, 10, 4, 20]],
    ['OAT<sup>sing</sup>', [93, 90, 47, 78, 50, 3, 94, 8, 3, 21]],
    ['OAT<sup>pow2</sup>', [93, 85, 49, 70, 54, 10, 77, 6, 5, 20]],
    ['M<sup>2</sup>Tok', [87, 69, 18, 53, 43, 12, 83, 14, 5, 21]],
    ['NAC', [99, 90, 47, 87, 57, 15, 74, 18, 4, 26]],
    ['ActionCodec', [98, 83, 34, 60, 54, 23, 72, 25, 6, 37]],
    ['BiCAT', [100, 92, 66, 85, 81, 44, 88, 47, 41, 49]]
  ];
  var GROUP_TEXT = {
    all: 'Unweighted average over all ten tasks',
    single: 'Two single-arm tasks',
    loose: 'Four loosely coupled tasks: both arms act largely independently',
    tight: 'Four tightly coupled tasks: each arm’s motion depends on its partner'
  };
  function groupMean(vals, g) {
    var s = 0, n = 0;
    vals.forEach(function (v, i) { if (g === 'all' || SIM_TASKS[i][1] === g) { s += v; n++; } });
    return s / n;
  }
  var simBars = document.getElementById('sim-bars');
  var simRows = SIM.map(function (s) {
    var ours = s[0] === 'BiCAT';
    var n = document.createElement('div'); n.className = 'n' + (ours ? ' ours' : ''); n.innerHTML = s[0];
    var t = document.createElement('div'); t.className = 't';
    t.innerHTML = '<span class="f' + (ours ? ' ours' : '') + '" style="width:0"></span><span class="v" style="left:0"></span>';
    return { name: s[0], vals: s[1], ours: ours, n: n, t: t };
  });
  var X_MAX = 100;
  function ticks(el, max, step) {
    el.innerHTML = '';
    for (var v = 0; v <= max; v += step) { var s = document.createElement('span'); s.style.left = (v / max * 100) + '%'; s.textContent = v; el.appendChild(s); }
  }
  ticks(document.getElementById('sim-ticks'), X_MAX, 20);
  var simShown = false, simGroup = 'all';
  function renderSim(g) {
    simGroup = g;
    document.getElementById('sim-sub').textContent = GROUP_TEXT[g];
    var bestBase = 0;
    simRows.forEach(function (r) { r.m = groupMean(r.vals, g); if (!r.ours) bestBase = Math.max(bestBase, r.m); });
    var sorted = simRows.slice().sort(function (a, b) { return b.m - a.m; });
    simBars.innerHTML = '';
    sorted.forEach(function (r) {
      simBars.appendChild(r.n); simBars.appendChild(r.t);
      var w = simShown ? r.m / X_MAX * 100 : 0;
      r.t.querySelector('.f').style.width = w + '%';
      var v = r.t.querySelector('.v');
      v.style.left = w + '%';
      var label = r.m.toFixed(1);
      if (r.ours) { var d = r.m - bestBase; label += '<span class="d' + (d < 0 ? ' neg' : '') + '">' + (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(1) + '</span>'; }
      v.innerHTML = label;
      var detail = r.vals.map(function (x, i) { return (g === 'all' || SIM_TASKS[i][1] === g) ? SIM_TASKS[i][0] + ': ' + x : null; }).filter(Boolean).join('<br>');
      var html = '<b>' + r.name + '</b> · mean ' + r.m.toFixed(1) + '%<br><span style="opacity:.75">' + detail + '</span>';
      r.t.onmousemove = function (ev) { showTip(html, ev); };
      r.t.onmouseleave = hideTip;
    });
  }
  document.querySelectorAll('#sim-tabs button').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('#sim-tabs button').forEach(function (x) { x.setAttribute('aria-selected', x === b ? 'true' : 'false'); });
      renderSim(b.dataset.g);
    });
  });
  renderSim('all');
  var simIO = new IntersectionObserver(function (e) {
    if (e[0].isIntersecting) { simIO.disconnect(); simShown = true; renderSim(simGroup); }
  }, { threshold: 0.3 });
  simIO.observe(simBars);

  /* per-task table */
  (function () {
    var cols = SIM_TASKS.length;
    var best = [], second = [];
    for (var c = 0; c < cols; c++) {
      var vals = SIM.map(function (s) { return s[1][c]; }).sort(function (a, b) { return b - a; });
      best[c] = vals[0]; second[c] = vals.filter(function (v) { return v < vals[0]; })[0];
    }
    var h = '<table class="data"><thead><tr><th rowspan="2" scope="col" style="text-align:left">Tokenizer</th><th colspan="2" scope="colgroup">Single-arm</th><th colspan="4" scope="colgroup">Loosely coupled</th><th colspan="4" scope="colgroup">Tightly coupled</th><th rowspan="2" scope="col">Avg.</th></tr><tr>';
    SIM_TASKS.forEach(function (t) { h += '<th scope="col">' + t[0] + '</th>'; });
    h += '</tr></thead><tbody>';
    SIM.forEach(function (s) {
      var ours = s[0] === 'BiCAT';
      h += '<tr' + (ours ? ' class="ours"' : '') + '><th scope="row">' + s[0] + (ours ? ' (ours)' : '') + '</th>';
      s[1].forEach(function (v, c) { h += '<td class="' + (v === best[c] ? 'best' : v === second[c] ? 'second' : '') + '">' + v + '</td>'; });
      h += '<td class="mean">' + groupMean(s[1], 'all').toFixed(1) + '</td></tr>';
    });
    h += '</tbody></table><p class="chart-note">Success (%) over 100 rollouts per task. Best in bold, second-best underlined.</p>';
    document.getElementById('sim-table').innerHTML = h;
  })();

  /* ---------------- scatter: latency vs success ---------------- */
  (function () {
    var P = [
      // name, policy ms, mean SR, label dx, dy, anchor
      ['Bin', 451.7, 10.2, -10, 4, 'end'],
      ['FAST', 533.6, 22.3, -10, -10, 'end'],
      ['QueST', 227.7, 49.1, 10, -9, 'start'],
      ['OAT<tspan baseline-shift="super" font-size="8">sing</tspan>', 229.1, 48.7, 10, 15, 'start'],
      ['OAT<tspan baseline-shift="super" font-size="8">pow2</tspan>', 79.6, 46.9, 10, 15, 'start'],
      ['M<tspan baseline-shift="super" font-size="8">2</tspan>Tok', 40.6, 40.5, 10, 4, 'start'],
      ['NAC', 40.8, 51.7, 10, -8, 'start'],
      ['ActionCodec', 26.8, 49.2, -10, 4, 'end'],
      ['BiCAT', 40.5, 69.3, 12, 5, 'start']
    ];
    var W = 560, H = 380, m = { l: 58, r: 18, t: 16, b: 46 };
    var x0 = Math.log10(12), x1 = Math.log10(700);
    function X(v) { return m.l + (Math.log10(v) - x0) / (x1 - x0) * (W - m.l - m.r); }
    function Y(v) { return H - m.b - v / 80 * (H - m.t - m.b); }
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Scatter plot of mean RoboTwin success against policy decoding time per chunk. BiCAT is at 40.5 ms and 69.3 percent, the highest success; token-by-token tokenizers take over 200 ms.">';
    s += '<g class="grid">';
    [0, 20, 40, 60, 80].forEach(function (v) { s += '<line x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + Y(v) + '" y2="' + Y(v) + '"/>'; });
    [20, 50, 100, 200, 500].forEach(function (v) { s += '<line y1="' + m.t + '" y2="' + (H - m.b) + '" x1="' + X(v) + '" x2="' + X(v) + '"/>'; });
    s += '</g><g class="axis">';
    [0, 20, 40, 60, 80].forEach(function (v) { s += '<text x="' + (m.l - 8) + '" y="' + (Y(v) + 4) + '" text-anchor="end">' + v + '</text>'; });
    [20, 50, 100, 200, 500].forEach(function (v) { s += '<text x="' + X(v) + '" y="' + (H - m.b + 18) + '" text-anchor="middle">' + v + '</text>'; });
    s += '<text class="axis-title" x="' + ((W + m.l) / 2) + '" y="' + (H - 6) + '" text-anchor="middle">Decoding time per chunk (ms, log) → slower</text>';
    s += '<text class="axis-title" transform="translate(13 ' + ((H - m.b + m.t) / 2) + ') rotate(-90)" text-anchor="middle">Mean success (%)</text>';
    s += '</g>';
    P.forEach(function (p, i) {
      var ours = p[0] === 'BiCAT';
      s += '<circle class="pt' + (ours ? ' ours' : '') + '" cx="' + X(p[1]) + '" cy="' + Y(p[2]) + '" r="' + (ours ? 8 : 6) + '"/>';
      s += '<text class="pl' + (ours ? ' ours' : '') + '" x="' + (X(p[1]) + p[3]) + '" y="' + (Y(p[2]) + p[4]) + '" text-anchor="' + p[5] + '">' + p[0] + '</text>';
      s += '<circle class="hit" data-i="' + i + '" cx="' + X(p[1]) + '" cy="' + Y(p[2]) + '" r="14"/>';
    });
    s += '</svg>';
    var host = document.getElementById('scatter'); host.innerHTML = s;
    host.querySelectorAll('.hit').forEach(function (c) {
      var p = P[+c.dataset.i];
      var name = p[0].replace(/<tspan[^>]*>/g, '<sup>').replace(/<\/tspan>/g, '</sup>');
      bindTip(c, '<b>' + name + '</b><br>' + p[2] + '% mean success<br>' + p[1] + ' ms per chunk');
    });
  })();

  /* ---------------- ablation bars ---------------- */
  (function () {
    var A = [
      ['BiCAT (full)', 69.3, true],
      ['Raw coordinates', 58.7], ['Arm-specific modules', 56.9], ['Encoder-only coupling', 56.0],
      ['Right-first prediction', 54.2], ['Decoder-only coupling', 51.7], ['Single-block prediction', 51.1], ['Independent arms', 50.0]
    ];
    var DESC = {
      'Raw coordinates': 'No mirror canonicalization (s = 1)',
      'Arm-specific modules': 'Separate modules and normalization per arm',
      'Encoder-only coupling': 'No joint decoding',
      'Right-first prediction': 'Right-arm block predicted first',
      'Decoder-only coupling': 'No pre-quantization cross-attention',
      'Single-block prediction': 'Both arms predicted in one block',
      'Independent arms': 'No cross-attention and no joint decoding'
    };
    var host = document.getElementById('abl-bars'), MAX = 80, shown = false;
    ticks(document.getElementById('abl-ticks'), MAX, 20);
    var rows = A.map(function (a) {
      var n = document.createElement('div'); n.className = 'n' + (a[2] ? ' ours' : ''); n.textContent = a[0];
      var t = document.createElement('div'); t.className = 't';
      var d = a[2] ? '' : '<span class="d neg">−' + (69.3 - a[1]).toFixed(1) + '</span>';
      t.innerHTML = '<span class="f' + (a[2] ? ' ours' : '') + '" style="width:0"></span><span class="v" style="left:0">' + a[1].toFixed(1) + d + '</span>';
      host.appendChild(n); host.appendChild(t);
      bindTip(t, '<b>' + a[0] + '</b><br>' + (DESC[a[0]] ? DESC[a[0]] + '<br>' : '') + a[1].toFixed(1) + '% mean success');
      return [a, t];
    });
    var io = new IntersectionObserver(function (e) {
      if (!e[0].isIntersecting || shown) return; shown = true; io.disconnect();
      rows.forEach(function (r) {
        var w = r[0][1] / MAX * 100;
        r[1].querySelector('.f').style.width = w + '%';
        r[1].querySelector('.v').style.left = w + '%';
      });
    }, { threshold: 0.3 });
    io.observe(host);
  })();

  /* ---------------- copy BibTeX ---------------- */
  var copyBtn = document.getElementById('copy-bib');
  if (copyBtn) copyBtn.addEventListener('click', function () {
    var text = document.getElementById('bib-text').textContent;
    function done() { copyBtn.textContent = 'Copied'; setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1600); }
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () {});
  });

})();
