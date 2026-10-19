import { test, expect } from '@playwright/test';
import { createSyncServer, installSyncServer, seedBookReaderSync } from './bookreader-sync-mock';

// MON4 F2 · Cifrado del sync de BookReader y emparejamiento. Lo que se comprueba:
//   - el servidor no ve ni contenidos, ni rutas, ni nombres en claro;
//   - lo cifrado para una ruta no se descifra en otra, ni recortado, ni con otra clave;
//   - la clave de recuperación va y vuelve, y detecta los errores al teclearla;
//   - un segundo dispositivo NO crea otra clave si ya hay datos: empareja o recupera.

test.describe('MON4 F2 — cifrado y emparejamiento', () => {
  test('cifrar y descifrar: ida y vuelta por trozos; ruta, recorte o clave equivocada fallan', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(async () => {
      const C = await import('/js/sync/sync-crypto.js');
      const k = await C.importKeys(C.generateKey());
      const otra = await C.importKeys(C.generateKey());
      const pid = await C.pathId(k, 'bookreader/books/abc.json');
      const pid2 = await C.pathId(k, 'bookreader/books/xyz.json');
      // 9 MB: tres trozos de 4 MB (el último corto).
      const big = new Uint8Array(9 * 1024 * 1024);
      for (let i = 0; i < big.length; i += 4096) big[i] = i % 251;
      const ct = await C.encrypt(k, pid, big);
      const back = new Uint8Array(await (await C.decrypt(k, pid, ct)).arrayBuffer());
      const same = back.length === big.length && back.every((v, i) => v === big[i]);
      const fails = async (fn: () => Promise<unknown>) => { try { await fn(); return false; } catch { return true; } };
      return {
        pidShape: /^[A-Za-z0-9_-]{43}$/.test(pid),
        pidStable: pid === await C.pathId(k, 'bookreader/books/abc.json'),
        pidOtherKey: pid !== await C.pathId(otra, 'bookreader/books/abc.json'),
        size: ct.size === C.encryptedSize(big.length),
        same,
        text: await C.decryptText(k, pid, await C.encrypt(k, pid, 'hola')),
        empty: (await C.decrypt(k, pid, await C.encrypt(k, pid, new Uint8Array(0)))).size,
        otraRuta: await fails(() => C.decrypt(k, pid2, ct)),
        otraClave: await fails(() => C.decrypt(otra, pid, ct)),
        recortado: await fails(() => C.decrypt(k, pid, ct.slice(0, C.SEG_ENC * 2))),
        nombre: await C.decryptName(k, await C.encryptName(k, 'bookreader/settings.json')),
        nombreAleatorio: (await C.encryptName(k, 'x')) !== (await C.encryptName(k, 'x')),
      };
    });
    expect(r).toEqual({
      pidShape: true, pidStable: true, pidOtherKey: true, size: true, same: true, text: 'hola', empty: 0,
      otraRuta: true, otraClave: true, recortado: true, nombre: 'bookreader/settings.json', nombreAleatorio: true,
    });
  });

  test('clave de recuperación: 14 grupos, tolera minúsculas y O/I/L, y detecta una errata', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(async () => {
      const C = await import('/js/sync/sync-crypto.js');
      const raw = C.generateKey();
      const code = await C.recoveryCode(raw);
      const back = await C.parseRecoveryCode(code.toLowerCase().replace(/0/g, 'o').replace(/-/g, ' '));
      const typo = code.slice(0, 5) + (code[5] === 'A' ? 'B' : 'A') + code.slice(6);
      let typoCode = '';
      try { await C.parseRecoveryCode(typo); } catch (e: any) { typoCode = e.code; }
      return { groups: code.split('-').length, same: back.every((v: number, i: number) => v === raw[i]), typoCode };
    });
    expect(r).toEqual({ groups: 14, same: true, typoCode: 'typo' });
  });

  test('primer dispositivo crea la clave; el servidor solo ve bytes, hashes y nombres cifrados', async ({ page }) => {
    const server = await createSyncServer();
    await installSyncServer(page, server);
    await seedBookReaderSync(page);
    await page.goto('/');
    const r = await page.evaluate(async () => {
      const A = await import('/js/sync/bookreader-auth.js');
      const first = await A.enable();
      const again = await A.enable();
      return { first, again, connected: A.isConnected(), code: await A.recoveryCode() };
    });
    expect(r.first).toEqual({ state: 'ready', created: true });
    expect(r.again).toEqual({ state: 'ready' });
    expect(r.connected).toBe(true);
    const rows = server.env.DB._raw.prepare('SELECT path, name FROM objects').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rows[0].name).not.toContain('keycheck');
    for (const bytes of server.env.SYNC._m.values()) {
      expect(Buffer.from(bytes).toString('latin1')).not.toContain('keycheck');
    }
  });

  test('segundo dispositivo: con datos en el servidor pide emparejar; el enlace lo empareja; una clave ajena no entra', async ({ browser }) => {
    const server = await createSyncServer();
    const pc = await browser.newContext();
    const movil = await browser.newContext();
    for (const c of [pc, movil]) await installSyncServer(c, server);
    await seedBookReaderSync(pc);
    const pcPage = await pc.newPage();
    await pcPage.goto('/');
    const link = await pcPage.evaluate(async () => {
      const A = await import('/js/sync/bookreader-auth.js');
      await A.enable();
      return A.pairingLink();
    });
    expect(link).toMatch(/#pair=[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]+$/);

    // El móvil tiene licencia pero ninguna clave: no debe inventarse otra.
    await seedBookReaderSync(movil);
    const m = await movil.newPage();
    await m.goto('/');
    const sinClave = await m.evaluate(async () => (await import('/js/sync/bookreader-auth.js')).enable());
    expect(sinClave).toEqual({ state: 'needs-key' });

    const ajena = await m.evaluate(async () => {
      const A = await import('/js/sync/bookreader-auth.js');
      const C = await import('/js/sync/sync-crypto.js');
      try { await A.useKey(C.generateKey()); return 'entró'; } catch (e: any) { return e.code + ':' + A.hasKey(); }
    });
    expect(ajena).toBe('wrong_key:false');

    const frag = link.slice(link.indexOf('#'));
    const r = await m.evaluate(async (hash) => {
      history.replaceState({}, '', location.pathname + hash);
      const A = await import('/js/sync/bookreader-auth.js');
      const p = A.consumePairLink();
      await A.useKey(p!.raw);
      return { license: p!.license, hashLeft: location.hash, ready: await A.enable() };
    }, frag);
    expect(r.license).toBe('BKRD-TEST-SYNC');
    expect(r.hashLeft).toBe('');
    expect(r.ready).toEqual({ state: 'ready' });
    const k1 = await pcPage.evaluate(() => localStorage.getItem('bookreader_sync_key'));
    const k2 = await m.evaluate(() => localStorage.getItem('bookreader_sync_key'));
    expect(k2).toBe(k1);
    await pc.close();
    await movil.close();
  });

  test('una clave de otro sync en un dispositivo con OTRA licencia no se acepta (espacio vacío)', async ({ browser }) => {
    const server = await createSyncServer();
    const pc = await browser.newContext();
    const otro = await browser.newContext();
    for (const c of [pc, otro]) await installSyncServer(c, server);
    await seedBookReaderSync(pc, 'BKRD-LIC-AAAA');
    await seedBookReaderSync(otro, 'BKRD-LIC-BBBB');
    const a = await pc.newPage();
    await a.goto('/');
    const raw = await a.evaluate(async () => {
      await (await import('/js/sync/bookreader-auth.js')).enable();
      return localStorage.getItem('bookreader_sync_key');
    });
    const b = await otro.newPage();
    await b.goto('/');
    const r = await b.evaluate(async (raw) => {
      const A = await import('/js/sync/bookreader-auth.js');
      const C = await import('/js/sync/sync-crypto.js');
      try { await A.useKey(C.fromB64url(JSON.parse(raw!))); return 'entró'; } catch (e: any) { return e.code + ':' + A.hasKey(); }
    }, raw);
    expect(r).toBe('empty:false');
    await pc.close();
    await otro.close();
  });

  test('la clave del sync y su token no salen en el backup ni en el sync', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(async () => {
      localStorage.setItem('bookreader_sync_key', JSON.stringify('k'));
      localStorage.setItem('bookreader_sync_token', JSON.stringify({ token: 't' }));
      localStorage.setItem('bookreader_sync_provider', JSON.stringify('bookreader'));
      const B = await import('/js/backup.js');
      const L = await import('/js/sync/layout.js');
      const backup = JSON.stringify(await B.buildBackup());
      const snap = JSON.stringify(await L.buildSnapshot());
      return { backup: /sync_key|sync_token|sync_provider/.test(backup), snap: /sync_key|sync_token|sync_provider/.test(snap) };
    });
    expect(r).toEqual({ backup: false, snap: false });
  });
});
