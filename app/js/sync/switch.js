// MON4 F3/F5 · Cambiar de proveedor de sync, y pasar lo sincronizado de uno a otro.
//
// Cambiar es: elegir el proveedor, olvidar lo acordado con el anterior (engine ·
// resetRemoteState) y sincronizar. Como el merge es idempotente, el primer ciclo con el nuevo
// sube lo local entero y baja lo que hubiera.
//
// Migrar («Pasar mi sync de Drive a BookReader», y al revés para quien cancela) añade dos
// pasos, para que no se quede nada atrás:
//   1. ANTES de cambiar, un ciclo con el proveedor viejo: lo que otro dispositivo subió y este
//      aún no tenía, baja aquí y viaja con lo local.
//   2. DESPUÉS, los ficheros de libro: los que están en el viejo y no en el nuevo se copian
//      pasando por este navegador (bajar, verificar y subir, uno a uno). Lo que el nuevo no
//      admite (sin ficheros en el plan, o al tope) se queda en el viejo y se dice cuántos.
// El proveedor viejo no se borra: los datos siguen allí por si hace falta volver.

import * as Provider from './provider.js';
import * as Engine from './engine.js';
import { BASE } from './layout.js';

// Activa `id` sin migrar (primer sync, o el dispositivo ya estaba al día).
export async function activate(id) {
  Provider.setActive(id);
  Engine.resetRemoteState();
  Engine.setIntentionalOff(false);
  return Engine.syncNow();
}

// Pasa lo sincronizado de `from` a `to` y deja `to` activo. Los dos tienen que estar
// conectados. `onProgress({ step, done, total })` para la UI.
export async function migrate(from, to, onProgress = () => {}) {
  const src = Provider.get(from);
  const dst = Provider.get(to);
  if (!src || !dst || from === to) throw new Error('migración no válida');
  if (!src.isConnected() || !dst.isConnected()) throw new Error('reconnect');

  // 1) Ponerse al día con el viejo. Si el viejo ya solo deja leer (suscripción caducada), el
  //    ciclo baja y luego falla al subir: lo bajado ya está aplicado y es lo que importa.
  onProgress({ step: 'pull', done: 0, total: 1 });
  if (Provider.activeId() === from) await Engine.syncNow();
  const files = (await src.list(BASE + 'files/')).map(f => f.path);

  // 2) Cambiar y subir todo lo local al nuevo.
  onProgress({ step: 'push', done: 0, total: 1 });
  Provider.setActive(to);
  Engine.resetRemoteState();
  Engine.setIntentionalOff(false);
  const r = await Engine.syncNow();
  if (r === 'error') {
    const diag = Engine.getDiag();
    throw new Error(diag.lastError || 'sync');
  }

  // 3) Ficheros de libro, servidor a servidor a través de este navegador.
  let copied = 0;
  let skipped = 0;
  const canFiles = dst.canTransferFiles();
  for (let i = 0; i < files.length; i++) {
    onProgress({ step: 'files', done: i, total: files.length });
    if (!canFiles) { skipped++; continue; }
    try {
      if (await dst.exists(files[i])) continue;
      const got = await src.readBinary(files[i]);
      if (!got) continue;
      await dst.writeBinary(files[i], got.blob, { mime: got.blob.type });
      copied++;
    } catch (e) {
      if (dst.isQuotaError(e)) { skipped += files.length - i; break; }
      skipped++;
    }
  }
  onProgress({ step: 'done', done: files.length, total: files.length });
  return { pulled: r.pulled || 0, pushed: r.pushed || 0, files: files.length, copied, skipped };
}
