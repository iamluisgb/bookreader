// Las 6 plantillas de lectura orientada a objetivos (templates.md), declarativas.
// Cada plantilla: bloque, nombre, para quién, rol del agente, pregunta de objetivo y
// los campos de la libreta. type: 'text' (un valor) | 'list' (varias entradas).
// E5.1 del backlog. Las plantillas propias del usuario (P2) se fusionan aquí.
//
// Distinción INFO/COGNICIÓN (fill por campo): 'agent' = INFO, lo puede rellenar la IA
// (recuperación mecánica); 'user' = COGNICIÓN, lo genera el usuario (efecto de generación /
// active recall) y la IA NO lo escribe, solo pregunta y revisa. Un campo sin `fill` se trata
// como 'agent' (compatibilidad).
//
// NB2 · La libreta guía en vez de esperar. Por campo (todo opcional; las propias no lo usan):
//   label    : nombre corto. `hint`: la instrucción, como texto de ejemplo del campo vacío.
//   when     : cuándo se te pregunta ('inicio' | 'capitulo' | 'final' = libro terminado).
//   ask      : la pregunta de ese momento (tarjeta «Te toca» de la libreta).
//   fromGoal : repite el objetivo del onboarding → no se pide dos veces (se oculta vacío).
//   after    : campo de la IA que solo se enseña cuando existe el tuyo (primero tú).
//   toDeck   : el par P/R respondido pasa al mazo del libro (HQ&A).
// Por plantilla: `byChapter` (la libreta se agrupa por capítulo) y `deliverable` (botón
// final que monta el artefacto con tus notas).
import * as Custom from './custom-templates.js';
import { t as tr } from '../i18n.js';

// Los bloques (técnico/humanista) ya no organizan el onboarding —ahora es por objetivo—,
// pero se conservan para agrupar la lista de plantillas en Ajustes y en las propias.
export const BLOCKS = {
  tecnico:   { id: 'tecnico',   icon: 'chart',   label: tr('Técnico / Práctico'), hint: tr('Negocios, software, ciencia, ensayo metodológico') },
  humanista: { id: 'humanista', icon: 'columns', label: tr('Humanista / Creativo'), hint: tr('Biografías, historia, filosofía, ficción') },
};

