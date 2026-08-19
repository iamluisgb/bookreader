// css-loader.js — Carga perezosa de hojas de estilo, respetando el orden de la cascada.
//
// agent.css son ~63 KB que solo hacen falta al abrir el panel del agente o los ajustes,
// y hasta ahora iban dentro de main.css, bloqueando el primer pintado de la biblioteca,
// que no usa ni una de sus reglas.
//
// La parte delicada NO es cargarla tarde, es cargarla EN SU SITIO. El orden de las hojas
// lo decide la posición del <link> en el DOM, no cuándo se inserta ni cuándo termina de
// bajar. Por eso index.html reserva un hueco (`#css-slot-agent`) entre main.css y
// main-late.css: ahí es donde estaban estas reglas, y ahí es donde se inserta el <link>.
// Colgarla del final del head cambiaría quién gana los empates de especificidad contra
// la cola genérica (foco, tooltips, responsive).

const cargando = new Map();

// Resuelve cuando la hoja está APLICADA, no solo pedida: quien la espera antes de enseñar
// un panel se ahorra el parpadeo de verlo un frame sin estilar.
export function loadStylesheet(href, { antesDe } = {}) {
  if (cargando.has(href)) return cargando.get(href);

  const p = new Promise((resolve, reject) => {
    // Ya presente (p. ej. un despliegue que la inline en el futuro): nada que hacer.
    if (document.querySelector(`link[rel="stylesheet"][href="${href}"]`)) { resolve(); return; }

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => {
      cargando.delete(href);   // un fallo de red no debe envenenar el intento siguiente
      reject(new Error(`No se pudo cargar ${href}`));
    };

    const ancla = antesDe ? document.getElementById(antesDe) : null;
    if (ancla && ancla.parentNode) ancla.parentNode.insertBefore(link, ancla);
    else document.head.appendChild(link);
  });

  cargando.set(href, p);
  return p;
}

// La hoja del agente y de ajustes generales. Idempotente: la piden los dos módulos que
// la necesitan (ai/panel.js y ui/app-settings.js) y solo se carga una vez.
export function loadAgentCss() {
  return loadStylesheet('css/agent.css', { antesDe: 'css-slot-agent' });
}
