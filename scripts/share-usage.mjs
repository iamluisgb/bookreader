// Gasto del almacén de enlaces compartidos (workers/share) frente a lo GRATIS de R2.
// Los topes del Worker están al 80 %: por encima se niega a subir o bajar, nunca cobra.
//
//   SHARE_USAGE_TOKEN=… npm run share:usage
// (el token es el secret USAGE_TOKEN del Worker; también se lee de .env).
import { readFileSync, existsSync } from 'node:fs';

const BASE = process.env.SHARE_URL || 'https://bookreader-share.luisgonzalezb93.workers.dev/v1';
let token = process.env.SHARE_USAGE_TOKEN;
if (!token && existsSync('.env')) token = (readFileSync('.env', 'utf8').match(/^SHARE_USAGE_TOKEN=(.+)$/m) || [])[1]?.trim();
if (!token) { console.error('Falta SHARE_USAGE_TOKEN (en el entorno o en .env).'); process.exit(1); }

const res = await fetch(`${BASE}/usage`, { headers: { Authorization: `Bearer ${token}` } });
if (!res.ok) { console.error(`HTTP ${res.status}`); process.exit(1); }
const u = await res.json();
const gb = (b) => (b / 1024 ** 3).toFixed(2) + ' GB';
const bar = (p) => '█'.repeat(Math.min(20, Math.round(p / 5))).padEnd(20, '·');
console.log(`Mes ${u.month} · ${u.links} enlaces vivos · ${u.refused} rechazados por tope`);
console.log(`Almacenamiento  ${bar(u.storage.pctOfFree)} ${String(u.storage.pctOfFree).padStart(5)} % de 10 GB   (${gb(u.storage.bytes)}; tope ${gb(u.storage.cap)})`);
console.log(`Escrituras (A)  ${bar(u.classA.pctOfFree)} ${String(u.classA.pctOfFree).padStart(5)} % de 1 M     (${u.classA.ops}; tope ${u.classA.cap})`);
console.log(`Lecturas (B)    ${bar(u.classB.pctOfFree)} ${String(u.classB.pctOfFree).padStart(5)} % de 10 M    (${u.classB.ops}; tope ${u.classB.cap})`);
