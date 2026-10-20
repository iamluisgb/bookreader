// MON4 F2 · Cifrado de extremo a extremo del sync de BookReader (ADR-056 §4).
//
// La clave del sync es ALEATORIA (32 bytes), nace en el primer dispositivo y pasa a los demás
// por el enlace de emparejamiento o la clave de recuperación. No sale de la licencia a
// propósito: la license key llega al servidor, y una clave derivada de ella la podríamos
// descifrar nosotros.
//
// De la clave salen dos (HKDF):
//   - `enc`: AES-GCM para el contenido y para el nombre de cada fichero;
//   - `mac`: HMAC-SHA256 para la RUTA que ve el servidor. Es determinista (la misma ruta da
//     el mismo id, que es lo que el servidor indexa) y no revela nada: ni títulos ni ids de
//     libro. El nombre real viaja aparte, cifrado, para que el listado se pueda descifrar.
//
// Formato del contenido: trozos de SEG bytes, cada uno `iv(12) ‖ AES-GCM(trozo)` con el id
// de la ruta, el índice y si es el último como datos asociados. Así:
//   - un libro de cientos de MB se cifra y descifra por trozos, sin tenerlo entero dos veces;
//   - la subida por partes (F4) parte por múltiplos exactos de trozo;
//   - el servidor no puede cambiar un fichero por otro, reordenar trozos ni cortar el final
//     sin que el descifrado falle.

const SEG = 4 * 1024 * 1024;
const IV = 12;
const TAG = 16;
export const SEG_ENC = SEG + IV + TAG;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s) {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

export function generateKey() {
  return crypto.getRandomValues(new Uint8Array(32));
}

// Las dos claves de trabajo a partir de la clave del sync.
export async function importKeys(raw) {
  if (!(raw instanceof Uint8Array) || raw.length !== 32) throw new Error('clave de sync inválida');
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  const hkdf = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(info) });
  const [encKey, macKey] = await Promise.all([
    crypto.subtle.deriveKey(hkdf('bookreader-sync/enc/v1'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
    crypto.subtle.deriveKey(hkdf('bookreader-sync/path/v1'), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']),
  ]);
  return { enc: encKey, mac: macKey };
}

// La ruta que ve el servidor: 43 caracteres opacos.
export async function pathId(keys, path) {
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', keys.mac, enc.encode(path))));
}

export async function encryptName(keys, path) {
  const iv = crypto.getRandomValues(new Uint8Array(IV));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('name') }, keys.enc, enc.encode(path)));
  const out = new Uint8Array(IV + ct.length);
  out.set(iv);
  out.set(ct, IV);
  return b64url(out);
}

export async function decryptName(keys, name) {
  const b = fromB64url(name);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, IV), additionalData: enc.encode('name') }, keys.enc, b.subarray(IV));
  return dec.decode(pt);
}

const aad = (pid, i, last) => enc.encode(`${pid}:${i}:${last ? 1 : 0}`);

// Tamaño cifrado de `n` bytes en claro (un fichero vacío es un trozo vacío).
export function encryptedSize(n) {
  const segs = Math.max(1, Math.ceil(n / SEG));
  return n + segs * (IV + TAG);
}

// Cifra el trozo `i` (de `count`) de `plain`, que ya viene cortado.
async function sealSegment(keys, pid, i, count, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(IV));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(pid, i, i === count - 1) }, keys.enc, plain));
  const out = new Uint8Array(IV + ct.length);
  out.set(iv);
  out.set(ct, IV);
  return out;
}

