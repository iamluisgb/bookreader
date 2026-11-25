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
  // Clasificación de la Library of Congress: la letra es la materia y las dos letras, la subclase
  // (PA = literatura griega y latina, PR = inglesa, PQ = románica…). [español, inglés]
  var MAT = {
    A: ['Obras generales', 'General'], B: ['Filosofía y religión', 'Philosophy and religion'],
    C: ['Ciencias auxiliares', 'Auxiliary history'], D: ['Historia universal', 'World history'],
    E: ['Historia de América', 'History of America'], F: ['América local', 'Local America'],
    G: ['Geografía y viajes', 'Geography and travel'], H: ['Ciencias sociales', 'Social sciences'],
    J: ['Política', 'Politics'], K: ['Derecho', 'Law'], L: ['Educación', 'Education'],
    M: ['Música', 'Music'], N: ['Arte', 'Art'], P: ['Literatura', 'Literature'], Q: ['Ciencia', 'Science'],
    R: ['Medicina', 'Medicine'], S: ['Agricultura', 'Agriculture'], T: ['Tecnología', 'Technology'],
    U: ['Militar', 'Military'], V: ['Naval', 'Naval'], Z: ['Bibliografía', 'Bibliography'],
  };
  var MAT2 = {
    PA: ['Literatura griega y latina', 'Greek and Latin literature'], PB: ['Filología', 'Philology'],
    PC: ['Lenguas románicas', 'Romance languages'], PD: ['Lenguas germánicas', 'Germanic languages'],
    PE: ['Lengua inglesa', 'English language'], PG: ['Lenguas eslavas', 'Slavic languages'],
    PH: ['Lenguas urálicas y otras', 'Uralic and other languages'], PN: ['Crítica literaria', 'Literary criticism'],
    PQ: ['Literatura románica', 'Romance literature'], PR: ['Literatura inglesa', 'English literature'],
    PS: ['Literatura americana', 'American literature'], PT: ['Literatura germánica y nórdica', 'Germanic and Nordic literature'],
    PZ: ['Ficción y juvenil', 'Fiction and juvenile'],
    DA: ['Historia de Europa central', 'Central European history'], DC: ['Historia de Francia', 'French history'],
    DD: ['Historia de Alemania', 'German history'], DE: ['Historia del Mediterráneo', 'Mediterranean history'],
    DG: ['Historia de Roma', 'Roman history'], DS: ['Historia de Asia', 'Asian history'],
    DT: ['Historia de África', 'African history'], DU: ['Historia de Oceanía', 'Oceanian history'],
    F1: ['Historia de EE. UU.', 'US history'], E0: ['Historia de América', 'American history'],
    BX: ['Confesiones cristianas', 'Christian denominations'], BV: ['Teología práctica', 'Practical theology'],
    BS: ['Biblia', 'Bible'], BR: ['Cristianismo', 'Christianity'], BQ: ['Budismo', 'Buddhism'],
    BL: ['Religiones comparadas', 'Comparative religion'], AP: ['Prensa y periódicos', 'Periodicals'],
    QL: ['Zoología', 'Zoology'], QH: ['Biología', 'Biology'], QC: ['Física', 'Physics'],
    QA: ['Matemáticas', 'Mathematics'], QK: ['Botánica', 'Botany'],
  };
  function etiquetaMat(code) {
    if (!code) return L.sinclasif;
    var e = MAT2[code] || MAT[code[0]];
    return e ? e[ES ? 0 : 1] : (ES ? 'Otras materias' : 'Other subjects');
  }
  var SRCN = { se: 'Standard Ebooks', pg: 'Project Gutenberg', el: 'Elejandría', ws: 'Wikisource', tec: ES ? 'Técnico' : 'Technical' };
  var input = root.querySelector('input[type="search"]');
  var list = root.querySelector('.lib-list');
  var status = root.querySelector('.lib-status');
  var moreBtn = root.querySelector('.lib-more');
  var facetBox = root.querySelector('.lib-facets');
  var all = [];
  var filtro = { lang: '', mat: '', era: '', src: '' };
  var orden = '';
  var shown = PAGE;
  var restoPedido = false;
  var reintentado = false;
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
  function materia(c) {
    return etiquetaMat(c);
  }

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

  // Un filtro casa si pasa todos los ejes activos salvo el que se esté contando (`skip`): así el
  // contador de Idioma dice cuántos hay en cada idioma CON lo de Materia y Época ya aplicado, que es
  // lo que espera quien está filtrando. Contar sobre todo el catálogo era mentir con números.
  function casa(b, skip) {
    if (skip !== 'lang' && filtro.lang && b.lang !== filtro.lang) return false;
    if (skip !== 'mat' && filtro.mat && (b.matCode || '').indexOf(filtro.mat) !== 0) return false;
    if (skip !== 'era' && filtro.era && b.era !== filtro.era) return false;
    if (skip !== 'src' && filtro.src && b.src !== filtro.src) return false;
    var q = fold(input.value.trim());
    return !q || b.key.indexOf(q) !== -1;
  }

  function opciones(campo, etiqueta, valores, grupos) {
    var sel = el('select');
    sel.setAttribute('aria-label', etiqueta);
    var vacio = el('option', null, etiqueta);
    vacio.value = '';
    sel.appendChild(vacio);
    if (grupos) {
      // Materia va en dos niveles: la letra agrupa (Literatura) y las subclases filtran (PA).
      grupos.forEach(function (g) {
        var og = el('optgroup');
        og.setAttribute('label', g.etiqueta);
        g.opciones.forEach(function (p) {
          var o = el('option', null, p[0] + ' (' + p[1].toLocaleString(ES ? 'es' : 'en') + ')');
          o.value = p[2];
          og.appendChild(o);
        });
        if (og.children.length) sel.appendChild(og);
      });
    } else {
      valores.forEach(function (p) {
        var o = el('option', null, p[0] + ' (' + p[1].toLocaleString(ES ? 'es' : 'en') + ')');
        o.value = p[2];
        sel.appendChild(o);
      });
    }
    sel.value = filtro[campo];
    sel.addEventListener('change', function () { filtro[campo] = sel.value; shown = PAGE; render(); });
    return sel;
  }

  function pintarFacetas() {
    if (!facetBox) return;
    var cuenta = { lang: {}, mat: {}, era: {}, src: {} };
    var codigos = {};
    all.forEach(function (b) {
      if (casa(b, 'lang')) cuenta.lang[b.lang] = (cuenta.lang[b.lang] || 0) + 1;
      if (casa(b, 'era')) cuenta.era[b.era] = (cuenta.era[b.era] || 0) + 1;
      if (casa(b, 'src')) cuenta.src[b.src] = (cuenta.src[b.src] || 0) + 1;
      if (casa(b, 'mat')) {
        var c = b.matCode || '?';
        codigos[c] = (codigos[c] || 0) + 1;
        cuenta.mat[c[0]] = (cuenta.mat[c[0]] || 0) + 1;
      }
    });
    var orden = function (o) {
      return Object.keys(o).map(function (k) { return [k, o[k]]; }).sort(function (a, b) { return b[1] - a[1]; });
    };
    facetBox.textContent = '';
    facetBox.appendChild(opciones('lang', L.lang, orden(cuenta.lang).map(function (p) { return [LANGNAME[p[0]] || p[0].toUpperCase(), p[1], p[0]]; })));
    // Materia: un grupo por letra (con su total) y dentro, las subclases con obras.
    var grupos = orden(cuenta.mat).map(function (p) {
      var letra = p[0];
      // Solo se listan las subclases que tienen nombre propio y obras: un código suelto sin etiqueta
      // («PL», «P») no le dice nada al lector, y esas obras ya están dentro del total de su materia.
      var dentro = orden(codigos)
        .filter(function (c) { return c[0][0] === letra && c[0].length > 1 && MAT2[c[0]]; })
        .map(function (c) { return [etiquetaMat(c[0]), c[1], c[0]]; });
      var total = [etiquetaMat(letra) + (ES ? ' (toda)' : ' (all)'), p[1], letra];
      return { etiqueta: etiquetaMat(letra), opciones: [total].concat(dentro.length > 1 ? dentro : []) };
    });
    facetBox.appendChild(opciones('mat', L.mat, null, grupos));
    facetBox.appendChild(opciones('era', L.era, orden(cuenta.era).map(function (p) { return [p[0], p[1], p[0]]; })));
    facetBox.appendChild(opciones('src', L.src, orden(cuenta.src).map(function (p) { return [SRCN[p[0]] || p[0], p[1], p[0]]; })));
  }

  // Orden explícito: el de serie (por fuente: técnicos, luego clásicos curados, luego el fondo) no
  // sirve para nada cuando ya has filtrado y quieres, por ejemplo, el más antiguo que haya.
  function ordenar(hits) {
    if (!orden) return hits;
    var c = hits.slice();
    if (orden === 'year') c.sort(function (a, b) { return (a.year || 9999) - (b.year || 9999); });
    else if (orden === 'year-desc') c.sort(function (a, b) { return (b.year || 0) - (a.year || 0); });
    else if (orden === 'author') c.sort(function (a, b) { return String(a.author || '').localeCompare(String(b.author || ''), ES ? 'es' : 'en'); });
    else c.sort(function (a, b) { return String(a.title || '').localeCompare(String(b.title || ''), ES ? 'es' : 'en'); });
    return c;
  }

  function pintarOrden() {
    var tools = root.querySelector('.lib-tools');
    if (!tools || tools.querySelector('.lib-sort')) return;
    var s = el('select', 'lib-sort');
    s.setAttribute('aria-label', ES ? 'Orden' : 'Sort');
    [
      ['', ES ? 'Como viene' : 'Default'],
      ['title', ES ? 'Título (A-Z)' : 'Title (A-Z)'],
      ['author', ES ? 'Autor (A-Z)' : 'Author (A-Z)'],
      ['year', ES ? 'Más antiguos' : 'Oldest first'],
      ['year-desc', ES ? 'Más recientes' : 'Newest first'],
    ].forEach(function (o) {
      var op = el('option', null, o[1]);
      op.value = o[0];
      s.appendChild(op);
    });
    s.addEventListener('change', function () { orden = s.value; shown = PAGE; render(); });
    tools.appendChild(s);
  }

  function render() {
    var hits = ordenar(all.filter(function (b) { return casa(b, null); }));
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
        // Un solo reintento: son 3,5 MB y si el primer intento falla (red móvil, pestaña de fondo)
        // el lector se queda con 4.000 de 48.000 y unos contadores que no cuadran con la página.
        if (!reintentado) {
          reintentado = true;
          setTimeout(function () { if (!restoPedido) pedirResto(btn); }, 4000);
        }
      });
  }

  // [id, título, autor, idioma, clase LoCC, año] de Gutenberg → fila de la lista.
  function desdePg(w) {
    return {
      id: 'pg:' + w[0], kind: 'lit', title: w[1], author: w[2], lang: w[3] || 'en', matCode: w[4] || '', mat: materia(w[4]),
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
        return { id: 'tec:' + b.id, kind: 'tec', title: b.title, author: b.author, lang: b.lang, format: b.format, license: b.license, home: b.home, src: 'tec', matCode: 'T', mat: ES ? 'Técnico' : 'Technical', era: L.sindato, year: null, sourceName: new URL(b.home).hostname.replace(/^www\./, '') };
      });
      var se = c.se.map(function (b) {
        return { id: 'se:' + b.p, kind: 'lit', title: b.t, author: b.a, lang: 'en', format: 'epub', license: ES ? 'Dominio público en EE. UU.' : 'Public domain in the US', home: 'https://standardebooks.org/ebooks/' + b.p, src: 'se', matCode: 'P', mat: ES ? 'Literatura' : 'Literature', era: L.sindato, year: null, sourceName: 'Standard Ebooks' };
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
          id: 'el:' + w[0], kind: 'lit', title: w[1], author: w[2], lang: 'es', matCode: w[3] || '', mat: materia(w[3]),
          year: w[4], era: epoca(w[4]), src: 'el', format: 'epub',
          license: ES ? 'Dominio público o licencia abierta' : 'Public domain or open licence',
          format: w[5] || 'epub', home: 'https://www.elejandria.com/libro/' + w[0], sourceName: 'Elejandría',
        };
      });
      // Obras compuestas desde Wikisource (EPUB generado por nosotros, con su atribución dentro).
      var wiki = (c.wiki || []).map(function (w) {
        var anio = w.authorYear === undefined ? null : w.authorYear;
        return {
          id: 'ws:' + w.id, kind: 'lit', title: w.title, author: w.author, lang: w.lang || 'es',
          matCode: 'P', mat: ES ? 'Literatura' : 'Literature', year: anio, era: epoca(anio), src: 'ws',
          format: w.format || 'epub', license: w.licence || (ES ? 'Dominio público' : 'Public domain'),
          home: w.source, sourceName: 'Wikisource',
        };
      });
      // Los técnicos primero: son pocos y en la lista larga de clásicos se perderían.
      all = filas.concat(se, pgEs, el_, wiki);
      all.forEach(function (b) { b.key = fold(b.title + ' ' + b.author); });
      // Cuántas obras quedan fuera de lo cargado, según el índice de ids del catálogo.
      var cargados = {};
      all.forEach(function (b) { if (b.id.indexOf('pg:') === 0) cargados[b.id.slice(3)] = 1; });
      fondoPendiente = (c.pgIds || []).filter(function (n) { return !cargados[String(n)]; }).length;
      root.classList.add('is-ready');
      pintarOrden();
      render();
      // El fondo se pide solo, en segundo plano: con los contadores por faceta, filtrar sobre 4.000
      // de 48.000 daría números que no cuadran con la promesa de la página. El botón sigue ahí por
      // si el navegador no llega (o el lector prefiere no bajarlo).
      if (fondoPendiente > 0) {
        setTimeout(function () {
          var b = root.querySelector('.lib-fondo');
          if (b && !restoPedido) pedirResto(b);
        }, 1200);
      }
    })
    .catch(function () { status.textContent = L.err; });

  var timer;
  input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { shown = PAGE; render(); }, 120); });
  moreBtn.addEventListener('click', function () { shown += PAGE; render(); });
})();
