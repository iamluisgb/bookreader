// helpers/dataset.mjs — los datos de prueba, en un solo sitio.
//
// De aquí salen los DOS fixtures (el backup y el layout de Drive) que describen la MISMA
// biblioteca. Eso es lo que hace posible el test de paridad: si las dos fuentes no devuelven
// lo mismo sobre datos equivalentes, la «misma superficie de tools» de F2 sería una promesa
// de boquilla.
//
// Las formas son las de verdad, copiadas de los productores:
//   - backup:      app/js/backup.js · buildBackup() — localStorage aplanado + `ai.*`
//   - layout:      app/js/sync/layout.js · buildSnapshot() — manifest + settings + books/<id>.json
//   - reading_days: app/js/reading-log.js · exportDays() — `{ key: '<día>|<deviceId>', day,
//                  deviceId, updatedAt, books: { <id>: { ms, words, units } } }`
//
// Los ids de libro son hex como los de la app (sha256 del fichero, recortados para que el
// fixture se pueda leer a ojo). Los `deviceId` son falsos y están AQUÍ A PROPÓSITO: el test de
// redacción comprueba que ninguno asoma en la salida de ninguna tool.

export const BOOK_1 = {
  id: '01f3a7c9d4b28e56',
  title: 'Diseño de datos intensivos',
};
export const BOOK_2 = {
  id: '7c4d1e9ab0f23a58',
  title: null, // sin metadatos del agente: el caso real de un libro solo subrayado
};

// Identificadores de dispositivo (falsos) que NUNCA deben salir por una tool.
export const DEVICE_IDS = ['dev0a1b2c', 'dev9z8y7w'];

const at = (iso) => Date.parse(iso);

export const CONVO = {
  id: 'c1f0a4b7e2d39415',
  bookId: BOOK_1.id,
  templateId: 't1-extraccion',
  goal: 'Elegir el índice que aguante mi volumen de pedidos',
  createdAt: at('2026-09-20T18:02:00.000Z'),
  lastUsedAt: at('2026-09-22T20:31:00.000Z'),
};

export const HIGHLIGHTS = {
  [BOOK_1.id]: [
    {
      uid: 'epubcfi(/6/14!/4/2/2,/1:0,/1:88)',
      id: 'epubcfi(/6/14!/4/2/2,/1:0,/1:88)',
      cfi: 'epubcfi(/6/14!/4/2/2,/1:0,/1:88)',
      text: 'Un índice de cobertura evita volver a la tabla: la consulta se resuelve solo con el árbol.',
      color: '#ffeb3b',
      chapter: 'Capítulo 3 · Almacenamiento y recuperación',
      note: 'Clave para el listado de pedidos por fecha.',
      timestamp: at('2026-09-20T18:11:00.000Z'),
      updatedAt: at('2026-09-20T18:11:00.000Z'),
    },
    {
      uid: 'epubcfi(/6/30!/4/2/6,/1:0,/1:64)',
      id: 'epubcfi(/6/30!/4/2/6,/1:0,/1:64)',
      cfi: 'epubcfi(/6/30!/4/2/6,/1:0,/1:64)',
      text: 'El consenso no es gratis: cada ronda paga una ida y vuelta de red.',
      color: '#8bc34a',
      chapter: 'Capítulo 9 · Consistencia y consenso',
      note: '',
      timestamp: at('2026-09-21T07:45:00.000Z'),
      updatedAt: at('2026-09-21T07:45:00.000Z'),
    },
    {
      uid: 'u-pdf-42-cobertura',
      id: 'pdf-42-1789895400000-ab12c',
      page: 42,
      rects: [{ x: 40, y: 120, w: 380, h: 44 }], // ruido de pintado: no debe salir por la tool
      text: 'Los registros con clave compuesta se reparten por el prefijo, no por el hash completo.',
      color: '#ff9800',
      chapter: 'Pág. 42',
      note: 'Ojo con el punto caliente de partición.',
      timestamp: at('2026-09-22T08:20:00.000Z'),
      updatedAt: at('2026-09-22T08:20:00.000Z'),
    },
    {
      // Tombstone: el borrado también viaja en el sync, y aquí no debe leerse.
      uid: 'epubcfi(/6/14!/4/2/8,/1:0,/1:40)',
      cfi: 'epubcfi(/6/14!/4/2/8,/1:0,/1:40)',
      text: 'Este subrayado estaba borrado y no debe aparecer en ninguna tool.',
      deleted: true,
      deletedAt: at('2026-09-22T09:00:00.000Z'),
      updatedAt: at('2026-09-22T09:00:00.000Z'),
    },
  ],
  [BOOK_2.id]: [
    {
      uid: 'epubcfi(/6/4!/4/2/2,/1:0,/1:52)',
      id: 'epubcfi(/6/4!/4/2/2,/1:0,/1:52)',
      cfi: 'epubcfi(/6/4!/4/2/2,/1:0,/1:52)',
      text: 'La memoria es una reconstrucción, no un registro fiel.',
      color: '#ffeb3b',
      chapter: 'Capítulo 1 · Ilusión y recuerdo',
      note: 'La ilusión de continuidad.',
      timestamp: at('2026-09-19T21:10:00.000Z'),
      updatedAt: at('2026-09-19T21:10:00.000Z'),
    },
    {
      uid: 'epubcfi(/6/8!/4/2/4,/1:0,/1:60)',
      id: 'epubcfi(/6/8!/4/2/4,/1:0,/1:60)',
      cfi: 'epubcfi(/6/8!/4/2/4,/1:0,/1:60)',
      text: 'Epidemiología y memoria: dos formas de contar lo que le pasa a un pueblo.',
      color: '#8bc34a',
      chapter: 'Capítulo 2 · Contar',
      note: '',
      timestamp: at('2026-09-19T21:25:00.000Z'),
      updatedAt: at('2026-09-19T21:25:00.000Z'),
    },
  ],
};

