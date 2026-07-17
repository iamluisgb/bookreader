// Umami Analytics (sin cookies): solo carga en producción — el dominio sirve /u/s.js
// (script self-hosteado en el repo de la web personal, mismo website-id que el resto de
// luisgonzalezbernal.com, segmentado por ruta /bookreader/*) y reporta a cloud.umami.is.
// En localhost/tests no hay ni petición. Va en fichero aparte porque la CSP de la app
// prohíbe scripts inline; /u/s.js pasa por script-src 'self' (same-origin) y el beacon
// por connect-src https:.
(function () {
  if (location.hostname !== 'luisgonzalezbernal.com') return;
  var u = document.createElement('script');
  u.defer = true;
  u.src = '/u/s.js';
  u.setAttribute('data-website-id', '08c1619b-4bb8-471b-9dc9-9b6cda88e8ae');
  u.setAttribute('data-host-url', 'https://cloud.umami.is');
  document.head.appendChild(u);
})();
