// ¿Este fichero lleva DRM? Se mira ANTES de abrirlo. Un EPUB con DRM es un zip válido con el
// texto cifrado: epub.js lo intentaba abrir y acababa en «Error al cargar el archivo EPUB: …», un
// mensaje técnico que no decía ni qué pasaba ni qué hacer. Con esto la app lo dice claro y manda a
// la ayuda «Consigue libros sin DRM».
//
// Solo detecta, nunca quita: BookReader no quita el DRM (en España saltarse una protección
// anticopia no está permitido; ver la nota de esa página de ayuda).
//
// Lo que se reconoce:
//   EPUB · Adobe ADEPT (META-INF/rights.xml) · Readium LCP (META-INF/license.lcpl) · Apple FairPlay
//          (META-INF/sinf.xml) · cualquier otro cifrado declarado en META-INF/encryption.xml. La
//          ofuscación de FUENTES (IDPF y Adobe) también va en encryption.xml y no es DRM: el texto
//          está en claro y epub.js lo abre, así que no cuenta.
//   PDF  · los manejadores de seguridad de Adobe ADEPT (EBX_HANDLER), LiveCycle (Adobe.APS) y
//          FileOpen (FOPN_…). Un PDF con la seguridad estándar (contraseña de propietario, sin
//          contraseña para abrir) NO es DRM a estos efectos: pdf.js lo abre.
//   Por el nombre, sin abrir nada: los formatos de Kindle y el vale `.acsm` de Adobe.
import { loadJsZip } from './vendor-loader.js';

const FONT_OBFUSCATION = new Set([
  'http://www.idpf.org/2008/embedding',
  'http://ns.adobe.com/pdf/enc#RC',
]);

export const KINDLE_EXT = ['azw', 'azw3', 'azw4', 'kfx', 'mobi', 'prc'];

// Por la extensión: 'acsm' | 'kindle' | null.
export function kindOfName(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (ext === 'acsm') return 'acsm';
  if (KINDLE_EXT.includes(ext)) return 'kindle';
  return null;
}

// Pura (la usan los tests): el XML de encryption.xml → ¿cifra algo que no sea una fuente?
export function encryptsContent(xml) {
  const algos = [...String(xml || '').matchAll(/EncryptionMethod[^>]*Algorithm\s*=\s*["']([^"']+)["']/g)].map(m => m[1]);
  return algos.some(a => !FONT_OBFUSCATION.has(a));
}

async function epubDrm(buffer) {
  const JSZip = await loadJsZip();
  const zip = await JSZip.loadAsync(buffer);
  const has = (p) => Object.keys(zip.files).some(n => n.toLowerCase() === p);
  if (has('meta-inf/rights.xml')) return 'adobe';
  if (has('meta-inf/license.lcpl')) return 'lcp';
  if (has('meta-inf/sinf.xml')) return 'apple';
  const enc = Object.keys(zip.files).find(n => n.toLowerCase() === 'meta-inf/encryption.xml');
  if (enc && encryptsContent(await zip.file(enc).async('string'))) return 'other';
  return null;
}

const latin1 = (bytes) => new TextDecoder('latin1').decode(bytes);

function pdfDrm(buffer) {
  const bytes = new Uint8Array(buffer);
  const EDGE = 64 * 1024;
  // El diccionario /Encrypt se declara en el tráiler (al final, o al principio en los PDF
  // linealizados): sin él no hay cifrado y no hace falta leer el fichero entero.
  const edges = latin1(bytes.subarray(0, EDGE)) + latin1(bytes.subarray(Math.max(0, bytes.length - EDGE)));
  if (!edges.includes('/Encrypt')) return null;
  const all = latin1(bytes);
  if (all.includes('/EBX_HANDLER')) return 'adobe';
  if (all.includes('/Adobe.APS')) return 'adobe';
  if (/\/FOPN_/.test(all)) return 'other';
  return null;
}

// 'adobe' | 'lcp' | 'apple' | 'other' | null. Ante cualquier duda (zip roto, lo que sea),
// null: que lo intente abrir el lector y diga lo suyo, como antes.
export async function drmOf(buffer, kind) {
  try {
    if (kind === 'epub') return await epubDrm(buffer);
    if (kind === 'pdf') return pdfDrm(buffer);
  } catch { /* sin veredicto */ }
  return null;
}

export function helpUrl(lang) {
  return lang === 'es' ? '/es/ayuda/guias/books-without-drm/' : '/help/guias/books-without-drm/';
}