export const BOOKMARKS = {
  [BOOK_1.id]: [
    {
      uid: 'epubcfi(/6/14!/4/2/2)',
      cfi: 'epubcfi(/6/14!/4/2/2)',
      title: 'Índices de cobertura',
      chapter: 'Capítulo 3',
      page: null,
      timestamp: at('2026-09-21T07:40:00.000Z'),
      updatedAt: at('2026-09-21T07:40:00.000Z'),
    },
  ],
};

export const NOTES = [
  {
    id: 1,
    uid: 'n-1-problema',
    convoId: CONVO.id,
    bookId: BOOK_1.id,
    fieldKey: 'problema_actual',
    content: 'El listado de pedidos por rango de fecha tarda 8 s con 40 M de filas.',
    sourceCfis: [],
    ts: at('2026-09-20T18:12:00.000Z'),
    updatedAt: at('2026-09-20T18:12:00.000Z'),
  },
  {
    id: 2,
    uid: 'n-2-conceptos',
    convoId: CONVO.id,
    fieldKey: 'conceptos_frameworks', // sin `bookId`: se resuelve por la conversación
    content: 'Índice de cobertura · réplica de lectura · partición por prefijo.',
    sourceCfis: ['epubcfi(/6/14!/4/2/2,/1:0,/1:88)'],
    ts: at('2026-09-20T18:30:00.000Z'),
    updatedAt: at('2026-09-20T18:30:00.000Z'),
  },
  {
    id: 3,
    uid: 'n-3-borrada',
    convoId: CONVO.id,
    bookId: BOOK_1.id,
    fieldKey: 'plan_accion',
    content: 'Esta nota se borró y no debe salir.',
    deleted: true,
    deletedAt: at('2026-09-22T09:05:00.000Z'),
    ts: at('2026-09-20T18:40:00.000Z'),
    updatedAt: at('2026-09-22T09:05:00.000Z'),
  },
];

export const MESSAGES = [
  {
    id: 1,
    uid: 'm-1',
    convoId: CONVO.id,
    bookId: BOOK_1.id,
    role: 'user',
    content: '¿Me sirve un índice de cobertura?',
    ts: at('2026-09-20T18:05:00.000Z'),
  },
  {
    id: 2,
    uid: 'm-2',
    convoId: CONVO.id,
    bookId: BOOK_1.id,
    role: 'assistant',
    content: 'Depende del predicado: [[a1]] lo explica en la página 88.',
    ts: at('2026-09-20T18:06:00.000Z'),
  },
];

export const LAST_POSITION = {
  [BOOK_1.id]: { cfi: 'epubcfi(/6/30!/4/2/6)', at: at('2026-09-22T20:30:00.000Z') },
};

/** Registro de lectura: filas por DÍA y DISPOSITIVO, como las exporta reading-log.js. */
export const READING_DAYS = [
  {
    key: '2026-09-20|' + DEVICE_IDS[0],
    day: '2026-09-20',
    deviceId: DEVICE_IDS[0],
    updatedAt: at('2026-09-20T22:00:00.000Z'),
    books: { [BOOK_1.id]: { ms: 1200000, words: 3600, units: 18 } },
  },
  {
    key: '2026-09-21|' + DEVICE_IDS[0],
    day: '2026-09-21',
    deviceId: DEVICE_IDS[0],
    updatedAt: at('2026-09-21T22:00:00.000Z'),
    books: { [BOOK_1.id]: { ms: 1800000, words: 5400, units: 27 } },
  },
  {
    // Mismo día, otro dispositivo: el merge es unión y leer es SUMAR.
    key: '2026-09-21|' + DEVICE_IDS[1],
    day: '2026-09-21',
    deviceId: DEVICE_IDS[1],
    updatedAt: at('2026-09-21T23:30:00.000Z'),
    books: { [BOOK_1.id]: { ms: 600000, words: 1800, units: 9 } },
  },
  {
    key: '2026-09-22|' + DEVICE_IDS[0],
    day: '2026-09-22',
    deviceId: DEVICE_IDS[0],
    updatedAt: at('2026-09-22T22:10:00.000Z'),
    books: {
      [BOOK_1.id]: { ms: 900000, words: 2700, units: 13 },
      [BOOK_2.id]: { ms: 300000, words: 900, units: 5 },
    },
  },
];

