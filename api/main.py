
import json
import shutil
import subprocess
import uuid
from pathlib import Path

import pretty_midi
from basic_pitch.inference import ICASSP_2022_MODEL_PATH, predict as bp_predict
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from music21 import converter

STORAGE = Path(__file__).parent / "storage"
STORAGE.mkdir(exist_ok=True)

app = FastAPI(title="Piano Tutor API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _session_dir(session_id: str, *, create: bool = False) -> Path:
    d = STORAGE / session_id
    if create:
        d.mkdir(parents=True, exist_ok=True)
    elif not d.exists():
        raise HTTPException(404, f"unknown sessionId: {session_id}")
    return d


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/midi")
async def upload_midi(file: UploadFile = File(...)) -> dict:
    if not (file.filename or "").lower().endswith((".mid", ".midi")):
        raise HTTPException(400, "expected a .mid or .midi file")

    session_id = uuid.uuid4().hex
    sdir = _session_dir(session_id, create=True)
    midi_path = sdir / "reference.mid"

    with midi_path.open("wb") as out:
        shutil.copyfileobj(file.file, out)

    try:
        pm = pretty_midi.PrettyMIDI(str(midi_path))
    except Exception as e:
        raise HTTPException(400, f"could not parse MIDI: {e}")

    reference_notes = sorted(
        (
            {
                "pitch": int(n.pitch),
                "onset": int(n.start * 1000),
                "duration": int((n.end - n.start) * 1000),
                "velocity": int(n.velocity),
            }
            for inst in pm.instruments
            if not inst.is_drum
            for n in inst.notes
        ),
        key=lambda x: (x["onset"], x["pitch"]),
    )

    xml_path = sdir / "reference.musicxml"
    musicxml_text: str | None = None
    try:
        score = converter.parse(str(midi_path)).quantize()
        score.write("musicxml", fp=str(xml_path))
        musicxml_text = xml_path.read_text(encoding="utf-8")
    except Exception as e:
        # MusicXML rendering is non-fatal — alignment only needs the note list.
        print(f"[midi] MusicXML conversion failed: {e}")

    tempo_bpm: float | None = None
    try:
        tempo_bpm = float(pm.estimate_tempo())
    except Exception:
        pass

    return {
        "sessionId": session_id,
        "referenceNotes": reference_notes,
        "musicxml": musicxml_text,
        "tempoBpm": tempo_bpm,
        "durationMs": int(pm.get_end_time() * 1000),
        "noteCount": len(reference_notes),
    }


@app.post("/video")
async def upload_video(
    session_id: str = Form(...),
    file: UploadFile = File(...),
) -> dict:
    sdir = _session_dir(session_id)

    suffix = Path(file.filename or "").suffix.lower() or ".mov"
    if suffix not in {".mov", ".mp4", ".m4v", ".webm", ".mkv"}:
        raise HTTPException(400, f"unsupported video extension: {suffix}")

    video_path = sdir / f"performance{suffix}"
    audio_path = sdir / "performance.wav"

    with video_path.open("wb") as out:
        shutil.copyfileobj(file.file, out)

    result = subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", str(video_path),
            "-vn",
            "-ac", "1",
            "-ar", "22050",
            str(audio_path),
        ],
        capture_output=True,
    )
    if result.returncode != 0:
        tail = result.stderr.decode("utf-8", errors="replace")[-500:]
        raise HTTPException(500, f"ffmpeg failed: {tail}")

    return {
        "sessionId": session_id,
        "videoPath": str(video_path.relative_to(STORAGE.parent)),
        "audioPath": str(audio_path.relative_to(STORAGE.parent)),
        "audioSampleRate": 22050,
    }


@app.post("/analyze")
async def analyze(request: Request) -> dict:
    session_id: str | None = None
    content_type = request.headers.get("content-type", "").lower()
    if "application/json" in content_type:
        body = await request.json()
        if isinstance(body, dict):
            raw_id = body.get("sessionId") or body.get("session_id")
            if isinstance(raw_id, str):
                session_id = raw_id
    else:
        form = await request.form()
        raw_id = form.get("sessionId") or form.get("session_id")
        if isinstance(raw_id, str):
            session_id = raw_id

    if not session_id:
        raise HTTPException(400, "missing sessionId")

    sdir = _session_dir(session_id)
    audio_path = sdir / "performance.wav"
    if not audio_path.exists():
        raise HTTPException(400, "no audio found for session; upload video first")

    try:
        _model_output, midi_data, _note_events = bp_predict(
            str(audio_path),
            model_or_model_path=str(ICASSP_2022_MODEL_PATH.with_suffix(".onnx")),
            onset_threshold=0.5,
            frame_threshold=0.5,
            minimum_note_length=100,
            minimum_frequency=80.0,
            maximum_frequency=2000.0,
            melodia_trick=False,
            multiple_pitch_bends=False,
        )
    except Exception as e:
        raise HTTPException(500, f"basic-pitch failed: {e}")

    played_notes = sorted(
        [
            {
                "pitch": int(n.pitch),
                "onset_ms": int(n.start * 1000),
                "duration_ms": int((n.end - n.start) * 1000),
                "velocity": int(n.velocity),
            }
            for inst in midi_data.instruments
            if not inst.is_drum
            for n in inst.notes
        ],
        key=lambda x: (x["onset_ms"], x["pitch"]),
    )

    played_path = sdir / "played.json"
    played_path.write_text(
        json.dumps(
            {
                "sessionId": session_id,
                "playedNotes": played_notes,
                "noteCount": len(played_notes),
            },
            ensure_ascii=True,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )

    transcription_path = sdir / "performance.transcribed.mid"
    midi_data.write(str(transcription_path))

    return {
        "sessionId": session_id,
        "playedNotes": played_notes,
        "noteCount": len(played_notes),
        "playedPath": str(played_path.relative_to(STORAGE.parent)),
        "transcribedMidiPath": str(transcription_path.relative_to(STORAGE.parent)),
        "durationMs": int(midi_data.get_end_time() * 1000),
    }
