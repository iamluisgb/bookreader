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
};

let current = { ...defaults, ...Storage.get(SETTINGS_KEY, {}) };

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
    let resolved = current.theme;
    if (!resolved || resolved === 'system') {
      resolved = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    const bar = { light: '#ffffff', dark: '#1c1c1e', sepia: '#f1e9d6' };
    meta.setAttribute('content', bar[resolved] || bar.light);
  }

  // Update theme buttons
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === current.theme);
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
