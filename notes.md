# Project Handoff Notes — Piano Tutor (Hackathon)

## What this is

A web app that gives post-performance feedback on piano playing. User uploads a **MIDI** of the piece + a **side-view phone video** of themselves playing. App transcribes the audio (Basic Pitch), aligns to the reference MIDI (DTW), runs MediaPipe on the video for posture, and a **Claude + ElevenLabs** voice tutor explains mistakes. Side-by-side score view with wrong notes in red.

**Hackathon constraint:** ~18 hours total. Decisions locked in: MIDI-only ingest (no OMR, no MusicXML upload), post-recording analysis only (no live), phone records standalone (not tethered) and user uploads the file. Quiet-room is an assumption, not a risk.

Full PRD is in [PRD.md](PRD.md). Don't re-litigate scope unless asked.

## Repo layout

```
privtor-ai/
  PRD.md
  notes.md                        # this file
  README.md
  IMG_2347 2.mov                  # 15s sample performance video
  Paul de Senneville - Mariage d'Amour.mid   # sample reference MIDI
  .env                            # has Gemini + ElevenLabs keys; NO Anthropic key yet
  api/                            # FastAPI backend (port 8000)
    main.py
    requirements.txt              # pinned deps incl. setuptools<81 fix, fastdtw
    .venv/                        # already set up
    storage/<sessionId>/          # gitignored; per-session artifacts
  web/                            # Next.js 16 frontend (port 3000)
    app/page.tsx
    AGENTS.md                     # MUST read node_modules/next/dist/docs/ before any Next.js code
    CLAUDE.md                     # @AGENTS.md
    package.json                  # next 16.2.4, react 19, OSMD 1.9.7, tailwind 4
```

## Playbook progress (18-hour plan)

| Step | Status |
|---|---|
| 1–7: pre-flight, scaffolding, deps | done |
| 8: `POST /midi` + `POST /video` endpoints | done & verified |
| 9: upload page + OSMD score render | done & verified |
| 10: validate Basic Pitch on real audio | done & passed |
| 11: `POST /analyze` (BP transcription → playedNotes) | implemented |
| 12: `POST /align` (DTW alignment) | implemented |
| 13: timing classification (early/late/on-time) | implemented |
| 14: red-highlight UI + alignment summary in frontend | implemented (score + piano-roll modes) |
| 15–17: MediaPipe pose + rule-based posture flags | **next** |
| 18–21: Claude tutor diff prompt → ElevenLabs MP3 | pending (need Anthropic key) |
| 22–24: stretch — A/B reference audio, dynamics, click-to-scrub | buffer |
| 25–28: dry runs, polish, demo | pending |

## Backend — `api/main.py` (573 lines)

FastAPI on port 8000, CORS allows `localhost:3000`. Endpoints:

- `GET /health` → `{ok: true}`
- `POST /midi` (multipart `file`): parses with `pretty_midi`, drum tracks filtered, sorted by `(onset, pitch)`. Converts to MusicXML via `music21.converter.parse(...).quantize()` (non-fatal). Returns `{sessionId, referenceNotes[], musicxml, tempoBpm, durationMs, noteCount}`. Files saved to `storage/<sessionId>/{reference.mid, reference.musicxml}`.
- `POST /video` (multipart `session_id` + `file`): saves video, runs `ffmpeg -y -i <video> -vn -ac 1 -ar 22050 <wav>`. Allowed extensions: `.mov .mp4 .m4v .webm .mkv`. Returns `{sessionId, videoPath, audioPath, audioSampleRate}`. 404 on unknown sessionId.
- `POST /analyze` (JSON `{sessionId}`): runs Basic Pitch on `performance.wav`, parses output MIDI into `playedNotes[]` (`pitch`, `onset_ms`, `duration_ms`, `velocity`), persists to `storage/<sessionId>/played.json`.
- `POST /align` (JSON `{sessionId}`): DTW alignment of `referenceNotes[]` vs `playedNotes[]`. Returns `{annotatedReferenceNotes[], summary}` where each annotated note has `status: correct | wrongPitch | missed | extra`, `timingStatus: on-time | early | late | null`, `timingDeltaMs`, `pitchDelta`. Summary includes counts, `timingThresholdMs`, `tempoDeviationPct`. Reference notes are clipped to `played_end + 1200ms` so a short performance doesn't get penalized for the entire reference being "missed."
- Helpers: `_session_dir`, `_read_session_id`, `_normalize_note`, `_reference_notes_for_session`, `_played_notes_for_session`, `_timing_status`, `_dtw_align_notes`.
- Constants: `TIMING_EARLY_LATE_THRESHOLD_MS` for early/late classification.

