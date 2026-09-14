// SHA-256 incremental, en JS.
//
// Por qué no `crypto.subtle.digest`: la WebCrypto no tiene API de streaming —
// hay que darle el mensaje ENTERO en memoria. Verificar una revista de 400 MB
// recién bajada significaba tener sus 400 MB en el heap (más la copia
// defensiva) y dejar el hilo principal sin ceder durante segundos: la app se
// quedaba clavada justo al acabar la barra de descarga.
//
// Con esto el fichero se verifica leyéndolo del Blob a trozos, así que el pico
// de memoria es un trozo y no el libro. Es más lento que la WebCrypto (~50
// MB/s contra ~500), pero corre en un Worker (ver hash-blob.js), donde la
// lentitud no la nota nadie.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  constructor() {
    this.h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    this.w = new Uint32Array(64);   // reutilizado en cada bloque: 0 basura por trozo
    this.tail = new Uint8Array(64); // bytes sueltos que no completaron bloque
    this.tailLen = 0;
    this.bytes = 0;
  }

  update(data) {
    this.bytes += data.length;
    let off = 0;
    if (this.tailLen) {
      const need = Math.min(64 - this.tailLen, data.length);
      this.tail.set(data.subarray(0, need), this.tailLen);
      this.tailLen += need;
      off = need;
      if (this.tailLen < 64) return this;
      this.block(this.tail, 0);
      this.tailLen = 0;
    }
    for (; off + 64 <= data.length; off += 64) this.block(data, off);
    if (off < data.length) {
      this.tail.set(data.subarray(off), 0);
      this.tailLen = data.length - off;
    }
    return this;
  }

  hex() {
    // Relleno: 0x80, ceros hasta dejar 8 bytes, y la longitud en BITS (64 bits
    // big-endian). La parte alta importa de verdad aquí: por encima de 512 MB
    // el contador de bits ya no cabe en 32.
    const padded = new Uint8Array(this.tailLen + ((this.tailLen < 56 ? 56 : 120) - this.tailLen) + 8);
    padded.set(this.tail.subarray(0, this.tailLen), 0);
    padded[this.tailLen] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, Math.floor(this.bytes / 0x20000000));
    dv.setUint32(padded.length - 4, (this.bytes * 8) >>> 0);
    for (let i = 0; i < padded.length; i += 64) this.block(padded, i);
    let out = '';
    for (let i = 0; i < 8; i++) out += this.h[i].toString(16).padStart(8, '0');
    return out;
  }

  block(buf, off) {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const p = off + i * 4;
      w[i] = (buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = this.h[0], b = this.h[1], c = this.h[2], d = this.h[3];
    let e = this.h[4], f = this.h[5], g = this.h[6], h = this.h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    this.h[0] = (this.h[0] + a) >>> 0; this.h[1] = (this.h[1] + b) >>> 0;
    this.h[2] = (this.h[2] + c) >>> 0; this.h[3] = (this.h[3] + d) >>> 0;
    this.h[4] = (this.h[4] + e) >>> 0; this.h[5] = (this.h[5] + f) >>> 0;
    this.h[6] = (this.h[6] + g) >>> 0; this.h[7] = (this.h[7] + h) >>> 0;
  }
}

// Hash de un Blob leyéndolo a trozos. `onProgress(leídos, total)` opcional.
// El trozo es de 4 MB: suficiente para que el coste por rebanada domine sobre
// el de pedirla, y bastante pequeño para no engordar el heap.
export const HASH_CHUNK = 4 * 1024 * 1024;

export async function sha256Blob(blob, onProgress = null) {
  const h = new Sha256();
  for (let at = 0; at < blob.size; at += HASH_CHUNK) {
    const part = blob.slice(at, Math.min(at + HASH_CHUNK, blob.size));
    h.update(new Uint8Array(await part.arrayBuffer()));
    if (onProgress) onProgress(Math.min(at + HASH_CHUNK, blob.size), blob.size);
  }
  return h.hex();
}
