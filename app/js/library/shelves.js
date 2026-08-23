// Estanterías: reglas (inteligentes), pertenencia y árbol por nombre.
//
// Lógica PURA (sin DOM ni IndexedDB) para poder compartirla entre la vista de
// biblioteca, los ámbitos de repaso y los tests. Tres decisiones que explican
// por qué este módulo existe, y por qué NO hay un `parentId` en el registro de
// estantería:
//
//   1. Una estantería es una ETIQUETA, no una carpeta. `book.shelfIds` es un
//      array: un libro está en varias a la vez. Por eso filtrar es intersecar
//      (AND) o unir (OR) conjuntos, no bajar por un árbol.
//
//   2. La JERARQUÍA se deriva del NOMBRE ("Técnico/ML" cuelga de "Técnico"), no
//      de un puntero al padre. El merge del sync es LWW por registro: con un
//      `parentId`, dos dispositivos moviendo X bajo Y e Y bajo X producen un
//      CICLO al fusionar, y habría que detectarlo y repararlo en cada carga. Con
//      el nombre el ciclo es imposible por construcción (un string no puede ser
//      prefijo propio de sí mismo) y renombrar o mover es una operación de texto
//      que el merge ya sabe fusionar.
//
//   3. Una estantería INTELIGENTE guarda una `rule` y CALCULA sus miembros. La
//      regla solo admite campos SINCRONIZADOS del libro: si mirase
//      `lastOpenedAt` o si el binario está descargado —decisiones locales de
//      cada dispositivo— la misma estantería contendría libros distintos en cada
//      equipo, y el contador del rail no cuadraría entre ellos.
//
// Una regla puede apuntar a otras estanterías (`rule.shelfIds`), que es la forma
// segura de conseguir agrupaciones: al evaluarla se ignoran las que a su vez son
// inteligentes, así que la recursión —y con ella los ciclos— no existe.

export const SEP = '/';

const DAY_MS = 24 * 60 * 60 * 1000;

// Campos admitidos en una regla. Fuera quedan a propósito los locales
// (`lastOpenedAt`, tener el fichero descargado): ver cabecera.
export const RULE_FIELDS = ['status', 'format', 'author', 'title', 'addedWithinDays', 'shelfIds'];

function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// ¿La regla dice algo? Una `rule` vacía (o con todos los campos en blanco) no
// convierte la estantería en inteligente: sería "todos los libros" disfrazado.
export function hasRule(rule) {
  if (!rule || typeof rule !== 'object') return false;
  return RULE_FIELDS.some(f => {
    const v = rule[f];
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'number') return v > 0;
    return typeof v === 'string' && v.trim() !== '';
  });
}

export function isSmart(shelf) {
  return hasRule(shelf && shelf.rule);
}

// Limpia una regla dejando solo campos con contenido, para no guardar ruido en
// el registro (que viaja en el sync y se compara con JSON.stringify).
export function cleanRule(rule) {
  const out = {};
  if (!rule) return out;
  for (const f of RULE_FIELDS) {
    const v = rule[f];
    if (Array.isArray(v)) { if (v.length) out[f] = [...v]; }
    else if (typeof v === 'number') { if (v > 0) out[f] = v; }
    else if (typeof v === 'string' && v.trim()) out[f] = v.trim();
  }
  return out;
}

export function matchesRule(book, rule, now = Date.now()) {
  if (!book || book.deleted) return false;
  const r = rule || {};
  if (r.status && (book.status || 'unread') !== r.status) return false;
  if (r.format && norm(book.format) !== norm(r.format)) return false;
  if (r.author && !norm(book.author).includes(norm(r.author))) return false;
  if (r.title && !norm(book.title).includes(norm(r.title))) return false;
  if (r.addedWithinDays > 0 && (book.addedAt || 0) < now - r.addedWithinDays * DAY_MS) return false;
  if (r.shelfIds && r.shelfIds.length) {
    const ids = book.shelfIds || [];
    if (!r.shelfIds.some(id => ids.includes(id))) return false;
  }
  return true;
}

// Miembros de UNA estantería: los que la llevan en `shelfIds` (manual) o los que
// cumplen la regla (inteligente). Punto único de verdad: lo usan el rail, los
// contadores y los ámbitos de repaso, así que una estantería inteligente
// funciona como ámbito de estudio sin tocar nada más.
export function booksIn(books, shelf, now = Date.now()) {
  if (!shelf) return [];
  if (isSmart(shelf)) {
    const rule = { ...shelf.rule };
    // Una regla solo puede apoyarse en estanterías MANUALES (ver cabecera).
    if (rule.shelfIds) rule.shelfIds = rule.shelfIds.filter(id => id !== shelf.id);
    return (books || []).filter(b => matchesRule(b, rule, now));
  }
  return (books || []).filter(b => (b.shelfIds || []).includes(shelf.id));
}

// ---- Árbol por nombre -------------------------------------------------------

// Segmentos de un nombre: "  Técnico / ML  " → ["Técnico", "ML"]. Un nombre que
// solo tenga separadores se trata como plano (nunca devuelve lista vacía).
export function segments(name) {
  const parts = String(name || '').split(SEP).map(p => p.trim()).filter(Boolean);
  return parts.length ? parts : [String(name || '').trim() || SEP];
}

