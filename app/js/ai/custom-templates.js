// Plantillas de libreta propias del usuario (P2). Mismo shape que las de fábrica
// en templates.js ({ id, block, name, ideal, goalPrompt, agentRole, fields[] }) más
// `custom: true`. Persisten en localStorage (vía Storage): la API de plantillas es
// SÍNCRONA (getTemplate/isValidField se llaman en caliente durante el streaming), así
// que un store síncrono encaja sin caché ni carreras de arranque. Payload diminuto.
//
// No importa templates.js para evitar dependencia circular (templates.js sí fusiona
// estas). Solo depende de Storage.
import * as Storage from '../storage.js';

const KEY = 'custom_templates';
// Marcas diacríticas combinantes (U+0300–U+036F), para slugificar etiquetas: NFD las
// separa de la letra base y aquí las quitamos. Escapes unicode para no meter caracteres
// invisibles en el fuente.
const COMBINING = /[̀-ͯ]/g;

export function getAll() {
  const arr = Storage.get(KEY, []);
  return Array.isArray(arr) ? arr.map(normalize) : [];
}

export function get(id) {
  const t = getAll().find(t => t.id === id);
  return t ? JSON.parse(JSON.stringify(t)) : null;   // copia: el form edita un borrador
}

export function save(raw) {
  const tpl = normalize({ ...raw, id: raw.id || makeId() });
  const all = getAll();
  const i = all.findIndex(t => t.id === tpl.id);
  if (i >= 0) all[i] = tpl; else all.push(tpl);
  Storage.set(KEY, all);
  return tpl;
}

export function remove(id) {
  Storage.set(KEY, getAll().filter(t => t.id !== id));
}

export function makeId() {
  return 'custom-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Borrador vacío para el formulario de creación.
export function blank() {
  return { id: null, custom: true, block: 'tecnico', name: '', ideal: '',
    goalPrompt: '', agentRole: '', fields: [{ key: '', label: '', type: 'text', fill: 'agent' }] };
}

// Devuelve un mensaje de error si el borrador no es válido, o null si lo es.
export function validate(raw) {
  if (!(raw.name || '').trim()) return 'Ponle un nombre a la plantilla.';
  const fields = (raw.fields || []).filter(f => (f.label || '').trim());
  if (!fields.length) return 'Añade al menos un campo a la libreta.';
  return null;
}

// Normaliza un borrador al shape canónico: bloque válido, defaults, y claves de campo
// únicas derivadas de la etiqueta (preservando la clave existente al editar, para no
// huérfanar notas ya tomadas).
function normalize(raw) {
  const used = new Set();
  const fields = (raw.fields || [])
    .filter(f => (f.label || '').trim())
    .map(f => {
      const base = f.key || slug(f.label);
      let k = base, i = 2;
      while (used.has(k)) k = `${base}_${i++}`;
      used.add(k);
      // fill: 'user' = cognición (lo genera el usuario); cualquier otro valor = INFO.
      return { key: k, label: f.label.trim(), type: f.type === 'list' ? 'list' : 'text', fill: f.fill === 'user' ? 'user' : 'agent' };
    });
  return {
    id: raw.id || makeId(),
    custom: true,
    block: raw.block === 'humanista' ? 'humanista' : 'tecnico',
    name: (raw.name || '').trim() || 'Plantilla sin nombre',
    ideal: (raw.ideal || '').trim() || 'Plantilla personalizada.',
    goalPrompt: (raw.goalPrompt || '').trim() || '¿Cuál es tu objetivo con este libro?',
    agentRole: (raw.agentRole || '').trim(),
    fields,
  };
}

function slug(s) {
  return (s || '').toString().toLowerCase().normalize('NFD').replace(COMBINING, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'campo';
}
