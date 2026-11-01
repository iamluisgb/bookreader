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

// Embudo de activación (ADR-061: «crea su primer mazo y vuelve a repasar la semana
// siguiente»). Los módulos llaman a `window.brTrack(nombre, datos)`; fuera de producción no
// hay tracker y no hace nada. NUNCA datos personales ni del libro: solo formato, origen o
// semanas. Si el tracker aún no ha cargado (va con defer), se reintenta una vez.
window.brTrack = function (name, data) {
  try {
    if (window.umami) { window.umami.track(name, data); return; }
    if (location.hostname !== 'bookreader.raiatech.com') return;
    setTimeout(function () { try { window.umami && window.umami.track(name, data); } catch (e) { /* nada */ } }, 4000);
  } catch (e) { /* la analítica nunca rompe la app */ }
};
// Una vez por dispositivo: el primer mensaje al agente, el primer mazo. `key` va a localStorage.
window.brTrackOnce = function (key, name, data) {
  try {
    if (localStorage.getItem('bookreader_track_' + key)) return;
    localStorage.setItem('bookreader_track_' + key, String(Date.now()));
  } catch (e) { return; }
  window.brTrack(name, data);
};
