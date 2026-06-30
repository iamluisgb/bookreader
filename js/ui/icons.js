// SF Symbols-inspired line icons. Single source of truth for every glyph in the
// UI (no emoji). Each entry is the inner markup of a 24×24 SVG; the wrapper sets
// stroke: currentColor so icons inherit text colour and tint with the theme.
//
// Usage:
//   import { icon, hydrateIcons } from './ui/icons.js';
//   el.innerHTML = icon('bookmark');           // returns an <svg> string
//   hydrateIcons(root);                         // fills every [data-icon] in root

const ICONS = {
  // ——— chrome / navigation ———
  menu: '<line x1="3.5" y1="7" x2="20.5" y2="7"/><line x1="3.5" y1="12" x2="20.5" y2="12"/><line x1="3.5" y1="17" x2="20.5" y2="17"/>',
  xmark: '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
  'chevron-left': '<polyline points="14.5 5 8 12 14.5 19"/>',
  'chevron-right': '<polyline points="9.5 5 16 12 9.5 19"/>',
  'arrow-up-right': '<line x1="7" y1="17" x2="16.5" y2="7.5"/><polyline points="8.5 7 17 7 17 15.5"/>',
  'chevron-down': '<polyline points="5 9.5 12 16 19 9.5"/>',
  upload: '<path d="M12 15V4.5"/><polyline points="7.5 9 12 4.5 16.5 9"/><path d="M5 14v3.5A1.5 1.5 0 0 0 6.5 19h11a1.5 1.5 0 0 0 1.5-1.5V14"/>',
  sort: '<line x1="5" y1="7" x2="19" y2="7"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="10" y1="17" x2="14" y2="17"/>',
  expand: '<polyline points="9 4 4 4 4 9"/><polyline points="15 4 20 4 20 9"/><polyline points="20 15 20 20 15 20"/><polyline points="4 15 4 20 9 20"/>',
  // Toggles de panel lateral (estilo NotebookLM): marco + divisor del lado.
  'panel-left': '<rect x="3.5" y="4" width="17" height="16" rx="2.3"/><line x1="9.5" y1="4" x2="9.5" y2="20"/>',
  'panel-right': '<rect x="3.5" y="4" width="17" height="16" rx="2.3"/><line x1="14.5" y1="4" x2="14.5" y2="20"/>',

  // ——— actions ———
  bookmark: '<path d="M6.5 4.5h11a1 1 0 0 1 1 1V20l-6.5-4.3L5.5 20V5.5a1 1 0 0 1 1-1Z"/>',
  'bookmark-fill': '<path d="M6.5 4.5h11a1 1 0 0 1 1 1V20l-6.5-4.3L5.5 20V5.5a1 1 0 0 1 1-1Z" fill="currentColor" stroke="none"/>',
  share: '<path d="M12 15V4"/><polyline points="8 8 12 4 16 8"/><path d="M5 14v4a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 18v-4"/>',
  pencil: '<path d="M4 20h4L18.5 9.5a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 16v4Z"/><line x1="13" y1="7" x2="17" y2="11"/>',
  check: '<polyline points="5 12.5 10 17.5 19 7"/>',
  copy: '<rect x="9" y="9" width="10.5" height="10.5" rx="2.4"/><path d="M5.5 15H5A1.5 1.5 0 0 1 3.5 13.5v-8A1.5 1.5 0 0 1 5 4h8a1.5 1.5 0 0 1 1.5 1.5V6"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  ellipsis: '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  books: '<path d="M5 5.5A1.5 1.5 0 0 1 6.5 4H10a1.5 1.5 0 0 1 1.5 1.5V20a2 2 0 0 0-2-2H5V5.5Z"/><path d="M19 5.5A1.5 1.5 0 0 0 17.5 4H14a1.5 1.5 0 0 0-1.5 1.5V20a2 2 0 0 1 2-2H19V5.5Z"/>',
  trash: '<polyline points="4 7 20 7"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7"/><path d="M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 13a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',

  // ——— agent / AI ———
  sparkles: '<path d="M12 3.5l1.5 4.2 4.2 1.5-4.2 1.5L12 14.9l-1.5-4.2L6.3 9.2l4.2-1.5L12 3.5Z"/><path d="M18.5 14l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9Z"/>',
  bubble: '<path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.5L4 20.5l1.2-4.3A8.5 8.5 0 1 1 21 11.5Z"/>',
  note: '<rect x="5" y="3.5" width="14" height="17" rx="2.2"/><line x1="8.5" y1="9" x2="15.5" y2="9"/><line x1="8.5" y1="12.5" x2="15.5" y2="12.5"/><line x1="8.5" y1="16" x2="12.5" y2="16"/>',
  target: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3.6"/><circle cx="12" cy="12" r="0.6" fill="currentColor" stroke="none"/>',
  shield: '<path d="M12 3.5l6.5 2.3v5.2c0 4-2.8 6.8-6.5 8-3.7-1.2-6.5-4-6.5-8V5.8L12 3.5Z"/>',

  // ——— content / blocks ———
  book: '<path d="M5 4.5h7a2 2 0 0 1 2 2V20a2.5 2.5 0 0 0-2.5-2H5V4.5Z"/><path d="M19 4.5h-3a2 2 0 0 0-2 2V20a2.5 2.5 0 0 1 2.5-2H19V4.5Z"/>',
  columns: '<path d="M4 9l8-4.5L20 9"/><line x1="3.5" y1="20" x2="20.5" y2="20"/><line x1="6.5" y1="9.5" x2="6.5" y2="19"/><line x1="10" y1="9.5" x2="10" y2="19"/><line x1="14" y1="9.5" x2="14" y2="19"/><line x1="17.5" y1="9.5" x2="17.5" y2="19"/>',
  chart: '<line x1="5.5" y1="20" x2="5.5" y2="12"/><line x1="12" y1="20" x2="12" y2="4.5"/><line x1="18.5" y1="20" x2="18.5" y2="9"/>',

  // ——— theme glyphs (used inside swatches when helpful) ———
  sun: '<circle cx="12" cy="12" r="4"/><line x1="12" y1="3" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="21"/><line x1="3" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="21" y2="12"/><line x1="5.6" y1="5.6" x2="7" y2="7"/><line x1="17" y1="17" x2="18.4" y2="18.4"/><line x1="18.4" y1="5.6" x2="17" y2="7"/><line x1="7" y1="17" x2="5.6" y2="18.4"/>',
  moon: '<path d="M20 13.5A8 8 0 1 1 10.5 4 6.4 6.4 0 0 0 20 13.5Z"/>',
};

// Build an <svg> string. Defaults match a 22px line icon; `filled` swaps to the
// solid variant when one exists.
export function icon(name, { size = 22, strokeWidth = 1.7, filled = false } = {}) {
  const key = filled && ICONS[name + '-fill'] ? name + '-fill' : name;
  const body = ICONS[key];
  if (!body) return '';
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

// Fill every element carrying a data-icon attribute. Reads optional
// data-icon-size / data-icon-filled overrides. Idempotent.
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    const name = el.getAttribute('data-icon');
    if (!name) return;
    const size = parseInt(el.getAttribute('data-icon-size') || '', 10) || undefined;
    const filled = el.getAttribute('data-icon-filled') === 'true';
    el.innerHTML = icon(name, { size, filled });
  });
}
