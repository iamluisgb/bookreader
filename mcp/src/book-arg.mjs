// book-arg.mjs — el libro de una tool, por `bookId` o por título, y el plegado de texto (sin
// tildes ni mayúsculas) con el que se compara. Aparte de tools.mjs para que las tools de
// escritura y de texto lo usen sin un ciclo de imports.

import { ToolError } from './errors.mjs';

export function fold(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

// El libro, por `bookId` o por `book` (título o parte, sin tildes ni mayúsculas). Así «los
// subrayados de Pedro Páramo» funciona sin pasar antes por list_books. Si el título casa con
// varios, error con los candidatos: mejor que el modelo pregunte que adivinar.
export async function resolveBookArg(source, args) {
  const id = typeof args.bookId === 'string' ? args.bookId.trim() : '';
  if (id) return id;
  const q = typeof args.book === 'string' ? fold(args.book.trim()) : '';
  if (!q) throw new ToolError('Falta el libro: pasa «bookId» (de list_books) o «book» (su título).');
  const titles = await source.titles();
  const entries = Object.entries(titles).filter(([, t]) => t);
  const exact = entries.filter(([, t]) => fold(t) === q);
  const hits = exact.length ? exact : entries.filter(([, t]) => fold(t).includes(q));
  if (hits.length === 1) return hits[0][0];
  const list = (hits.length ? hits : entries).slice(0, 15).map(([bid, t]) => `${t} (${bid})`).join('; ');
  throw new ToolError(hits.length
    ? `«${args.book}» casa con varios libros: ${list}. Repite con su bookId.`
    : `Ningún libro se llama «${args.book}». Hay: ${list || 'ninguno con título'}.`);
}

// Igual, para las tools donde el libro es un filtro opcional: sin `bookId` ni `book`, null.
export async function optionalBookArg(source, args) {
  const given = (k) => typeof args[k] === 'string' && args[k].trim();
  return given('bookId') || given('book') ? resolveBookArg(source, args) : null;
}
