---
updated: 2026-11-15
---

# Sync and storage

The numbers and the ceilings, on one page. The step by step is in
[Sync and back up](../guias/sync-and-backup.md).

## Where each thing lives

| What                                  | Where                                     |
| ------------------------------------- | ----------------------------------------- |
| Books, notes, decks, conversations    | The browser on this device                |
| API key                               | This device only, never travels           |
| Sync copy (if you enable Drive)       | Private folder in your Drive (`appDataFolder`) |
| Backup (JSON)                         | A file you download                       |

## Ceilings

| Limit                                        | Value                                       |
| -------------------------------------------- | ------------------------------------------- |
| Book that uploads on its own to Drive sync   | Up to **50 MB**; larger ones are fetched from the book menu |
| Shared shelf with the books inside           | **100 MB**; without books, the link is light |
| Books and reader                             | Free, no account                            |
| Agent demo                                   | A quota of trial questions                  |
| With your own key (BYOK)                     | Your provider's account limit               |

## What sync uploads

- The **data** (notes, progress, decks, settings) always.
- The **book files** only if you opt in; anything over 50 MB is never uploaded on its own.

## Backup (JSON) vs sync

|              | Backup (JSON)                    | Sync                                  |
| ------------ | -------------------------------- | ------------------------------------- |
| What it is   | One file with everything of yours | The same data on several devices     |
| API key      | Not included                     | Never travels                         |
| Book files   | Not included                     | Optional                              |
| Restore      | Merges: deletes nothing extra    | Automatic                             |

## Next

- [Sync and back up](../guias/sync-and-backup.md), the step by step.
- [What happens to your data](../explicacion/your-data.md), the why.