## Frontend — `web/app/page.tsx` (540 lines)

Single client component (`"use client"`):

- Two `UploadCard`s: MIDI first (gates the second), video second.
- "Start analysis" button calls `/analyze` then `/align` sequentially.
- Alignment summary: correct / wrongPitch / missed / extra counts, tempo deviation %, timing breakdown (on-time / early / late).
- Render mode toggle: `"score"` (OSMD with red-coloring per status) vs `"piano-roll"` (canvas).
- `STATUS_COLORS`: `wrongPitch: #dc2626`, `missed: #9ca3af`, `extra: #f97316`.
- `ScoreView`: dynamic `import("opensheetmusicdisplay")` inside `useEffect` to keep it out of SSR.
- API base from `process.env.NEXT_PUBLIC_API_URL`, defaulting to `http://localhost:8000`.

## Known facts (verified, don't re-discover)

- **`pretty_midi.estimate_tempo()` is unreliable** — returned 179 BPM on Mariage d'Amour (real ~76, off by 2×). Don't trust it for analysis; use note onsets directly.
- **Sample reference MIDI is dynamics-flat** (every note velocity=80, typed-in from MuseScore). Don't compare played velocity against reference velocity directly — judge played velocity against itself or an expressive contour.
- **`pretty_midi` warns** "Tempo, Key or Time signature change events found on non-zero tracks" on the sample MIDI. Cosmetic; can suppress.
- **Basic Pitch validation results** on the 15s sample, after 280ms startup-offset correction:
  - 112 detected vs 99 reference notes (first 15s window)
  - Pitch range exact match (41..82)
  - 97% of BP onsets within ±150ms of *some* ref onset
  - 40% exact onset+pitch match after offset correction (the rest is real DTW work)
  - BP velocities have real range (36–92, stdev 13) — actual dynamics recovered
  - Inference time: ~17s for 15s of audio on Apple Silicon CPU
  - **Verdict: keep Basic Pitch, no CREPE swap needed.**
- **Next.js 16 has breaking changes from training data** — `web/AGENTS.md` mandates reading `web/node_modules/next/dist/docs/` before writing any Next.js code. Default: server components; use `'use client'` for state/effects/browser APIs.
- **CORS is configured** for `http://localhost:3000` → `http://localhost:8000`. Verified preflight works.
- **`.env` has Gemini and ElevenLabs keys but NO Anthropic key.** PRD specifies Claude for the tutor; either add `ANTHROPIC_API_KEY` before the tutor step, or switch to Gemini.

## Dependencies

`api/requirements.txt`:
- fastapi, uvicorn, python-multipart
- pretty_midi>=0.2.11, music21>=9.1
- basic-pitch[onnx]>=0.4.0
- fastdtw>=0.3.4
- **setuptools<81** (required — `resampy` still imports `pkg_resources`, removed in setuptools 81)
- anthropic>=0.97.0, elevenlabs>=2.20.0

`web/package.json`: next 16.2.4, react 19.2.4, opensheetmusicdisplay 1.9.7, tailwind 4.

## How to run

```bash
# terminal 1 — backend
cd api && .venv/bin/uvicorn main:app --reload --port 8000

# terminal 2 — frontend
cd web && npm run dev
```

Open `http://localhost:3000`, drop in the sample `.mid` then the sample `.mov`, click Start analysis.

## Conventions

- No emojis in code or output unless asked.
- No comments unless the *why* is non-obvious.
- Edit existing files; don't create new docs/READMEs unless asked.
- For Next.js work: read `web/node_modules/next/dist/docs/` first.
- User runs lean and prefers concise output.

