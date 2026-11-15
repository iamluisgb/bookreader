// help-link.js — Un solo sitio sabe cómo se llama la ayuda en cada lengua.
// La ayuda completa vive fuera de la app (/help/ en EN, /es/ayuda/ en ES, mismo
// árbol de URLs); aquí está el prefijo y el arma Enlaces contextuales: la guía
// rápida, los ajustes y los avisos de error enlazan a la página que resuelve el
// problema en vez de dejar al usuario en la portada.
//
// REGLA F5 ampliada: todo path que entra aquí tiene que existir en los dos
// builds; scripts/build-help.mjs valida los paths contra los sitemaps al
// construir, así un renombre de página rompe el build, no la ayuda.

import { getLang } from '../i18n.js';

const prefix = () => (getLang() === 'es' ? '/es/ayuda/' : '/help/');

/** URL absoluta-en-sitio a una página de la ayuda ('' = portada). */
export function helpUrl(path = '') {
  return prefix() + path;
}

/** Atributos comunes para abrir la ayuda sin perder la lectura. */
export const helpAttrs = 'target="_blank" rel="noopener"';