// Cifra un Blob (o bytes, o texto) para la ruta `pid`. Devuelve un Blob, sin tener el fichero
// entero en memoria dos veces: se lee y se cifra trozo a trozo.
export async function encrypt(keys, pid, data) {
  const blob = data instanceof Blob ? data : new Blob([typeof data === 'string' ? enc.encode(data) : data]);
  const count = Math.max(1, Math.ceil(blob.size / SEG));
  const parts = [];
  for (let i = 0; i < count; i++) {
    const plain = new Uint8Array(await blob.slice(i * SEG, (i + 1) * SEG).arrayBuffer());
    parts.push(await sealSegment(keys, pid, i, count, plain));
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}

// Cifra solo los trozos [from, to) de un Blob en claro: la subida por partes cifra cada parte
// justo antes de mandarla.
export async function encryptRange(keys, pid, blob, from, to) {
  const count = Math.max(1, Math.ceil(blob.size / SEG));
  const parts = [];
  for (let i = from; i < Math.min(to, count); i++) {
    const plain = new Uint8Array(await blob.slice(i * SEG, (i + 1) * SEG).arrayBuffer());
    parts.push(await sealSegment(keys, pid, i, count, plain));
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}

export function segmentCount(plainSize) {
  return Math.max(1, Math.ceil(plainSize / SEG));
}

// Descifra lo que devolvió `encrypt` para la misma ruta. Lanza si la clave no es la buena o si
// alguien tocó, reordenó o cortó los trozos.
export async function decrypt(keys, pid, data, { type = 'application/octet-stream' } = {}) {
  const blob = data instanceof Blob ? data : new Blob([data]);
  const count = Math.max(1, Math.ceil(blob.size / SEG_ENC));
  const parts = [];
  for (let i = 0; i < count; i++) {
    const seg = new Uint8Array(await blob.slice(i * SEG_ENC, (i + 1) * SEG_ENC).arrayBuffer());
    if (seg.length < IV + TAG) throw new Error('cifrado corrupto');
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: seg.subarray(0, IV), additionalData: aad(pid, i, i === count - 1) },
      keys.enc, seg.subarray(IV),
    );
    parts.push(new Uint8Array(pt));
  }
  return new Blob(parts, { type });
}

export async function decryptText(keys, pid, data) {
  return (await decrypt(keys, pid, data)).text();
}

// ---- Bloques sellados por separado (IA10 · almacén de pasajes) -------------------------------
//
// Un objeto hecho de bloques pequeños de tamaño libre, cada uno `iv ‖ AES-GCM(bloque)` con la
// ruta, su posición y el TOTAL como datos asociados (otro prefijo que el de los trozos de 4 MB,
// para que uno no pase por el otro). Quien sabe dónde empieza cada bloque (`offsets`, que va en
// el manifiesto del índice) lee y abre solo los que necesita, con una lectura por rango. El
// servidor no puede cambiar un bloque de sitio, mezclar dos objetos ni quitar el final.

const blockAad = (pid, i, count) => enc.encode(`${pid}:blk:${i}:${count}`);

/** Sella `blocks` (Uint8Array[]) para `pid`. Devuelve { body, offsets } (offsets.length = n + 1). */
export async function sealBlocks(keys, pid, blocks) {
  const out = [];
  const offsets = [0];
  for (const [i, plain] of blocks.entries()) {
    const iv = crypto.getRandomValues(new Uint8Array(IV));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: blockAad(pid, i, blocks.length) }, keys.enc, plain));
    const sealed = new Uint8Array(IV + ct.length);
    sealed.set(iv);
    sealed.set(ct, IV);
    out.push(sealed);
    offsets.push(offsets[offsets.length - 1] + sealed.length);
  }
  const body = new Uint8Array(offsets[offsets.length - 1]);
  out.forEach((b, i) => body.set(b, offsets[i]));
  return { body, offsets };
}

/** Abre el bloque `i` de `count` (sus bytes sellados, tal como los dio la lectura por rango). */
export async function openBlock(keys, pid, sealed, i, count) {
  if (sealed.length < IV + TAG) throw new Error('cifrado corrupto');
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: sealed.subarray(0, IV), additionalData: blockAad(pid, i, count) },
    keys.enc, sealed.subarray(IV),
  ));
}

// ---- Clave de recuperación ------------------------------------------------------------------
//
// La clave en Crockford base32 (sin letras que se confundan: ni I, L, O ni U), en grupos de 4
// con guiones, más 2 caracteres de control: un error al teclearla se detecta antes de probarla
// contra el servidor. 52 + 2 = 54 caracteres, 14 grupos.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function toBase32(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(s) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error('carácter no válido');
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function checksum(raw) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  return ALPHABET[d[0] & 31] + ALPHABET[d[1] & 31];
}

export async function recoveryCode(raw) {
  const s = toBase32(raw) + (await checksum(raw));
  return s.match(/.{1,4}/g).join('-');
}

// Acepta la clave con o sin guiones, en minúsculas y con las confusiones típicas al teclear
// (O por 0, I/L por 1). Devuelve los 32 bytes o lanza con code 'typo' si no cuadra el control.
export async function parseRecoveryCode(code) {
  const s = String(code || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  const err = () => Object.assign(new Error('clave de recuperación no válida'), { code: 'typo' });
  if (s.length !== 54) throw err();
  let raw;
  try { raw = fromBase32(s.slice(0, 52)).subarray(0, 32); } catch { throw err(); }
  if (raw.length !== 32 || (await checksum(raw)) !== s.slice(52)) throw err();
  return raw;
}
