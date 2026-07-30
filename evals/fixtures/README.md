# Fixtures de evals — fuentes y licencias

Libros reales, uno por persona (ver [`docs/EVALS.md`](../../docs/EVALS.md)). No se
versionan (tamaño); se descargan con `node evals/fetch-fixtures.mjs`.

| Fichero | Batería | Obra | Fuente | Licencia |
|---|---|---|---|---|
| `p1-relativity.epub` | P1 estudiante | *Relativity: The Special and General Theory*, A. Einstein | [Gutenberg #30155](https://www.gutenberg.org/ebooks/30155) | Dominio público |
| `p2-progit.epub` | P2 lector técnico | *Pro Git 2*, Chacon & Straub | [progit/progit2 releases](https://github.com/progit/progit2/releases) | CC BY-NC-SA 3.0 |
| `p3-constitucion.pdf` | P3 opositor | Constitución Española (consolidada) | [BOE-A-1978-31229](https://www.boe.es/buscar/act.php?id=BOE-A-1978-31229) | Texto legal público (art. 13 LPI: sin derechos de autor) |
| `../../tests/test.epub` | P4 no-ficción/literatura | *Pedro Páramo* (fixture histórico del repo) | ya versionado | fixture de test |

El golden de retrieval de IA7 ([`tests/retrieval-hyde.spec.ts`](../../tests/retrieval-hyde.spec.ts))
usa **DDIA** (*Designing Data-Intensive Applications*), que **no** se puede descargar aquí: tiene
copyright. Sus preguntas y sus `targets` son específicos de ese libro, así que no vale sustituirlo
por otro. Deja el PDF en `evals/fixtures/ddia.pdf` (esta carpeta está gitignored) o apunta a él con
`GOLDEN_BOOK=/ruta/al.pdf`. Si falta, el golden se salta **avisando por consola** — un skip mudo en
mitad de un run largo pasa desapercibido y ese test es la única prueba del retrieval cross-lingüe.

Criterios de elección: licencia que permite redistribuir/usar, tamaño razonable,
estructura de capítulos real, y mezcla de idiomas (P1/P2 EN, P3/P4 ES) para cubrir
el caso cross-lingüe de IA7.
