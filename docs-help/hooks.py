"""Hooks de MkDocs para la ayuda de BookReader.

Cada lengua se compila con su propio `mkdocs.*.yml` (mismo árbol de páginas, distinto
`docs_dir`), así que las URLs quedan limpias: /help/… y /es/ayuda/… sin prefijos
anidados. Este hook pone en el selector de idioma de Material el enlace a la MISMA
página en la otra lengua, que es lo que espera quien está leyendo un artículo.
"""


def on_page_context(context, page, config, nav):
    extra = config.get("extra") or {}
    other_root = extra.get("other_root")
    if not other_root:
        return context
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
