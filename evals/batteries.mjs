// Baterías de evals (docs/EVALS.md · EV1): una por persona del LAUNCH_PLAN.
// Compartido por el runner (tests/evals.spec.ts) y el juez (evals/judge.mjs).
//
// `goldenConcepts`: los conceptos que un artefacto de estudio DEBE cubrir para esa
// obra+objetivo (la lista dorada de la rúbrica de cobertura). Crece con fallos reales.
// `phase`: F1 = flashcards+resumen (P1, P4); F2 añade P2/P3 y más artefactos.

export const BATTERIES = [
  {
    id: 'p1-estudiante',
    phase: 1,
    fixture: 'evals/fixtures/p1-relativity.epub',
    lang: 'en',
    persona: 'Estudiante con Anki (física): prepara un examen sobre relatividad',
    goal: 'Aprobar el examen de física: entender la relatividad especial y general y memorizar sus conceptos clave.',
    goldenConcepts: [
      'principio de relatividad (las leyes físicas son iguales en todos los sistemas inerciales)',
      'constancia de la velocidad de la luz en el vacío',
      'relatividad de la simultaneidad',
      'transformación de Lorentz (frente a la de Galileo)',
      'dilatación del tiempo',
      'contracción de la longitud',
      'equivalencia masa-energía (E=mc²)',
      'principio de equivalencia (gravitación ≡ aceleración) y relatividad general',
      'curvatura del continuo espacio-tiempo por la materia',
    ],
  },
  {
    id: 'p4-noficcion',
    phase: 1,
    fixture: 'tests/test.epub',
    lang: 'es',
    persona: 'Lector de literatura/ensayo: quiere entender la obra a fondo',
    goal: 'Entender la estructura y los temas de la obra.',
    goldenConcepts: [
      'Juan Preciado viaja a Comala a buscar a su padre por la promesa a su madre moribunda (Dolores)',
      'Comala es un pueblo de muertos: los narradores son ánimas',
      'Pedro Páramo como cacique (poder, tierras, violencia)',
      'Susana San Juan como obsesión amorosa de Pedro Páramo',
      'estructura fragmentada y no lineal (voces y tiempos entrelazados)',
      'el padre Rentería y la culpa/la religión',
      'el rencor como motor ("un rencor vivo")',
      'la muerte del narrador a mitad de la novela (giro estructural)',
    ],
  },
  {
    id: 'p2-tecnico',
    phase: 2,
    fixture: 'evals/fixtures/p2-progit.epub',
    lang: 'en',
    persona: 'Lector técnico: estudia Git a fondo (certificación/trabajo)',
    goal: 'Dominar Git: modelo de objetos, ramas, merge/rebase y flujos de trabajo en equipo.',
    goldenConcepts: [
      'los tres estados: working directory, staging area (index) y repositorio',
      'commits como snapshots (no diffs) y el DAG de objetos',
      'ramas como punteros móviles a commits (baratas)',
      'merge vs rebase y cuándo no rebasar (historia publicada)',
      'remotos: fetch vs pull, push y tracking branches',
      'HEAD y detached HEAD',
      'reset vs checkout vs revert',
      'flujos: feature branch, fork+PR, git flow',
    ],
  },
  {
    id: 'p3-opositor',
    phase: 2,
    fixture: 'evals/fixtures/p3-constitucion.pdf',
    lang: 'es',
    persona: 'Opositor: memoriza texto legal literal (fechas, plazos, artículos)',
    goal: 'Memorizar la Constitución para el examen tipo test: títulos, artículos clave, plazos y mayorías.',
    goldenConcepts: [
      'art. 1: Estado social y democrático de Derecho; soberanía nacional; forma política',
      'art. 2: unidad de la Nación y derecho a la autonomía',
      'derechos fundamentales y libertades públicas (Título I, Cap. II, Sección 1ª)',
      'garantías: recurso de amparo y Defensor del Pueblo',
      'la Corona: funciones del Rey y refrendo',
      'Cortes Generales: composición y mandato de 4 años',
      'reforma constitucional: procedimientos del art. 167 y 168',
      'Tribunal Constitucional: composición y competencias',
    ],
  },
];

// Baterías cuyo fixture existe y son de la fase pedida (o inferior).
export function activeBatteries(fs, phase = 1) {
  return BATTERIES.filter(b => b.phase <= phase && fs.existsSync(b.fixture));
}
