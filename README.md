<p align="center">
  <img src="https://img.shields.io/badge/Built%20for-Eureka%20Hacks-7c3aed?style=for-the-badge" alt="Built for Eureka Hacks" />
</p>

<h1 align="center"><b>Privtor AI</b></h1>

<p align="center">
  AI piano practice coach for turning one performance video into score alignment, posture checks, and actionable feedback.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white" alt="FastAPI" />
  <img src="https://img.shields.io/badge/Next.js-000000?style=for-the-badge&logo=nextdotjs&logoColor=white" alt="Next.js" />
  <img src="https://img.shields.io/badge/MediaPipe-ff6f00?style=for-the-badge" alt="MediaPipe" />
  <img src="https://img.shields.io/badge/Basic%20Pitch-4f46e5?style=for-the-badge" alt="Basic Pitch" />
  <img src="https://img.shields.io/badge/OpenCV-5c3c00?style=for-the-badge&logo=opencv&logoColor=white" alt="OpenCV" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white" alt="Python" />
  <img src="https://img.shields.io/badge/React-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React" />
  <img src="https://img.shields.io/badge/ffmpeg-4e4e4e?style=for-the-badge" alt="ffmpeg" />
  <img src="https://img.shields.io/badge/Gemini-8b5cf6?style=for-the-badge" alt="Gemini" />
  <img src="https://img.shields.io/badge/ElevenLabs-111827?style=for-the-badge" alt="ElevenLabs" />
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
2. transcribes the performance into note events
3. aligns the played notes against the reference score
4. analyzes posture from sampled video frames
5. generates feedback and drills
6. renders the result in a web interface

Output:

- score annotations
- piano-roll fallback
- video playback with pose overlay
- reference audio playback
- AI tutor feedback

## How I Built It

### Frontend
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

Pipeline:

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

## Tech Stack

### Frontend

- `Next.js 16`
- `React 19`
- `TypeScript`
- `OpenSheetMusicDisplay`

### Backend

- `FastAPI`
- `Uvicorn`
- `Python`
- `pretty_midi`
- `music21`
- `basic-pitch`
- `fastdtw`
- `OpenCV`
- `MediaPipe`
- `ffmpeg`

### AI and Feedback

- `Gemini` for written tutor feedback
- `ElevenLabs` for audio narration

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

- Audio transcription needs cleanup and alignment to be useful.
- Reference-aware heuristics matter when performances drift from the score.
- Audio and video analysis solve different parts of the problem.
- Specific feedback beats a raw score.
- Structured inputs make AI feedback much better.

## Next Steps to Scale This Project

- improve transcription accuracy on noisier recordings
- support longer performances and bigger excerpts
- separate left-hand and right-hand analysis
- improve posture scoring
- support multi-song sessions
- track progress across practice attempts
- deploy the pipeline for reliable scale
- personalize feedback from recurring mistakes

## Local Development

### Backend

```bash
cd api
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

or 

```bash
cd /Users/dzkchen/privtor-ai/api
source .venv/bin/activate
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

### Frontend

```bash
cd web
npm install
npm run dev
```

Open the app and upload a reference MIDI plus a performance video.

## Repo Structure

- `api/` - FastAPI backend and analysis pipeline
- `web/` - Next.js frontend
- `api/storage/` - session outputs, transcriptions, alignments, and posture results

## License

No license has been specified yet.
