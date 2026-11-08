// Idioma y tema de las páginas públicas (portada, manifiesto, blog, privacidad, Anki).
// Se carga en el <head> SIN defer: tiene que fijar el tema antes de pintar, o la página
// parpadea en el tema del sistema y luego cambia.
//
// Idioma. La preferencia vive en `bookreader_lang` ('en'|'es'), la misma clave que la app
// (app/js/i18n.js). Cualquier enlace de cambio de idioma lleva ?lang=xx y aquí se guarda: así
// elegir English en el blog no se pierde al volver a la portada (la raíz redirige a /es/
// según esta clave).
//
// Tema. El mismo ajuste que la app (`bookreader_settings`.theme: system|light|sepia|dark),
// para que lo elegido en un sitio valga en el otro. Las páginas públicas no tienen sepia:
// se ven en claro. El selector del pie (.theme-pick) escribe en la misma clave.
(function () {
  var root = document.documentElement;
  var KEY = 'bookreader_settings';
  var BAR = { light: '#ffffff', dark: '#121214' };

  try {
    var q = new URLSearchParams(location.search).get('lang');
    if (q === 'en' || q === 'es') localStorage.setItem('bookreader_lang', q);
  } catch (e) { /* sin storage: el idioma lo da la URL */ }

  function saved() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || '{}');
      return s && typeof s === 'object' ? s : {};
    } catch (e) { return {}; }
  }

  function choice() {
    var t = saved().theme;
    return t === 'dark' ? 'dark' : (t === 'light' || t === 'sepia') ? 'light' : 'system';
  }

  function apply(c) {
    if (c === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', c);
    // Barra del navegador: dos <meta theme-color> con media (claro/oscuro). Con un tema fijado,
    // las dos dicen lo mismo; en automático, cada una el suyo.
    var metas = document.querySelectorAll('meta[name="theme-color"][media]');
    for (var i = 0; i < metas.length; i++) {
      var dark = /dark/.test(metas[i].getAttribute('media'));
      metas[i].setAttribute('content', c === 'system' ? (dark ? BAR.dark : BAR.light) : BAR[c]);
    }
  }

  function mark() {
    var c = choice();
    var btns = document.querySelectorAll('.theme-pick [data-pick]');
    for (var i = 0; i < btns.length; i++) btns[i].setAttribute('aria-pressed', String(btns[i].getAttribute('data-pick') === c));
  }

  apply(choice());

  document.addEventListener('DOMContentLoaded', function () {
    // Las <meta theme-color> van después de este script en el <head>: al ejecutarse arriba aún
    // no existían. El atributo del tema sí se fijó a tiempo; la barra se ajusta ahora.
    apply(choice());
    mark();
    var btns = document.querySelectorAll('.theme-pick [data-pick]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () {
        var c = this.getAttribute('data-pick');
        var s = saved();
        s.theme = c;
        try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* sin storage: solo esta visita */ }
        apply(c);
        mark();
        try { if (window.umami && window.umami.track) window.umami.track('Theme', { to: c }); } catch (e) { /* sin analítica */ }
      });
    }
  });
})();