## Next action

Step 15: pose analysis. Add `POST /pose` that runs MediaPipe Hands + Pose on the uploaded video at ~10fps and saves landmarks per frame. Then step 16: 3–4 simple rule-based posture flags (slouched back, raised shoulders, collapsed wrist, flat fingers) that emit `{type, startMs, endMs, severity}` segments. Step 17: posture timeline UI strip beneath the score, time-aligned to playback.

## Full playbook (all 28 steps)

### Pre-flight (before the clock starts)

1. **Pick a demo piece + grab its MIDI.** A 20–30 second monophonic or lightly polyphonic excerpt (first 8 bars of *Für Elise*, *Ode to Joy*, etc.). Download the `.mid` from MuseScore.com or export from MuseScore Studio. Open it in MuseScore once to confirm it sounds right and isn't 14 tracks of orchestration.
2. **Record one practice take with your phone now.** Side-view, tripod, hands+upper body in frame, ~720p. Confirm AirDrop / USB transfer to laptop works. ~3 min total.
3. **Get API keys.** Anthropic (Claude) and ElevenLabs. Paste into `.env`, add to `.gitignore`.
4. **Install system deps.** macOS: `brew install ffmpeg python@3.11 node`.

### H+0 to H+2 — Scaffolding & MIDI ingest

5. **Repo layout:**
   ```
   privtor-ai/
     web/          # Next.js app
     api/          # FastAPI service
     storage/      # local files (gitignored)
     .env
   ```
6. **Frontend:** `npx create-next-app@latest web --ts --tailwind --app`. Install `opensheetmusicdisplay`.
7. **Backend:** `cd api && python3.11 -m venv .venv && source .venv/bin/activate && pip install fastapi uvicorn python-multipart pretty_midi music21 librosa basic-pitch mediapipe fastdtw anthropic elevenlabs`.
8. **Two endpoints** (`POST /midi`, `POST /video`).
   - `POST /midi` accepts `.mid`, parses with `pretty_midi`, also writes a MusicXML version with `music21` for rendering. Returns `{sessionId, referenceNotes, musicxml}`.
   - `POST /video` accepts a video, runs `ffmpeg -i in.mov -ac 1 -ar 22050 out.wav`, saves both, returns the same `sessionId`.
9. **One upload page** with two file inputs (MIDI + video) and a "Start analysis" button. Render the returned MusicXML in OSMD immediately on MIDI upload.
   - **Done when:** uploading the `.mid` renders the score, then uploading the video returns the same session ID.

### H+2 to H+8 — Pitch detection & alignment (the core)

10. **Validate Basic Pitch on your real recording immediately.** Run `basic-pitch out.wav --output-dir .` and inspect the resulting MIDI in MuseScore. If it's garbage, swap to CREPE (monophonic, more robust on solo lines). **Don't keep building until this is acceptable.** Highest-risk step in the project.
11. **Add `POST /analyze`** that takes a session ID, runs Basic Pitch on the WAV, parses the resulting MIDI into `playedNotes[]` (`pitch`, `onset_ms`, `duration_ms`, `velocity`).
12. **Implement DTW alignment** — pitch-sequence-only first; ignore timing.
    - Cost function: 0 if same MIDI pitch, 1 otherwise.
    - Use `fastdtw` on the two pitch sequences.
    - Walk the warp path to produce `AlignedNote[]` with `correct | wrongPitch | missed | extra`.
13. **Add timing classification on top:** for each aligned pair, compute `timingDeltaMs`. Mark `late` / `early` if `|delta| > 150ms`. Compute overall `tempoDeviationPct`.
14. **Annotated score view in OSMD.** Iterate notes in render order and color them by alignment status (red / gray / orange) using OSMD's per-note SVG access (`graphicalNote.sourceNote` → set fill on the SVG path).
    - **OSMD coloring fighting back?** Bail to a piano-roll canvas: one rectangle per reference note (faded), one per played note (colored by status), x = time, y = pitch. ~30 lines of code, same information, cleaner demo.
    - **Done when:** uploading MIDI + a real recording produces a view with at least one red note that *actually corresponds to a wrong note played*.

