---
updated: 2026-11-15
---

# Formats and limits

## What it opens

| Format               | Reads                     | Table of contents                        | Text for the agent | Figures                  |
| -------------------- | ------------------------- | ---------------------------------------- | ------------------ | ------------------------ |
| **EPUB** without DRM | Yes, with adjustable type | From the book's nav/NCX, with its levels | Yes                | Yes, with a vision model |
| **PDF** with text    | Yes, with zoom and fit    | From its **bookmarks** (outline)         | Yes                | Yes, with a vision model |
| **Scanned PDF**      | Yes, as an image          | Only if it has bookmarks                 | **No**             | Yes, with a vision model |

And what it **does not** open: MOBI, AZW3, CBZ/CBR, EPUB or PDF with DRM (Kindle or Adobe), and
anything that is not EPUB or PDF. A `.bookreader` file (a book with its notes, exported by the app)
can be imported.

## EPUB

- The text reflows: you can change font, size, columns and line spacing.
- The table of contents comes from the EPUB's own contents and keeps its levels. The "you are here"
  marker follows you down the chapter.
- The page numbers in the contents are the reader's estimate, not the pagination of a printed
  edition.

## PDF

- It is a fixed layout: text does not reflow. You can zoom and choose the fit: **Page**, **Width** or
  **Text** (trims the white margins).
- **The table of contents comes from the bookmarks.** A PDF printed from Chrome or Word usually has
  none: it opens fine, but the sidebar is empty. Not an upload failure.
- With no text layer (a scan) you can read and look, but **not** search inside or quote passages. The
  agent has nothing to read.
- **Area**: you can crop a figure or an equation and send it with the question. That uses vision, so
  it needs a model that accepts images.

## Sizes and storage

- Books are stored in the browser. A book of hundreds of MB takes a while to get in and uses device
  space; the browser may ask you to grant more quota.
- **Drive sync** always uploads the data; **book files** only if you switch it on. Files over 50 MB
  are not uploaded automatically: you request them from the book menu.
- A shared shelf link with the books inside is capped at 100 MB; without books, the link is light.

## Accounts and quotas

- **Books and reader**: free, no account.
- **Agent**: free demo with a quota, or your key (you pay the provider).
- **Plus**: €8/month when it launches; includes MCP, BookReader Sync and hosted AI. Everything else
  in BookReader stays free.

## Next

- [Read a book](../guias/read-a-book.md).
- [How the agent answers](../explicacion/how-the-agent-works.md).

