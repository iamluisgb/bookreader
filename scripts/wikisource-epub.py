#!/usr/bin/env python3
"""Wikisource (es) → EPUB para la biblioteca libre.

No hay EPUB oficial de estas traducciones: Wikisource publica el texto como páginas wiki (una raíz
con capítulos en subpáginas) y su exportador (ws-export) está detrás de un muro anti-bots. Este
script las compone en un EPUB 3 con índice. Solo stdlib, sin dependencias.

    scripts/wikisource-epub.py --page "Soliloquios" --author "Marco Aurelio" \
        --translator "Jacinto Díaz de Miranda" --out assets/muestra/wikisource/soliloquios.epub

El texto está en dominio público; la transcripción de Wikisource va con CC BY-SA 4.0, y eso se
declara en `dc:rights`. Antes de publicar una obra hay que comprobar la fecha de muerte del
TRADUCTOR: en España la traducción tiene derechos propios (≤1945, u 80 años si murió antes de 1987).

El HTML de Wikisource no es XML (trae `<br>` sin cerrar, entidades HTML y etiquetas sueltas), así que
se vuelve a componer con un parser y una pila de elementos abiertos: eso es lo que hace que el EPUB
sea XML bien formado, que es lo que exige un lector de EPUB.
"""
import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
import uuid
import zipfile
from datetime import datetime, timezone
from html.parser import HTMLParser

API = 'https://es.wikisource.org/w/api.php'
UA = 'BookReader wikisource builder (+https://bookreader.raiatech.com/samples/)'

# Etiquetas que se conservan y cómo se cierran. El resto (tablas de navegación, cajas de aviso,
# estilos) se descarta: no son texto del libro.
VOID = {'br', 'hr', 'wbr'}
BLOQUE = {'p', 'div', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'pre', 'section'}
INLINE = {'i', 'b', 'em', 'strong', 'u', 'sup', 'sub', 'small', 'cite', 'q', 'span'}
PERMITIDAS = BLOQUE | INLINE | VOID
# Cierra lo que esté abierto cuando llega un bloque nuevo (HTML no obliga a cerrar <p>).
CIERRA_P = {'p'}
DESCARTAR = {'table', 'style', 'script', 'figure', 'audio', 'video', 'form', 'input', 'button', 'nav', 'img'}


def api(params, intentos=3):
    url = f"{API}?format=json&" + urllib.parse.urlencode(params)
    for i in range(intentos):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            datos = json.loads(urllib.request.urlopen(req, timeout=30).read().decode('utf-8'))
            return datos if isinstance(datos, dict) else {}
        except Exception:
            if i == intentos - 1:
                raise
            time.sleep(1.2 * (i + 1))
    return {}


def subpaginas(titulo):
    d = api({'action': 'query', 'list': 'allpages', 'apprefix': titulo + '/', 'aplimit': '500'})
    return [p['title'] for p in (d.get('query') or {}).get('allpages', [])]


ROMANOS = {'i': 1, 'v': 5, 'x': 10, 'l': 50, 'c': 100, 'd': 500, 'm': 1000}
APERTURA = re.compile(r'^(prefacio|prólogo|prologo|introducción|introduccion|biografía|biografia|nota|advertencia|dedicatoria|epístola|epistola)', re.I)


def a_numero(s):
    if s.isdigit():
        return int(s)
    t = s.lower()
    if not re.fullmatch(r'[ivxlcdm]+', t):
        return None
    total = 0
    for i, ch in enumerate(t):
        v = ROMANOS[ch]
        sig = ROMANOS[t[i + 1]] if i + 1 < len(t) else 0
        total += -v if v < sig else v
    return total


def clave(titulo):
    """Orden de lectura: material de apertura, luego por número (romano o árabe), luego alfabético."""
    if APERTURA.match(titulo):
        return (1, 0, titulo)
    m = re.search(r'\b([ivxlcdm]{1,7}|\d{1,3})\b', titulo, re.I)
    n = a_numero(m.group(1)) if m and m.group(1) else None
    return (3, 0, titulo) if n is None else (2, n, titulo)


