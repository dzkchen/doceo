
import json
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Any

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

TIMING_EARLY_LATE_THRESHOLD_MS = 120


def _session_dir(session_id: str, *, create: bool = False) -> Path:
    d = STORAGE / session_id
    if create:
        d.mkdir(parents=True, exist_ok=True)
    elif not d.exists():
        raise HTTPException(404, f"unknown sessionId: {session_id}")
    return d


async def _read_session_id(request: Request) -> str:
    content_type = request.headers.get("content-type", "").lower()
    raw_id: Any = None
    if "application/json" in content_type:
        body = await request.json()
        if isinstance(body, dict):
            raw_id = body.get("sessionId") or body.get("session_id")
    else:
        form = await request.form()
        raw_id = form.get("sessionId") or form.get("session_id")

    if isinstance(raw_id, str) and raw_id.strip():
        return raw_id.strip()
    raise HTTPException(400, "missing sessionId")


def _normalize_note(note: dict[str, Any]) -> dict[str, int]:
    onset = note.get("onset_ms", note.get("onset"))
    duration = note.get("duration_ms", note.get("duration"))
    if onset is None or duration is None:
        raise ValueError("missing onset/duration in note")
    return {
        "pitch": int(note["pitch"]),
        "onset_ms": int(onset),
        "duration_ms": int(duration),
        "velocity": int(note.get("velocity", 0)),
    }


def _reference_notes_for_session(sdir: Path) -> list[dict[str, int]]:
    midi_path = sdir / "reference.mid"
    if not midi_path.exists():
        raise HTTPException(400, "missing reference MIDI for session; upload MIDI first")
    try:
        pm = pretty_midi.PrettyMIDI(str(midi_path))
    except Exception as e:
        raise HTTPException(500, f"failed to parse reference MIDI: {e}")

    return sorted(
        (
            {
                "pitch": int(n.pitch),
                "onset_ms": int(n.start * 1000),
                "duration_ms": int((n.end - n.start) * 1000),
                "velocity": int(n.velocity),
            }
            for inst in pm.instruments
            if not inst.is_drum
            for n in inst.notes
        ),
        key=lambda x: (x["onset_ms"], x["pitch"]),
    )


def _played_notes_for_session(sdir: Path) -> list[dict[str, int]]:
    played_path = sdir / "played.json"
    if not played_path.exists():
        raise HTTPException(400, "missing played notes for session; run /analyze first")
    try:
        raw = json.loads(played_path.read_text(encoding="utf-8"))
    except Exception as e:
        raise HTTPException(500, f"failed to parse played.json: {e}")
    raw_notes = raw.get("playedNotes")
    if not isinstance(raw_notes, list):
        raise HTTPException(500, "played.json missing playedNotes[]")

    try:
        notes = [_normalize_note(n) for n in raw_notes]
    except Exception as e:
        raise HTTPException(500, f"invalid played note payload: {e}")

    return sorted(notes, key=lambda x: (x["onset_ms"], x["pitch"]))


def _note_match_cost(ref_note: dict[str, int], played_note: dict[str, int]) -> float:
    pitch_diff = abs(ref_note["pitch"] - played_note["pitch"])
    ref_onset = int(ref_note.get("rel_onset_ms", ref_note["onset_ms"]))
    played_onset = int(played_note.get("rel_onset_ms", played_note["onset_ms"]))
    onset_diff = abs(ref_onset - played_onset)
    duration_diff = abs(ref_note["duration_ms"] - played_note["duration_ms"])

    pitch_cost = min(pitch_diff, 24) * 4.5
    onset_cost = min(onset_diff / 120.0, 14.0)
    duration_cost = min(duration_diff / 250.0, 4.0)
    if onset_diff > 2500:
        onset_cost += 10.0
    return pitch_cost + onset_cost + duration_cost


