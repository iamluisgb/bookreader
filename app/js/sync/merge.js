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
  if (a.deleted !== b.deleted) return a.deleted ? a : b;
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
