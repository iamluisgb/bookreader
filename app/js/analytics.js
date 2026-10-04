// Umami Analytics (sin cookies): solo carga en producción. El tracker se sirve desde la raíz
// del dominio (`/u/s.js`, versionado en este repo — ver `u/s.js`) porque la CSP de la app
// (`script-src 'self'`) no deja cargarlo de otro origen. Reporta a cloud.umami.is.
// En localhost/tests no hay ni petición. Sin el fragmento de la URL (ver abajo). Va en fichero aparte porque la CSP de la app
// prohíbe scripts inline; /u/s.js pasa por script-src 'self' y el beacon por connect-src https:.
(function () {
  if (location.hostname !== 'bookreader.raiatech.com') return;
  var u = document.createElement('script');
  u.defer = true;
  u.src = '/u/s.js';
  u.setAttribute('data-website-id', '08c1619b-4bb8-471b-9dc9-9b6cda88e8ae');
  u.setAttribute('data-host-url', 'https://cloud.umami.is');
  // NUNCA el fragmento: ahí van la CLAVE de un enlace compartido (#d=<id>.<clave>, que es lo
  // que garantiza que nadie más pueda leerlo, ADR-053), el token de la demo (#demo=) y el
  // libro que se lee (#book=). Sin esto Umami los enviaba a un tercero con cada página vista.
  u.setAttribute('data-exclude-hash', 'true');
  document.head.appendChild(u);
})();