### H+8 to H+12 — Pose analysis

15. **Add `POST /pose`** that runs MediaPipe Hands + Pose on the video at ~10fps (don't process every frame — wasteful). Save landmarks per frame to JSON.
16. **Write 3–4 simple posture rules.** Don't get fancy:
    - **Slouched back:** `pose.shoulder.y` rises relative to `pose.hip.y` over time.
    - **Raised shoulders:** shoulder-to-ear distance below a threshold.
    - **Collapsed wrist:** wrist-y above MCP-knuckle-y.
    - **Flat fingers:** PIP-to-MCP angle near 180°.
    Each rule outputs `{type, startMs, endMs, severity}` segments.
17. **Posture timeline UI:** a horizontal strip beneath the score with colored blocks per flag, time-aligned to playback.
    - **Done when:** intentionally slouching during a take produces a "slouched back" flag at the right time range.

### H+12 to H+15 — Voice tutor

18. **Build the structured diff** that goes into Claude:
    ```json
    {
      "piece": "Für Elise (excerpt)",
      "wrongNotes": [{"timeSec": 4.2, "expected": "E5", "played": "F5"}],
      "missedNotes": [...],
      "tempoDeviationPct": -8,
      "dynamicsDeltas": [{"timeSec": 7.1, "expected": "mf", "played": "p"}],
      "postureFlags": [{"type": "slouched_back", "atSec": 12, "severity": "moderate"}]
    }
    ```
19. **Prompt Claude** (`claude-sonnet-4-6`). System: "You are a warm, specific piano tutor. Given this performance diff, give a 30–60 second spoken critique. Reference at least two concrete moments by time. End with one focused practice tip." `max_tokens` ~400.
20. **Pipe the script into ElevenLabs** TTS. Save the MP3, return the URL.
21. **Frontend:** "Play tutor feedback" button → `<audio>` element with the returned MP3.
    - **Done when:** clicking the button plays a coherent critique that names a real mistake from the run.

### H+15 to H+17 — MIDI bonus features (the buffer block)

This block is the buffer. **If behind, skip it entirely** — the demo is already complete. If on time, these are cheap wins because MIDI makes them trivial:

22. **A/B reference audio.** One line: `wav = pm.synthesize(fs=22050)`. Save it on `/midi` upload, expose via `<audio>` on the results page beside "Your performance" and "Correct version" buttons. Strong demo moment.
23. **Dynamics comparison.** Played velocities (from Basic Pitch) and reference velocities (from MIDI) are already on hand. For each aligned pair, compute `dynamicDelta`. Surface notes >40 velocity units off as orange highlights with a "much louder/softer than written" tooltip. Feed the deltas into the Claude diff so the tutor mentions dynamics.
24. **Click-to-scrub.** Click any wrong note in the score → seek the recorded video to its timestamp. Strong demo moment.

### H+17 to H+18 — Polish & demo

25. **Three end-to-end dry runs** on the actual demo piece. Time yourself; live demo should be under 3 minutes total.
26. **Pre-record a backup demo video** of a successful run in case something breaks on stage.
27. **Wrap risky calls in try/except** and degrade gracefully (if pose fails, hide the timeline rather than erroring out).
28. **README.md** — one paragraph + a screenshot. Skip if no time.

### When something goes wrong

- **Basic Pitch is bad** → switch to CREPE, pick a melody-only excerpt for the demo.
- **DTW looks crazy** → print the warp path; usually leading silence in one sequence. Trim before DTW.
- **OSMD score renders as 32nd-note soup** → call `.quantize()` on the `music21` stream before exporting MusicXML. Still bad? Drop to piano-roll view.
- **Multi-track MIDI confuses things** → `pretty_midi` already flattens across instruments; just confirm `is_drum=False` filtering and that the demo file isn't a full orchestral arrangement.
- **ElevenLabs is slow** → cache MP3 by hash of the script; second click is instant.