// 5 plantillas por OBJETIVO (T1–T5). `objective` es la respuesta a "¿qué quieres conseguir
// con este libro?" que se muestra en el onboarding. El Artesano (más abajo) no es un
// objetivo: es un modo opt-in dentro de la Lectura Inmersiva (leer ficción como escritor).
export const TEMPLATES = [
  {
    id: 't1-extraccion',
    block: 'tecnico',
    objective: tr('Resolver un problema concreto que tengo ahora'),
    name: tr('Extracción para proyectos'),
    ideal: tr('Libros técnicos, de negocio o metodológicos. Lectura de minería.'),
    goalPrompt: tr('¿Qué problema o cuello de botella te hizo abrir este libro?'),
    agentRole: tr('Filtra el libro hacia el problema del usuario: atenúa lo introductorio/anecdótico y resalta métodos directamente aplicables.'),
    // La recompensa de T1: con tus notas, el agente monta el artefacto que pediste al empezar.
    deliverable: { what: 'artefacto_salida', from: ['plan_accion'] },
    fields: [
      { key: 'problema_actual',      label: tr('Problema'), type: 'text', fill: 'user', fromGoal: true },
      { key: 'artefacto_salida',     label: tr('Qué quiero tener al terminar'), hint: tr('Una checklist, un plan, una arquitectura…'), type: 'text', fill: 'user',
        when: 'inicio', ask: tr('¿Qué quieres tener en la mano al terminar el libro?') },
      { key: 'conceptos_frameworks', label: tr('Conceptos del autor'), hint: tr('Solo los que sirven para tu problema'), type: 'list', fill: 'agent' },
      { key: 'por_que_importa',      label: tr('Qué me sirve'), hint: tr('Lo de este capítulo que aplica a tu problema'), type: 'text', fill: 'user',
        when: 'capitulo', ask: tr('¿Qué de este capítulo te sirve para tu problema?') },
      { key: 'plan_accion',          label: tr('Plan de acción'), hint: tr('Qué haces en 3 días y qué en 2 semanas'), type: 'list', fill: 'user',
        when: 'final', ask: tr('¿Qué vas a hacer en los próximos 3 días? ¿Y en 2 semanas?') },
    ],
  },
  {
    id: 'hqa',
    block: 'tecnico',
    objective: tr('Dominar y memorizar el material a fondo'),
    name: tr('Pregunta y respuesta'),
    ideal: tr('Documentación, libros de texto, conceptos complejos.'),
    goalPrompt: tr('¿Qué concepto o tema necesitas comprender y memorizar?'),
    agentRole: tr('Cuando el usuario subraya un dato, genera la Pregunta conceptual que responde; la Respuesta la escribe el usuario con sus palabras.'),
    // Libreta por capítulos. El cierre de capítulo es el repaso de memoria del chat (IA2).
    byChapter: true,
    fields: [
      // Un solo campo por par: el Highlight y la Question las pone la IA, la Answer la
      // escribes tú (fill:'user'). Mantenerlo en un campo conserva el emparejamiento H-Q-A.
      // aiScaffold: es un campo de cognición donde la IA SÍ puede crear la entrada como
      // andamio —su parte (H+Q) sí, la del usuario (la Answer) SIEMPRE en blanco—. Es lo
      // que ya hacía el subrayado (generateHQA); con el flag también puede hacerlo desde
      // el chat cuando se le pide, sin romper el efecto de generación.
      // toDeck: al responder, el par P/R pasa al mazo del libro (NB2).
      { key: 'hqa', label: tr('Preguntas y respuestas'), hint: tr('Subraya un pasaje: el agente propone la pregunta y la respuesta es tuya'), type: 'list', fill: 'user', aiScaffold: true, toDeck: true },
    ],
  },
  {
    id: 't3-juicio',
    block: 'humanista',
    objective: tr('Entender y juzgar la tesis del autor'),
    name: tr('Juicio analítico'),
    ideal: tr('Cierre de un ensayo o no-ficción argumentativa. Síntesis final.'),
    goalPrompt: tr('¿Qué quieres obtener de una lectura crítica de este libro?'),
    agentRole: tr('Guía las 4 preguntas de Adler. En el juicio actúa como sparring (aporta contraargumentos), no des veredictos: el juicio es del lector.'),
    fields: [
      // Primero tú, luego el agente: formular la tesis ES la lectura analítica (Adler). La
      // versión del agente (mapa_global) se enseña cuando existe la tuya (`after`).
      { key: 'afirmacion',     label: tr('Qué afirma cada capítulo'), hint: tr('Una frase por capítulo'), type: 'list', fill: 'user',
        when: 'capitulo', ask: tr('¿Qué afirma el autor en este capítulo? Una frase.') },
      { key: 'tesis',          label: tr('Mi tesis del libro'), hint: tr('La tesis central en 3 frases, antes de ver la del agente'), type: 'text', fill: 'user',
        when: 'final', ask: tr('¿Cuál es la tesis del libro en 3 frases? Luego verás la del agente para contrastar.') },
      { key: 'mapa_global',    label: tr('La tesis según el agente'), type: 'text', fill: 'agent', after: 'tesis' },
      { key: 'anatomia',       label: tr('Anatomía del argumento'), hint: tr('Pilares y sub-argumentos'), type: 'text', fill: 'agent' },
      { key: 'juicio_critico', label: tr('Juicio crítico'), hint: tr('¿Dónde flaquea la lógica? ¿Sesgos, datos?'), type: 'text', fill: 'user',
        when: 'final', ask: tr('¿Dónde flaquea la lógica del autor? ¿Sesgos, datos que faltan?') },
      { key: 'y_que',          label: tr('¿Y qué?'), hint: tr('Qué cambia en cómo pienso o actúo'), type: 'text', fill: 'user',
        when: 'final', ask: tr('¿Qué cambia en cómo piensas o actúas después de este libro?') },
    ],
  },
  {
    id: 't4-sabiduria',
    block: 'humanista',
    objective: tr('Cambiar cómo pienso o cómo actúo'),
    name: tr('Sabiduría aplicada'),
    ideal: tr('Biografía, historia, filosofía, estoicismo, crecimiento.'),
    goalPrompt: tr('¿Qué patrón o área de tu vida quieres transformar? / ¿qué quieres aprender de este personaje?'),
    agentRole: tr('Localiza y resume el crisol (el momento de máxima tensión o la idea que desafía). El espejo y el experimento los genera el usuario: confróntalo, no los escribas.'),
    fields: [
      { key: 'proposito',    label: tr('Propósito'), type: 'text', fill: 'user', fromGoal: true },
      { key: 'crisol',       label: tr('El crisol'), hint: tr('El momento de tensión o la idea que incomoda'), type: 'list', fill: 'agent' },
      { key: 'espejo',       label: tr('El espejo'), hint: tr('Qué haría yo en una encrucijada equivalente'), type: 'text', fill: 'user',
        when: 'final', ask: tr('¿Qué harías tú en una encrucijada equivalente?') },
      { key: 'experimento',  label: tr('El experimento'), hint: tr('El cambio concreto que hago mañana'), type: 'text', fill: 'user',
        when: 'final', ask: tr('¿Qué cambio concreto vas a probar mañana?') },
    ],
  },
  {
    id: 't5-inmersiva',
    block: 'humanista',
    objective: tr('Solo disfrutar / leer del tirón'),
    name: tr('Lectura inmersiva'),
    ideal: tr('Ficción y cualquier lectura por placer. Fricción cero.'),
    goalPrompt: tr('¿Qué esperas de esta lectura? (opcional)'),
    agentRole: tr('Acompaña sin interrumpir. La síntesis es opcional y siempre posterior: resúmenes solo al terminar o por sesión, si se piden.'),
    // Sin «Highlights sueltos»: los subrayados ya viven en su panel. Las notas antiguas de
    // ese campo se siguen mostrando (la libreta pinta cualquier campo con notas).
    fields: [
      { key: 'resumen',    label: tr('Resumen'), hint: tr('Solo si lo pides al terminar'), type: 'text', fill: 'agent' },
      { key: 'nota_libre', label: tr('Nota libre'), hint: tr('Lo que quieras recordar'), type: 'list', fill: 'user',
        when: 'final', ask: tr('¿Algo que quieras recordar de este libro?') },
    ],
  },
  {
    // T6 · Libros que se IMPLEMENTAN (ML, sistemas, lenguajes): el material no se aplica
    // como un método de negocio, se teclea y se ejecuta. T1 aquí no encaja —pide un "plan
    // de acción a 3 días y 2 semanas", que no significa nada cuando lo que toca es
    // construir el tokenizador del capítulo 2—. El eje aquí es: qué construye este
    // capítulo, con qué formas/tipos, dónde me atasqué y qué implemento antes de seguir.
    id: 't6-implementacion',
    block: 'tecnico',
    objective: tr('Implementar lo que enseña el libro, capítulo a capítulo'),
    name: tr('Construir con el libro'),
    ideal: tr('Libros con código: ML/IA, sistemas, compiladores, "from scratch".'),
    goalPrompt: tr('¿Qué quieres ser capaz de construir al terminar el libro?'),
    agentRole: tr('Trata el libro como un proyecto que se construye: prioriza el mecanismo sobre la narrativa, explica las estructuras de datos y sus dimensiones, y cuando aparezca una fórmula ofrece verla con números pequeños. No des por entendido lo que no se ha implementado.'),
    byChapter: true,
    fields: [
      { key: 'que_construyo',    label: tr('Qué construye el capítulo'), hint: tr('La pieza y para qué sirve'), type: 'text', fill: 'agent' },
      { key: 'piezas_clave',     label: tr('Piezas clave del código'), type: 'list', fill: 'agent' },
      { key: 'formas_datos',     label: tr('Formas y tipos'), hint: tr('Qué entra, qué sale, con qué dimensiones'), type: 'list', fill: 'agent' },
      { key: 'lo_implemento',    label: tr('Lo implemento yo'), hint: tr('Sin mirar el libro'), type: 'text', fill: 'user',
        when: 'capitulo', ask: tr('¿Has implementado la pieza de este capítulo sin mirar el libro? ¿Qué te costó?') },
      { key: 'donde_me_atasque', label: tr('Dónde me atasqué'), hint: tr('Y qué lo desatascó'), type: 'list', fill: 'user' },
    ],
  },
  {
    // Modo avanzado "Artesano": opt-in dentro de T5 (leo para aprender a escribir). No se
    // muestra como objetivo en el onboarding; se selecciona con la casilla de la pantalla T5.
    id: 'artesano',
    block: 'humanista',
    name: tr('Artesano del Texto'),
    ideal: tr('Leer ficción como escritor: estructura, ritmo, estilo.'),
    goalPrompt: tr('¿Qué quieres "robarle" al autor? (ritmo, personajes, worldbuilding...)'),
    agentRole: tr('Analiza la técnica del autor (estructura, ritmo, gestión de la información, estilo) para que el usuario la imite.'),
    fields: [
      { key: 'objetivo_artesanal',  label: tr('Objetivo artesanal'), type: 'text', fill: 'user', fromGoal: true },
      { key: 'estructura_ritmo',    label: tr('Estructura y ritmo'), type: 'list', fill: 'agent' },
      { key: 'gestion_informacion', label: tr('Gestión de la información'), type: 'list', fill: 'agent' },
      { key: 'laboratorio_palabras',label: tr('Laboratorio de palabras'), hint: tr('Frases brillantes'), type: 'list', fill: 'agent' },
      { key: 'experimento',         label: tr('Mi experimento'), hint: tr('La técnica que pruebo en mi escritura'), type: 'text', fill: 'user',
        when: 'final', ask: tr('¿Qué técnica del autor vas a probar en tu propia escritura?') },
    ],
  },
];

