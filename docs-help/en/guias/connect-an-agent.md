---
updated: 2026-11-15
---

# Connect an AI agent to your library

BookReader can let an AI agent —Claude Code, Claude Desktop, Hermes or another **MCP** client—
query your books: highlights, notes, stats, decks and book text. You decide what each token can see
and revoke it whenever you want.

!!! note "It ships with Plus"
    This connection is part of **BookReader Plus** and is still in testing. When it opens, the switch
    will appear under **Settings → Data**, inside the BookReader Sync section.

## What MCP is

MCP (Model Context Protocol) is a standard for letting an agent use tools from an app. Instead of
copying and pasting passages, the agent asks BookReader and gets results with their citations,
without leaving the conversation.

## Create a token

1. **Settings → Data**.
2. In the **BookReader Sync** section, scroll down to **Agents (MCP)**.
3. **Connect an agent** and give it a name: it is how you will recognise it in the list and revoke
   it.
4. Choose permissions. By default it **can only read** your books, highlights, notes and decks. You
   can also tick:
    - change decks and cards, and create summaries and maps;
    - read the text of your books;
    - organise the library (shelves, status, titles);
    - upload books.
5. Copy the **token** right away: it is never shown again. The app also gives you the ready-made
   command for Claude Code.

## Revoke

In the same list, each agent shows its last use. **Revoke** cuts access immediately. One token per
agent: if one leaks, revoke that one and the rest keep working.

## How it is protected

- The sync server **cannot read** your library at rest: it is encrypted with a key only your devices
  hold.
- To answer a query it decrypts **only what the agent asks for**, in memory, for the duration of the
  request.
- Books cannot be deleted over MCP. Cards, summaries and shelves can be created and edited, with the
  write permissions.

## If the section is not there

- **You do not have Plus or BookReader Sync is not active**: the agents section lives inside that
  panel. BookReader Sync is not public yet; Google Drive is, but it does not expose MCP.
- **You changed device**: the token belongs to the agent, not the device. Create a new one if you
  lost it; it cannot be recovered.

## Next step

- [How the agent answers](../explicacion/how-the-agent-works.md).
- [What happens to your data](../explicacion/your-data.md).

