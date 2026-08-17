// ui/when.js — Antigüedad de algo, en texto. Pieza compartida: el Studio la usaba en
// privado y la lista de subrayados necesitaba lo mismo.
import { t, getLang } from '../i18n.js';

// Relativo siempre ("hace 3 días", "hace 92 días"). Para historiales cortos y vivos, donde
// lo que importa es "esto es de hace un rato" y no la fecha exacta.
export function ago(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return t('hace un momento');
  if (s < 3600) return t('hace {n} min', { n: Math.round(s / 60) });
  if (s < 86400) return t('hace {n} h', { n: Math.round(s / 3600) });
  const d = Math.round(s / 86400);
  return d === 1 ? t('hace {n} día', { n: d }) : t('hace {n} días', { n: d });
}

// Relativo mientras signifique algo, fecha en cuanto deja de significarlo. Un subrayado de
// hace tres meses no se sitúa mejor con "hace 92 días" que con "14 may": pasada la semana,
// la fecha es más informativa y más corta. El año solo aparece si NO es el actual.
export function whenLabel(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 7 * 86400) return ago(ts);
  const d = new Date(ts);
  const opts = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  try { return d.toLocaleDateString(getLang(), opts); } catch (e) { return d.toLocaleDateString(); }
}

// Fecha y hora completas para el `title`: el texto corto dice "hace 3 h", el tooltip dice
// exactamente cuándo.
export function fullWhen(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString(getLang()); } catch (e) { return new Date(ts).toLocaleString(); }
}
