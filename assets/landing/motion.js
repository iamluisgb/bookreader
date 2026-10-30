/* global window, document, location, history, performance, requestAnimationFrame, setTimeout, URLSearchParams, IntersectionObserver */
// Landing · movimiento en 3D y un libro por público (P32).
//
// Un solo objeto, el libro, hace de hilo: se abre solo al cargar (hero), se nubla (beat 2),
// contesta y su cita señala la línea que lo dice (beat 3; antes eran dos escenas con la misma
// página), se reparte en tarjetas (beat 5) y vuelve a la estantería (cierre). El libro lo elige el visitante o el enlace de la campaña (?para=).
//
// El contenido de cada libro vive en la página (<script id="books-data">), en su idioma.
// Sin `.motion` en <html> (menos movimiento pedido) todo se pinta en su estado final.
(function () {
  'use strict';

  var dataEl = document.getElementById('books-data');
  if (!dataEl) return;
  var BOOKS = JSON.parse(dataEl.textContent);
  var root = document.documentElement;
  var motion = root.classList.contains('motion');
  var finePointer = window.matchMedia('(pointer: fine)').matches;
  // El hero se reproduce solo: atar la apertura al scroll obligaba a bajar para verla (fricción).
  var HERO_MS = 3800;

  // Alias de ?para= en los dos idiomas: un enlace de campaña funciona en /, /es/ y tras la
  // redirección de idioma.
  var ALIASES = {
    ddia: 'ddia', ingenieria: 'ddia', engineering: 'ddia',
    fa: 'fa', medicina: 'fa', medicine: 'fa',
    aws: 'aws', certificaciones: 'aws', certifications: 'aws',
  };

  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
  function clamp(v, a, b) { return Math.min(b === undefined ? 1 : b, Math.max(a || 0, v)); }
  function seg(p, a, b) { return clamp((p - a) / (b - a)); }
  function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function onView(el, threshold, cb) {
    if (!el || !('IntersectionObserver' in window)) return;
    new IntersectionObserver(function (entries) { cb(entries[0].isIntersecting); }, { threshold: threshold }).observe(el);
  }

  var current = (function initialBook() {
    var q = new URLSearchParams(location.search).get('para');
    return (q && ALIASES[q.toLowerCase()]) || 'ddia';
  })();

  /* ------------------------------------------------------------------ Hero */
  var book = $('#bk-book');
  var stage = $('.bk-stage');
  var floor = $('.bk-floor');
  var cover = $('#bk-cover');
  var hQ = $('#bk-q'), hA = $('#bk-a'), hCite = $('#bk-cite'), hHl = $('#bk-hl');
  var heroAnswer = '';
  var prog = 0, anim = null, tilt = { x: 0, y: 0 }, tiltT = { x: 0, y: 0 }, raf = 0, swapping = false, started = false;

  function renderHero(p) {
    var open = ease(seg(p, 0.04, 0.5));
    var s = book.style;
    s.setProperty('--open', open.toFixed(4));
    s.setProperty('--c', (-180 * ease(seg(p, 0.04, 0.42))).toFixed(2));
    s.setProperty('--l1', (-179 * ease(seg(p, 0.14, 0.52))).toFixed(2));
    s.setProperty('--l2', (-178 * ease(seg(p, 0.22, 0.6))).toFixed(2));
    s.setProperty('--rx', (lerp(26, 10, open) + tilt.y).toFixed(2));
    s.setProperty('--ry', tilt.x.toFixed(2));
    s.setProperty('--rz', lerp(-6, 0, open).toFixed(2));
    floor.style.width = 'calc(var(--w) * ' + (1 + open).toFixed(3) + ')';
    var qa = seg(p, 0.58, 0.66);
    hQ.style.opacity = qa;
    hQ.style.transform = 'translateY(' + ((1 - qa) * 6).toFixed(1) + 'px)';
    var t = seg(p, 0.66, 0.9);
    hA.textContent = heroAnswer.slice(0, Math.round(heroAnswer.length * t));
    hA.classList.toggle('caret', t > 0 && t < 1);
    hCite.style.opacity = seg(p, 0.9, 0.96);
    hHl.classList.toggle('lit', p > 0.93);
  }

  function heroLoop() {
    if (anim) {
      var t = clamp((performance.now() - anim.t0) / anim.dur);
      prog = lerp(anim.from, anim.to, t);
      if (t >= 1) { var done = anim.done; anim = null; if (done) done(); }
    }
    tilt.x += (tiltT.x - tilt.x) * 0.12;
    tilt.y += (tiltT.y - tilt.y) * 0.12;
    renderHero(prog);
    var tilting = Math.abs(tiltT.x - tilt.x) > 0.01 || Math.abs(tiltT.y - tilt.y) > 0.01;
    raf = anim || tilting ? requestAnimationFrame(heroLoop) : 0;
  }
  function playHero(to, dur, done) {
    anim = { from: prog, to: to, t0: performance.now(), dur: dur, done: done };
    kickHero();
  }
  function kickHero() { if (!raf) raf = requestAnimationFrame(heroLoop); }

  function fillHero(b) {
    // Ruta RELATIVA a la página (la landing también se sirve bajo /bookreader/ en otro
    // dominio): el src de un <img> se resuelve contra el documento. Ver .bk-cover-img.
    cover.querySelector('.bk-cover-img').src = b.cover;
    stage.setAttribute('aria-label', b.stageLabel);
    $('#bk-ch').textContent = b.hero.ch;
    $('#bk-p1').textContent = b.hero.p1;
    hHl.textContent = b.hero.hl;
    hQ.textContent = b.hero.q;
    hCite.textContent = b.hero.cite;
    heroAnswer = b.hero.a;
    if (!motion) hA.textContent = heroAnswer;
  }

  /* ------------------------------------------------ Beat 2 · el párrafo */
  var dense = $('#dense');
  var denseWords = [];
  function fillDense(b) {
    dense.textContent = '';
    denseWords = [];
    [['lead', b.dense.lead], ['key', b.dense.key], ['tail', b.dense.tail]].forEach(function (part, n) {
      if (n) dense.appendChild(document.createTextNode(' '));
      // La frase clave va entera en un span: se ilumina como una sola marca.
      var toks = part[0] === 'key' ? [part[1]] : part[1].split(/(\s+)/);
      toks.forEach(function (tok) {
        if (!tok) return;
        if (/^\s+$/.test(tok)) { dense.appendChild(document.createTextNode(tok)); return; }
        var w = document.createElement('span');
        w.className = 'w' + (part[0] === 'key' ? ' k' : '') + (!motion && part[0] === 'tail' ? ' fade' : '');
        w.textContent = tok;
        dense.appendChild(w);
        denseWords.push(w);
      });
    });
    renderDense();
  }
  function renderDense() {
    if (!motion) return;
    var r = dense.getBoundingClientRect();
    var vh = window.innerHeight;
    // 0 cuando el párrafo asoma por abajo, 1 cuando su centro llega al centro de la pantalla.
    var p = clamp((vh - r.top) / (vh * 0.5 + r.height * 0.5));
    var n = denseWords.length;
    denseWords.forEach(function (w, i) {
      if (w.classList.contains('k')) w.classList.toggle('lit', p > 0.92);
      else w.classList.toggle('blur', i / n < p * 1.05 - 0.05);
    });
  }

  /* ------------------------------------------- Beat 3 · la página contesta */
  var ask = $('#ask');
  var askQ = $('#ask-q'), askA = $('#ask-a'), askCite = $('#ask-cite'), askMark = $('#ask-mark');
  var askPath = $('#ask-path'), askDot = $('#ask-dot');
  var askRun = 0, askSeen = false;
  function fillAsk(b) {
    $('#ask-ch').textContent = b.ask.ch;
    $('#ask-before').textContent = b.ask.before;
    askMark.textContent = b.ask.mark;
    askQ.textContent = b.ask.q;
    askA.textContent = b.ask.a;
    askCite.lastChild.textContent = ' ' + b.ask.cite + ' — ' + b.ask.verify;
    askRun++;
    askQ.classList.remove('hide'); askCite.classList.remove('hide');
    if (motion && askSeen) playAsk();
    else drawThread(ask.classList.contains('marked') ? 1 : 0);
  }
  // El hilo sale de la cita (en el chat) y llega al final de la línea marcada (en la página).
  function drawThread(progress) {
    var box = ask.getBoundingClientRect();
    var rects = askMark.getClientRects();
    if (!rects.length || !box.width) return;
    var last = rects[rects.length - 1];
    var c = askCite.getBoundingClientRect();
    var x1 = c.left - box.left - 4, y1 = c.top + c.height / 2 - box.top;
    var x2 = last.right - box.left + 3, y2 = last.top + last.height / 2 - box.top;
    var bx = Math.max(36, Math.abs(x1 - x2) * 0.45);
    askPath.setAttribute('d', 'M' + x1 + ',' + y1 + ' C' + (x1 - bx) + ',' + y1 + ' ' + (x2 + bx) + ',' + y2 + ' ' + x2 + ',' + y2);
    var len = askPath.getTotalLength();
    askPath.style.strokeDasharray = len;
    askPath.style.strokeDashoffset = len * (1 - progress);
    var pt = askPath.getPointAtLength(len * progress);
    askDot.setAttribute('cx', pt.x);
    askDot.setAttribute('cy', pt.y);
    askDot.style.opacity = progress > 0 ? 1 : 0;
  }
  function playThread(id) {
    ask.classList.remove('marked');
    var t0 = performance.now();
    (function step(now) {
      if (id !== askRun) return;
      var t = clamp((now - t0) / 750);
      drawThread(ease(t));
      if (t < 1) requestAnimationFrame(step);
      else ask.classList.add('marked');
    })(t0);
  }
  function playAsk() {
    var id = ++askRun;
    var b = BOOKS[current];
    var words = b.ask.a.split(' ');
    askQ.classList.add('hide'); askCite.classList.add('hide'); askA.textContent = '';
    ask.classList.remove('marked'); drawThread(0);
    wait(300).then(function () {
      if (id !== askRun) return;
      askQ.classList.remove('hide');
      return wait(650);
    }).then(function typeWords() {
      if (id !== askRun) return;
      askA.classList.add('caret');
      var i = 0;
      return new Promise(function (done) {
        (function step() {
          if (id !== askRun) return done();
          askA.textContent = words.slice(0, ++i).join(' ');
          if (i < words.length) setTimeout(step, 42); else done();
        })();
      });
    }).then(function () {
      askA.classList.remove('caret');
      if (id !== askRun) return;
      askCite.classList.remove('hide');
      return wait(700).then(function () { if (id === askRun) playThread(id); });
    });
  }

  /* ------------------------------------------------- Beat 5 · el mazo */
  var deck = $('#deck');
  var cards = $$('.fcard', deck);
  var order = cards.map(function (_, i) { return i; });
  var fanned = !motion;
  var OFFS = [0, -1, 1, -2, 2];
  function placeDeck() {
    order.forEach(function (idx, k) {
      var el = cards[idx], o = OFFS[k];
      el.style.transform = fanned
        ? 'translateX(' + o * 30 + 'px) translateY(' + (Math.abs(o) * 12 + k * 2) + 'px) translateZ(' + -k * 22 + 'px) rotateZ(' + o * 5 + 'deg)'
        : 'translateY(' + -k * 6 + 'px) translateZ(' + -k * 22 + 'px) rotateZ(' + (k % 2 ? 1 : -1) * k * 1.2 + 'deg)';
      el.tabIndex = k === 0 ? 0 : -1;
      // Solo la de arriba recibe el toque: en el móvil, abanicadas, una de detrás se quedaba con él
      el.style.pointerEvents = k === 0 ? '' : 'none';
      el.setAttribute('aria-hidden', k === 0 ? 'false' : 'true');
    });
  }
  function fillDeck(b) {
    // El contenido de las tarjetas es de la propia página (books-data), no del usuario.
    cards.forEach(function (el, i) {
      var c = b.cards[i];
      el.classList.remove('flip');
      $('.face-tag', el).textContent = c.tag;
      $('.face-q', el).textContent = c.q;
      $('.face-a', el).innerHTML = c.a;
      $('.src-cite', el).textContent = c.cite;
    });
    order = cards.map(function (_, i) { return i; });
    placeDeck();
  }

  /* ----------------------------------------------- Cierre · la estantería */
  var mine = $('#spine-mine');
  function fillShelf(b) {
    mine.textContent = b.short;
    mine.style.setProperty('--c', b.spine[0]);
    mine.style.setProperty('--ci', b.spine[1]);
  }

  /* ---------------------------------------------------- Cambio de libro */
  function applyBook(key) {
    var b = BOOKS[key];
    if (!b) return;
    current = key;
    fillHero(b);
    fillDense(b);
    fillAsk(b);
    fillDeck(b);
    fillShelf(b);
    $$('.picker button').forEach(function (btn) { btn.setAttribute('aria-pressed', String(btn.dataset.book === key)); });
  }

  function pickBook(key) {
    if (key === current || swapping || !BOOKS[key]) return;
    var params = new URLSearchParams(location.search);
    params.set('para', BOOKS[key].slug);
    history.replaceState(null, '', location.pathname + '?' + params.toString() + location.hash);
    if (!motion || !started) { applyBook(key); renderHero(prog); return; }
    // Se cierra, cambia la portada y vuelve a abrirse sola.
    swapping = true;
    playHero(0, 550, function () {
      applyBook(key);
      setTimeout(function () { swapping = false; playHero(1, HERO_MS); }, 180);
    });
  }

  /* -------------------------------------------------------------- Arranque */
  applyBook(current);
  $$('.picker button').forEach(function (btn) {
    btn.addEventListener('click', function () { pickBook(btn.dataset.book); });
  });

  cards.forEach(function (el) {
    el.addEventListener('click', function () { if (el === cards[order[0]]) el.classList.toggle('flip'); });
  });
  $('#deck-next').addEventListener('click', function () {
    var top = cards[order[0]];
    if (motion) top.style.transform = 'translateY(-115%) translateZ(60px) rotateX(18deg) rotateZ(-4deg)';
    setTimeout(function () {
      top.classList.remove('flip');
      order.push(order.shift());
      placeDeck();
      cards[order[0]].focus({ preventScroll: true });
    }, motion ? 320 : 0);
  });

  if (!motion) {
    renderHero(1);
    ask.classList.add('marked');
    drawThread(1);
    window.addEventListener('resize', function () { drawThread(1); });
    return;
  }

  renderHero(0);
  // Arranca cuando el libro está a la vista (al cargar, casi siempre).
  onView(stage, 0.35, function (vis) {
    if (!vis || started) return;
    started = true;
    // Si en ese rato ya se eligió otro libro, su cambio manda: no se pisa su animación.
    setTimeout(function () { if (!anim && !swapping) playHero(1, HERO_MS); }, 350);
  });
  var ticking = false;
  window.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      ticking = false;
      renderDense();
    });
  }, { passive: true });
  window.addEventListener('resize', function () {
    renderDense();
    if (ask.classList.contains('marked')) drawThread(1);
  });

  if (finePointer) {
    stage.addEventListener('pointermove', function (e) {
      var r = stage.getBoundingClientRect();
      tiltT.x = ((e.clientX - r.left) / r.width - 0.5) * 14;
      tiltT.y = -((e.clientY - r.top) / r.height - 0.5) * 10;
      kickHero();
    });
    stage.addEventListener('pointerleave', function () { tiltT.x = 0; tiltT.y = 0; kickHero(); });

  }

  onView(ask, 0.5, function (vis) { if (vis && !askSeen) { askSeen = true; playAsk(); } });
  askCite.addEventListener('click', function () { playThread(++askRun); });
  onView(deck, 0.55, function (vis) { if (vis !== fanned) { fanned = vis; placeDeck(); } });

  // Privacidad: las capas se separan al entrar y se juntan al salir.
  var strata = $('#strata');
  var e = 1, eTarget = 1, eRaf = 0, strataSeen = false;
  function strataLoop() {
    e += (eTarget - e) * 0.07;
    strata.style.setProperty('--e', e.toFixed(3));
    if (Math.abs(eTarget - e) > 0.002) eRaf = requestAnimationFrame(strataLoop);
    else { e = eTarget; strata.style.setProperty('--e', e); eRaf = 0; }
  }
  onView(strata.parentElement, 0.4, function (vis) {
    if (vis && !strataSeen) { strataSeen = true; e = 0; }
    eTarget = vis ? 1 : 0;
    if (!eRaf) eRaf = requestAnimationFrame(strataLoop);
  });

  // Cierre: tu libro baja a la estantería cuando la ves.
  var shelf = $('#shelf');
  shelf.classList.add('pre');
  onView(shelf, 0.6, function (vis) { if (vis) shelf.classList.remove('pre'); });
})();
