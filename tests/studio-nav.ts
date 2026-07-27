// Camino de entrada a los artefactos: la pestaña Studio. Los iconos sueltos del toolbar
// (#ai-convo-cards / -summary / -mindmap) se retiraron —su casa es el Studio, que además
// muestra estado e historial—, así que los tests entran por donde entra el usuario.
import { Page } from '@playwright/test';

// Abre el generador de un tipo desde el Studio. El botón es `.studio-gen` cuando no hay nada
// generado y `.studio-new` ("Nuevo") cuando ya hay historial: ambos comparten data-act="gen".
export async function openFromStudio(page: Page, kind: 'summary' | 'mindmap' | 'flashcards' | 'feynman') {
  await page.locator('.ai-tab[data-view="studio"]').click();
  await page.locator(`[data-act="gen"][data-kind="${kind}"]`).first().click();
}

// Reabre un artefacto YA generado desde su tarjeta del historial. En el Studio esto es una
// acción distinta de "Nuevo" (que abre la configuración para generar otro) — una distinción
// que el icono suelto del toolbar no podía hacer: siempre reabría el más reciente.
export async function openArtifactFromStudio(page: Page, kind: 'summary' | 'mindmap') {
  await page.locator('.ai-tab[data-view="studio"]').click();
  await page.locator(`[data-act="open"][data-kind="${kind}"]`).first().click();
}
