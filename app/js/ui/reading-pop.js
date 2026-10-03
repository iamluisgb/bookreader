// Ajustes de lectura en «Aa» (auditoría de la cabecera, F2): popover anclado bajo el botón en
// escritorio, hoja inferior en móvil. Va SOBRE la página, sin velo ni empuje: el cambio de
// letra o de tema se ve en el texto real mientras se ajusta.
//
// Solo abre y cierra. Los controles de dentro (#tab-settings) los cablea app.js por id, igual
// que cuando eran una pestaña del índice, y updateFormatScopedUI() sigue ocultando los grupos
// que no aplican al formato abierto.
const MOBILE = '(max-width: 767px)';

export function isReadingPopOpen() {
  return !document.getElementById('reading-pop')?.hidden;
}

export function initReadingPop() {
  const pop = document.getElementById('reading-pop');
  const btn = document.getElementById('reading-settings');
  if (!pop || !btn) return;

  const place = () => {
    if (window.matchMedia(MOBILE).matches) { pop.style.top = pop.style.right = ''; return; }
    const r = btn.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 6)}px`;
    pop.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  };
  const onOutside = (e) => {
    if (!pop.contains(e.target) && !btn.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { close(); btn.focus(); }
  };
  function open() {
    pop.hidden = false;
    place();
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    pop.querySelector('button, input, select')?.focus({ preventScroll: true });
  }
  function close() {
    if (pop.hidden) return;
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', place);
  }

  btn.addEventListener('click', () => (pop.hidden ? open() : close()));
  pop.querySelector('.reading-pop-x')?.addEventListener('click', () => { close(); btn.focus(); });
  // Al volver a la biblioteca la cabecera desaparece: el popover no se queda huérfano.
  new MutationObserver(() => { if (!document.body.classList.contains('reading')) close(); })
    .observe(document.body, { attributes: true, attributeFilter: ['class'] });
}
