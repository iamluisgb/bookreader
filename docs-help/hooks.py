"""Hooks de MkDocs para la ayuda de BookReader.

Cada lengua se compila con su propio `mkdocs.*.yml` (mismo árbol de páginas, distinto
`docs_dir`), así que las URLs quedan limpias: /help/… y /es/ayuda/… sin prefijos
anidados. Este hook hace dos cosas:

1. Selector de idioma: pone en Material el enlace a la MISMA página en la otra
   lengua, que es lo que espera quien está leyendo un artículo.
2. Footer con la fecha: cada página lleva `updated:` en su frontmatter y el pie se
   genera aquí, no a mano en el Markdown — así la fecha no envejece mal y el enlace
   de feedback («¿te sirvió?») sale en todas las páginas con el contexto (título y
   URL) ya relleno.
"""

from urllib.parse import quote

MONTHS_ES = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]

MAIL = 'hola@raiatech.com'


def _footer(page, config):
    meta = page.meta or {}
    raw = str(meta.get('updated') or '').strip()
    if not raw:
        return ''
    try:
        y, m, d = (int(p) for p in raw.split('-'))
    except ValueError:
        return ''
    lang = config.get('theme', {}).get('language') or 'en'
    url = page.canonical_url or ''
    subject = quote(f'BookReader ayuda: {page.title} ({url})')
    mail = f'<a href="mailto:{MAIL}?subject={subject}">'
    if lang == 'es':
        date = f'{d} de {MONTHS_ES[m - 1]} de {y}'
        return (
            f'<p class="ayuda-footer">Actualizado el {date}. ¿Te sirvió esta página? '
            f'{mail}Dímelo</a>: la ayuda se corrige con lo que se atasca de verdad.</p>'
        )
    date = f'{d} {MONTHS_EN[m - 1]} {y}'
    return (
        f'<p class="ayuda-footer">Updated on {date}. Did this page help? '
        f'{mail}Tell me</a>: the help gets fixed where things actually get stuck.</p>'
    )


MONTHS_EN = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
]


def on_page_context(context, page, config, nav):
    extra = config.get("extra") or {}
    other_root = extra.get("other_root")
    if other_root:
        # `page.url` es relativa al site_dir y acaba en «/» ('' en la portada).
        url = page.url or ""
        config.extra["alternate"] = [
            {
                "name": extra.get("other_name") or extra.get("other_lang", ""),
                "link": other_root + url,
                "lang": extra.get("other_lang", ""),
            }
        ]
    return context


def on_page_content(html, page, config, files):
    # El footer va tras el contenido, sin tocar la plantilla de Material: si
    # Material cambia content.html, esto sigue funcionando.
    footer = _footer(page, config)
    return html + footer if footer else html
