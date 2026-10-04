// Redirige a la app conservando el fragmento (#d=<id>.<clave>): replace(), así el enlace con
// la clave no se queda como entrada del historial.
(function () {
  var to = '/app/' + location.hash;
  try { location.replace(to); } catch (e) { location.href = to; }
  document.addEventListener('DOMContentLoaded', function () {
    var a = document.getElementById('go');
    if (a) a.href = to;
  });
})();
