<p align="center">
  <img src="https://img.shields.io/badge/Built%20for-Eureka%20Hacks-7c3aed?style=for-the-badge" alt="Built for Eureka Hacks" />
</p>

<h1 align="center"><b>Privtor AI</b></h1>

<p align="center">
  An AI piano practice coach that listens to your performance video, transcribes the audio, aligns it to the score, checks posture, and gives targeted feedback.
</p>

## Inspiration

I wanted to build something closer to a real piano teacher than a generic score checker.

Most practice tools only tell you whether a note was right or wrong. I wanted a system that could also answer:

- Did I play the right notes, at the right time?
- Was my tempo stable?
- Did my posture look healthy while I was playing?
- What should I fix next, in plain language?

That idea became Privtor AI: a performance tutor that combines audio analysis, video analysis, and an AI-generated coaching layer.

## What It Does

Privtor AI takes in:

- a reference MIDI file
- a performance video

Then it:

1. extracts audio from the video
2. transcribes the performance into MIDI-like note events
3. aligns the played notes against the reference score
4. analyzes posture from sampled video frames
5. generates feedback and drills for the performer
6. renders the result in a web interface with score view, piano roll, video playback, and pose overlay

The result is a practice review that focuses on accuracy, timing, dynamics, posture, and tempo.

## How I Built It

### Frontend

The UI is a Next.js app in `web/` that manages the full practice flow:

- upload reference MIDI
- upload performance video
- run analysis
- view results

The results page shows:

- the annotated score
- a piano-roll fallback
- A/B playback with the user video and synthesized reference audio
- posture overlay on top of the video
- focus areas and drills
- AI tutor feedback

### Backend

The backend lives in `api/` and is built with FastAPI.

The pipeline is split into clear steps:

- `/midi` parses the reference MIDI, exports MusicXML, and synthesizes a reference audio track
- `/video` stores the performance video and extracts a mono WAV file with `ffmpeg`
- `/analyze` transcribes the extracted audio with Basic Pitch
- `/align` matches the played notes to the reference score with DTW
- `/pose` samples video frames with OpenCV + MediaPipe Pose/Hands
- `/tutor` feeds the analysis into Gemini and ElevenLabs for spoken coaching

### Core Libraries

- `FastAPI` for the API layer
- `Next.js` and `React` for the frontend
- `ffmpeg` for video-to-audio extraction
- `basic-pitch` for audio-to-note transcription
- `pretty_midi` and `music21` for MIDI/score handling
- `fastdtw` for note alignment
- `OpenCV` for frame sampling
- `MediaPipe` for pose and hand landmark detection
- `Gemini` for tutor script generation
- `ElevenLabs` for voice output

## Challenge: Converting Video to MIDI With High Accuracy

This was the hardest part of the project.

The raw audio coming from a performance video is messy:

- room noise leaks into the signal
- pedal resonance blurs note boundaries
- timing is not perfectly quantized
- transcribers can miss short notes or create duplicates
- performance tempo can drift compared with the reference

To make the transcription usable, I had to add multiple cleanup layers:

- extract a clean mono track from the video
- run Basic Pitch to get candidate note events
- smooth and merge near-duplicate transcribed notes
- estimate timing offset against synthesized reference audio
- reference-guide the note cleanup using the score itself
- write both raw and cleaned MIDI outputs for debugging

Even after transcription, note alignment still needed a second pass. I used DTW to compare the played note stream against the reference, then labeled each event as correct, wrong pitch, missed, extra, early, late, or on-time.

That combination of transcription plus alignment is what makes the output feel coherent instead of noisy.

## What I Learned

- Audio transcription alone is not enough; you need cleanup and alignment to make the result trustworthy.
- Reference-aware heuristics matter a lot when the performance is close to the score but not exact.
- Video analysis and audio analysis complement each other well. Audio explains what was played; pose explains how it was played.
- The best feedback is specific and actionable, not just a score.
- A good AI tutor needs structured inputs, not just a raw prompt.

## Next Steps to Scale This Project

- improve transcription accuracy on harder, noisier recordings
- support longer performances and larger score excerpts
- add better left-hand/right-hand separation
- improve posture scoring with more robust ergonomic metrics
- support multi-movement or multi-song sessions
- add analytics across multiple practice attempts so progress can be tracked over time
- deploy the pipeline so analysis can run reliably at scale
- make the tutor feedback more personalized by learning a user’s recurring mistakes

## Local Development

### Backend

```bash
cd api
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### Frontend

```bash
cd web
npm install
npm run dev
```

Then open the app in the browser and upload a reference MIDI file plus a performance video.

## Repo Structure

- `api/` - FastAPI backend and analysis pipeline
- `web/` - Next.js frontend
- `api/storage/` - session outputs, transcriptions, alignments, and posture results

## License

No license has been specified yet.
