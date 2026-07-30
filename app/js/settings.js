import * as Storage from './storage.js';

const SETTINGS_KEY = 'settings';

const defaults = {
  theme: 'system',
  fontSize: 16,
  fontFamily: 'serif',
  columnWidth: 720,
  lineHeight: 1.6,
  brightness: 1,      // 1 = sin atenuar; < 1 oscurece con un overlay (brillo tipo Play Books)
  nightLight: 0,      // 0 = off; > 0 aplica un filtro cálido ámbar (reduce luz azul)
  pdfPaper: 'auto',   // color de papel del PDF: 'auto' sigue al tema de la app (ver ADR-026)
};

// Papel del PDF que corresponde a cada tema cuando el ajuste está en 'auto'. Sin esto, el
// PDF era la única superficie que ignoraba el tema: app en sepia y folio blanco deslumbrando.
const PAPER_BY_THEME = { light: 'white', sepia: 'cream', dark: 'night' };

let current = { ...defaults, ...Storage.get(SETTINGS_KEY, {}) };

// Tema efectivo: 'system' se resuelve contra el sistema operativo.
function resolvedTheme() {
  const th = current.theme;
  if (th && th !== 'system') return th;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Papel efectivo del PDF: nunca devuelve 'auto'. Es la ÚNICA función que decide el papel;
// el resto de la app solo lee el atributo `data-pdf-paper` que publica applySettings.
export function resolvedPdfPaper() {
  const p = current.pdfPaper || 'auto';
  return p === 'auto' ? (PAPER_BY_THEME[resolvedTheme()] || 'white') : p;
}

export function getAll() {
  return { ...current };
}

export function get(key) {
  return current[key];
}

export function set(key, value) {
  current[key] = value;
  Storage.set(SETTINGS_KEY, current);
  applySettings();
}

export function applySettings() {
  // Theme: 'system' = sin atributo (manda prefers-color-scheme); el resto fija el tema.
  if (current.theme && current.theme !== 'system') {
    document.documentElement.setAttribute('data-theme', current.theme);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }

  // theme-color de la barra de estado (PWA), resolviendo 'system'.
  const meta = document.getElementById('meta-theme-color');
  if (meta) {
    const bar = { light: '#ffffff', dark: '#1c1c1e', sepia: '#f1e9d6' };
    meta.setAttribute('content', bar[resolvedTheme()] || bar.light);
  }

  // Papel del PDF. Se resuelve AQUÍ a un valor concreto y se publica como atributo: todo
  // el pintado lo hace el CSS (tinte en multiply / inversión en noche), sin volver a
  // pdf.js y sin re-rasterizar. Ver ADR-026.
  document.documentElement.setAttribute('data-pdf-paper', resolvedPdfPaper());

  // Update theme buttons
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === current.theme);
  });
  document.querySelectorAll('.paper-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.paper === (current.pdfPaper || 'auto'));
  });

  // Font size display
  const fontValue = document.getElementById('font-size-value');
  if (fontValue) fontValue.textContent = current.fontSize + 'px';

  // Column width display
  const colValue = document.getElementById('column-width-value');
  if (colValue) colValue.textContent = current.columnWidth + 'px';

  // Line height display
  const lhValue = document.getElementById('line-height-value');
  if (lhValue) lhValue.textContent = current.lineHeight;

  // Brillo y luz nocturna (overlays de pantalla; la web no controla el brillo/temperatura
  // reales del dispositivo). Brillo = capa negra atenuante; luz nocturna = capa ámbar en
  // multiply que entibia y reduce la luz azul. Ambas con pointer-events:none.
  const dim = document.getElementById('screen-dim');
  if (dim) dim.style.opacity = String(Math.max(0, Math.min(0.7, 1 - (current.brightness ?? 1))));
  const warm = document.getElementById('night-warm');
  if (warm) warm.style.opacity = String(Math.max(0, Math.min(0.75, (current.nightLight ?? 0) * 0.75)));
  const brVal = document.getElementById('brightness-value');
  if (brVal) brVal.textContent = Math.round((current.brightness ?? 1) * 100) + '%';
  const nlVal = document.getElementById('night-light-value');
  if (nlVal) nlVal.textContent = Math.round((current.nightLight ?? 0) * 100) + '%';

  // Apply to reader
  document.documentElement.style.setProperty('--reader-max-width', current.columnWidth + 'px');

  // Emit custom event for epub reader to pick up
  window.dispatchEvent(new CustomEvent('settings:changed', { detail: current }));
}

export function init() {
  // Theme buttons
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => set('theme', btn.dataset.theme));
  });

  // Papel del PDF
  document.querySelectorAll('.paper-btn').forEach(btn => {
    btn.addEventListener('click', () => set('pdfPaper', btn.dataset.paper));
  });

  // Con el tema (o el papel) en 'auto', un cambio de modo del sistema debe arrastrar la
  // app EN CALIENTE. Sin esto, quien lee de noche con el tema del sistema se quedaba con
  // el papel claro hasta recargar — justo el caso que 'auto' existe para cubrir.
  window.matchMedia?.('(prefers-color-scheme: dark)')
    ?.addEventListener?.('change', () => applySettings());

  // Font size
  document.getElementById('font-decrease')?.addEventListener('click', () => {
    if (current.fontSize > 12) {
      set('fontSize', current.fontSize - 1);
    }
  });

  document.getElementById('font-increase')?.addEventListener('click', () => {
    if (current.fontSize < 32) {
      set('fontSize', current.fontSize + 1);
    }
  });

  // Font family
  document.getElementById('font-family-select')?.addEventListener('change', (e) => {
    set('fontFamily', e.target.value);
  });

  // Column width
  document.getElementById('column-width')?.addEventListener('input', (e) => {
    set('columnWidth', parseInt(e.target.value));
  });

  // Line height
  document.getElementById('line-height')?.addEventListener('input', (e) => {
    set('lineHeight', parseFloat(e.target.value));
  });

  // Brillo / Luz nocturna
  document.getElementById('brightness')?.addEventListener('input', (e) => {
    set('brightness', parseFloat(e.target.value));
  });
  document.getElementById('night-light')?.addEventListener('input', (e) => {
    set('nightLight', parseFloat(e.target.value));
  });

  // Set initial values on controls
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === current.theme);
  });

  const fontInput = document.getElementById('font-size-value');
  if (fontInput) fontInput.textContent = current.fontSize + 'px';

  const fontSelect = document.getElementById('font-family-select');
  if (fontSelect) fontSelect.value = current.fontFamily;

  const colSlider = document.getElementById('column-width');
  if (colSlider) colSlider.value = current.columnWidth;

  const lhSlider = document.getElementById('line-height');
  if (lhSlider) lhSlider.value = current.lineHeight;

  const brSlider = document.getElementById('brightness');
  if (brSlider) brSlider.value = current.brightness ?? 1;

  const nlSlider = document.getElementById('night-light');
  if (nlSlider) nlSlider.value = current.nightLight ?? 0;

  applySettings();
}
