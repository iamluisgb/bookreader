import { test, expect } from '@playwright/test';

// rangeForText: localizar el trozo exacto de un pasaje citado dentro de una capa de
// texto de pdf.js (texto partido en muchos <span>, con blancos irregulares).

test.describe('PDF · rangeForText', () => {
  test('localiza texto que cruza varios spans y respeta el offset', async ({ page }) => {
    await page.goto('/');
    const res = await page.evaluate(async () => {
      const { rangeForText } = await import('/js/pdf-locate.js');
      // Capa de texto simulada: pdf.js parte el texto en spans, a veces a mitad de palabra.
      const layer = document.createElement('div');
      layer.innerHTML = '<span>El cabo Litu</span><span>ma subió</span><span> a los Andes</span>';
      document.body.appendChild(layer);

      const r1 = rangeForText(layer, 'Lituma subió');
      const cruzaSpans = rangeForText(layer, 'cabo Lituma subió a los');
      const noExiste = rangeForText(layer, 'texto que no aparece');
      return {
        r1: r1?.toString(),
        cruza: cruzaSpans?.toString(),
        noExiste,
      };
    });
    // El match reconstruye el texto real aunque cruce spans y esté partido "Litu|ma".
    expect(res.r1).toBe('Lituma subió');
    expect(res.cruza).toBe('cabo Lituma subió a los');
    expect(res.noExiste).toBeNull();
  });

  test('tolera blancos irregulares y cae al prefijo en pasajes largos', async ({ page }) => {
    await page.goto('/');
    const res = await page.evaluate(async () => {
      const { rangeForText } = await import('/js/pdf-locate.js');
      const layer = document.createElement('div');
      // Dobles espacios y saltos, como los que mete pdf.js entre items.
      layer.innerHTML = '<span>Los  huesos</span><span>\n de los </span><span>muertos yacían</span>';
      document.body.appendChild(layer);
      // Target con espacios simples: debe casar contra el texto de blancos colapsados.
      const exacto = rangeForText(layer, 'huesos de los muertos');

      // Fallback al prefijo: el corpus tiene una cola que la capa NO tiene (p. ej. el
      // pasaje sigue en la página siguiente); se resalta el prefijo MÁS LARGO presente.
      const layer2 = document.createElement('div');
      layer2.textContent = 'En el páramo de Naccos los terrucos habían tomado el control absoluto';
      document.body.appendChild(layer2);
      const largo = rangeForText(layer2,
        'En el páramo de Naccos los terrucos habían tomado el control absoluto de la carretera y del campamento minero');
      return { exacto: exacto?.toString().replace(/\s+/g, ' '), largo: largo?.toString() };
    });
    expect(res.exacto).toBe('huesos de los muertos');
    // Cayó al prefijo más largo presente: todo lo que la capa sí tiene del pasaje.
    expect(res.largo).toBe('En el páramo de Naccos los terrucos habían tomado el control absoluto');
  });

  test('casa aunque la capa no separe los renglones y parta palabras con guion', async ({ page }) => {
    await page.goto('/');
    const res = await page.evaluate(async () => {
      const { rangeForText } = await import('/js/pdf-locate.js');
      // Capa de texto REAL de pdf.js: un span por renglón, concatenados SIN separador, y
      // una palabra partida con guion de corte. El corpus (segment-pdf) tiene el mismo
      // texto con los renglones unidos por espacio y sin el guion.
      const layer = document.createElement('div');
      layer.innerHTML = '<span>sed do eiusmod</span><span>tempor incidi-</span><span>dunt ut labore</span>';
      document.body.appendChild(layer);
      const r = rangeForText(layer, 'sed do eiusmod tempor incididunt ut labore');
      return { chars: r?.toString().length ?? 0 };
    });
    // El rango cubre los tres renglones (44 chars crudos: 42 del pasaje + el guion partido).
    expect(res.chars).toBeGreaterThan(40);
  });
});
