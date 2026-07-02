// Las 6 plantillas de lectura orientada a objetivos (templates.md), declarativas.
// Cada plantilla: bloque, nombre, para quién, rol del agente, pregunta de objetivo y
// los campos de la libreta. type: 'text' (un valor) | 'list' (varias entradas).
// E5.1 del backlog. Las plantillas propias del usuario (P2) se fusionan aquí.
//
// Distinción INFO/COGNICIÓN (fill por campo): 'agent' = INFO, lo puede rellenar la IA
// (recuperación mecánica); 'user' = COGNICIÓN, lo genera el usuario (efecto de generación /
// active recall) y la IA NO lo escribe, solo pregunta y revisa. Un campo sin `fill` se trata
// como 'agent' (compatibilidad).
import * as Custom from './custom-templates.js';

// Los bloques (técnico/humanista) ya no organizan el onboarding —ahora es por objetivo—,
// pero se conservan para agrupar la lista de plantillas en Ajustes y en las propias.
export const BLOCKS = {
  tecnico:   { id: 'tecnico',   icon: 'chart',   label: 'Técnico / Práctico', hint: 'Negocios, software, ciencia, ensayo metodológico' },
  humanista: { id: 'humanista', icon: 'columns', label: 'Humanista / Creativo', hint: 'Biografías, historia, filosofía, ficción' },
};

