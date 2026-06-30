// Las 6 plantillas de lectura orientada a objetivos (templates.md), declarativas.
// Cada plantilla: bloque, nombre, para quién, rol del agente, pregunta de objetivo y
// los campos de la libreta. type: 'text' (un valor) | 'list' (varias entradas).
// E5.1 del backlog. Las plantillas propias del usuario (P2) se fusionan aquí.
import * as Custom from './custom-templates.js';

export const BLOCKS = {
  tecnico:   { id: 'tecnico',   icon: 'chart',   label: 'Técnico / Práctico', hint: 'Negocios, software, ciencia, ensayo metodológico' },
  humanista: { id: 'humanista', icon: 'columns', label: 'Humanista / Creativo', hint: 'Biografías, historia, filosofía, ficción' },
};

export const TEMPLATES = [
  {
    id: 'extraccion-sintopica',
    block: 'tecnico',
    name: 'Extracción Sintópica',
    ideal: 'Resolver un problema inmediato de tu trabajo o proyecto.',
    goalPrompt: '¿Qué problema o cuello de botella tienes hoy que te hizo abrir este libro?',
    agentRole: 'Filtra el libro hacia el problema del usuario: atenúa lo introductorio/anecdótico y resalta metodologías directamente aplicables.',
    fields: [
      { key: 'problema_actual',  label: 'Problema actual', type: 'text' },
      { key: 'artefacto_salida', label: 'Artefacto de salida esperado', type: 'text' },
      { key: 'conceptos_clave',  label: 'Conceptos clave para el objetivo', type: 'list' },
      { key: 'frameworks_autor', label: 'Modelos mentales / frameworks del autor', type: 'list' },
      { key: 'accion_inmediata', label: 'Plan de acción · próximos 3 días', type: 'list' },
      { key: 'accion_medio',     label: 'Plan de acción · próximas 2 semanas', type: 'list' },
    ],
  },
  {
    id: 'hqa',
    block: 'tecnico',
    name: 'Método HQ&A',
    ideal: 'Estudiar documentación o conceptos técnicos a fondo y memorizarlos.',
    goalPrompt: '¿Qué concepto o tema necesitas comprender y memorizar?',
    agentRole: 'Cuando el usuario subraya un dato, genera la Pregunta conceptual que responde y un borrador de Respuesta con sus propias palabras (Highlight → Question → Answer).',
    fields: [
      { key: 'hqa', label: 'Highlight → Question → Answer', type: 'list' },
    ],
  },
  {
    id: 'adler',
    block: 'tecnico',
    name: '4 Preguntas de Adler',
    ideal: 'Comprensión holística y crítica de un ensayo o no-ficción.',
    goalPrompt: '¿Qué quieres obtener de una lectura crítica de este libro?',
    agentRole: 'Guía al usuario por las 4 preguntas de Adler para una comprensión completa y crítica.',
    fields: [
      { key: 'mapa_global',    label: '1. Mapa global (tesis central en 3 frases)', type: 'text' },
      { key: 'anatomia',       label: '2. Anatomía del argumento (pilares)', type: 'text' },
      { key: 'juicio_critico', label: '3. Juicio crítico (¿dónde flaquea?)', type: 'text' },
      { key: 'y_que',          label: '4. El "¿y qué?" para mi objetivo', type: 'text' },
    ],
  },
  {
    id: 'modelado-comportamiento',
    block: 'humanista',
    name: 'Modelado de Comportamiento',
    ideal: 'Analizar la mentalidad de personajes históricos ante decisiones difíciles.',
    goalPrompt: '¿Qué quieres aprender de la mentalidad de este personaje? (p.ej. "cómo mantenía la calma")',
    agentRole: 'Actúa como Pepito Grillo histórico: en los puntos de quiebre, frena y debate qué debió evaluar el personaje, según el objetivo de aprendizaje.',
    fields: [
      { key: 'personaje',           label: 'Personaje focus', type: 'text' },
      { key: 'objetivo_aprendizaje',label: 'Mi objetivo de aprendizaje', type: 'text' },
      { key: 'crisis',              label: 'El crisol · la crisis', type: 'list' },
      { key: 'decision',            label: 'El crisol · la decisión', type: 'list' },
      { key: 'asimetria_riesgo',    label: 'Asimetría del riesgo (skin in the game)', type: 'list' },
      { key: 'espejo',              label: 'El espejo · aplicación personal', type: 'text' },
    ],
  },
  {
    id: 'artesano',
    block: 'humanista',
    name: 'El Artesano del Texto',
    ideal: 'Leer ficción para aprender a escribir mejor.',
    goalPrompt: '¿Qué quieres "robarle" al autor? (ritmo, personajes, worldbuilding...)',
    agentRole: 'Analiza la técnica del autor (estructura, ritmo, gestión de información, estilo) para que el usuario la imite.',
    fields: [
      { key: 'objetivo_artesanal',  label: 'Objetivo artesanal', type: 'text' },
      { key: 'estructura_ritmo',    label: 'Estructura y ritmo', type: 'list' },
      { key: 'gestion_informacion', label: 'Gestión de la información', type: 'list' },
      { key: 'laboratorio_palabras',label: 'Laboratorio de palabras (frases brillantes)', type: 'list' },
      { key: 'experimento',         label: 'Mi propio experimento', type: 'text' },
    ],
  },
  {
    id: 'compas-filosofico',
    block: 'humanista',
    name: 'El Compás Filosófico',
    ideal: 'Lecturas de filosofía/estoicismo para transformación interior.',
    goalPrompt: '¿Qué área de tu vida quieres transformar con esta lectura?',
    agentRole: 'Confronta al usuario con las ideas que desafían sus creencias y le propone experimentos prácticos.',
    fields: [
      { key: 'proposito_interior',  label: 'Propósito interior', type: 'text' },
      { key: 'demolicion',          label: 'La demolición (creencias desafiadas)', type: 'list' },
      { key: 'cita_faro',           label: 'La cita faro', type: 'text' },
      { key: 'experimento_estoico', label: 'El experimento estoico / práctico', type: 'text' },
    ],
  },
];

// Fábrica + plantillas propias del usuario (P2). Las custom viven en localStorage
// (síncrono), así que la API de plantillas sigue siendo síncrona como antes.
export function allTemplates() {
  return [...TEMPLATES, ...Custom.getAll()];
}

export function getTemplate(id) {
  return allTemplates().find(t => t.id === id) || null;
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
