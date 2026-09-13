// EV5 · PRESUPUESTOS de calidad del agente — la valla del bucle de evals.
//
// Mismo contrato que los presupuestos de `tests/perf.spec.ts`: son una VALLA contra
// regresiones, NO un objetivo. Cada número sale de runs REALES (van citados en `de:`);
// ninguno es aspiracional. Se suben solo DESPUÉS de verificar una mejora, nunca antes.
//
// Por qué existe, si ya hay gates en check.mjs: los gates cubren lo binario (¿hay ancla?
// ¿es válida?). Esto cubre lo GRADUAL —las notas del juez y los contadores— que hasta ahora
// solo se comparaba "contra el run anterior", y los runs están gitignored. Aquí queda
// versionado: la valla sobrevive a la máquina donde se corrió el run.
//
// CÓMO SE FIJA CADA NÚMERO
//   valla = (mínimo observado en runs COMPARABLES) − margen
//   · Comparables = mismo modelo principal (`deepseek-v4-flash`) y run COMPLETO. Se excluyen
//     los runs de otros modelos (ev3-mimo), los smoke y los anteriores a un arreglo que
//     cambió esa métrica (p. ej. f2 para el mindmap de P2/P3: era DNF por el bug).
//   · Margen del juez en escala 1-5 promediada (cards.*, chat.*): −0.3. El mínimo entre runs
//     ya absorbe parte del ruido (±0.4-0.5 entre pasadas sobre el MISMO artefacto); el margen
//     cubre el resto sin dejar la valla inservible.
//   · Margen de criterios ENTEROS (summary.*, mindmap.*: un solo artefacto, el juez da 1-5
//     sin promediar): −1. Con esa granularidad, medio punto no existe.
//   · Deterministas (contadores, Δ atenuación): margen holgado a ojo, son estables.
//
// QUÉ NO LLEVA VALLA (la decisión que hace esto útil, ver docs/EVALS.md)
//   · Cobertura dorada: osciló 5/8 → 4/8 → 2/8 con el MISMO prompt. Es tendencia, no señal;
//     ponerle gate sería medir una moneda al aire. **Revisar tras arreglar el cupo de su
//     llamada** (2026-09-13): parte de ese "ruido" era JSON truncado que salía como 0 en
//     silencio, así que el criterio puede volverse fiable y merecerse una valla.
//   · Nada que ya sea un gate de check.mjs (no se duplica).
//   · Métricas con un solo run de respaldo, salvo que se anote explícitamente como tal.

