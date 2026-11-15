---
updated: 2026-11-15
---

# Read offline

BookReader is a **PWA**: it installs like an app and works offline with what you already have
downloaded. It is not a cut-down mode: reading, highlighting, bookmarking and review all work the
same.

## Install it

- **iPhone / iPad (Safari):** Share → **Add to Home Screen**.
- **Android (Chrome):** menu → **Install app** (or the prompt that appears when you visit).
- **Desktop (Chrome, Edge):** the install icon in the address bar.

Installed, it opens full screen and the book you were reading carries on where you left it.

## What works without a network

| Yes                                    | No                                     |
| -------------------------------------- | -------------------------------------- |
| Open and read books already downloaded | Download a new book                    |
| Highlight, notes, bookmarks            | Search the whole library               |
| Review cards and exercises             | Generate summaries, maps or new cards  |
| The agent with the book's passages     | Explain figures (needs a vision model) |

**Progress and cards** are saved on the device even with no network; if you have sync, they upload
when the connection returns.

## Asking on a plane

Offline, the agent answers with **passages from the book itself** (local search), with anchors to
jump into the text. The question waits in a queue and is answered in full when the network comes
back. That is recall, not reasoning: if it cannot find the passage, it says so.

Before you take off, in the agent's menu, **Prepare for offline** caches the summary of the whole
book. It takes a couple of minutes and spends calls to your model, so do it while online.

!!! warning "The queue lives in the active conversation"
    Questions asked offline are sent when the connection returns **in the conversation where you
    asked them**. Questions from another book wait until you open that book.

## Books in Drive

A book that only exists in your Google Drive cannot be read offline until you download it. In the
book menu, **Download**. Books over 50 MB are not synced automatically: you request them by hand.

## Next step

- [Sync and back up](sync-and-backup.md).
- [What happens to your data](../explicacion/your-data.md).

