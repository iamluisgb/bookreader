---
updated: 2026-11-15
---

# How the agent answers

The agent does not "read the whole book" at once: it searches, picks passages and answers with them
in front of it. Knowing how it works explains why it gets things right, why it sometimes finds
nothing and why the citation is the part that matters.

## The path of a question

1. **It reads the question** and the context: the open chapter, the **reading goal** and the
   conversation template.
2. **It searches the book.** BookReader keeps the text segmented on the device and uses that index to
   locate the passages dealing with the subject. It does not search the web.
3. **It trims.** It does not send the whole book: it sends the passages that fit the budget for the
   question, prioritising the chapter you are reading.
4. **It answers and cites.** The answer arrives with references to chapter and page. Tap one and the
   reader jumps to the passage.

That is why a small question works better: "what does it say here about X" finds more than "summarise
the book".

## The goal changes the answer

The **reading goal** is not decoration: it decides what is relevant. "Why it matters" and "With
numbers" use it to connect the passage to what you are trying to learn. Without a goal, those two
actions ask for one before going on.

**Notebook templates** do the same for shape: a summary template asks for thesis and ideas; a study
template asks for questions. The same question with another template gives another answer.

## Which model is behind it

- **Demo**: the house model, through our gateway, within a trial quota.
- **Your key**: the provider and model you choose. BookReader talks to any OpenAI-compatible service.
- **Vision**: explaining a figure or reviewing a sketch needs a model that accepts images.
- **Dictation**: if you configure a transcription model, your voice goes to your provider instead of
  the browser's dictation.

The model changes quality, not the rule: the answer rests on the passages it cites.

## Where it can fail

- **It cannot find the term.** The book calls it something else. Try the author's words or **Where
  else**.
- **It cites well and concludes badly.** It happens: the model interprets. That is why the citation
  is one tap away; if it does not support the answer, the citation wins.
- **A scanned PDF.** There is no text to search. The page displays, but the agent cannot read it.
- **A very long book.** Trimming favours the chapter; for the whole book, a specific question finds
  more than a general one.
- **Offline.** It answers with the book's own passages, without reasoning over them; questions queue
  until the network returns.

## What it does not do

- It does not search the web or bring in outside sources.
- It does not invent citations: if there is no passage, it says so.
- It does not generate new artifacts offline or without a model.
- It does not send your library anywhere: it sends the question and the passages it needs.

## Next

- [What happens to your data](your-data.md).
- [Formats and limits](../referencia/formats-and-limits.md).

