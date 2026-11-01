// Landing · el diagrama de «Everything in the box», la pregunta con opciones de «Practicar», la lista
// de espera de Plus, la fecha de actualización y la analítica de la página (ver map.css).
// Sin dependencias; los textos están en el HTML de cada idioma, aquí solo hay lógica.
(function () {
  'use strict';
  var motion = document.documentElement.classList.contains('motion');
  var NS = 'http://www.w3.org/2000/svg';
  // Umami (sin cookies) solo existe en producción; aquí, nada.
  function track(name, data) { try { if (window.umami) window.umami.track(name, data); } catch (e) { /* nada */ } }

  /* ------------------------------------------------------------------ diagrama */
  var fig = document.getElementById('bmap');
  if (fig) {
    var svg = fig.querySelector('.bmap-lines'), core = fig.querySelector('.bmap-core');
    var ins = [].slice.call(fig.querySelectorAll('.bmap-in li'));
    var outs = [].slice.call(fig.querySelectorAll('.bmap-out button'));
    var demos = [].slice.call(fig.querySelectorAll('.bmap-demo'));
    var pIn = [], pOut = [], dot = null, k = 0, touched = false, visible = false, timer = 0, raf = 0;

    var curve = function (x1, y1, x2, y2) { var m = (x1 + x2) / 2; return 'M' + x1 + ' ' + y1 + ' C' + m + ' ' + y1 + ' ' + m + ' ' + y2 + ' ' + x2 + ' ' + y2; };
    var line = function (d) { var p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); svg.appendChild(p); return p; };
    var draw = function () {
      var f = fig.getBoundingClientRect(), c = core.getBoundingClientRect();
      if (f.width < 2 || getComputedStyle(svg).display === 'none') return;
      svg.setAttribute('viewBox', '0 0 ' + f.width + ' ' + f.height);
      svg.textContent = ''; pIn = []; pOut = [];
      var cy = c.top + c.height / 2 - f.top;
      ins.forEach(function (el) { var r = el.getBoundingClientRect(); var p = line(curve(r.right - f.left, r.top + r.height / 2 - f.top, c.left - f.left, cy)); p.classList.add('on'); pIn.push(p); });
      outs.forEach(function (el) { var r = el.getBoundingClientRect(); pOut.push(line(curve(c.right - f.left, cy, r.left - f.left, r.top + r.height / 2 - f.top))); });
      dot = document.createElementNS(NS, 'circle'); dot.setAttribute('r', 3.5); dot.style.opacity = 0; svg.appendChild(dot);
      pOut.forEach(function (p, i) { p.classList.toggle('on', i === k); });
    };
    // el punto sale de la tarjeta y viaja hasta la salida elegida (al revés de lo que se lee: es lo que el libro te da)
    var travel = function (p) {
      cancelAnimationFrame(raf);
      if (!p || !dot || !motion) return;
      var L = p.getTotalLength(), t0 = performance.now(), ms = 650;
      dot.style.opacity = 1;
      (function step(t) {
        var u = Math.min(1, (t - t0) / ms), e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2, q = p.getPointAtLength(L * e);
        dot.setAttribute('cx', q.x); dot.setAttribute('cy', q.y);
        if (u < 1) raf = requestAnimationFrame(step); else dot.style.opacity = 0;
      })(t0);
    };
    var show = function (i) {
      k = i;
      outs.forEach(function (b, j) { b.setAttribute('aria-pressed', String(j === i)); });
      demos.forEach(function (d) { d.hidden = d.dataset.demo !== outs[i].dataset.demo; });
      pOut.forEach(function (p, j) { p.classList.toggle('on', j === i); });
      travel(pOut[i]);
    };
    var loop = function () {
      clearTimeout(timer);
      if (touched || !visible || !motion) return;
      timer = setTimeout(function () { if (!touched && visible) { show((k + 1) % outs.length); loop(); } }, 4200);
    };
    outs.forEach(function (b, i) {
      b.addEventListener('click', function () {
        if (!touched && window.umami) window.umami.track('Box map', { feature: b.dataset.demo });
        touched = true; clearTimeout(timer); show(i);
      });
    });
    draw();
    if ('ResizeObserver' in window) new ResizeObserver(draw).observe(fig); else window.addEventListener('resize', draw);
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) {
        var was = visible; visible = es[0].isIntersecting;
        if (visible && !was) { show(k); loop(); }
      }, { threshold: 0.35 }).observe(fig);
    }
    show(0);
  }

  /* ------------------------------------------------------------- practicar */
  var quiz = document.querySelector('#quiz .quiz');
  if (quiz) {
    var opts = [].slice.call(quiz.querySelectorAll('.quiz-opt'));
    var mine = document.documentElement.lang === 'es' ? 'tu respuesta' : 'your answer';
    opts.forEach(function (b) {
      b.addEventListener('click', function () {
        if (quiz.classList.contains('done')) return;
        b.setAttribute('aria-pressed', 'true');
        b.querySelector('.quiz-l').setAttribute('data-mine', mine);
        quiz.classList.add('done');
        quiz.querySelector('.quiz-cite').hidden = false;
        if (window.umami) window.umami.track('Quiz', { right: b.dataset.ok === '1' });
      });
    });
  }
  var mem = document.querySelector('#quiz .mem');
  if (mem) {
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (es) { if (es[0].isIntersecting) { mem.classList.add('in'); io.disconnect(); } }, { threshold: 0.4 });
      io.observe(mem);
    } else mem.classList.add('in');
  }

  /* ------------------------------------------------- Plus: lista de espera */
  var form = document.getElementById('plus-form');
  if (form) {
    // En producción, por el propio dominio (ruta del Worker bookreader-sync en raiatech.com):
    // mismo origen y sin el subdominio de workers.dev a la vista. Fuera (pages.dev, local), directo.
    var WAITLIST = location.hostname === 'bookreader.raiatech.com'
      ? '/api/waitlist'
      : 'https://bookreader-sync.luisgonzalezb93.workers.dev/v1/waitlist';
    var msg = form.querySelector('.plus-msg'), btn = form.querySelector('button');
    var say = function (text, ok) { msg.textContent = text; msg.classList.toggle('ok', !!ok); };
    var want = function () { var w = form.querySelector('input[name="want"]:checked'); return w ? w.value : ''; };
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var email = form.email.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { say(form.dataset.bad); form.email.focus(); track('Waitlist invalid'); return; }
      btn.disabled = true; say('');
      fetch(WAITLIST, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, lang: document.documentElement.lang === 'es' ? 'es' : 'en', want: want(), website: form.website.value }),
      }).then(function (r) {
        if (r.ok) { form.classList.add('done'); say(form.dataset.ok, true); track('Waitlist', { want: want() || 'none' }); return; }
        say(r.status === 400 ? form.dataset.bad : form.dataset.err); btn.disabled = false;
        track('Waitlist error', { status: r.status });
      }).catch(function () { say(form.dataset.err); btn.disabled = false; track('Waitlist error', { status: 'network' }); });
    });
  }

  // ---------------------------------------------------------------- analítica de la página
  // Qué secciones se ven (dónde se abandona), y los gestos de las demos. Una vez por visita cada
  // uno: sirve para el embudo, no para contar clics.
  var seen = {};
  function once(key, name, data) { if (seen[key]) return; seen[key] = 1; track(name, data); }
  if ('IntersectionObserver' in window) {
    var so = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        so.unobserve(e.target);
        once('s:' + e.target.dataset.beat, 'Section seen', { beat: e.target.dataset.beat });
      });
    }, { threshold: 0.35 });
    Array.prototype.forEach.call(document.querySelectorAll('[data-beat]'), function (el) { so.observe(el); });
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target : e.target.parentElement;
    if (!t) return;
    if (t.closest('.fcard')) once('flip', 'Card flip');
    else if (t.closest('#deck-next')) once('next', 'Next card');
  });
  Array.prototype.forEach.call(document.querySelectorAll('.faq details'), function (d, i) {
    d.addEventListener('toggle', function () { if (d.open && i > 0) once('faq' + i, 'FAQ open', { q: i }); });
  });

  // «Actualizado el …»: la fecha del último despliegue (build.json lo escribe el build). Sin él
  // (local), la línea no aparece.
  var upd = document.querySelector('.proof-upd');
  if (upd && window.fetch) {
    fetch('/build.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (b) {
      var d = b && b.builtAt && new Date(b.builtAt);
      if (!d || isNaN(d)) return;
      var tm = upd.querySelector('time');
      tm.dateTime = b.builtAt.slice(0, 10);
      tm.textContent = d.toLocaleDateString(document.documentElement.lang === 'es' ? 'es-ES' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      upd.hidden = false;
    }).catch(function () { /* sin fecha */ });
  }
})();
