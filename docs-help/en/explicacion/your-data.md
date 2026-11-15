---
updated: 2026-11-15
---

# What happens to your data

BookReader's promise is short: **your books stay on your device** and the AI only gets what it needs
to answer. Here is the detail, with no small print.

## Where everything lives

| What                                     | Where                                                |
| ---------------------------------------- | ---------------------------------------------------- |
| Books (EPUB and PDF)                     | The browser's storage on this device (IndexedDB)     |
| Highlights, notes, bookmarks, settings   | The browser's storage                                |
| Cards, reviews, notebooks, conversations | IndexedDB                                            |
| API key                                  | This device only                                     |
| Google Drive sync                        | A private folder in **your** Drive (`appDataFolder`) |

There is no account and no database of ours holding your library. If you clear the site's data in
your browser, you clear that device's library: that is why backups exist.

## What the AI sees

When you ask, BookReader searches the book and sends the model:

- your question,
- the passages it found,
- the reading goal and the template for that conversation.

It does not send the whole book by default, nor your library, nor your other conversations. If you
attach a figure or the whole page, it sends that image.

With **your key**, the request goes from the browser **straight** to your provider. With the
**demo**, it goes through a service of ours that talks to the house model; that is what makes trying
it without an account possible.

## Sync

- **Google Drive**: data travels encrypted to a private folder in your Drive. The only server of ours
  involved renews Google's permission; it does not store your books.
- **BookReader Sync** (Plus, coming soon): **end-to-end** encryption in the browser. The server keeps
  blocks it cannot read; it only decrypts what an authorised agent asks for, and only while the
  request lasts.

## What you can take out

- **JSON backup**: settings, highlights, notes, notebooks, conversations, decks, exercises and
  artifacts. **Without** the API key and **without** the book files.
- **Cards to Anki**: `.apkg` or text.
- **Highlights and notes to Markdown**.
- **The original book**, from the book menu.

## What is measured

The app counts **visits and activations** (for example, the first deck) with Umami, without cookies
and without personal or book data. **There is no reading telemetry**: it does not track what you
read, for how long or where. Analytics never includes the part of the link carrying keys or the book
you are reading.

## Deleting

- **One book**: from its menu. The record and the file go from this device.
- **Everything**: clear the site's data in the browser. Download a backup first.
- **Sync**: disconnecting stops uploading changes; what is already in Drive or BookReader Sync stays
  there until you delete it from its panel.

## What I cannot promise

- A **scanned PDF** with no text cannot be searched or cited: there is no text to send.
- A **model** can be wrong even with the passage in front of it. That is why every answer carries its
  citation: the citation wins.
- If you **lose every device and the recovery key** for BookReader Sync, what was synced cannot be
  recovered. That is the price of nobody else being able to read it.

## Next

- [How the agent answers](how-the-agent-works.md).
- [Sync and back up](../guias/sync-and-backup.md).

