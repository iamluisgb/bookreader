import { test, expect } from '@playwright/test';
import path from 'path';

const EPUB = path.join(__dirname, 'test.epub');

// Seguridad de la API key BYOK. La key vive en el localStorage del documento padre. El
// contenido del EPUB se renderiza en un iframe same-origin (epub.js lo exige para paginar),
// así que la ÚNICA barrera que impide a un <script> del libro leer parent.localStorage es que
// el iframe NO tenga `allow-scripts` (+ la CSP heredada). Este test falla si esa barrera se
// rompe (p. ej. si alguien vuelve a añadir allow-scripts, como hacía el código original).

test('el iframe de contenido del EPUB no permite ejecutar scripts (protege la API key)', async ({ page }) => {
  await page.goto('/index.html');
  await page.setInputFiles('#file-input', EPUB);
  await page.waitForSelector('#epub-container iframe', { timeout: 15000 });
  await page.waitForTimeout(1000);

  const result = await page.evaluate(async () => {
    // Simula que el usuario ya guardó su key.
    localStorage.setItem('bookreader_ai_key', JSON.stringify('SECRET-KEY-123'));
    const iframe = document.querySelector('#epub-container iframe') as HTMLIFrameElement;
    const sandbox = iframe.getAttribute('sandbox') || '';

    // Intenta lo que haría un EPUB malicioso: inyectar un <script> que exfiltre la key del
    // padre a una variable global observable.
    (window as any).__leaked = 'clean';
    let injected = false;
    try {
      const d = iframe.contentDocument!;
      const s = d.createElement('script');
      s.textContent = 'try { parent.__leaked = parent.localStorage.getItem("bookreader_ai_key"); } catch (e) { parent.__leaked = "ERR:" + e.name; }';
      d.body.appendChild(s);
      injected = true;
    } catch (e) { /* sin acceso al doc: aún mejor */ }
    await new Promise((r) => setTimeout(r, 300));
    return { sandbox, injected, leaked: (window as any).__leaked };
  });

  // El sandbox no debe conceder allow-scripts.
  expect(result.sandbox).not.toContain('allow-scripts');
  // El script inyectado no debe haber corrido → la key no se filtró.
  expect(result.leaked).not.toContain('SECRET-KEY-123');
  expect(result.leaked).toBe('clean');
});