/** El backup tal cual lo produce buildBackup(): localStorage aplanado + stores de IA. */
export function buildBackupFixture() {
  return {
    format: 'bookreader-backup',
    version: 1,
    exportedAt: '2026-09-23T06:00:00.000Z',
    localStorage: {
      [`highlights_${BOOK_1.id}`]: HIGHLIGHTS[BOOK_1.id],
      [`highlights_${BOOK_2.id}`]: HIGHLIGHTS[BOOK_2.id],
      [`bookmarks_${BOOK_1.id}`]: BOOKMARKS[BOOK_1.id],
      [`lastPosition_${BOOK_1.id}`]: LAST_POSITION[BOOK_1.id].cfi,
      [`lastPositionAt_${BOOK_1.id}`]: LAST_POSITION[BOOK_1.id].at,
      theme: 'sepia',
      fontScale: 1.15,
      study_streak: { count: 4, lastDay: '2026-09-22' },
    },
    ai: {
      convos: [CONVO],
      messages: MESSAGES,
      notes: NOTES,
      ratings: [],
      books: [{ id: BOOK_1.id, title: BOOK_1.title, addedAt: at('2026-09-20T17:50:00.000Z') }],
    },
  };
}

/**
 * El layout de sync tal cual queda en el proveedor: `books/<id>.json` por libro + manifest +
 * settings. El backup y esto describen la MISMA biblioteca (menos el registro de lectura, que
 * solo está aquí).
 *
 * @returns {Record<string, object>} rutas relativas a la raíz de la carpeta del layout
 */
export function buildLayoutFiles(base = 'bookreader/') {
  const entry = (id) => ({
    local: {
      [`highlights_${id}`]: HIGHLIGHTS[id] || [],
      [`bookmarks_${id}`]: BOOKMARKS[id] || [],
      [`lastPosition_${id}`]: (LAST_POSITION[id] && LAST_POSITION[id].cfi) || null,
      [`lastPositionAt_${id}`]: (LAST_POSITION[id] && LAST_POSITION[id].at) || null,
      [`readingMode_${id}`]: 'paginated',
    },
    convos: id === BOOK_1.id ? [CONVO] : [],
    messages: id === BOOK_1.id ? MESSAGES : [],
    notes: id === BOOK_1.id ? NOTES : [],
    ratings: [],
    // Artefactos del Studio y mazos: están en el layout y NO se exponen en F1/F2 (ni falta):
    // van aquí para que quede claro que el MCP los ignora a propósito.
    artifacts:
      id === BOOK_1.id
        ? [
            {
              key: id + ':summary',
              bookId: id,
              kind: 'summary',
              result: 'resumen del capítulo',
              createdAt: at('2026-09-21T08:00:00.000Z'),
              updatedAt: at('2026-09-21T08:00:00.000Z'),
            },
          ]
        : [],
    decks: [],
    meta: id === BOOK_1.id ? { id, title: BOOK_1.title, addedAt: at('2026-09-20T17:50:00.000Z') } : null,
  });

  const manifest = {
    schemaVersion: 1,
    updatedAt: at('2026-09-22T22:10:00.000Z'),
    settingsUpdatedAt: at('2026-09-22T22:10:00.000Z'),
    books: {
      [BOOK_1.id]: {
        file: `books/${BOOK_1.id}.json`,
        title: BOOK_1.title,
        updatedAt: at('2026-09-22T20:31:00.000Z'),
      },
      [BOOK_2.id]: {
        file: `books/${BOOK_2.id}.json`,
        title: null, // el manifest no lo sabe: el libro se subrayó sin pasar por el agente
        updatedAt: at('2026-09-19T21:25:00.000Z'),
      },
    },
  };

  const settings = {
    theme: 'sepia',
    fontScale: 1.15,
    study_streak: { count: 4, lastDay: '2026-09-22' },
    reading_days: READING_DAYS,
  };

  return {
    [base + 'manifest.json']: manifest,
    [base + 'settings.json']: settings,
    [base + 'books/' + BOOK_1.id + '.json']: entry(BOOK_1.id),
    [base + 'books/' + BOOK_2.id + '.json']: entry(BOOK_2.id),
  };
}
