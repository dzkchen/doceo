# Save Review Button — Design Spec
**Date:** 2026-05-02

## Overview

Add a "Save review" button to the TutorChat panel on the results page. When clicked, it downloads the full session review as a Markdown file — tutor note, performance stats, focus areas, and chat transcript. The button is only visible when the chat history is non-empty.

## Placement

The button lives in the `TutorChat` header row, right side, alongside the existing "Tutor is thinking…" chip. It uses the existing `btn btn-sm` class.

Enabled condition: `history.length > 0`

## Download Mechanics

Pure client-side. No server involvement.

1. Build a Markdown string from the available data.
2. Wrap in a `Blob` with `type: "text/markdown"`.
3. Create a temporary `<a>` element with a `download` attribute, programmatically click it, then revoke the object URL.

## Filename

```
review-<first-8-chars-of-sessionId>-<YYYY-MM-DD>.md
```

Example: `review-a3f9b12c-2026-05-02.md`

## File Content Structure

```markdown
# Practice Review — <sessionId prefix> — <YYYY-MM-DD>

## Performance Summary
- Correct: N | Wrong pitch: N | Missed: N | Extra: N
- Timing: N early, N late (±Xms window)
- Tempo: X% behind/ahead of reference  ← omitted if null

## Tutor Note
"<tutor.writtenNote or tutor.tutorScript>"
← "(Tutor note not generated)" if tutor is null

## Focus Areas
- **<bucket>**: <summary>
← omitted section if focusAreas is empty

## Tutor Chat
**Student:** <text>

**Tutor:** <text>

... all messages in full history order
```

## Component Changes

### `TutorChat.tsx`

New optional props added to `TutorChatProps`:

```ts
tutor?: TutorResponse | null;
summary?: AlignResponse["summary"] | null;
focusAreas?: FocusArea[];
```

The `buildMarkdown(...)` function is a pure helper co-located in the same file. It takes `{ sessionId, tutor, summary, focusAreas, history }` and returns the full Markdown string.

The "Save review" button calls `buildMarkdown(...)`, creates a Blob, and triggers the download via a temporary anchor element.

### `ResultsStage.tsx`

Pass the three new props to `TutorChat`:
- `tutor` — already in scope
- `summary` — `alignment.summary`, already in scope
- `focusAreas` — already in scope

No changes to `ResultsStageProps` interface needed (values already flow in from `page.tsx`).

## Error Handling

No error handling needed — all data is already in memory on the client. The only failure mode is if `URL.createObjectURL` is unavailable (extremely rare, non-standard environments); no fallback required.

## What Is NOT in scope

- Server-side PDF generation
- Saving to a backend / persistence
- Exporting audio files
- The button appearing before any chat messages exist
