# Turn reading into review

Reading is not remembering. BookReader turns the book into **cards** that come back just before you
forget them, and lets you take them to Anki if that is where you live.

## Where the cards come from

1. **From the book's Studio.** Open the book, open the agent and go to the **Studio** tab. Ask for
   **Flashcards** for a chapter, a selection or the whole book. The agent reads the text and
   proposes the cards.
2. **From a selection.** Select a passage and send it to the notebook or create a card with its
   quote: the card keeps pointing at the exact page.
3. **From a deck you already have.** In the library, **Decks** gathers every card deck, whether or
   not it is tied to a book.

Before studying, review: you can edit the front, the back and the options. A bad card costs more
than no card.

## Reviewing

In **Decks** you see what is due today. Review uses **FSRS**, the same kind of algorithm as Anki:

- Each card comes back when the algorithm predicts you are about to forget it.
- You grade with **two buttons** (Again · Good) or **four** (Again · Hard · Good · Easy). Two is
  faster and the algorithm works just as well.
- The **new-card limit** stops a freshly generated deck from dropping 90 cards on you on day one.
  Cards you have already started always come in.
- The **streak** counts the days you review; the "due today" counter says what is left.

!!! note "The percentage is not a thermometer"
    FSRS schedules each review when it predicts you will be right about 90 % of the time. That
    percentage tends to 90 % by construction; what changes as you learn is the **interval**, not the
    number. The [explanation](../explicacion/how-the-agent-works.md) says it without decoration.

## Exercises, in addition to cards

The Studio can also build a practice **matrix**: rows and columns to fill in by comparing concepts,
with citations. It covers what a card cannot: relating ideas, not recalling a single fact. Exercises
live apart from cards and do not count as spaced review.

## Taking it to Anki

In the deck, **Export .apkg** builds an Anki deck with your cards. There is also a text export for
anyone who prefers to import by hand. Cards keep their page, so in Anki they still point at the book.

## What it does not do

- It does not invent cards for what is not in the text.
- It does not send your cards to a server: they stay on your device (and in your Drive, if sync is
  on).
- It does not replace reading. If a card does not ring a bell, go back to the passage: the link is
  on the card.

## Next step

- [Organise your library](organise-your-library.md).
- [Sync and back up](sync-and-backup.md) so you do not lose your progress.

---

_Updated on 15 November 2026._
