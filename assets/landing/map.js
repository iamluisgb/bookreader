// Landing · el diagrama de «Everything in the box» y la escena de la luz de lectura (ver map.css).
// Sin dependencias; los textos están en el HTML de cada idioma, aquí solo hay lógica.
(function () {
  'use strict';
  var motion = document.documentElement.classList.contains('motion');
  var NS = 'http://www.w3.org/2000/svg';

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

  /* ---------------------------------------------------------- luz de lectura */
  var stage = document.getElementById('night');
  if (stage && motion) {
    var page = stage.querySelector('.night-stage > .night-page');
    var warm = page.querySelector('.night-warm'), dim = page.querySelector('.night-dim');
    var steps = [].slice.call(stage.querySelectorAll('.night-steps span'));
    // Light → Sepia → Dark, los mismos colores que app/css/themes.css
    var STOPS = [[[255, 255, 255], [29, 29, 31]], [[247, 241, 227], [63, 56, 46]], [[18, 18, 20], [245, 245, 247]]];
    var mix = function (a, b, t) { return 'rgb(' + a.map(function (v, i) { return Math.round(v + (b[i] - v) * t); }).join(',') + ')'; };
    var paint = function () {
      var r = page.getBoundingClientRect(), vh = window.innerHeight;
      // 0 con la página entrando por abajo (85 % de la pantalla), 1 cuando su borde de arriba llega al 25 %:
      // el cambio se ve entero mientras la página está a la vista
      var p = Math.max(0, Math.min(1, (vh * 0.85 - r.top) / (vh * 0.6)));
      var s = p * 2, i = Math.min(1, Math.floor(s)), t = Math.min(1, s - i);
      t = Math.max(0, Math.min(1, (t - 0.25) / 0.5)); // cada tema se queda un rato quieto antes de pasar al siguiente
      page.style.background = mix(STOPS[i][0], STOPS[i + 1][0], t);
      page.style.color = mix(STOPS[i][1], STOPS[i + 1][1], t);
      var w = Math.max(0, Math.min(1, (p - 0.72) / 0.22)); // la luz cálida entra ya de noche
      warm.style.opacity = (0.32 * w).toFixed(3); dim.style.opacity = (0.12 * w).toFixed(3);
      var on = p < 0.25 ? 0 : p < 0.75 ? 1 : 2;
      steps.forEach(function (el, j) { el.classList.toggle('on', j === on); });
    };
    var ticking = false;
    window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(function () { ticking = false; paint(); }); } }, { passive: true });
    window.addEventListener('resize', paint);
    paint();
  }
})();
