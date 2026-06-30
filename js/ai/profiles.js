// Perfiles de agente (P1). Persona + contexto del usuario REUTILIZABLE entre libros
// (a diferencia de las convos, que son por libro). Un perfil tiene:
//   - soul        : personalidad/rol del agente (system).
//   - userProfile : quién es el usuario.
//   - notes       : notas permanentes que el agente siempre tiene en cuenta.
// Hay como mucho un perfil ACTIVO; su bloque se antepone al system prompt como
// prefijo estable (bueno para el prompt caching del proveedor).
//
// Persistencia en localStorage (vía Storage), igual que las plantillas propias (P2):
// systemPrompt() se construye de forma SÍNCRONA, así que un store síncrono evita
// caché en memoria y carreras de arranque; el payload es diminuto y, de paso, el
// backup global (P3) lo incluye sin tocar nada. Solo depende de Storage.
import * as Storage from '../storage.js';

const KEY = 'profiles';
const ACTIVE_KEY = 'active_profile';

export function getAll() {
  const arr = Storage.get(KEY, []);
  return Array.isArray(arr) ? arr.map(normalize) : [];
}

export function get(id) {
  const p = getAll().find(p => p.id === id);
  return p ? JSON.parse(JSON.stringify(p)) : null;   // copia: el form edita un borrador
}

export function save(raw) {
  const p = normalize({ ...raw, id: raw.id || makeId() });
  const all = getAll();
  const i = all.findIndex(x => x.id === p.id);
  if (i >= 0) all[i] = p; else all.push(p);
  Storage.set(KEY, all);
  return p;
}

export function remove(id) {
  Storage.set(KEY, getAll().filter(p => p.id !== id));
  if (getActiveId() === id) setActiveId(null);   // si era el activo, queda sin perfil
}

export function getActiveId() {
  return Storage.get(ACTIVE_KEY, null);
}

export function setActiveId(id) {
  if (id) Storage.set(ACTIVE_KEY, id); else Storage.remove(ACTIVE_KEY);
}

export function getActive() {
  const id = getActiveId();
  if (!id) return null;
  return getAll().find(p => p.id === id) || null;
}

export function makeId() {
  return 'prof-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function blank() {
  return { id: null, name: '', soul: '', userProfile: '', notes: '' };
}

export function validate(raw) {
  if (!(raw.name || '').trim()) return 'Ponle un nombre al perfil.';
  if (!((raw.soul || '').trim() || (raw.userProfile || '').trim() || (raw.notes || '').trim())) {
    return 'Rellena al menos uno de los campos (personalidad, usuario o notas).';
  }
  return null;
}

// Bloque que se antepone al system prompt cuando hay perfil activo. Vacío si no hay.
export function promptBlock(profile) {
  if (!profile) return '';
  const parts = [];
  if (profile.name) parts.push(`Te llamas ${profile.name}; preséntate por ese nombre si te lo preguntan.`);
  if (profile.soul) parts.push(`Personalidad y rol del agente: ${profile.soul}`);
  if (profile.userProfile) parts.push(`Sobre el usuario: ${profile.userProfile}`);
  if (profile.notes) parts.push(`Notas permanentes a tener siempre en cuenta: ${profile.notes}`);
  if (!parts.length) return '';
  return `PERFIL (aplica en todas tus respuestas):\n${parts.join('\n')}\n\n`;
}

function normalize(raw) {
  return {
    id: raw.id || makeId(),
    name: (raw.name || '').trim() || 'Perfil',
    soul: (raw.soul || '').trim(),
    userProfile: (raw.userProfile || '').trim(),
    notes: (raw.notes || '').trim(),
  };
}
