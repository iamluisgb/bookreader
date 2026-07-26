// Merge de colecciones del sync (SYNC_PLAN.md · "Estrategia de merge").
//
// Reglas, en orden:
//   1. Unión por `uid`: un item que solo existe en un lado, se queda.
//   2. Mismo `uid` en ambos lados → gana el `updatedAt` mayor (LWW por item).
//   3. Tombstones (`deleted`) participan igual: un borrado más reciente que la
//      última edición se propaga; una edición posterior al borrado lo resucita.
//   4. Empate exacto de `updatedAt` → gana el borrado (determinista: ambos
//      dispositivos llegan al mismo resultado comparando los mismos items).
//
// El merge es conmutativo e idempotente: A⊕B == B⊕A y A⊕A == A. Sincronizar
// dos veces no cambia nada. Items sin `uid` (no deberían existir tras la
// migración de Fase 0) se conservan del lado local, nunca se descartan.

function pickNewer(a, b) {
  const au = a.updatedAt || 0;
  const bu = b.updatedAt || 0;
  if (au !== bu) return au > bu ? a : b;
  // `deleted` se normaliza: undefined y false son el mismo estado. Sin el !!, un
  // item con `deleted: undefined` y otro con `deleted: false` se consideraban
  // distintos y el desempate dejaba de ser conmutativo (A⊕B ≠ B⊕A).
  const ad = !!a.deleted;
  const bd = !!b.deleted;
  if (ad !== bd) return ad ? a : b;
  return a;
}

export function mergeCollections(local = [], remote = []) {
  const localByUid = new Map();
  for (const it of local) if (it && it.uid) localByUid.set(it.uid, it);

  const out = [];
  const matched = new Set();
  for (const r of remote || []) {
    if (!r || !r.uid) continue; // remoto sin uid: pre-Fase 0, lo ignora el merge
    const l = localByUid.get(r.uid);
    if (l) {
      matched.add(r.uid);
      out.push(pickNewer(l, r));
    } else {
      out.push(r);
    }
  }
  for (const l of local || []) {
    if (!l) continue;
    if (!l.uid || !matched.has(l.uid)) out.push(l);
  }
  return out;
}

// Merge de MAPAS por clave (la biblioteca: libros y estanterías). Misma regla
// que mergeCollections, pero la identidad es la clave del objeto en vez de un
// campo `uid`.
//
// `monotone` son campos que, una vez conocidos, NO se pierden porque el otro
// lado gane el LWW. Dos casos reales:
//   - `blob`: que algún dispositivo haya subido el fichero a Drive es un HECHO,
//     no una opinión. Sin esto, el dispositivo que solo cambió el progreso (y
//     por tanto gana el updatedAt) borraría el puntero al binario y el resto
//     dejaría de poder descargarlo.
//   - `title`/`author`/`format`: solo los conoce quien importó el fichero. Un
//     dispositivo que recibió el libro como ficha fantasma no debe pisarlos con
//     null al tocar su progreso (mismo criterio que el "título pegajoso" del
//     engine).
// En un registro con tombstone no se rescata nada: borrado es borrado.
export function mergeMaps(local = {}, remote = {}, { monotone = [] } = {}) {
  const out = {};
  for (const id of new Set([...Object.keys(local || {}), ...Object.keys(remote || {})])) {
    const l = (local || {})[id];
    const r = (remote || {})[id];
    if (!l || !r) {
      out[id] = l || r;
      continue;
    }
    const win = pickNewer(l, r);
    const lose = win === l ? r : l;
    const rec = { ...win };
    if (!rec.deleted) {
      for (const f of monotone) {
        if ((rec[f] === undefined || rec[f] === null || rec[f] === '') && lose[f] != null && lose[f] !== '') {
          rec[f] = lose[f];
        }
      }
    }
    out[id] = rec;
  }
  return out;
}