// Id del modo avanzado Artesano y de la Lectura Inmersiva (la que lo ofrece como opt-in).
export const ARTESANO_ID = 'artesano';
export const INMERSIVA_ID = 't5-inmersiva';

// Fábrica + plantillas propias del usuario (P2). Las custom viven en localStorage
// (síncrono), así que la API de plantillas sigue siendo síncrona como antes.
export function allTemplates() {
  return [...TEMPLATES, ...Custom.getAll()];
}

export function getTemplate(id) {
  return allTemplates().find(t => t.id === id) || null;
}

// Plantillas que se ofrecen como OBJETIVO en el onboarding: las 5 de fábrica (excluye el
// Artesano, que es opt-in dentro de T5) más las propias del usuario.
export function objectiveTemplates() {
  return [...TEMPLATES.filter(t => t.id !== ARTESANO_ID), ...Custom.getAll()];
}

export function templatesByBlock(block) {
  return allTemplates().filter(t => t.block === block);
}

export function fieldLabel(templateId, fieldKey) {
  const t = getTemplate(templateId);
  const f = t?.fields.find(f => f.key === fieldKey);
  return f ? f.label : fieldKey;
}

export function isValidField(templateId, fieldKey) {
  const t = getTemplate(templateId);
  return !!t && t.fields.some(f => f.key === fieldKey);
}

