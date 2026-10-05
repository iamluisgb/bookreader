// P24 F2 · Pantalla de importar un dossier: qué trae, de quién (según el fichero) y qué
// pasará con cada libro, con casillas para quedarse solo con parte. Se carga perezosa
// desde app.js al elegir un .bookreader.
import { t } from '../i18n.js';
import { formBox, alertBox } from '../ui/dialog.js';
import * as Import from './import.js';

function sizeOf(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb < 1 ? Math.max(1, Math.round(bytes / 1024)) + ' KB' : (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + ' MB';
}

function stateLabel(b) {
  const s = b.state === 'have' ? t('ya lo tienes')
    : b.state === 'attach' ? t('trae el fichero que te faltaba')
    : b.state === 'new' ? [t('nuevo'), sizeOf(b.file?.size)].filter(Boolean).join(' · ')
    : b.entry.source ? t('sin fichero: consíguelo en {url}', { url: b.entry.source.replace(/^https?:\/\//, '') })
    : t('sin fichero: solo notas');
  return b.tampered ? `${s} · ${t('el fichero incluido no coincide y se descarta')}` : s;
}

function summary(total) {
  const count = (n, one, many) => (n === 1 ? t(one) : t(many, { n }));
  const parts = [];
  if (total.highlights) parts.push(count(total.highlights, '1 subrayado', '{n} subrayados'));
  if (total.notes) parts.push(count(total.notes, '1 nota de libreta', '{n} notas de libreta'));
  if (total.artifacts) parts.push(count(total.artifacts, '1 artefacto', '{n} artefactos'));
  if (total.cards) parts.push(count(total.cards, '1 tarjeta', '{n} tarjetas'));
  return parts.join(' · ');
}

// Devuelve el resultado de Import.apply, o null si se canceló o falló.
export async function importDossier(file) {
  let p;
  try {
    p = await Import.plan(file);
  } catch (e) {
    console.warn('Dossier no válido:', e);
    await alertBox(t('Este fichero no es un dossier de BookReader válido.'), { title: t('Abrir dossier') });
    return null;
  }
  const from = p.bundle.author
    ? t('De {name} (según el fichero).', { name: p.bundle.author })
    : t('Sin remitente.');
  const res = await formBox({
    title: t('Abrir «{name}»', { name: p.bundle.shelf?.name || '' }),
    message: [from, summary(p.total)].filter(Boolean).join(' '),
    fields: [{
      name: 'books', label: 'Libros', type: 'checks',
      value: p.books.map(b => b.entry.bookId),
      options: p.books.map(b => ({ value: b.entry.bookId, label: `${b.entry.title || t('Sin título')} — ${stateLabel(b)}` })),
    }],
    okText: t('Importar'),
  });
  if (!res || !(res.books || []).length) return null;
  const out = await Import.apply(p, res.books);
  const shelf = Import.shelfNameFor(p.bundle);
  if (out.scope === 'book') {
    await alertBox(t('Listo: «{title}» está en tu biblioteca, con lo de {name}.', { title: p.bundle.shelf?.name || '', name: p.bundle.author || t('quien te lo manda') }),
      { title: t('Abrir dossier') });
    return out;
  }
  await alertBox(out.books === 1
    ? t('Listo: 1 libro en la estantería «{shelf}».', { shelf })
    : t('Listo: {n} libros en la estantería «{shelf}».', { n: out.books, shelf }),
    { title: t('Abrir dossier') });
  return out;
}
