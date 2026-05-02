# Save Review Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Save review" button to the TutorChat panel that downloads the full session review (performance summary, tutor note, focus areas, chat transcript) as a Markdown file.

**Architecture:** Pure client-side — `buildMarkdown()` helper in `TutorChat.tsx` assembles a string from props, a Blob is created and downloaded via a temporary anchor element. Three new optional props (`tutor`, `summary`, `focusAreas`) are passed from `ResultsStage` to `TutorChat`.

**Tech Stack:** React, TypeScript, Next.js (app router). No new dependencies.

---

## File Map

| File | Change |
|------|--------|
| `web/app/components/TutorChat.tsx` | Add `tutor`, `summary`, `focusAreas` props; add `buildMarkdown` helper; add "Save review" button |
| `web/app/components/ResultsStage.tsx` | Pass new props to `<TutorChat>` |

---

### Task 1: Add new props and `buildMarkdown` to `TutorChat`

**Files:**
- Modify: `web/app/components/TutorChat.tsx`

- [ ] **Step 1: Add the three new optional props to `TutorChatProps`**

In `web/app/components/TutorChat.tsx`, update the import and type:

```tsx
import type { ChatMessage, TutorResponse, AlignmentSummary, FocusArea } from "./types";
```

Then extend `TutorChatProps`:

```ts
type TutorChatProps = {
  sessionId: string;
  history: ChatMessage[];
  busy: boolean;
  onSend: (text: string) => void | Promise<void>;
  resolveUrl: (path: string) => string;
  tutor?: TutorResponse | null;
  summary?: AlignmentSummary | null;
  focusAreas?: FocusArea[];
};
```

- [ ] **Step 2: Add `buildMarkdown` pure helper above the component**

Add this function above the `TutorChat` component function:

```ts
function buildMarkdown({
  sessionId,
  tutor,
  summary,
  focusAreas,
  history,
}: {
  sessionId: string;
  tutor?: TutorResponse | null;
  summary?: AlignmentSummary | null;
  focusAreas?: FocusArea[];
  history: ChatMessage[];
}): string {
  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];

  lines.push(`# Practice Review — ${sessionId.slice(0, 8)} — ${date}`, "");

  if (summary) {
    lines.push("## Performance Summary", "");
    lines.push(
      `- Correct: ${summary.correct} | Wrong pitch: ${summary.wrongPitch} | Missed: ${summary.missed} | Extra: ${summary.extra}`,
    );
    lines.push(
      `- Timing: ${summary.early} early, ${summary.late} late (±${summary.timingThresholdMs}ms window)`,
    );
    if (summary.tempoDeviationPct !== null) {
      const dir = summary.tempoDeviationPct > 0 ? "behind" : "ahead of";
      lines.push(`- Tempo: ${Math.abs(summary.tempoDeviationPct).toFixed(1)}% ${dir} reference`);
    }
    lines.push("");
  }

  lines.push("## Tutor Note", "");
  if (tutor) {
    lines.push(`> ${tutor.writtenNote ?? tutor.tutorScript}`);
  } else {
    lines.push("*(Tutor note not generated)*");
  }
  lines.push("");

  if (focusAreas && focusAreas.length > 0) {
    lines.push("## Focus Areas", "");
    for (const area of focusAreas) {
      lines.push(`- **${area.bucket}**: ${area.summary}`);
    }
    lines.push("");
  }

  lines.push("## Tutor Chat", "");
  for (const msg of history) {
    const label = msg.role === "student" ? "**Student**" : "**Tutor**";
    lines.push(`${label}: ${msg.text}`, "");
  }

  return lines.join("\n");
}
```

- [ ] **Step 3: Destructure new props in `TutorChat`**

Update the component signature to destructure the new props:

```tsx
export function TutorChat({
  sessionId,
  history,
  busy,
  onSend,
  resolveUrl,
  tutor,
  summary,
  focusAreas,
}: TutorChatProps) {
```

- [ ] **Step 4: Add `saveChatReview` handler inside the component**

Add this function inside `TutorChat`, after the `submit` function:

```ts
function saveChatReview() {
  const md = buildMarkdown({ sessionId, tutor, summary, focusAreas, history });
  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `review-${sessionId.slice(0, 8)}-${date}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 5: Add the "Save review" button to the header row**

In the `TutorChat` return JSX, find the header `<div className="row between center-y">` block. Add the button next to the existing "Tutor is thinking…" chip. The chip is currently:

```tsx
{busy && (
  <span className="chip chip-sepia">Tutor is thinking...</span>
)}
```

Replace that block with:

```tsx
<div className="row" style={{ gap: 8, alignItems: "center" }}>
  {busy && (
    <span className="chip chip-sepia">Tutor is thinking...</span>
  )}
  {history.length > 0 && (
    <button className="btn btn-sm" type="button" onClick={saveChatReview}>
      Save review
    </button>
  )}
</div>
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd web && npx tsc --noEmit
```

Expected: no errors related to `TutorChat`.

- [ ] **Step 7: Commit**

```bash
git add web/app/components/TutorChat.tsx
git commit -m "feat: add buildMarkdown helper and Save review button to TutorChat"
```

---

### Task 2: Pass new props from `ResultsStage` to `TutorChat`

**Files:**
- Modify: `web/app/components/ResultsStage.tsx`

`ResultsStage` already receives `tutor`, `focusAreas`, and `alignment` (which contains `alignment.summary`) as props. We just need to forward them.

- [ ] **Step 1: Update the `<TutorChat>` call in `ResultsStage`**

Find this block in `ResultsStage.tsx` (around line 107):

```tsx
{tutor && tutorChatVisible && (
  <TutorChat
    sessionId={midi.sessionId}
    history={chatHistory}
    busy={chatBusy}
    onSend={onSendChat}
    resolveUrl={resolveApiUrl}
  />
)}
```

Replace with:

```tsx
{tutor && tutorChatVisible && (
  <TutorChat
    sessionId={midi.sessionId}
    history={chatHistory}
    busy={chatBusy}
    onSend={onSendChat}
    resolveUrl={resolveApiUrl}
    tutor={tutor}
    summary={alignment.summary}
    focusAreas={focusAreas}
  />
)}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd web && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/app/components/ResultsStage.tsx
git commit -m "feat: pass tutor, summary, focusAreas to TutorChat for review download"
```

---

### Task 3: Manual smoke test

- [ ] **Step 1: Start the dev server**

```bash
cd web && npm run dev
```

- [ ] **Step 2: Complete a full analysis session**
  - Upload a MIDI file and video
  - Run analysis
  - Click "Play tutor feedback" to generate tutor note
  - Open tutor chat, send at least one message

- [ ] **Step 3: Verify button appears**
  - The "Save review" button should appear in the TutorChat header after the first chat message is sent
  - It should NOT appear before any messages are sent

- [ ] **Step 4: Click "Save review" and verify the downloaded file**
  - File should be named `review-<8chars>-<YYYY-MM-DD>.md`
  - Open in a text editor — verify it contains:
    - `# Practice Review` header with session ID prefix and today's date
    - `## Performance Summary` with correct/wrong/missed/extra counts
    - `## Tutor Note` with the tutor's written note text
    - `## Focus Areas` section (if any focus areas were identified)
    - `## Tutor Chat` with student and tutor messages in order

- [ ] **Step 5: Verify button is absent before chat has messages**
  - Reset the session and run analysis again
  - Generate tutor feedback but do NOT open the chat
  - Confirm the TutorChat panel (when eventually opened) shows no "Save review" button until a message is sent
