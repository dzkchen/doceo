# PRD — Piano Tutor (Hackathon)

> Side-view recording + sheet music → AI coach that shows you what you played wrong and tells you why.

## 1. Overview

A web-based piano coach inspired by SimplyPiano and Musically, but focused on **post-performance feedback** instead of gamified lessons. The user uploads a MIDI file of the piece and a side-view video of themselves playing it. The system reads the reference notes from MIDI, transcribes what the user actually played, tracks hand and body posture from the video, and produces an annotated playback where wrong notes are highlighted in red. A Claude-powered voice tutor (spoken via ElevenLabs) then explains the mistakes — wrong notes/chords, tempo, cadence, dynamics, hand posture, body posture — in plain language.

**Problem.** Solo piano learners practicing at home have no affordable way to get specific, technical feedback on what they just played. Apps like SimplyPiano focus on guided lessons; they don't let you bring your own piece, your own piano, and ask "what did I do wrong?".

**Hackathon framing.** ~18 hours of build time. Demo-readiness > completeness. Anything not on the critical path is a stretch.

## 2. Target User & Use Case

- Beginner-to-intermediate piano students practicing solo at home.
- Has a phone, a tripod, an acoustic or digital piano, and a piece they're working on.
- **Primary loop:** upload MIDI of the piece → record a 30–90 second performance → review annotated playback + voice tutor critique.

## 3. Goals & Non-Goals

**Goals (MVP)**
- Detect wrong, missed, and extra notes against a reference score.
- Detect tempo and timing deviations.
- Detect basic hand and body posture issues from a side-view video.
- Generate a spoken tutor critique explaining the mistakes.
- Visualize the comparison clearly: score with red-highlighted wrong notes + posture timeline.

**Non-Goals (MVP)**
- Real-time / live feedback while the user is playing.
- Multi-instrument support.
- Sight-reading drills, lessons, gamification, streaks, accounts.
- Native mobile app.
- Fingering recommendations (which finger to use on which key).

## 4. User Flow