class Saneador(HTMLParser):
    """HTML de Wikisource → XHTML bien formado, con pila de abiertos y sin atributos salvo class."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.salida = []
        self.pila = []
        self.ignorar = 0

    def handle_starttag(self, tag, attrs):
        if tag in DESCARTAR:
            self.ignorar += 1
            return
        if self.ignorar or tag not in PERMITIDAS:
            return
        if tag in CIERRA_P:
            self.cierra_hasta('p')
        clase = dict(attrs).get('class', '')
        # Las clases que importan: poemas y versos (el CSS las usa); el resto se tira.
        clase = ' '.join(c for c in clase.split() if c in ('poem', 'verse', 'indent', 'center'))
        self.salida.append(f'<{tag} class="{clase}">' if clase else f'<{tag}>')
        if tag in VOID:
            self.salida[-1] = f'<{tag}/>'
        else:
            self.pila.append(tag)

    def handle_startendtag(self, tag, attrs):
        if tag in PERMITIDAS and not self.ignorar:
            self.salida.append(f'<{tag}/>')

    def handle_endtag(self, tag):
        if tag in DESCARTAR:
            self.ignorar = max(0, self.ignorar - 1)
            return
        if self.ignorar or tag not in self.pila:
            return
        # Cierra hasta esa etiqueta: si hay anidadas abiertas, se cierran también (así se arreglan
        # los <i> que no se cierran dentro de un párrafo).
        while self.pila:
            t = self.pila.pop()
            self.salida.append(f'</{t}>')
            if t == tag:
                break

    def cierra_hasta(self, tag):
        if tag in self.pila:
            while self.pila:
                t = self.pila.pop()
                self.salida.append(f'</{t}>')
                if t == tag:
                    break

    def handle_data(self, data):
        if self.ignorar:
            return
        limpio = data.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
        limpio = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', limpio)
        if limpio.strip():
            self.salida.append(limpio)

    def cerrar(self):
        while self.pila:
            self.salida.append(f'</{self.pila.pop()}>')
        return ''.join(self.salida)


def a_xhtml(html):
    """Recorta el contenedor de MediaWiki y sanea el resto."""
    m = re.search(r'<div class="mw-parser-output">([\s\S]*)</div>\s*$', html)
    cuerpo = m.group(1) if m else html
    p = Saneador()
    p.feed(cuerpo)
    return p.cerrar()


CSS = """body{font-family:Georgia,serif;line-height:1.6;margin:0 auto;padding:1.2em;max-width:38em;text-align:justify}
h1,h2,h3{font-family:system-ui,sans-serif;line-height:1.25;text-align:left}
h1{font-size:1.5em;margin:0 0 1.2em}h2{font-size:1.2em;margin:1.6em 0 .6em}
p{margin:0 0 .9em;text-indent:1.4em}p:first-of-type,h2+p,h3+p{text-indent:0}
div.poem{white-space:pre-wrap;text-indent:0;margin:0 0 .9em;font-style:italic}
span.center,div.center{display:block;text-align:center}
hr{border:0;border-top:1px solid #ccc;margin:2em 0}"""


def capitulo(titulo, cuerpo, idioma):
    return f"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="{idioma}" lang="{idioma}">
<head><meta charset="utf-8"/><title>{esc(titulo)}</title><link rel="stylesheet" type="text/css" href="estilo.css"/></head>
<body><section epub:type="chapter"><h1>{esc(titulo)}</h1>
{cuerpo}
</section></body></html>"""


def esc(s):
    return (s or '').replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--page', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--author', default='Anónimo')
    ap.add_argument('--translator', default='')
    ap.add_argument('--lang', default='es')
    a = ap.parse_args()
    fuente = 'https://es.wikisource.org/wiki/' + urllib.parse.quote(a.page.replace(' ', '_'))

    subs = sorted(subpaginas(a.page), key=lambda t: clave(t[len(a.page) + 1:]))
    paginas = [a.page] + subs
    print(f'{a.page}: {len(paginas)} páginas', file=sys.stderr)

    capitulos = []
    for i, p in enumerate(paginas, 1):
        d = api({'action': 'parse', 'page': p, 'prop': 'text', 'disableeditsection': '1', 'disabletoc': '1'}) or {}
        if 'error' in d:
            print(f'  {i}/{len(paginas)} {p} — ERROR {d["error"]["info"]}', file=sys.stderr)
            continue
        cuerpo = a_xhtml(d['parse']['text']['*'])
        palabras = len(re.sub(r'<[^>]+>', ' ', cuerpo).split())
        if palabras < 80:
            print(f'  {i}/{len(paginas)} {p[len(a.page) + 1:] or p} — vacía, se omite ({palabras} palabras)', file=sys.stderr)
            continue
        titulo = a.page if p == a.page else p[len(a.page) + 1:]
        capitulos.append({'titulo': titulo, 'cuerpo': cuerpo, 'palabras': palabras})
        print(f'  {i}/{len(paginas)} {titulo} — {palabras} palabras', file=sys.stderr)
        time.sleep(0.25)

    if len(capitulos) < 2:
        print(f'SOLO {len(capitulos)} capítulos con texto: ¿título equivocado?', file=sys.stderr)
        sys.exit(1)

    ahora = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    uid = f'urn:uuid:{uuid.uuid5(uuid.NAMESPACE_URL, fuente)}'
    opf = f'''<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="{a.lang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">{uid}</dc:identifier>
<dc:title>{esc(a.page)}</dc:title>
<dc:creator>{esc(a.author)}</dc:creator>
{f'<dc:contributor>Traducción de {esc(a.translator)}</dc:contributor>' if a.translator else ''}
<dc:language>{a.lang}</dc:language>
<dc:source>{esc(fuente)}</dc:source>
<dc:rights>Texto en dominio público. Transcripción de Wikisource en español, CC BY-SA 4.0.</dc:rights>
<dc:publisher>BookReader, a partir de Wikisource</dc:publisher>
<dc:date>{ahora[:10]}</dc:date>
<meta property="dcterms:modified">{ahora}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="estilo.css" media-type="text/css"/>
{chr(10).join(f'<item id="c{i+1}" href="c{i+1}.xhtml" media-type="application/xhtml+xml"/>' for i in range(len(capitulos)))}
</manifest>
<spine toc="ncx">
{chr(10).join(f'<itemref idref="c{i+1}"/>' for i in range(len(capitulos)))}
</spine>
</package>'''

    nav = f'''<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="{a.lang}">
<head><meta charset="utf-8"/><title>{esc(a.page)}</title></head>
<body><nav epub:type="toc" id="toc"><h1>{esc(a.page)}</h1><ol>
{chr(10).join(f'<li><a href="c{i+1}.xhtml">{esc(c["titulo"])}</a></li>' for i, c in enumerate(capitulos))}
</ol></nav></body></html>'''

    ncx = f'''<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="{uid}"/></head>
<docTitle><text>{esc(a.page)}</text></docTitle>
<navMap>
{chr(10).join(f'<navPoint id="n{i+1}" playOrder="{i+1}"><navLabel><text>{esc(c["titulo"])}</text></navLabel><content src="c{i+1}.xhtml"/></navPoint>' for i, c in enumerate(capitulos))}
</navMap></ncx>'''

    contenedor = '''<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>'''

    with zipfile.ZipFile(a.out, 'w') as z:
        z.writestr('mimetype', 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
        z.writestr('META-INF/container.xml', contenedor, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/content.opf', opf, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/nav.xhtml', nav, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/toc.ncx', ncx, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/estilo.css', CSS, compress_type=zipfile.ZIP_DEFLATED)
        for i, c in enumerate(capitulos, 1):
            z.writestr(f'OEBPS/c{i}.xhtml', capitulo(c['titulo'], c['cuerpo'], a.lang), compress_type=zipfile.ZIP_DEFLATED)

    total = sum(c['palabras'] for c in capitulos)
    import os
    print(f'{a.out}: {len(capitulos)} capítulos, {total:,} palabras, {os.path.getsize(a.out)//1024} KB · {a.author}'
          f'{f", trad. {a.translator}" if a.translator else ""}'.replace(',', '.'))


if __name__ == '__main__':
    main()