function nodeSortKey(node) {
  let order = Number.POSITIVE_INFINITY;
  let created = Number.POSITIVE_INFINITY;
  for (const s of node.shelves) {
    if (Number.isFinite(s.order)) order = Math.min(order, s.order);
    created = Math.min(created, s.createdAt || 0);
  }
  for (const c of node.children) {
    const k = nodeSortKey(c);
    order = Math.min(order, k[0]);
    created = Math.min(created, k[1]);
  }
  return [order, created, norm(node.label)];
}

function cmpNodes(a, b) {
  const ka = nodeSortKey(a), kb = nodeSortKey(b);
  return ka[0] - kb[0] || ka[1] - kb[1] || String(ka[2]).localeCompare(String(kb[2]));
}

function cmpShelves(a, b) {
  const oa = Number.isFinite(a.order) ? a.order : Number.POSITIVE_INFINITY;
  const ob = Number.isFinite(b.order) ? b.order : Number.POSITIVE_INFINITY;
  return oa - ob || (a.createdAt || 0) - (b.createdAt || 0) || norm(a.name).localeCompare(norm(b.name));
}

// Construye el árbol de nodos por ruta. Un tramo intermedio que no existe como
// estantería ("Técnico" con solo "Técnico/ML" creada) se materializa como nodo
// GRUPO: se pinta como cabecera y al pulsarlo filtra por todos sus
// descendientes, pero no es una estantería y no se puede renombrar ni borrar.
//
// Dos estanterías con el mismo nombre comparten nodo y se pintan como dos filas:
// el nombre no es una clave, el id sí.
function buildNodes(shelves) {
  const roots = [];
  const byPath = new Map();
  const ensure = (path, label, parent) => {
    let n = byPath.get(path);
    if (!n) {
      n = { path, label, shelves: [], children: [] };
      byPath.set(path, n);
      (parent ? parent.children : roots).push(n);
    }
    return n;
  };
  for (const s of shelves || []) {
    const parts = segments(s.name);
    let parent = null, path = '';
    for (let i = 0; i < parts.length; i++) {
      path = i ? path + SEP + parts[i] : parts[i];
      parent = ensure(path, parts[i], parent);
    }
    parent.shelves.push(s);
  }
  const sortRec = (list) => {
    list.sort(cmpNodes);
    for (const n of list) { n.shelves.sort(cmpShelves); sortRec(n.children); }
  };
  sortRec(roots);
  return roots;
}

// Filas del rail en orden de pintado. Cada fila es o una ESTANTERÍA
// (`shelf`) o un GRUPO (`shelf: null`), y trae `shelfIds` con todo lo que
// cuelga de ella (la propia + descendientes) para poder filtrar y contar.
//
// Además de lo que filtra, cada fila lleva lo que hace falta para PINTAR el
// árbol sin volver a recorrerlo: `path` (su nodo), `ancestors` (las rutas de
// las que cuelga, para saber si alguna está plegada), `hasChildren` (si merece
// un triángulo) y `ownIds` (solo ella, sin descendientes: es a lo que se añade
// un libro al soltarlo encima, y el contador "propio" frente al del subárbol).
export function shelfRows(shelves) {
  const rows = [];
  const walk = (nodes, depth, ancestors) => {
    for (const n of nodes) {
      const all = descendantIds(n);
      const branches = n.children.length > 0;
      if (n.shelves.length) {
        for (const s of n.shelves) {
          // Solo la PRIMERA estantería del nodo arrastra a los descendientes:
          // si hay dos con el mismo nombre, duplicar el subárbol en ambas haría
          // que el mismo libro se contara dos veces en el filtro. Por lo mismo
          // solo ella manda sobre el plegado del nodo.
          const first = s === n.shelves[0];
          rows.push({
            key: s.id, kind: 'shelf', depth, label: n.label, shelf: s,
            shelfIds: first ? all : [s.id], ownIds: [s.id],
            path: n.path, ancestors, hasChildren: branches && first,
          });
        }
      } else {
        rows.push({
          key: 'g:' + n.path, kind: 'group', depth, label: n.label, shelf: null,
          shelfIds: all, ownIds: [],
          path: n.path, ancestors, hasChildren: branches,
        });
      }
      walk(n.children, depth + 1, [...ancestors, n.path]);
    }
  };
  walk(buildNodes(shelves), 0, []);
  return rows;
}

function descendantIds(node) {
  const out = node.shelves.map(s => s.id);
  for (const c of node.children) out.push(...descendantIds(c));
  return out;
}

// ---- Reordenar --------------------------------------------------------------

// Mueve una estantería entre sus HERMANAS (mismo nivel del árbol) y devuelve los
// parches `{ id, order }` a persistir. Reasigna la secuencia entera del nivel en
// vez de intercambiar dos valores: así un nivel que aún no tenía `order` (todas
// ordenadas por fecha de creación) queda numerado de una vez, y no hay empates.
export function reorder(shelves, id, delta) {
  const target = (shelves || []).find(s => s.id === id);
  if (!target) return [];
  const parentOf = (s) => segments(s.name).slice(0, -1).join(SEP);
  const parent = parentOf(target);
  const siblings = shelves.filter(s => parentOf(s) === parent).sort(cmpShelves);
  const i = siblings.findIndex(s => s.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= siblings.length) return [];
  siblings.splice(j, 0, siblings.splice(i, 1)[0]);
  return siblings
    .map((s, idx) => ({ id: s.id, order: idx }))
    .filter(p => {
      const s = siblings.find(x => x.id === p.id);
      return s.order !== p.order;
    });
}