1. User sets up the phone on a tripod for a side view of the piano and themselves (hands and upper body in frame).
2. In the laptop web app, user uploads a **MIDI file** of the piece they're working on.
3. App parses the MIDI and renders a preview of the score (MIDI → MusicXML via `music21` → OSMD) with detected key and tempo.
4. User records the performance on the phone using its native camera app, then stops.
5. User transfers the video to the laptop (AirDrop, cable, or upload from the phone's browser) and submits it to the web app.
6. Backend extracts audio with ffmpeg, then runs the pipeline:
   - Audio → played-note timeline (polyphonic pitch detection).
   - Video → hand/body pose timeline (MediaPipe).
   - MIDI → reference-note timeline.
   - Alignment → per-note diff.
7. Results screen shows:
   - Scrolling score with played notes overlaid; wrong = red, missed = gray, extra = orange.
   - Posture timeline beneath the score.
   - **"Play tutor feedback"** button → Claude-generated critique spoken via ElevenLabs.

## 5. Inputs

- **Reference score** — **MIDI file only** (`.mid` / `.midi`). Direct ingest via `pretty_midi` / `music21`. No OMR, no MusicXML, no PDF in MVP — MIDI is widely available for any practice piece (MuseScore.com, IMSLP, etc.) and removes a major class of parsing errors.
- **Performance video** — single video file recorded standalone on the phone (not tethered). Side-view, ~720p+, hands and upper body in frame. Audio track is extracted server-side via ffmpeg.
- **Audio** — extracted from the video. Light noise reduction (e.g. RNNoise) before pitch detection. The quiet-room assumption keeps this path simple.

## 6. Core Features

- **MIDI parsing.** Read the uploaded `.mid` with `pretty_midi`. Filter out drum tracks. Emit a reference timeline of `(pitch, onset_ms, duration_ms, velocity)` events. Convert to MusicXML with `music21` once for OSMD rendering; quantize the stream first if the MIDI has expressive timing.
- **Audio analysis.** Noise reduction → polyphonic pitch detection (Spotify Basic Pitch; CREPE as a monophonic alternative) → played-note timeline.
- **Score alignment.** Dynamic Time Warping (DTW) between played and reference timelines to absorb tempo drift. Per-note classification: `correct | wrong-pitch | missed | extra | late | early`. Tempo deviation reported as a percentage and as a per-bar curve.
- **Pose analysis.** MediaPipe Hands + Pose on video frames. Rule-based flags for common issues: slouched back, collapsed wrist, raised shoulders, flat (un-curved) fingers, head dropped toward keys.
- **Comparison UI.** Scrolling score view with played notes overlaid. Color coding: red = wrong pitch, gray = missed, orange = extra. Posture-flag timeline shown beneath, aligned to playback time. Click any wrong note to scrub the video to that moment.
- **Voice tutor.** Claude receives a structured diff (wrong notes summary, tempo deviation %, dynamics deltas, posture flags with timestamps) and generates a 30–60 second coaching script in a warm, specific tone. ElevenLabs synthesizes the audio. User can replay.
- **Reference audio (near-free with MIDI).** `pretty_midi.PrettyMIDI(...).synthesize(fs=22050)` produces a playable WAV in one call — no soundfont needed. Surface it as an A/B "listen to the correct version" button. Promoted from stretch to MVP since MIDI makes it trivial.
- **Dynamics analysis (now cheap).** Compare per-note velocities from Basic Pitch against MIDI velocities directly. Surface notes played significantly louder or softer than written.

## 7. Technical Architecture

- **Frontend** — Next.js (or Vite + React) running on the laptop. Standard `<input type="file">` upload for both the sheet and the performance video. Local filesystem for storing recordings and intermediate artifacts. No accounts, no cloud storage.
- **Backend** — Python 3.11 FastAPI service running on the laptop. Handles MIDI parsing, audio extraction, pitch detection, DTW alignment, pose analysis, and orchestrates Claude/ElevenLabs calls. Frontend talks to it over HTTP (WebSocket for progress updates if time permits).
- **Pose** — MediaPipe Tasks. Run server-side in Python for simplicity; can move to MediaPipe JS later if perf demands it.
- **Score rendering** — OpenSheetMusicDisplay (OSMD) in the browser, fed from MusicXML that the backend converts from MIDI on upload via `music21`. If OSMD coloring proves fiddly, fall back to a **piano-roll canvas view** (one rectangle per note, x = time, y = pitch) — simpler and arguably clearer for a comparison demo.
- **Voice AI** — Claude API (Sonnet/Opus 4.x) for the feedback script; ElevenLabs API for TTS.

## 8. Data Model (sketch)

```
Session {
  id
  midiPath            // uploaded .mid file
  videoPath
  audioPath
  referenceNotes[]    // Note[]
  playedNotes[]       // Note[]
  alignment[]         // AlignedNote[]
  postureFlags[]      // { type, startMs, endMs, severity }
  tutorScript
  tutorAudioPath
}

Note {
  pitch               // MIDI number
  onset               // ms
  duration            // ms
  velocity?           // 0–127
}

AlignedNote {
  refIdx
  playedIdx?          // null if missed
  status              // correct | wrongPitch | missed | extra | late | early
  timingDeltaMs
  dynamicDelta?
}
```

## 9. Tech Stack Summary

- **Frontend** — Next.js / React, OpenSheetMusicDisplay, Tailwind.
- **Backend** — Python 3.11, FastAPI, Basic Pitch, pretty_midi, music21, librosa, ffmpeg, RNNoise, fastdtw, MediaPipe Tasks.
- **AI** — Claude API, ElevenLabs API.
- **Recording** — phone's native camera app; file transfer via AirDrop, cable, or browser upload.

## 10. Hackathon Milestones (18-hour budget)

| Window | Goal |
| --- | --- |
| H+0–2 | Repo scaffolding, web app shell, video upload + ffmpeg audio extraction, MIDI ingest with `pretty_midi`, OSMD render via MIDI→MusicXML. |
| H+2–8 | Pitch detection (Basic Pitch) + DTW alignment against MIDI reference notes. Basic comparison view with red wrong-note highlights. |
| H+8–12 | MediaPipe Hands + Pose on the uploaded video. Rule-based posture flags on a timeline. |
| H+12–15 | Claude tutor prompt with the structured diff as input → ElevenLabs TTS playback button. |
| H+15–17 | A/B reference-audio playback (`pretty_midi.synthesize`), dynamics comparison (played vs MIDI velocities), click-to-scrub on wrong notes. |
| H+17–18 | End-to-end run-throughs on the demo piece, polish, record the demo video. |

**Stretch (cut first if behind)** — dynamics comparison, click-to-scrub, A/B audio. The H+15–17 block is the buffer: drop those features first if anything earlier slips.

## 11. Open Questions & Risks

- **Polyphonic transcription accuracy on phone mics** — the quiet-room assumption helps. Still: validate with the actual demo piece *early* (H+2–4), not at H+15. If Basic Pitch is unreliable, swap to CREPE and use a monophonic excerpt for the demo.
- **MIDI rendering quality** — MIDI files exported with expressive timing can render as a wall of tied 32nd notes in OSMD. Mitigate by quantizing the `music21` stream before export, or fall back to a piano-roll canvas view.
- **Multi-track / split-staff MIDI** — piano MIDIs may have one or two tracks (treble/bass). `pretty_midi` flattens to a single note list; confirm the demo file's structure early.
- **"Hand posture" depth** — rule-based posture flags only for MVP. Real biomechanics is post-MVP.
- **File-transfer friction** — the AirDrop / cable / upload step is the awkward part of the demo. Rehearse it; consider letting the user drag-and-drop directly from the phone's browser.
- **18-hour budget is tight** — the H+15–17 block (A/B audio, dynamics, click-to-scrub) is the buffer; cut it first if anything slips.

## 12. Success Criteria for Demo

End-to-end run on a 30-second piece, on stage:

- Upload a MIDI file → see the score render.
- Upload the user's phone-recorded video → see analysis progress.
- Land on the results screen with **at least one correctly-flagged wrong note** in red.
- Hit "Play tutor feedback" → hear a coherent critique that names a real mistake from the performance and at least one posture observation.