// ---- INFO / COGNICIÓN ------------------------------------------------------
// Un campo es de cognición (lo genera el usuario) si fill === 'user'. Cualquier otro
// valor —incluido ausente— es INFO (lo puede rellenar la IA): compatibilidad hacia atrás.
export function isCognitionField(field) {
  return !!field && field.fill === 'user';
}

// Campos que la IA SÍ puede rellenar (INFO). Los de cognición se excluyen.
export function agentFields(template) {
  return template ? template.fields.filter(f => !isCognitionField(f)) : [];
}

// ¿Puede la IA escribir en este campo? Debe existir y ser INFO. Se usa como guard del
// auto-relleno para que la IA no toque los campos de cognición del usuario.
export function isAgentFillable(templateId, fieldKey) {
  const t = getTemplate(templateId);
  const f = t?.fields.find(f => f.key === fieldKey);
  return !!f && !isCognitionField(f);
}

// Campos que la IA puede ESCRIBIR en la libreta: los INFO siempre, y los de cognición
// marcados como andamio (aiScaffold) creando la entrada con su parte y dejando la del
// usuario en blanco. Hoy solo HQ&A; una plantilla custom puede usar el flag igualmente.
export function aiWritableFields(template) {
  if (!template) return [];
  return template.fields.filter(f => !isCognitionField(f) || f.aiScaffold);
}

// Guard de escritura de la IA por campo: INFO, o cognición-andamio. Complementa a
// isAgentFillable (que solo mira INFO) para las rutas donde el andamio sí vale.
export function isAiWritable(templateId, fieldKey) {
  const t = getTemplate(templateId);
  const f = t?.fields.find(f => f.key === fieldKey);
  return !!f && (!isCognitionField(f) || !!f.aiScaffold);
}
