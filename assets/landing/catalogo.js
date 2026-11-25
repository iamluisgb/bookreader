// Biblioteca libre de /samples/ y /es/muestra/: buscador con facetas sobre
// assets/muestra/catalogo.json (índice) + catalogo-es.json (estantería curada) y, cuando se pide,
// catalogo-completo.json (el resto del fondo, 3,5 MB que no se bajan hasta que hacen falta).
// Cada resultado abre la app con `?sample=<id>&t=<título>`: samples.js baja el libro de su fuente
// y usa el título solo para el aviso.
// Sin dependencias; todo el texto del catálogo entra con textContent, nunca como HTML.
(function () {
  var root = document.getElementById('libre');
  if (!root) return;
  var ES = document.documentElement.lang === 'es';
  var base = root.getAttribute('data-base') || '../';
  var L = ES
    ? {
        alsoIn: { en: 'También en inglés', es: 'También en español' },
        read: 'Leer',
        more: 'Ver {n} más',
        none: 'Nada coincide con «{q}».',
        count: '{n} libros',
        countOne: '1 libro',
        err: 'No se pudo cargar el catálogo.',
        tech: 'Técnico',
        lit: 'Clásico',
        lang: 'Idioma',
        mat: 'Materia',
        era: 'Época',
        src: 'Edición',
        fondo: 'Explorar las {n} obras restantes',
        loading: 'Cargando el resto del fondo…',
        sinclasif: 'Sin clasificar',
        sindato: 'sin dato',
      }
    : {
        alsoIn: { en: 'Also in English', es: 'Also in Spanish' },
        read: 'Read',
        more: 'Show {n} more',
        none: 'Nothing matches “{q}”.',
        count: '{n} books',
        countOne: '1 book',
        err: 'The catalogue could not be loaded.',
        tech: 'Technical',
        lit: 'Classic',
        lang: 'Language',
        mat: 'Subject',
        era: 'Period',
        src: 'Edition',
        fondo: 'Browse the remaining {n} works',
        loading: 'Loading the rest of the shelf…',
        sinclasif: 'Unclassified',
        sindato: 'not dated',
      };
  var PAGE = 24;
  var LANGNAME = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', nl: 'Dutch', pt: 'Portuguese', fi: 'Finnish', sv: 'Swedish', hu: 'Hungarian', el: 'Greek', la: 'Latin', da: 'Danish', ru: 'Russian', pl: 'Polish', cs: 'Czech', ca: 'Catalan', gl: 'Galician', eu: 'Basque', no: 'Norwegian', ja: 'Japanese', zh: 'Chinese', ar: 'Arabic', he: 'Hebrew', tr: 'Turkish', ro: 'Romanian', bg: 'Bulgarian', hr: 'Croatian', sl: 'Slovenian', et: 'Estonian', lt: 'Lithuanian', lv: 'Latvian', is: 'Icelandic', ga: 'Irish', cy: 'Welsh', eo: 'Esperanto', uk: 'Ukrainian', sr: 'Serbian', mk: 'Macedonian', sq: 'Albanian', af: 'Afrikaans', tl: 'Tagalog', ko: 'Korean', hi: 'Hindi', fa: 'Persian', yi: 'Yiddish' };
  var MAT = { A: 'General', B: 'Philosophy and religion', C: 'Auxiliary history', D: 'World history', E: 'History of America', F: 'Local America', G: 'Geography and travel', H: 'Social sciences', J: 'Politics', K: 'Law', L: 'Education', M: 'Music', N: 'Art', P: 'Literature', Q: 'Science', R: 'Medicine', S: 'Agriculture', T: 'Technology', U: 'Military', V: 'Naval', Z: 'Bibliography' };
  var MAT_ES = { A: 'Obras generales', B: 'Filosofía y religión', C: 'Ciencias auxiliares', D: 'Historia universal', E: 'Historia de América', F: 'América local', G: 'Geografía y viajes', H: 'Ciencias sociales', J: 'Política', K: 'Derecho', L: 'Educación', M: 'Música', N: 'Arte', P: 'Literatura', Q: 'Ciencia', R: 'Medicina', S: 'Agricultura', T: 'Tecnología', U: 'Militar', V: 'Naval', Z: 'Bibliografía' };
  var SRCN = { se: 'Standard Ebooks', pg: 'Project Gutenberg', el: 'Elejandría', tec: ES ? 'Técnico' : 'Technical' };
  var input = root.querySelector('input[type="search"]');
  var list = root.querySelector('.lib-list');
  var status = root.querySelector('.lib-status');
  var moreBtn = root.querySelector('.lib-more');
  var filterBtns = root.querySelectorAll('[data-filter]');
  var facetBox = root.querySelector('.lib-facets');
  var all = [];
  var filtro = { kind: 'all', lang: '', mat: '', era: '', src: '' };
  var shown = PAGE;
  var restoPedido = false;
  var fondoPendiente = 0;

  function fmt(s, p) { return s.replace(/\{(\w+)\}/g, function (_, k) { return p[k]; }); }
  function fold(s) { return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  // Época = siglo de nacimiento del autor. Los años a.C. tienen su propio tramo en lugar de caer
  // en «sin dato», que es lo que hacía perder a Platón y a Séneca.
  function epoca(y) {
    if (y === null || y === undefined) return L.sindato;
    if (y < 0) return ES ? 'Antigüedad (a.C.)' : 'Antiquity (BC)';
    if (y < 1600) return ES ? 'antes de 1600' : 'before 1600';
    if (y < 1700) return ES ? 'siglo XVII' : '17th century';
    if (y < 1800) return ES ? 'siglo XVIII' : '18th century';
    if (y < 1850) return ES ? 'siglo XIX (1800-1849)' : '19th century (1800–1849)';
    if (y < 1900) return ES ? 'fin del XIX (1850-1899)' : 'late 19th (1850–1899)';
    return ES ? 'siglo XX' : '20th century';
  }
  function materia(c) { return c ? (ES ? MAT_ES : MAT)[c] || c : L.sinclasif; }

  function row(b) {
    var li = el('li', 'lib-row');
    var main = el('div', 'lib-main');
    main.appendChild(el('span', 'lib-title', b.title));
    main.appendChild(el('span', 'lib-author', b.author));
    var meta = el('span', 'lib-meta');
    meta.appendChild(el('span', 'lib-tag', b.kind === 'tec' ? L.tech : L.lit));
    meta.appendChild(document.createTextNode(b.format.toUpperCase() + ' · ' + (LANGNAME[b.lang] || (b.lang || '').toUpperCase()) + ' · ' + b.license + ' · '));
    var src = el('a', null, b.sourceName);
    src.href = b.home; src.rel = 'noopener'; src.target = '_blank';
    meta.appendChild(src);
    if (b.mat !== L.sinclasif) meta.appendChild(document.createTextNode(' · ' + b.mat));
    if (b.year !== null && b.year !== undefined) meta.appendChild(document.createTextNode(' · ' + (b.year < 0 ? (ES ? 'a.C. ' : 'BC ') + -b.year : b.year)));
    // La misma obra en otro idioma va en la misma fila, no en otra (Pro Git EN/ES parecía duplicado).
    (b.alt || []).forEach(function (o) {
      meta.appendChild(document.createTextNode(' · '));
      var a = el('a', 'lib-alt', L.alsoIn[o.lang] || o.lang.toUpperCase());
      a.href = base + 'app/?sample=' + encodeURIComponent(o.id) + '&t=' + encodeURIComponent(o.title || '');
      a.setAttribute('data-umami-event', 'Free library read');
      a.setAttribute('data-umami-event-kind', o.kind);
      meta.appendChild(a);
    });
    main.appendChild(meta);
    var go = el('a', 'lib-read', L.read);
    go.href = base + 'app/?sample=' + encodeURIComponent(b.id) + '&t=' + encodeURIComponent(b.title);
    go.setAttribute('data-umami-event', 'Free library read');
    go.setAttribute('data-umami-event-kind', b.kind);
    li.appendChild(main);
    li.appendChild(go);
    return li;
  }

  // Un <select> por faceta, con el recuento REAL de lo que hay cargado: un contador que no cuadra
  // con la lista de al lado es peor que no tener contador.
  function opciones(campo, etiqueta, valores) {
    var sel = el('select');
    sel.setAttribute('aria-label', etiqueta);
    var vacio = el('option', null, etiqueta);
    vacio.value = '';
    sel.appendChild(vacio);
    valores.forEach(function (p) {
      var o = el('option', null, p[0] + ' (' + p[1].toLocaleString(ES ? 'es' : 'en') + ')');
      o.value = p[2];
      sel.appendChild(o);
    });
    sel.value = filtro[campo];
    sel.addEventListener('change', function () { filtro[campo] = sel.value; shown = PAGE; render(); });
    return sel;
  }

  function pintarFacetas() {
    if (!facetBox) return;
    var cuenta = { lang: {}, mat: {}, era: {}, src: {} };
    all.forEach(function (b) {
      cuenta.lang[b.lang] = (cuenta.lang[b.lang] || 0) + 1;
      cuenta.mat[b.mat] = (cuenta.mat[b.mat] || 0) + 1;
      cuenta.era[b.era] = (cuenta.era[b.era] || 0) + 1;
      cuenta.src[b.src] = (cuenta.src[b.src] || 0) + 1;
    });
    var orden = function (o) {
      return Object.keys(o).map(function (k) { return [k, o[k]]; }).sort(function (a, b) { return b[1] - a[1]; });
    };
    facetBox.textContent = '';
    facetBox.appendChild(opciones('lang', L.lang, orden(cuenta.lang).map(function (p) { return [LANGNAME[p[0]] || p[0].toUpperCase(), p[1], p[0]]; })));
    facetBox.appendChild(opciones('mat', L.mat, orden(cuenta.mat).map(function (p) { return [p[0], p[1], p[0]]; })));
    facetBox.appendChild(opciones('era', L.era, orden(cuenta.era).map(function (p) { return [p[0], p[1], p[0]]; })));
    facetBox.appendChild(opciones('src', L.src, orden(cuenta.src).map(function (p) { return [SRCN[p[0]] || p[0], p[1], p[0]]; })));
  }

  function render() {
    var q = fold(input.value.trim());
    var hits = all.filter(function (b) {
      if (filtro.kind !== 'all' && b.kind !== filtro.kind) return false;
      if (filtro.lang && b.lang !== filtro.lang) return false;
      if (filtro.mat && b.mat !== filtro.mat) return false;
      if (filtro.era && b.era !== filtro.era) return false;
      if (filtro.src && b.src !== filtro.src) return false;
      return !q || b.key.indexOf(q) !== -1;
    });
    pintarFacetas();
    list.textContent = '';
    var frag = document.createDocumentFragment();
    hits.slice(0, shown).forEach(function (b) { frag.appendChild(row(b)); });
    list.appendChild(frag);
    status.textContent = hits.length ? (hits.length === 1 ? L.countOne : fmt(L.count, { n: hits.length.toLocaleString(ES ? 'es' : 'en') })) : fmt(L.none, { q: input.value.trim() });
    var rest = hits.length - shown;
    moreBtn.hidden = rest <= 0;
    if (rest > 0) moreBtn.textContent = fmt(L.more, { n: Math.min(rest, PAGE) });
    // El resto del fondo se ofrece cuando ya hay algo en pantalla, no antes.
    var ya = root.querySelector('.lib-fondo');
    if (fondoPendiente > 0 && !restoPedido && !ya) {
      ya = el('button', 'lib-more lib-fondo', fmt(L.fondo, { n: fondoPendiente.toLocaleString(ES ? 'es' : 'en') }));
      ya.addEventListener('click', function () { pedirResto(ya); });
      moreBtn.parentNode.insertBefore(ya, moreBtn.nextSibling);
    }
  }

  function pedirResto(btn) {
    if (restoPedido) return;
    restoPedido = true;
    btn.disabled = true;
    btn.textContent = L.loading;
    fetch(base + 'assets/muestra/catalogo-completo.json')
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (c) {
        all = all.concat((c.pg || []).map(desdePg)).sort(function (a, b) { return a.key < b.key ? -1 : 1; });
        fondoPendiente = 0;
        btn.parentNode.removeChild(btn);
        render();
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = fmt(L.fondo, { n: fondoPendiente.toLocaleString(ES ? 'es' : 'en') });
        restoPedido = false;
      });
  }

  // [id, título, autor, idioma, clase LoCC, año] de Gutenberg → fila de la lista.
  function desdePg(w) {
    return {
      id: 'pg:' + w[0], kind: 'lit', title: w[1], author: w[2], lang: w[3] || 'en', mat: materia(w[4]),
      year: w[5], era: epoca(w[5]), src: 'pg', format: 'epub',
      license: ES ? 'Dominio público en España' : 'Public domain in Spain',
      home: 'https://www.gutenberg.org/ebooks/' + w[0], sourceName: 'Project Gutenberg',
    };
  }

  Promise.all([
    fetch(base + 'assets/muestra/catalogo.json').then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }),
    fetch(base + 'assets/muestra/catalogo-es.json').then(function (r) { return r.ok ? r.json() : { pg: [], el: [] }; }).catch(function () { return { pg: [], el: [] }; }),
  ])
    .then(function (res) {
      var c = res[0];
      var curada = res[1];
      var tec = c.tecnicos.map(function (b) {
        return { id: 'tec:' + b.id, kind: 'tec', title: b.title, author: b.author, lang: b.lang, format: b.format, license: b.license, home: b.home, src: 'tec', mat: ES ? 'Técnico' : 'Technical', era: L.sindato, year: null, sourceName: new URL(b.home).hostname.replace(/^www\./, '') };
      });
      var se = c.se.map(function (b) {
        return { id: 'se:' + b.p, kind: 'lit', title: b.t, author: b.a, lang: 'en', format: 'epub', license: ES ? 'Dominio público en EE. UU.' : 'Public domain in the US', home: 'https://standardebooks.org/ebooks/' + b.p, src: 'se', mat: ES ? 'Literatura' : 'Literature', era: L.sindato, year: null, sourceName: 'Standard Ebooks' };
      });
      // Ediciones de la misma obra (`work` en tecnicos.json) en una sola fila, en el sitio de la
      // primera: el botón abre la del idioma de la página y las demás salen como «También en…».
      var lang = ES ? 'es' : 'en';
      var obras = {};
      c.tecnicos.forEach(function (raw, i) { if (raw.work) (obras[raw.work] = obras[raw.work] || []).push(tec[i]); });
      var filas = [];
      c.tecnicos.forEach(function (raw, i) {
        var w = raw.work;
        if (!w) { filas.push(tec[i]); return; }
        if (obras[w] === null) return; // obra ya puesta
        var eds = obras[w].slice().sort(function (x, y) { return (y.lang === lang) - (x.lang === lang); });
        var fila = {};
        for (var k in eds[0]) fila[k] = eds[0][k];
        fila.alt = eds.slice(1);
        filas.push(fila);
        obras[w] = null;
      });
      var pgEs = (curada.pg || []).map(desdePg);
      var el_ = (curada.el || []).map(function (w) {
        return {
          id: 'el:' + w[0], kind: 'lit', title: w[1], author: w[2], lang: 'es', mat: materia(w[3]),
          year: w[4], era: epoca(w[4]), src: 'el', format: 'epub',
          license: ES ? 'Dominio público o licencia abierta' : 'Public domain or open licence',
          home: 'https://www.elejandria.com/libro/' + w[0], sourceName: 'Elejandría',
        };
      });
      // Los técnicos primero: son pocos y en la lista larga de clásicos se perderían.
      all = filas.concat(se, pgEs, el_);
      all.forEach(function (b) { b.key = fold(b.title + ' ' + b.author); });
      // Cuántas obras quedan fuera de lo cargado, según el índice de ids del catálogo.
      var cargados = {};
      all.forEach(function (b) { if (b.id.indexOf('pg:') === 0) cargados[b.id.slice(3)] = 1; });
      fondoPendiente = (c.pgIds || []).filter(function (n) { return !cargados[String(n)]; }).length;
      root.classList.add('is-ready');
      render();
    })
    .catch(function () { status.textContent = L.err; });

  var timer;
  input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { shown = PAGE; render(); }, 120); });
  moreBtn.addEventListener('click', function () { shown += PAGE; render(); });
  filterBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      filtro.kind = btn.getAttribute('data-filter');
      filterBtns.forEach(function (b) { b.setAttribute('aria-pressed', String(b === btn)); });
      shown = PAGE;
      render();
    });
  });
})();
