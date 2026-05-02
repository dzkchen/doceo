
import shutil
import subprocess
import uuid
from pathlib import Path

import pretty_midi
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
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