// 5 plantillas por OBJETIVO (T1–T5). `objective` es la respuesta a "¿qué quieres conseguir
// con este libro?" que se muestra en el onboarding. El Artesano (más abajo) no es un
// objetivo: es un modo opt-in dentro de la Lectura Inmersiva (leer ficción como escritor).
export const TEMPLATES = [
  {
    id: 't1-extraccion',
    block: 'tecnico',
    objective: 'Resolver un problema concreto que tengo ahora',
    name: 'T1 · Extracción para Proyectos',
    ideal: 'Libros técnicos, de negocio o metodológicos. Lectura de minería.',
    goalPrompt: '¿Qué problema o cuello de botella te hizo abrir este libro?',
    agentRole: 'Filtra el libro hacia el problema del usuario: atenúa lo introductorio/anecdótico y resalta métodos directamente aplicables.',
    fields: [
      { key: 'problema_actual',      label: 'Problema actual', type: 'text', fill: 'user' },
      { key: 'artefacto_salida',     label: 'Artefacto de salida esperado (checklist / plan / arquitectura)', type: 'text', fill: 'user' },
      { key: 'conceptos_frameworks', label: 'Conceptos y frameworks del autor (relevantes al problema)', type: 'list', fill: 'agent' },
      { key: 'por_que_importa',      label: 'Por qué importa para MI problema', type: 'text', fill: 'user' },
      { key: 'plan_accion',          label: 'Plan de acción (3 días + 2 semanas)', type: 'list', fill: 'user' },
    ],
  },
  {
    id: 'hqa',
    block: 'tecnico',
    objective: 'Dominar y memorizar el material a fondo',
    name: 'T2 · HQ&A',
    ideal: 'Documentación, libros de texto, conceptos complejos.',
    goalPrompt: '¿Qué concepto o tema necesitas comprender y memorizar?',
    agentRole: 'Cuando el usuario subraya un dato, genera la Pregunta conceptual que responde; la Respuesta la escribe el usuario con sus palabras.',
    fields: [
      // Un solo campo por par: el Highlight y la Question las pone la IA, la Answer la
      // escribes tú (fill:'user'). Mantenerlo en un campo conserva el emparejamiento H-Q-A.
      { key: 'hqa', label: 'Highlight → Question → Answer (tú escribes la respuesta)', type: 'list', fill: 'user' },
    ],
  },
  {
    id: 't3-juicio',
    block: 'humanista',
    objective: 'Entender y juzgar la tesis del autor',
    name: 'T3 · Juicio Analítico',
    ideal: 'Cierre de un ensayo o no-ficción argumentativa. Síntesis final.',
    goalPrompt: '¿Qué quieres obtener de una lectura crítica de este libro?',
    agentRole: 'Guía las 4 preguntas de Adler. En el juicio actúa como sparring (aporta contraargumentos), no des veredictos: el juicio es del lector.',
    fields: [
      { key: 'mapa_global',    label: 'Mapa global (tesis central en 3 frases)', type: 'text', fill: 'agent' },
      { key: 'anatomia',       label: 'Anatomía del argumento (pilares y sub-argumentos)', type: 'text', fill: 'agent' },
      { key: 'juicio_critico', label: 'Juicio crítico (¿dónde flaquea la lógica? sesgos, datos)', type: 'text', fill: 'user' },
      { key: 'y_que',          label: '¿Y qué? (qué cambia en cómo pienso o actúo)', type: 'text', fill: 'user' },
    ],
  },
  {
    id: 't4-sabiduria',
    block: 'humanista',
    objective: 'Cambiar cómo pienso o cómo actúo',
    name: 'T4 · Sabiduría Aplicada',
    ideal: 'Biografía, historia, filosofía, estoicismo, crecimiento.',
    goalPrompt: '¿Qué patrón o área de tu vida quieres transformar? / ¿qué quieres aprender de este personaje?',
    agentRole: 'Localiza y resume el crisol (el momento de máxima tensión o la idea que desafía). El espejo y el experimento los genera el usuario: confróntalo, no los escribas.',
    fields: [
      { key: 'proposito',    label: 'Propósito (qué quiero transformar / aprender)', type: 'text', fill: 'user' },
      { key: 'crisol',       label: 'El crisol (momento de tensión o idea que incomoda)', type: 'list', fill: 'agent' },
      { key: 'espejo',       label: 'El espejo (qué haría yo en una encrucijada equivalente)', type: 'text', fill: 'user' },
      { key: 'experimento',  label: 'El experimento (el cambio concreto que hago mañana)', type: 'text', fill: 'user' },
    ],
  },
  {
    id: 't5-inmersiva',
    block: 'humanista',
    objective: 'Solo disfrutar / leer del tirón',
    name: 'T5 · Lectura Inmersiva',
    ideal: 'Ficción y cualquier lectura por placer. Fricción cero.',
    goalPrompt: '¿Qué esperas de esta lectura? (opcional)',
    agentRole: 'Acompaña sin interrumpir. La síntesis es opcional y siempre posterior: resúmenes solo al terminar o por sesión, si se piden.',
    fields: [
      { key: 'highlights', label: 'Highlights sueltos', type: 'list', fill: 'agent' },
      { key: 'resumen',    label: 'Resumen al terminar (opcional)', type: 'text', fill: 'agent' },
      { key: 'nota_libre', label: 'Nota libre (opcional)', type: 'list', fill: 'user' },
    ],
  },
  {
    // Modo avanzado "Artesano": opt-in dentro de T5 (leo para aprender a escribir). No se
    // muestra como objetivo en el onboarding; se selecciona con la casilla de la pantalla T5.
    id: 'artesano',
    block: 'humanista',
    name: 'Artesano del Texto',
    ideal: 'Leer ficción como escritor: estructura, ritmo, estilo.',
    goalPrompt: '¿Qué quieres "robarle" al autor? (ritmo, personajes, worldbuilding...)',
    agentRole: 'Analiza la técnica del autor (estructura, ritmo, gestión de la información, estilo) para que el usuario la imite.',
    fields: [
      { key: 'objetivo_artesanal',  label: 'Objetivo artesanal', type: 'text', fill: 'user' },
      { key: 'estructura_ritmo',    label: 'Estructura y ritmo', type: 'list', fill: 'agent' },
      { key: 'gestion_informacion', label: 'Gestión de la información', type: 'list', fill: 'agent' },
      { key: 'laboratorio_palabras',label: 'Laboratorio de palabras (frases brillantes)', type: 'list', fill: 'agent' },
      { key: 'experimento',         label: 'Mi propio experimento', type: 'text', fill: 'user' },
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