export const BUDGETS = {
  'p1-estudiante': {
    'cards.fidelidad': { min: 4.2, de: 'f2 4.50 · post-mejoras 4.58' },
    'cards.atomicidad': { min: 4.4, de: 'f2 4.67 · post-mejoras 5.00' },
    'cards.utilidad': { min: 4.6, de: 'f2 4.92 · post-mejoras 5.00' },
    'summary.fidelidad': { min: 4, de: 'f2 5 · post-mejoras 5' },
    // El foso del producto. f2 dio 4 y post-mejoras 5: la valla va sobre el peor de los dos
    // (una valla no se pone en el mejor día).
    'summary.pertinencia_citas': { min: 3, de: 'f2 4 · post-mejoras 5' },
    'chat.fundamento': { min: 4.3, de: 'f2 4.67' },
    'chat.honestidad': { min: 4.5, de: 'f2 5.00 — es la afirmación de producto' },
    'mindmap.no_invencion': { min: 4, de: 'f2 5' },
    attenuation_separation: { min: 0.1, de: 'f2 +0.23' },
  },

  'p2-tecnico': {
    // El libro grande. 15 tarjetas para Pro Git entero daban 1/8 de cobertura; IA8 lo subió
    // a 30. Si el reparto vuelve a bajar, la cobertura se hunde detrás sin avisar.
    cards_total: { min: 25, de: 'verif-prio 30 (f2: 15, pre-IA8)' },
    'cards.fidelidad': { min: 4.1, de: 'f2 4.42 · verif-prio 5.00' },
    'cards.atomicidad': { min: 4.0, de: 'f2 4.33 · verif-prio 5.00' },
    'cards.utilidad': { min: 4.7, de: 'f2 5.00 · verif-prio 5.00' },
    'summary.fidelidad': { min: 3, de: 'f2 4 · verif-prio 4' },
    'summary.pertinencia_citas': { min: 2, de: 'f2 4 · verif-prio 3' },
    'chat.fundamento': { min: 4.0, de: 'f2 5.00 · verif-prio 4.33' },
    'chat.honestidad': { min: 4.5, de: 'f2 5.00 · verif-prio 5.00' },
    // Era DNF a los 7 min en f2 (bug, no calidad). El gate de check.mjs solo exige ≥2, que un
    // mapa inservible cumple. Ojo con el baseline: las 8 ramas de verif-prio eran el ÍNDICE
    // copiado (7 de 8 eran títulos de capítulo verbatim); desde P14 F7 el mapa organiza por
    // objetivo y salen 5-6 ramas con 0 capítulos. La valla mide el suelo nuevo, no el viejo.
    mindmap_branches: { min: 5, de: 'verif-prio 8 (pre-P14 F7) · 2026-09-13 6' },
    attenuation_separation: { min: 0.4, de: 'f2 +0.65 · verif-prio +0.59' },
  },

  'p3-opositor': {
    'cards.fidelidad': { min: 4.2, de: 'f2 4.58 · verif-prio 4.50' },
    'cards.atomicidad': { min: 3.9, de: 'f2 5.00 · verif-prio 4.25' },
    'cards.utilidad': { min: 4.5, de: 'f2 5.00 · verif-prio 4.83' },
    // El 5/5 de verif-prio (post-PDF6) NO se reprodujo: f2 dio 3/3 y el run 2026-09-13
    // también. Era el outlier, no el nuevo suelo — justo el riesgo que la valla anotaba al
    // ponerse en 4 "hasta que un segundo run lo confirme". Baja a lo observado dos de tres
    // veces. Lección barata: una mejora de UN run no es un suelo.
    'summary.fidelidad': { min: 2, de: 'f2 3 · verif-prio 5 · 2026-09-13 3' },
    'summary.pertinencia_citas': { min: 2, de: 'f2 3 · verif-prio 5 · 2026-09-13 3' },
    'chat.fundamento': { min: 4.3, de: 'f2 4.67 · verif-prio 4.67' },
    'chat.honestidad': { min: 4.5, de: 'f2 5.00 · verif-prio 5.00' },
    mindmap_branches: { min: 5, de: 'verif-prio 8 (pre-P14 F7) · 2026-09-13 6' },
    // En PDF la atenuación depende del fallback a `tocLabels`; sin TOC real queda null
    // legítimamente y nunca ha dado un número. Opcional hasta que lo dé.
    attenuation_separation: { min: 0, de: 'null en f2 y verif-prio', opcional: true },
  },

  'p4-noficcion': {
    // Literatura, el caso duro: notas bajas por naturaleza de la obra, no por regresión.
    'cards.fidelidad': { min: 3.5, de: 'f2 3.83 · post-mejoras 3.83' },
    'cards.atomicidad': { min: 4.2, de: 'f2 4.50 · post-mejoras 4.50' },
    'cards.utilidad': { min: 3.9, de: 'f2 4.58 · post-mejoras 4.25' },
    'summary.fidelidad': { min: 3, de: 'f2 4 · post-mejoras 4' },
    // Plana en ~3 durante 4 runs y ya CLASIFICADA: es retrieval (el aparato crítico entra en
    // el muestreo), no prompt. La valla solo vigila que no empeore mientras IA5 F2 no la toque.
    'summary.pertinencia_citas': { min: 2, de: 'f2 3 · post-mejoras 4' },
    'chat.fundamento': { min: 4.5, de: 'f2 5.00' },
    'chat.honestidad': { min: 4.5, de: 'f2 5.00' },
    attenuation_separation: { min: 0.1, de: 'f2 +0.37' },
  },
};

// Resuelve una métrica del presupuesto contra el run: `cards.*` → judge.cards_avg ·
// `summary.*` → judge.summary · `chat.*` → judge.chat_avg · `mindmap.*` → judge.mindmap ·
// el resto → checks.<clave>.
export function metricValue(name, checks, judge) {
  const [ns, key] = name.includes('.') ? name.split('.') : [null, name];
  if (!ns) return checks?.[key];
  const bag = { cards: judge?.cards_avg, summary: judge?.summary, chat: judge?.chat_avg, mindmap: judge?.mindmap }[ns];
  return bag?.[key];
}

// Métricas que solo existen desde F2 (chat, mindmap y atenuación). En un run v1 —el modo
// smoke y los runs históricos— faltan LEGÍTIMAMENTE: su presupuesto no aplica, y tratarlas
// como "sin dato" llenaría de rojos falsos runs que están bien.
const SOLO_V2 = m => /^(chat|mindmap)\./.test(m) || m === 'mindmap_branches' || m === 'attenuation_separation';

// Evalúa los presupuestos de una batería. Cada fila: {metric, tipo, limite, valor, estado}.
// estado ∈ 'ok' | 'roto' | 'sin dato'.
//
// "sin dato" cuenta como ROTO salvo `opcional: true`. Es deliberado: el arnés de evals no
// corre en `npm test` y se pudre sin avisar (pasó con EV1 y la pestaña Studio, meses sin que
// nadie se enterara). Una métrica que desaparece del run vaciaría su valla en silencio, que
// es la peor forma de fallar: verde por ausencia.
export function evalBudgets(batteryId, checks, judge, evalVersion = 2) {
  const spec = BUDGETS[batteryId];
  if (!spec) return [];
  return Object.entries(spec).filter(([metric]) => evalVersion >= 2 || !SOLO_V2(metric)).map(([metric, b]) => {
    const tipo = 'max' in b ? 'max' : 'min';
    const limite = b[tipo];
    const valor = metricValue(metric, checks, judge);
    let estado;
    if (valor == null || !Number.isFinite(valor)) estado = b.opcional ? 'ok' : 'sin dato';
    else estado = (tipo === 'min' ? valor >= limite : valor <= limite) ? 'ok' : 'roto';
    return { metric, tipo, limite, valor, estado, de: b.de };
  });
}