def _timing_status(timing_delta_ms: int) -> str:
    if timing_delta_ms <= -TIMING_EARLY_LATE_THRESHOLD_MS:
        return "early"
    if timing_delta_ms >= TIMING_EARLY_LATE_THRESHOLD_MS:
        return "late"
    return "on-time"


def _dtw_align_notes(
    reference_notes: list[dict[str, int]],
    played_notes: list[dict[str, int]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], dict[str, int]]:
    if played_notes:
        played_end = max(n["onset_ms"] + n["duration_ms"] for n in played_notes)
        clip_end = played_end + 1200
        clipped_reference = [n for n in reference_notes if n["onset_ms"] <= clip_end]
        if clipped_reference:
            reference_notes = clipped_reference

    n = len(reference_notes)
    m = len(played_notes)
    if n == 0:
        raise HTTPException(400, "reference note list is empty")

    ref_start = reference_notes[0]["onset_ms"]
    played_start = played_notes[0]["onset_ms"] if played_notes else 0
    ref_seq = [{**n, "rel_onset_ms": n["onset_ms"] - ref_start} for n in reference_notes]
    played_seq = [{**n, "rel_onset_ms": n["onset_ms"] - played_start} for n in played_notes]

    gap_cost = 9.0
    inf = float("inf")

    dp = [[inf] * (m + 1) for _ in range(n + 1)]
    back: list[list[str | None]] = [[None] * (m + 1) for _ in range(n + 1)]
    dp[0][0] = 0.0

    for i in range(1, n + 1):
        dp[i][0] = dp[i - 1][0] + gap_cost
        back[i][0] = "up"
    for j in range(1, m + 1):
        dp[0][j] = dp[0][j - 1] + gap_cost
        back[0][j] = "left"

    band = max(24, abs(n - m) + 24)
    for i in range(1, n + 1):
        j_min = max(1, i - band)
        j_max = min(m, i + band)
        for j in range(j_min, j_max + 1):
            diag = dp[i - 1][j - 1] + _note_match_cost(ref_seq[i - 1], played_seq[j - 1])
            up = dp[i - 1][j] + gap_cost
            left = dp[i][j - 1] + gap_cost

            best = diag
            move = "diag"
            if up < best:
                best = up
                move = "up"
            if left < best:
                best = left
                move = "left"
            dp[i][j] = best
            back[i][j] = move

    if back[n][m] is None and (n > 0 or m > 0):
        raise HTTPException(500, "alignment failed to find a valid path")

    alignment: list[dict[str, Any]] = []
    ref_annotations: list[dict[str, Any]] = []
    extra_count = 0
    missed_count = 0
    wrong_pitch_count = 0
    correct_count = 0
    early_count = 0
    late_count = 0
    on_time_count = 0

    i = n
    j = m
    while i > 0 or j > 0:
        move = back[i][j]
        if move == "diag":
            ref_idx = i - 1
            played_idx = j - 1
            ref_note = reference_notes[ref_idx]
            played_note = played_notes[played_idx]
            pitch_delta = played_note["pitch"] - ref_note["pitch"]
            timing_delta = (played_note["onset_ms"] - played_start) - (ref_note["onset_ms"] - ref_start)
            timing_status = _timing_status(timing_delta)
            if pitch_delta == 0:
                if timing_status == "early":
                    status = "early"
                    early_count += 1
                elif timing_status == "late":
                    status = "late"
                    late_count += 1
                else:
                    status = "correct"
                    correct_count += 1
                    on_time_count += 1
            else:
                status = "wrong-pitch"
                wrong_pitch_count += 1
            alignment.append(
                {
                    "refIdx": ref_idx,
                    "playedIdx": played_idx,
                    "status": status,
                    "timingStatus": timing_status,
                    "timingDeltaMs": timing_delta,
                    "pitchDelta": pitch_delta,
                }
            )
            ref_annotations.append(
                {
                    "refIdx": ref_idx,
                    "playedIdx": played_idx,
                    "status": status,
                    "timingStatus": timing_status,
                    "timingDeltaMs": timing_delta,
                    "pitchDelta": pitch_delta,
                }
            )
            i -= 1
            j -= 1
            continue

        if move == "up":
            ref_idx = i - 1
            missed_count += 1
            alignment.append(
                {
                    "refIdx": ref_idx,
                    "playedIdx": None,
                    "status": "missed",
                    "timingStatus": None,
                    "timingDeltaMs": None,
                    "pitchDelta": None,
                }
            )
            ref_annotations.append(
                {
                    "refIdx": ref_idx,
                    "playedIdx": None,
                    "status": "missed",
                    "timingStatus": None,
                    "timingDeltaMs": None,
                    "pitchDelta": None,
                }
            )
            i -= 1
            continue

        if move == "left":
            played_idx = j - 1
            extra_count += 1
            alignment.append(
                {
                    "refIdx": None,
                    "playedIdx": played_idx,
                    "status": "extra",
                    "timingStatus": None,
                    "timingDeltaMs": None,
                    "pitchDelta": None,
                }
            )
            j -= 1
            continue

        raise HTTPException(500, "alignment traceback failed")

    alignment.reverse()
    ref_annotations.reverse()

    extra_played_notes = []
    for row in alignment:
        if row["status"] != "extra":
            continue
        played_idx = row["playedIdx"]
        if played_idx is None:
            continue
        note = played_notes[played_idx]
        extra_played_notes.append(
            {
                "playedIdx": played_idx,
                "pitch": note["pitch"],
                "onset_ms": note["onset_ms"],
                "duration_ms": note["duration_ms"],
                "velocity": note["velocity"],
                "status": "extra",
            }
        )

    annotated_reference_notes = []
    for idx, ref_note in enumerate(reference_notes):
        ann = ref_annotations[idx]
        annotated_reference_notes.append(
            {
                "refIdx": idx,
                "pitch": ref_note["pitch"],
                "onset_ms": ref_note["onset_ms"],
                "duration_ms": ref_note["duration_ms"],
                "velocity": ref_note["velocity"],
                "status": ann["status"],
                "playedIdx": ann["playedIdx"],
                "timingStatus": ann["timingStatus"],
                "timingDeltaMs": ann["timingDeltaMs"],
                "pitchDelta": ann["pitchDelta"],
            }
        )

    summary = {
        "correct": correct_count,
        "early": early_count,
        "late": late_count,
        "onTime": on_time_count,
        "wrongPitch": wrong_pitch_count,
        "missed": missed_count,
        "extra": extra_count,
        "matched": correct_count + early_count + late_count + wrong_pitch_count,
        "referenceCount": n,
        "playedCount": m,
        "timingThresholdMs": TIMING_EARLY_LATE_THRESHOLD_MS,
    }
    return alignment, annotated_reference_notes, extra_played_notes, summary


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
    session_id = await _read_session_id(request)
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


@app.post("/align")
async def align(request: Request) -> dict:
    session_id = await _read_session_id(request)
    sdir = _session_dir(session_id)

    reference_notes = _reference_notes_for_session(sdir)
    played_notes = _played_notes_for_session(sdir)

    alignment, annotated_reference_notes, extra_played_notes, summary = _dtw_align_notes(reference_notes, played_notes)

    alignment_path = sdir / "alignment.json"
    alignment_payload = {
        "sessionId": session_id,
        "alignment": alignment,
        "annotatedReferenceNotes": annotated_reference_notes,
        "extraPlayedNotes": extra_played_notes,
        "summary": summary,
    }
    alignment_path.write_text(
        json.dumps(alignment_payload, ensure_ascii=True, separators=(",", ":")),
        encoding="utf-8",
    )

    return {
        **alignment_payload,
        "alignmentPath": str(alignment_path.relative_to(STORAGE.parent)),
    }
