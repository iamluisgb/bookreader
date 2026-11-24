// Biblioteca libre de /samples/ y /es/muestra/: buscador sobre assets/muestra/catalogo.json.
// Cada resultado abre la app con `?sample=<id>` (app/js/samples.js baja el libro de su fuente).
// Sin dependencias; todo el texto del catálogo entra con textContent, nunca como HTML.
(function () {
  var root = document.getElementById('libre');
  if (!root) return;
  var ES = document.documentElement.lang === 'es';
  var base = root.getAttribute('data-base') || '../';
  var L = ES
    ? { read: 'Leer', source: 'Fuente', more: 'Ver {n} más', none: 'Nada coincide con «{q}».', count: '{n} libros', countOne: '1 libro', err: 'No se pudo cargar el catálogo.', tech: 'Técnico', lit: 'Clásico' }
    : { read: 'Read', source: 'Source', more: 'Show {n} more', none: 'Nothing matches “{q}”.', count: '{n} books', countOne: '1 book', err: 'The catalogue could not be loaded.', tech: 'Technical', lit: 'Classic' };
  var PAGE = 24;
  var input = root.querySelector('input[type="search"]');
  var list = root.querySelector('.lib-list');
  var status = root.querySelector('.lib-status');
  var moreBtn = root.querySelector('.lib-more');
  var filterBtns = root.querySelectorAll('[data-filter]');
  var all = [];
  var filter = 'all';
  var shown = PAGE;

  function fmt(s, p) { return s.replace(/\{(\w+)\}/g, function (_, k) { return p[k]; }); }
  function fold(s) { return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function row(b) {
    var li = el('li', 'lib-row');
    var main = el('div', 'lib-main');
    main.appendChild(el('span', 'lib-title', b.title));
    main.appendChild(el('span', 'lib-author', b.author));
    var meta = el('span', 'lib-meta');
    meta.appendChild(el('span', 'lib-tag', b.kind === 'tec' ? L.tech : L.lit));
    meta.appendChild(document.createTextNode(b.format.toUpperCase() + ' · ' + b.lang.toUpperCase() + ' · ' + b.license + ' · '));
    var src = el('a', null, b.sourceName);
    src.href = b.home; src.rel = 'noopener'; src.target = '_blank';
    meta.appendChild(src);
    main.appendChild(meta);
    var go = el('a', 'lib-read', L.read);
    go.href = base + 'app/?sample=' + encodeURIComponent(b.id);
    go.setAttribute('data-umami-event', 'Free library read');
    go.setAttribute('data-umami-event-kind', b.kind);
    li.appendChild(main);
    li.appendChild(go);
    return li;
  }

  function render() {
    var q = fold(input.value.trim());
    var hits = all.filter(function (b) {
      return (filter === 'all' || b.kind === filter) && (!q || b.key.indexOf(q) !== -1);
    });
    list.textContent = '';
    var frag = document.createDocumentFragment();
    hits.slice(0, shown).forEach(function (b) { frag.appendChild(row(b)); });
    list.appendChild(frag);
    status.textContent = hits.length ? (hits.length === 1 ? L.countOne : fmt(L.count, { n: hits.length.toLocaleString(ES ? 'es' : 'en') })) : fmt(L.none, { q: input.value.trim() });
    var rest = hits.length - shown;
    moreBtn.hidden = rest <= 0;
    if (rest > 0) moreBtn.textContent = fmt(L.more, { n: Math.min(rest, PAGE) });
  }

  fetch(base + 'assets/muestra/catalogo.json').then(function (r) {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }).then(function (c) {
    var tec = c.tecnicos.map(function (b) {
      return { id: 'tec:' + b.id, kind: 'tec', title: b.title, author: b.author, lang: b.lang, format: b.format, license: b.license, home: b.home, sourceName: new URL(b.home).hostname.replace(/^www\./, '') };
    });
    var se = c.se.map(function (b) {
      return { id: 'se:' + b.p, kind: 'lit', title: b.t, author: b.a, lang: 'en', format: 'epub', license: ES ? 'Dominio público en EE. UU.' : 'Public domain in the US', home: 'https://standardebooks.org/ebooks/' + b.p, sourceName: 'Standard Ebooks' };
    });
    // Los técnicos primero: son pocos y en la lista larga de clásicos se perderían.
    all = tec.concat(se);
    all.forEach(function (b) { b.key = fold(b.title + ' ' + b.author); });
    root.classList.add('is-ready');
    render();
  }).catch(function () { status.textContent = L.err; });

  var timer;
  input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { shown = PAGE; render(); }, 120); });
  moreBtn.addEventListener('click', function () { shown += PAGE; render(); });
  filterBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      filter = btn.getAttribute('data-filter');
      filterBtns.forEach(function (b) { b.setAttribute('aria-pressed', String(b === btn)); });
      shown = PAGE; render();
    });
  });
})();
