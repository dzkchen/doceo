
import copy
import json
import math
import os
import re
import shutil
import subprocess
import uuid
import wave
from hashlib import sha256
from pathlib import Path
from statistics import median
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote as url_quote
from urllib.request import Request as UrlRequest, urlopen

import cv2
import mediapipe as mp
import numpy as np
import pretty_midi
from basic_pitch.inference import ICASSP_2022_MODEL_PATH, predict as bp_predict
from elevenlabs import ElevenLabs
from fastdtw import fastdtw
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from music21 import converter

STORAGE = Path(__file__).parent / "storage"
STORAGE.mkdir(exist_ok=True)
PROJECT_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = PROJECT_ROOT / ".env"

app = FastAPI(title="Piano Tutor API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

TIMING_EARLY_LATE_THRESHOLD_MS = 150
REFERENCE_SYNTH_SAMPLE_RATE = 22050
REFERENCE_SYNTH_LOWPASS_HZ = 5200.0
LEGATO_CLOSE_GAP_MAX_SEC = 0.09
LEGATO_OVERLAP_SEC = 0.018
LEGATO_MAX_EXTENSION_SEC = 0.14
FLUIDSYNTH_GAIN = 0.8
DYNAMIC_DELTA_ALERT_THRESHOLD = 40
POSE_SAMPLE_FPS = 10
POSTURE_MIN_SEGMENT_MS = 500
POSTURE_GAP_TOLERANCE_MS = 220
TUTOR_MAX_NOTES_PER_BUCKET = 10
TUTOR_MAX_POSTURE_FLAGS = 8
TUTOR_MAX_DYNAMICS_DELTAS = 8
GEMINI_MODEL_CANDIDATES = (
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
)
DEFAULT_TUTOR_VOICE_ID = "EXAVITQu4vr4xnSDxMaL"
MIN_TUTOR_SECONDS = 15.0
MIN_TUTOR_WORDS = 45


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


def _timing_status(timing_delta_ms: int) -> str:
    if timing_delta_ms < -TIMING_EARLY_LATE_THRESHOLD_MS:
        return "early"
    if timing_delta_ms > TIMING_EARLY_LATE_THRESHOLD_MS:
        return "late"
    return "on-time"


def _find_performance_video(sdir: Path) -> Path:
    for suffix in (".mov", ".mp4", ".m4v", ".webm", ".mkv"):
        candidate = sdir / f"performance{suffix}"
        if candidate.exists():
            return candidate
    raise HTTPException(400, "no performance video found for session; upload video first")


def _resolve_session_media_path(sdir: Path, filename: str, *, allowed_suffixes: set[str]) -> Path:
    if "/" in filename or "\\" in filename:
        raise HTTPException(400, "invalid filename")
    suffix = Path(filename).suffix.lower()
    if suffix not in allowed_suffixes:
        raise HTTPException(400, f"unsupported media extension: {suffix or '<none>'}")

    media_path = (sdir / filename).resolve()
    if media_path.parent != sdir.resolve():
        raise HTTPException(400, "invalid media path")
    if not media_path.exists():
        raise HTTPException(404, f"media not found: {filename}")
    return media_path


def _media_type_for_suffix(suffix: str) -> str:
    mapping = {
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".mov": "video/quicktime",
        ".mp4": "video/mp4",
        ".m4v": "video/mp4",
        ".webm": "video/webm",
        ".mkv": "video/x-matroska",
    }
    return mapping.get(suffix.lower(), "application/octet-stream")


def _resolve_soundfont_path() -> Path | None:
    env_path = os.getenv("PIANO_SOUNDFONT_PATH")
    if env_path and env_path.strip():
        candidate = Path(env_path.strip()).expanduser()
        if candidate.exists() and candidate.suffix.lower() in {".sf2", ".sf3"}:
            return candidate

    bundled = PROJECT_ROOT / "api" / "assets" / "GeneralUser-GS.sf2"
    if bundled.exists():
        return bundled
    return None


def _legatoize_pretty_midi(pm: pretty_midi.PrettyMIDI) -> pretty_midi.PrettyMIDI:
    legato_pm = copy.deepcopy(pm)

    for inst in legato_pm.instruments:
        if inst.is_drum or not inst.notes:
            continue

        inst.notes.sort(key=lambda note: (note.start, note.pitch))
        for idx in range(len(inst.notes) - 1):
            note = inst.notes[idx]
            nxt = inst.notes[idx + 1]
            if nxt.start <= note.start + 1e-5:
                continue
            gap = nxt.start - note.end
            if gap < 0.0 or gap > LEGATO_CLOSE_GAP_MAX_SEC:
                continue

            target_end = min(
                nxt.start + LEGATO_OVERLAP_SEC,
                note.end + LEGATO_MAX_EXTENSION_SEC,
            )
            if target_end > note.end:
                note.end = target_end

        end_time = max(note.end for note in inst.notes)
        inst.control_changes.append(pretty_midi.ControlChange(number=64, value=92, time=0.0))
        inst.control_changes.append(
            pretty_midi.ControlChange(number=64, value=0, time=end_time + 0.08)
        )
        inst.control_changes.sort(key=lambda cc: cc.time)

    return legato_pm


def _render_with_fluidsynth(pm: pretty_midi.PrettyMIDI, *, sdir: Path) -> Path | None:
    soundfont_path = _resolve_soundfont_path()
    if soundfont_path is None:
        print("[midi] sampled render skipped: no SoundFont (.sf2/.sf3) configured")
        return None

    fluidsynth_bin = shutil.which("fluidsynth")
    if not fluidsynth_bin:
        print("[midi] sampled render skipped: fluidsynth binary not found")
        return None

    legato_pm = _legatoize_pretty_midi(pm)
    legato_midi_path = sdir / "reference_legato.mid"
    legato_pm.write(str(legato_midi_path))

    audio_path = sdir / "reference_synth.wav"
    cmd = [
        fluidsynth_bin,
        "-ni",
        "-q",
        "-T",
        "wav",
        "-F",
        str(audio_path),
        "-r",
        str(REFERENCE_SYNTH_SAMPLE_RATE),
        "-g",
        str(FLUIDSYNTH_GAIN),
        "-C",
        "0",
        "-R",
        "1",
        str(soundfont_path),
        str(legato_midi_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0 or not audio_path.exists():
        stderr_tail = result.stderr[-500:] if isinstance(result.stderr, str) else ""
        stdout_tail = result.stdout[-200:] if isinstance(result.stdout, str) else ""
        print(f"[midi] fluidsynth render failed ({result.returncode}): {stderr_tail}{stdout_tail}")
        return None

    return audio_path


def _piano_like_wave(phase: np.ndarray) -> np.ndarray:
    # Harmonic mix tuned for a mellow piano-like timbre instead of a plain sine.
    return (
        0.72 * np.sin(phase)
        + 0.34 * np.sin(2.0 * phase + 0.015)
        + 0.21 * np.sin(3.0 * phase)
        + 0.14 * np.sin(4.01 * phase)
        + 0.09 * np.sin(5.02 * phase)
        + 0.05 * np.sin(6.03 * phase)
    )


def _one_pole_lowpass(signal: np.ndarray, *, sample_rate: int, cutoff_hz: float) -> np.ndarray:
    if signal.size <= 1:
        return signal
    if cutoff_hz <= 0.0:
        return signal

    alpha = math.exp(-2.0 * math.pi * cutoff_hz / float(sample_rate))
    output = np.empty_like(signal, dtype=np.float32)
    output[0] = float(signal[0])
    coeff = 1.0 - alpha
    for idx in range(1, signal.shape[0]):
        output[idx] = coeff * float(signal[idx]) + alpha * output[idx - 1]
    return output


def _synthesize_reference_audio(
    pm: pretty_midi.PrettyMIDI,
    *,
    sdir: Path,
) -> tuple[Path | None, str | None]:
    sampled_audio_path = _render_with_fluidsynth(pm, sdir=sdir)
    if sampled_audio_path is not None:
        return sampled_audio_path, "fluidsynth_sf2"

    try:
        samples = pm.synthesize(fs=REFERENCE_SYNTH_SAMPLE_RATE, wave=_piano_like_wave)
    except Exception as exc:
        print(f"[midi] reference audio synthesis failed: {exc}")
        return None, None

    waveform = np.asarray(samples, dtype=np.float32)
    if waveform.size == 0:
        return None, None
    if waveform.ndim > 1:
        waveform = waveform.mean(axis=1)

    waveform = np.nan_to_num(waveform, nan=0.0, posinf=1.0, neginf=-1.0)
    waveform = waveform - float(np.mean(waveform))
    waveform = _one_pole_lowpass(
        waveform,
        sample_rate=REFERENCE_SYNTH_SAMPLE_RATE,
        cutoff_hz=REFERENCE_SYNTH_LOWPASS_HZ,
    )
    waveform = np.tanh(1.35 * waveform)
    peak = float(np.max(np.abs(waveform)))
    if peak > 1.0:
        waveform = waveform / peak

    pcm = np.clip(waveform, -1.0, 1.0)
    pcm_i16 = (pcm * 32767.0).astype(np.int16)

    audio_path = sdir / "reference_synth.wav"
    with wave.open(str(audio_path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(REFERENCE_SYNTH_SAMPLE_RATE)
        wav_file.writeframes(pcm_i16.tobytes())

    return audio_path, "fallback_wave"


def _round_coord(v: float) -> float:
    return round(float(v), 6)


def _finger_angle_deg(
    mcp: tuple[float, float],
    pip: tuple[float, float],
    dip: tuple[float, float],
) -> float | None:
    v1 = (mcp[0] - pip[0], mcp[1] - pip[1])
    v2 = (dip[0] - pip[0], dip[1] - pip[1])
    n1 = math.hypot(v1[0], v1[1])
    n2 = math.hypot(v2[0], v2[1])
    if n1 < 1e-9 or n2 < 1e-9:
        return None
    cosine = (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)
    cosine = max(-1.0, min(1.0, cosine))
    return math.degrees(math.acos(cosine))


def _score_to_severity(score: float, mild: float, moderate: float, severe: float) -> str | None:
    if score >= severe:
        return "severe"
    if score >= moderate:
        return "moderate"
    if score >= mild:
        return "mild"
    return None


def _angle_to_severity(angle_deg: float) -> str | None:
    if angle_deg >= 176.0:
        return "severe"
    if angle_deg >= 171.0:
        return "moderate"
    if angle_deg >= 166.0:
        return "mild"
    return None


def _collapse_segments(
    rule_type: str,
    series: list[dict[str, Any]],
    frame_interval_ms: int,
) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None

    def flush_current() -> None:
        nonlocal current
        if current is None:
            return
        end_ms = current["lastMs"] + frame_interval_ms
        duration = end_ms - current["startMs"]
        if duration >= POSTURE_MIN_SEGMENT_MS:
            segments.append(
                {
                    "type": rule_type,
                    "startMs": current["startMs"],
                    "endMs": end_ms,
                    "severity": current["severity"],
                    "peakScore": round(current["peakScore"], 4),
                }
            )
        current = None

    for sample in series:
        ts = int(sample["timestampMs"])
        severity = sample.get("severity")
        score = float(sample.get("score", 0.0))
        if severity is None:
            if current is not None and ts - current["lastMs"] > POSTURE_GAP_TOLERANCE_MS:
                flush_current()
            continue

        if (
            current is not None
            and current["severity"] == severity
            and ts - current["lastMs"] <= POSTURE_GAP_TOLERANCE_MS
        ):
            current["lastMs"] = ts
            current["peakScore"] = max(current["peakScore"], score)
            continue

        flush_current()
        current = {
            "startMs": ts,
            "lastMs": ts,
            "severity": severity,
            "peakScore": score,
        }

    flush_current()
    return segments


def _read_json_dict(path: Path, *, missing_message: str, invalid_message: str) -> dict[str, Any]:
    if not path.exists():
        raise HTTPException(400, missing_message)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise HTTPException(500, invalid_message) from exc
    if not isinstance(payload, dict):
        raise HTTPException(500, invalid_message)
    return payload


def _load_secret(env_keys: tuple[str, ...], *, legacy_labels: tuple[str, ...] = ()) -> str | None:
    for key in env_keys:
        raw = os.getenv(key)
        if raw and raw.strip():
            return raw.strip()

    if not ENV_PATH.exists():
        return None

    labels = set(env_keys) | set(legacy_labels)
    try:
        lines = ENV_PATH.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None

    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            key, value = line.split("=", 1)
        elif ":" in line:
            key, value = line.split(":", 1)
        else:
            continue
        if key.strip() not in labels:
            continue
        cleaned = value.strip().strip('"').strip("'")
        if cleaned:
            return cleaned
    return None


def _pitch_to_note_name(pitch: int) -> str:
    try:
        return pretty_midi.note_number_to_name(int(pitch))
    except Exception:
        return str(int(pitch))


def _dynamic_label(delta: int) -> str:
    if delta >= DYNAMIC_DELTA_ALERT_THRESHOLD:
        return "much louder than written"
    if delta <= -DYNAMIC_DELTA_ALERT_THRESHOLD:
        return "much softer than written"
    if delta > 0:
        return "louder than written"
    if delta < 0:
        return "softer than written"
    return "close to written dynamic"


def _safe_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and math.isfinite(value):
        return int(value)
    return None


def _safe_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    return None


def _build_tutor_diff(
    reference_notes: list[dict[str, int]],
    played_notes: list[dict[str, int]],
    alignment_payload: dict[str, Any],
    posture_payload: dict[str, Any] | None,
    *,
    piece_name: str,
) -> dict[str, Any]:
    alignment_rows = alignment_payload.get("alignment")
    summary = alignment_payload.get("summary")
    if not isinstance(alignment_rows, list) or not isinstance(summary, dict):
        raise HTTPException(500, "invalid alignment payload in storage")

    wrong_notes: list[dict[str, Any]] = []
    missed_notes: list[dict[str, Any]] = []
    extra_notes: list[dict[str, Any]] = []
    dynamics_deltas: list[dict[str, Any]] = []

    for row in alignment_rows:
        if not isinstance(row, dict):
            continue
        status = row.get("status")
        ref_idx = _safe_int(row.get("refIdx"))
        played_idx = _safe_int(row.get("playedIdx"))

        ref_note = reference_notes[ref_idx] if ref_idx is not None and 0 <= ref_idx < len(reference_notes) else None
        played_note = played_notes[played_idx] if played_idx is not None and 0 <= played_idx < len(played_notes) else None

        if status == "wrongPitch" and ref_note and played_note:
            wrong_notes.append(
                {
                    "timeSec": round(ref_note["onset_ms"] / 1000.0, 2),
                    "expected": _pitch_to_note_name(ref_note["pitch"]),
                    "played": _pitch_to_note_name(played_note["pitch"]),
                    "timingStatus": row.get("timingStatus"),
                    "timingDeltaMs": _safe_int(row.get("timingDeltaMs")),
                }
            )
        elif status == "missed" and ref_note:
            missed_notes.append(
                {
                    "timeSec": round(ref_note["onset_ms"] / 1000.0, 2),
                    "expected": _pitch_to_note_name(ref_note["pitch"]),
                }
            )
        elif status == "extra" and played_note:
            extra_notes.append(
                {
                    "timeSec": round(played_note["onset_ms"] / 1000.0, 2),
                    "played": _pitch_to_note_name(played_note["pitch"]),
                }
            )

        if status in {"correct", "wrongPitch"} and ref_note and played_note:
            delta = int(played_note["velocity"]) - int(ref_note["velocity"])
            if abs(delta) > DYNAMIC_DELTA_ALERT_THRESHOLD:
                dynamics_deltas.append(
                    {
                        "timeSec": round(ref_note["onset_ms"] / 1000.0, 2),
                        "expectedVelocity": int(ref_note["velocity"]),
                        "playedVelocity": int(played_note["velocity"]),
                        "delta": delta,
                        "label": _dynamic_label(delta),
                    }
                )

    wrong_notes.sort(key=lambda note: note["timeSec"])
    missed_notes.sort(key=lambda note: note["timeSec"])
    extra_notes.sort(key=lambda note: note["timeSec"])
    dynamics_deltas.sort(key=lambda item: abs(int(item["delta"])), reverse=True)

    posture_flags: list[dict[str, Any]] = []
    if posture_payload:
        raw_flags = posture_payload.get("postureFlags")
        if isinstance(raw_flags, list):
            for raw in raw_flags:
                if not isinstance(raw, dict):
                    continue
                rule_type = raw.get("type")
                severity = raw.get("severity")
                if not isinstance(rule_type, str) or not isinstance(severity, str):
                    continue
                start_ms = _safe_int(raw.get("startMs"))
                end_ms = _safe_int(raw.get("endMs"))
                if start_ms is None:
                    continue
                posture_flags.append(
                    {
                        "type": rule_type,
                        "atSec": round(start_ms / 1000.0, 2),
                        "endSec": round((end_ms if end_ms is not None else start_ms) / 1000.0, 2),
                        "severity": severity,
                    }
                )

    posture_flags.sort(key=lambda flag: (flag["atSec"], flag["type"]))

    return {
        "piece": piece_name,
        "wrongNotes": wrong_notes[:TUTOR_MAX_NOTES_PER_BUCKET],
        "missedNotes": missed_notes[:TUTOR_MAX_NOTES_PER_BUCKET],
        "extraNotes": extra_notes[:TUTOR_MAX_NOTES_PER_BUCKET],
        "tempoDeviationPct": _safe_float(summary.get("tempoDeviationPct")),
        "timingSummary": {
            "thresholdMs": _safe_int(summary.get("timingThresholdMs")),
            "onTime": _safe_int(summary.get("onTime")),
            "early": _safe_int(summary.get("early")),
            "late": _safe_int(summary.get("late")),
        },
        "dynamicsDeltas": dynamics_deltas[:TUTOR_MAX_DYNAMICS_DELTAS],
        "postureFlags": posture_flags[:TUTOR_MAX_POSTURE_FLAGS],
        "alignmentSummary": {
            "correct": _safe_int(summary.get("correct")),
            "wrongPitch": _safe_int(summary.get("wrongPitch")),
            "missed": _safe_int(summary.get("missed")),
            "extra": _safe_int(summary.get("extra")),
        },
    }


def _extract_gemini_text(payload: dict[str, Any]) -> str:
    candidates = payload.get("candidates")
    if not isinstance(candidates, list):
        raise HTTPException(502, "Gemini returned no candidates")
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        content = candidate.get("content")
        if not isinstance(content, dict):
            continue
        parts = content.get("parts")
        if not isinstance(parts, list):
            continue
        chunks: list[str] = []
        for part in parts:
            if not isinstance(part, dict):
                continue
            text = part.get("text")
            if isinstance(text, str) and text.strip():
                chunks.append(text.strip())
        if chunks:
            return "\n".join(chunks).strip()
    raise HTTPException(502, "Gemini response did not contain text content")


def _count_words(text: str) -> int:
    return len(re.findall(r"[A-Za-z0-9']+", text))


def _estimate_tutor_seconds(text: str) -> float:
    # Typical spoken pacing for tutor feedback sits around ~150 wpm.
    words = _count_words(text)
    if words <= 0:
        return 0.0
    return words / 2.5


def _list_gemini_generate_models(gemini_key: str) -> list[str]:
    models: list[str] = []
    seen: set[str] = set()
    page_token: str | None = None

    for _ in range(4):
        encoded_key = url_quote(gemini_key, safe="")
        token_query = ""
        if page_token:
            token_query = f"&pageToken={url_quote(page_token, safe='')}"
        url = (
            "https://generativelanguage.googleapis.com/v1beta/models"
            f"?key={encoded_key}{token_query}"
        )
        with urlopen(UrlRequest(url=url, method="GET"), timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))

        raw_models = payload.get("models")
        if not isinstance(raw_models, list):
            break
        for item in raw_models:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            methods = item.get("supportedGenerationMethods")
            if not isinstance(name, str) or not name.startswith("models/"):
                continue
            if not isinstance(methods, list) or "generateContent" not in methods:
                continue
            model_id = name.split("/", 1)[1]
            if not model_id or model_id in seen:
                continue
            seen.add(model_id)
            models.append(model_id)

        next_token = payload.get("nextPageToken")
        if not isinstance(next_token, str) or not next_token.strip():
            break
        page_token = next_token.strip()

    return models


def _generate_tutor_script_with_gemini(diff_payload: dict[str, Any]) -> tuple[str, str]:
    gemini_key = _load_secret(
        ("GEMINI_API_KEY", "GOOGLE_API_KEY"),
        legacy_labels=("Gemini", "GEMINI"),
    )
    if not gemini_key:
        raise HTTPException(500, "missing Gemini API key (GEMINI_API_KEY or GOOGLE_API_KEY)")

    system_prompt = (
        "You are a warm, specific piano tutor. "
        "Write a spoken critique script for one student performance.\n"
        "Requirements:\n"
        "- 30 to 60 seconds when read aloud (~90-150 words).\n"
        "- Reference at least two concrete moments using timestamps from the provided diff.\n"
        "- Cover note accuracy and timing. Mention posture if posture flags exist.\n"
        "- End with exactly one focused practice tip.\n"
        "- Return plain text only (no markdown, no bullets)."
    )
    user_prompt = (
        "Performance diff JSON:\n"
        f"{json.dumps(diff_payload, ensure_ascii=True)}"
    )
    base_request_payload = {
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
        "generationConfig": {
            "temperature": 0.35,
            "maxOutputTokens": 420,
        },
    }

    model_candidates: list[str] = []
    preferred_override = os.getenv("GEMINI_MODEL")
    if preferred_override and preferred_override.strip():
        model_candidates.append(preferred_override.strip())
    model_candidates.extend(GEMINI_MODEL_CANDIDATES)

    try:
        available_models = _list_gemini_generate_models(gemini_key)
    except Exception:
        available_models = []

    if available_models:
        ranked: list[str] = []
        seen: set[str] = set()
        for candidate in model_candidates:
            if candidate in available_models and candidate not in seen:
                ranked.append(candidate)
                seen.add(candidate)
        for available in available_models:
            if available not in seen:
                ranked.append(available)
                seen.add(available)
        model_candidates = ranked
    else:
        deduped: list[str] = []
        seen_local: set[str] = set()
        for candidate in model_candidates:
            if candidate in seen_local:
                continue
            seen_local.add(candidate)
            deduped.append(candidate)
        model_candidates = deduped

    encoded_key = url_quote(gemini_key, safe="")

    def _generate_for_model(model: str, request_payload: dict[str, Any]) -> str:
        model_path = url_quote(model, safe="")
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{model_path}:generateContent?key={encoded_key}"
        )
        encoded_payload = json.dumps(
            request_payload,
            ensure_ascii=True,
            separators=(",", ":"),
        ).encode("utf-8")
        with urlopen(
            UrlRequest(
                url=url,
                data=encoded_payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            ),
            timeout=40,
        ) as response:
            payload = json.loads(response.read().decode("utf-8"))
        return _extract_gemini_text(payload).strip()

    errors: list[str] = []
    for model in model_candidates:
        try:
            script = _generate_for_model(model, base_request_payload)
            word_count = _count_words(script)
            if word_count >= MIN_TUTOR_WORDS:
                return script, model

            retry_prompt = (
                "Your previous output was too short for audio playback.\n"
                f"Previous output ({word_count} words): {script}\n\n"
                "Rewrite the tutor script using the same performance diff.\n"
                "Hard requirements:\n"
                f"- At least {MIN_TUTOR_WORDS} words.\n"
                f"- At least {int(MIN_TUTOR_SECONDS)} seconds when spoken naturally.\n"
                "- Keep it concise and practical.\n"
                "- Reference at least two timestamps.\n"
                "- End with one focused practice tip.\n"
                "- Plain text only."
            )
            retry_payload = {
                "systemInstruction": base_request_payload["systemInstruction"],
                "contents": [{"role": "user", "parts": [{"text": retry_prompt}]}],
                "generationConfig": {
                    "temperature": 0.35,
                    "maxOutputTokens": 520,
                },
            }
            retry_script = _generate_for_model(model, retry_payload)
            retry_words = _count_words(retry_script)
            if retry_words >= MIN_TUTOR_WORDS:
                return retry_script, model
            errors.append(
                f"{model}: output too short ({word_count} words, retry {retry_words} words)"
            )
        except HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            errors.append(f"{model}: HTTP {exc.code} {body[:180]}")
        except URLError as exc:
            errors.append(f"{model}: {exc.reason}")
        except HTTPException as exc:
            errors.append(f"{model}: {exc.detail}")
        except Exception as exc:
            errors.append(f"{model}: {exc}")

    raise HTTPException(502, f"Gemini generation failed: {' | '.join(errors)}")


def _synthesize_tutor_audio(script: str, *, sdir: Path) -> tuple[str, Path]:
    elevenlabs_key = _load_secret(
        ("ELEVENLABS_API_KEY",),
        legacy_labels=("ElevenLabs", "ELEVENLABS"),
    )
    if not elevenlabs_key:
        raise HTTPException(500, "missing ElevenLabs API key (ELEVENLABS_API_KEY)")

    voice_id = (
        os.getenv("ELEVENLABS_VOICE_ID")
        or _load_secret(("ELEVENLABS_VOICE_ID",))
        or DEFAULT_TUTOR_VOICE_ID
    )
    model_id = os.getenv("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2")

    script_hash = sha256(script.encode("utf-8")).hexdigest()[:16]
    audio_path = sdir / f"tutor_feedback_{script_hash}.mp3"
    if audio_path.exists():
        return voice_id, audio_path

    try:
        client = ElevenLabs(api_key=elevenlabs_key)
        audio_stream = client.text_to_speech.convert(
            voice_id=voice_id,
            text=script,
            output_format="mp3_44100_128",
            model_id=model_id,
        )
        audio_bytes = b"".join(audio_stream)
    except Exception as exc:
        raise HTTPException(502, f"ElevenLabs text-to-speech failed: {exc}") from exc

    if not audio_bytes:
        raise HTTPException(502, "ElevenLabs text-to-speech returned empty audio")

    audio_path.write_bytes(audio_bytes)
    return voice_id, audio_path


def _dtw_align_notes(
    reference_notes: list[dict[str, int]],
    played_notes: list[dict[str, int]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
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

    if m == 0:
        annotated_reference_notes = [
            {
                "refIdx": idx,
                "pitch": ref_note["pitch"],
                "onset_ms": ref_note["onset_ms"],
                "duration_ms": ref_note["duration_ms"],
                "velocity": ref_note["velocity"],
                "status": "missed",
                "playedIdx": None,
                "timingStatus": None,
                "timingDeltaMs": None,
                "pitchDelta": None,
                "dynamicDelta": None,
                "dynamicLabel": None,
            }
            for idx, ref_note in enumerate(reference_notes)
        ]
        alignment = [
            {
                "refIdx": idx,
                "playedIdx": None,
                "status": "missed",
                "timingStatus": None,
                "timingDeltaMs": None,
                "pitchDelta": None,
                "dynamicDelta": None,
                "dynamicLabel": None,
            }
            for idx in range(n)
        ]
        summary = {
            "correct": 0,
            "wrongPitch": 0,
            "missed": n,
            "extra": 0,
            "matched": 0,
            "referenceCount": n,
            "playedCount": 0,
            "timingThresholdMs": TIMING_EARLY_LATE_THRESHOLD_MS,
            "early": 0,
            "late": 0,
            "onTime": 0,
            "tempoDeviationPct": None,
        }
        return alignment, annotated_reference_notes, [], summary

    ref_start = reference_notes[0]["onset_ms"]
    played_start = played_notes[0]["onset_ms"]
    ref_pitches = [note["pitch"] for note in reference_notes]
    played_pitches = [note["pitch"] for note in played_notes]

    _distance, raw_path = fastdtw(
        ref_pitches,
        played_pitches,
        dist=lambda ref_pitch, played_pitch: 0 if ref_pitch == played_pitch else 1,
    )
    if not raw_path:
        raise HTTPException(500, "alignment failed to produce a warp path")
    path = sorted(raw_path, key=lambda x: (x[0], x[1]))

    alignment: list[dict[str, Any]] = []
    ref_annotations: list[dict[str, Any] | None] = [None] * n
    extra_count = 0
    missed_count = 0
    wrong_pitch_count = 0
    correct_count = 0
    early_count = 0
    late_count = 0
    on_time_count = 0

    prev_i = -1
    prev_j = -1
    for target_i, target_j in path:
        if target_i < prev_i or target_j < prev_j:
            raise HTTPException(500, "alignment path is not monotonic")
        while prev_i < target_i or prev_j < target_j:
            next_i = prev_i + (1 if prev_i < target_i else 0)
            next_j = prev_j + (1 if prev_j < target_j else 0)
            moved_i = next_i != prev_i
            moved_j = next_j != prev_j

            if moved_i and moved_j:
                ref_idx = next_i
                played_idx = next_j
                ref_note = reference_notes[ref_idx]
                played_note = played_notes[played_idx]
                pitch_delta = played_note["pitch"] - ref_note["pitch"]
                timing_delta = (played_note["onset_ms"] - played_start) - (ref_note["onset_ms"] - ref_start)
                timing_status = _timing_status(timing_delta)
                dynamic_delta = int(played_note["velocity"]) - int(ref_note["velocity"])
                status = "correct" if pitch_delta == 0 else "wrongPitch"
                if status == "correct":
                    correct_count += 1
                else:
                    wrong_pitch_count += 1
                if timing_status == "early":
                    early_count += 1
                elif timing_status == "late":
                    late_count += 1
                else:
                    on_time_count += 1
                row = {
                    "refIdx": ref_idx,
                    "playedIdx": played_idx,
                    "status": status,
                    "timingStatus": timing_status,
                    "timingDeltaMs": timing_delta,
                    "pitchDelta": pitch_delta,
                    "dynamicDelta": dynamic_delta,
                    "dynamicLabel": _dynamic_label(dynamic_delta),
                }
                alignment.append(row)
                ref_annotations[ref_idx] = row
                prev_i = next_i
                prev_j = next_j
                continue

            if moved_i and not moved_j:
                ref_idx = next_i
                row = {
                    "refIdx": ref_idx,
                    "playedIdx": None,
                    "status": "missed",
                    "timingStatus": None,
                    "timingDeltaMs": None,
                    "pitchDelta": None,
                    "dynamicDelta": None,
                    "dynamicLabel": None,
                }
                missed_count += 1
                alignment.append(row)
                ref_annotations[ref_idx] = row
                prev_i = next_i
                prev_j = next_j
                continue

            if moved_j and not moved_i:
                played_idx = next_j
                row = {
                    "refIdx": None,
                    "playedIdx": played_idx,
                    "status": "extra",
                    "timingStatus": None,
                    "timingDeltaMs": None,
                    "pitchDelta": None,
                    "dynamicDelta": None,
                    "dynamicLabel": None,
                }
                extra_count += 1
                alignment.append(row)
                prev_i = next_i
                prev_j = next_j
                continue

            raise HTTPException(500, "alignment path contains a zero-length step")

    for ref_idx in range(n):
        if ref_annotations[ref_idx] is not None:
            continue
        row = {
            "refIdx": ref_idx,
            "playedIdx": None,
            "status": "missed",
            "timingStatus": None,
            "timingDeltaMs": None,
            "pitchDelta": None,
            "dynamicDelta": None,
            "dynamicLabel": None,
        }
        missed_count += 1
        alignment.append(row)
        ref_annotations[ref_idx] = row

    aligned_pairs = [
        row for row in alignment
        if row["refIdx"] is not None and row["playedIdx"] is not None
    ]
    tempo_deviation_pct: float | None = None
    if len(aligned_pairs) >= 2:
        first = aligned_pairs[0]
        last = aligned_pairs[-1]
        first_ref = reference_notes[first["refIdx"]]["onset_ms"]
        last_ref = reference_notes[last["refIdx"]]["onset_ms"]
        first_played = played_notes[first["playedIdx"]]["onset_ms"]
        last_played = played_notes[last["playedIdx"]]["onset_ms"]
        ref_span = last_ref - first_ref
        played_span = last_played - first_played
        if ref_span > 0:
            tempo_deviation_pct = ((played_span / ref_span) - 1.0) * 100.0

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
        if ann is None:
            raise HTTPException(500, "alignment annotation missing a reference index")
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
                "dynamicDelta": ann.get("dynamicDelta"),
                "dynamicLabel": ann.get("dynamicLabel"),
            }
        )

    alignment.sort(
        key=lambda row: (
            row["refIdx"] if row["refIdx"] is not None else n + (row["playedIdx"] or 0),
            row["playedIdx"] if row["playedIdx"] is not None else -1,
        )
    )

    summary = {
        "correct": correct_count,
        "wrongPitch": wrong_pitch_count,
        "missed": missed_count,
        "extra": extra_count,
        "matched": correct_count + wrong_pitch_count,
        "referenceCount": n,
        "playedCount": m,
        "timingThresholdMs": TIMING_EARLY_LATE_THRESHOLD_MS,
        "early": early_count,
        "late": late_count,
        "onTime": on_time_count,
        "tempoDeviationPct": tempo_deviation_pct,
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

    reference_audio_path, reference_audio_renderer = _synthesize_reference_audio(pm, sdir=sdir)

    return {
        "sessionId": session_id,
        "referenceNotes": reference_notes,
        "musicxml": musicxml_text,
        "tempoBpm": tempo_bpm,
        "durationMs": int(pm.get_end_time() * 1000),
        "noteCount": len(reference_notes),
        "referenceAudioPath": (
            str(reference_audio_path.relative_to(STORAGE.parent))
            if reference_audio_path is not None
            else None
        ),
        "referenceAudioUrl": (
            f"/media/{session_id}/{reference_audio_path.name}"
            if reference_audio_path is not None
            else None
        ),
        "referenceAudioSampleRate": REFERENCE_SYNTH_SAMPLE_RATE if reference_audio_path is not None else None,
        "referenceAudioRenderer": reference_audio_renderer,
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
        "videoUrl": f"/media/{session_id}/{video_path.name}",
        "audioPath": str(audio_path.relative_to(STORAGE.parent)),
        "performanceAudioUrl": f"/media/{session_id}/{audio_path.name}",
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


@app.post("/pose")
async def pose(request: Request) -> dict:
    session_id = await _read_session_id(request)
    sdir = _session_dir(session_id)
    video_path = _find_performance_video(sdir)

    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise HTTPException(500, "failed to open performance video for pose analysis")

    fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
    if not math.isfinite(fps) or fps <= 1e-3:
        fps = 30.0
    sample_every = max(1, int(round(fps / POSE_SAMPLE_FPS)))
    sample_fps = fps / sample_every
    frame_interval_ms = max(1, int(round(1000.0 / sample_fps)))

    try:
        mp_pose = mp.solutions.pose
        mp_hands = mp.solutions.hands
    except AttributeError as exc:
        raise HTTPException(
            501,
            "mediapipe Pose/Hands solutions are unavailable in this environment. "
            "Install a mediapipe build that includes the solutions API.",
        ) from exc

    frames: list[dict[str, Any]] = []
    torso_spans: list[float] = []
    ear_to_shoulder_distances: list[float] = []
    frame_index = 0

    with (
        mp_pose.Pose(
            static_image_mode=False,
            model_complexity=1,
            enable_segmentation=False,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5,
        ) as pose_model,
        mp_hands.Hands(
            static_image_mode=False,
            model_complexity=0,
            max_num_hands=2,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5,
        ) as hands_model,
    ):
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            if frame_index % sample_every != 0:
                frame_index += 1
                continue

            timestamp_ms = int((frame_index / fps) * 1000.0)
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            pose_result = pose_model.process(rgb)
            hands_result = hands_model.process(rgb)

            frame_payload: dict[str, Any] = {
                "frameIndex": frame_index,
                "timestampMs": timestamp_ms,
                "pose": None,
                "hands": [],
                "metrics": {
                    "torsoSpan": None,
                    "earShoulderDistance": None,
                    "maxWristCollapse": None,
                    "maxFlatFingerAngle": None,
                },
            }

            if pose_result.pose_landmarks:
                pl = pose_result.pose_landmarks.landmark
                left_shoulder = pl[mp_pose.PoseLandmark.LEFT_SHOULDER.value]
                right_shoulder = pl[mp_pose.PoseLandmark.RIGHT_SHOULDER.value]
                left_hip = pl[mp_pose.PoseLandmark.LEFT_HIP.value]
                right_hip = pl[mp_pose.PoseLandmark.RIGHT_HIP.value]
                left_ear = pl[mp_pose.PoseLandmark.LEFT_EAR.value]
                right_ear = pl[mp_pose.PoseLandmark.RIGHT_EAR.value]

                shoulder_y = (left_shoulder.y + right_shoulder.y) / 2.0
                hip_y = (left_hip.y + right_hip.y) / 2.0
                ear_y = (left_ear.y + right_ear.y) / 2.0
                torso_span = hip_y - shoulder_y
                ear_dist = shoulder_y - ear_y

                frame_payload["pose"] = {
                    "leftShoulder": {"x": _round_coord(left_shoulder.x), "y": _round_coord(left_shoulder.y)},
                    "rightShoulder": {"x": _round_coord(right_shoulder.x), "y": _round_coord(right_shoulder.y)},
                    "leftHip": {"x": _round_coord(left_hip.x), "y": _round_coord(left_hip.y)},
                    "rightHip": {"x": _round_coord(right_hip.x), "y": _round_coord(right_hip.y)},
                    "leftEar": {"x": _round_coord(left_ear.x), "y": _round_coord(left_ear.y)},
                    "rightEar": {"x": _round_coord(right_ear.x), "y": _round_coord(right_ear.y)},
                }
                frame_payload["metrics"]["torsoSpan"] = round(torso_span, 6)
                frame_payload["metrics"]["earShoulderDistance"] = round(ear_dist, 6)
                torso_spans.append(torso_span)
                ear_to_shoulder_distances.append(ear_dist)

            max_wrist_collapse = 0.0
            max_finger_angle = 0.0
            if hands_result.multi_hand_landmarks and hands_result.multi_handedness:
                for hand_lms, handedness in zip(
                    hands_result.multi_hand_landmarks,
                    hands_result.multi_handedness,
                    strict=False,
                ):
                    label = handedness.classification[0].label.lower()
                    lms = hand_lms.landmark

                    wrist = lms[mp_hands.HandLandmark.WRIST.value]
                    index_mcp = lms[mp_hands.HandLandmark.INDEX_FINGER_MCP.value]
                    index_pip = lms[mp_hands.HandLandmark.INDEX_FINGER_PIP.value]
                    index_dip = lms[mp_hands.HandLandmark.INDEX_FINGER_DIP.value]
                    middle_mcp = lms[mp_hands.HandLandmark.MIDDLE_FINGER_MCP.value]
                    middle_pip = lms[mp_hands.HandLandmark.MIDDLE_FINGER_PIP.value]
                    middle_dip = lms[mp_hands.HandLandmark.MIDDLE_FINGER_DIP.value]

                    wrist_collapse = max(0.0, index_mcp.y - wrist.y)
                    max_wrist_collapse = max(max_wrist_collapse, wrist_collapse)

                    index_angle = _finger_angle_deg(
                        (index_mcp.x, index_mcp.y),
                        (index_pip.x, index_pip.y),
                        (index_dip.x, index_dip.y),
                    )
                    middle_angle = _finger_angle_deg(
                        (middle_mcp.x, middle_mcp.y),
                        (middle_pip.x, middle_pip.y),
                        (middle_dip.x, middle_dip.y),
                    )
                    angle_candidates = [a for a in (index_angle, middle_angle) if a is not None]
                    hand_max_angle = max(angle_candidates) if angle_candidates else 0.0
                    max_finger_angle = max(max_finger_angle, hand_max_angle)

                    frame_payload["hands"].append(
                        {
                            "label": label,
                            "wrist": {"x": _round_coord(wrist.x), "y": _round_coord(wrist.y)},
                            "indexMcp": {"x": _round_coord(index_mcp.x), "y": _round_coord(index_mcp.y)},
                            "indexPip": {"x": _round_coord(index_pip.x), "y": _round_coord(index_pip.y)},
                            "middleMcp": {"x": _round_coord(middle_mcp.x), "y": _round_coord(middle_mcp.y)},
                            "middlePip": {"x": _round_coord(middle_pip.x), "y": _round_coord(middle_pip.y)},
                            "indexPipAngleDeg": round(hand_max_angle, 3),
                            "wristCollapse": round(wrist_collapse, 6),
                        }
                    )

            if max_wrist_collapse > 0.0:
                frame_payload["metrics"]["maxWristCollapse"] = round(max_wrist_collapse, 6)
            if max_finger_angle > 0.0:
                frame_payload["metrics"]["maxFlatFingerAngle"] = round(max_finger_angle, 3)

            frames.append(frame_payload)
            frame_index += 1

    capture.release()

    if not frames:
        raise HTTPException(500, "pose analysis failed: no frames sampled")

    baseline_torso = median(torso_spans) if torso_spans else None
    baseline_ear_dist = median(ear_to_shoulder_distances) if ear_to_shoulder_distances else None

    slouched_series: list[dict[str, Any]] = []
    raised_series: list[dict[str, Any]] = []
    collapsed_wrist_series: list[dict[str, Any]] = []
    flat_fingers_series: list[dict[str, Any]] = []
    posture_timeline: list[dict[str, Any]] = []

    for frame_payload in frames:
        metrics = frame_payload["metrics"]
        timestamp_ms = int(frame_payload["timestampMs"])
        flags_at_time: list[dict[str, Any]] = []

        slouched_score = 0.0
        slouched_severity: str | None = None
        if baseline_torso and baseline_torso > 1e-6 and metrics["torsoSpan"] is not None:
            slouched_score = max(0.0, (baseline_torso - float(metrics["torsoSpan"])) / baseline_torso)
            slouched_severity = _score_to_severity(slouched_score, mild=0.10, moderate=0.18, severe=0.30)
            if slouched_severity is not None:
                flags_at_time.append(
                    {
                        "type": "slouched_back",
                        "severity": slouched_severity,
                        "score": round(slouched_score, 4),
                    }
                )
        slouched_series.append(
            {"timestampMs": timestamp_ms, "severity": slouched_severity, "score": slouched_score}
        )

        raised_score = 0.0
        raised_severity: str | None = None
        if baseline_ear_dist and baseline_ear_dist > 1e-6 and metrics["earShoulderDistance"] is not None:
            raised_score = max(
                0.0,
                (baseline_ear_dist - float(metrics["earShoulderDistance"])) / baseline_ear_dist,
            )
            raised_severity = _score_to_severity(raised_score, mild=0.18, moderate=0.30, severe=0.45)
            if raised_severity is not None:
                flags_at_time.append(
                    {
                        "type": "raised_shoulders",
                        "severity": raised_severity,
                        "score": round(raised_score, 4),
                    }
                )
        raised_series.append({"timestampMs": timestamp_ms, "severity": raised_severity, "score": raised_score})

        collapse_score = float(metrics["maxWristCollapse"] or 0.0)
        collapse_severity = _score_to_severity(collapse_score, mild=0.02, moderate=0.035, severe=0.06)
        if collapse_severity is not None:
            flags_at_time.append(
                {"type": "collapsed_wrist", "severity": collapse_severity, "score": round(collapse_score, 4)}
            )
        collapsed_wrist_series.append(
            {"timestampMs": timestamp_ms, "severity": collapse_severity, "score": collapse_score}
        )

        flat_angle = float(metrics["maxFlatFingerAngle"] or 0.0)
        flat_severity = _angle_to_severity(flat_angle)
        if flat_severity is not None:
            flags_at_time.append(
                {
                    "type": "flat_fingers",
                    "severity": flat_severity,
                    "score": round(flat_angle, 2),
                }
            )
        flat_fingers_series.append({"timestampMs": timestamp_ms, "severity": flat_severity, "score": flat_angle})

        posture_timeline.append(
            {
                "timestampMs": timestamp_ms,
                "flags": flags_at_time,
                "metrics": metrics,
            }
        )

    posture_flags = [
        *_collapse_segments("slouched_back", slouched_series, frame_interval_ms),
        *_collapse_segments("raised_shoulders", raised_series, frame_interval_ms),
        *_collapse_segments("collapsed_wrist", collapsed_wrist_series, frame_interval_ms),
        *_collapse_segments("flat_fingers", flat_fingers_series, frame_interval_ms),
    ]
    posture_flags.sort(key=lambda item: (item["startMs"], item["type"]))

    by_type: dict[str, int] = {}
    for flag in posture_flags:
        by_type[flag["type"]] = by_type.get(flag["type"], 0) + 1

    posture_payload = {
        "sessionId": session_id,
        "sampleFps": round(sample_fps, 3),
        "sampledFrameCount": len(frames),
        "postureFlags": posture_flags,
        "postureTimeline": posture_timeline,
        "postureSummary": {
            "flagCount": len(posture_flags),
            "byType": by_type,
            "baselines": {
                "torsoSpan": None if baseline_torso is None else round(float(baseline_torso), 6),
                "earShoulderDistance": None if baseline_ear_dist is None else round(float(baseline_ear_dist), 6),
            },
        },
        "frames": frames,
    }

    posture_path = sdir / "posture.json"
    posture_path.write_text(
        json.dumps(posture_payload, ensure_ascii=True, separators=(",", ":")),
        encoding="utf-8",
    )

    return {
        "sessionId": session_id,
        "sampleFps": round(sample_fps, 3),
        "sampledFrameCount": len(frames),
        "postureFlags": posture_flags,
        "postureTimeline": posture_timeline,
        "postureSummary": posture_payload["postureSummary"],
        "posturePath": str(posture_path.relative_to(STORAGE.parent)),
        "frames": frames,
    }


@app.get("/media/{session_id}/{filename}")
def get_session_media(session_id: str, filename: str) -> FileResponse:
    sdir = _session_dir(session_id)
    media_path = _resolve_session_media_path(
        sdir,
        filename,
        allowed_suffixes={".mp3", ".wav", ".mov", ".mp4", ".m4v", ".webm", ".mkv"},
    )
    media_type = _media_type_for_suffix(media_path.suffix.lower())
    return FileResponse(str(media_path), media_type=media_type, filename=filename)


@app.get("/audio/{session_id}/{filename}")
def get_audio(session_id: str, filename: str) -> FileResponse:
    sdir = _session_dir(session_id)
    audio_path = _resolve_session_media_path(
        sdir,
        filename,
        allowed_suffixes={".mp3", ".wav"},
    )
    media_type = _media_type_for_suffix(audio_path.suffix.lower())
    return FileResponse(str(audio_path), media_type=media_type, filename=filename)


@app.post("/tutor")
async def tutor(request: Request) -> dict:
    session_id = await _read_session_id(request)
    sdir = _session_dir(session_id)

    reference_notes = _reference_notes_for_session(sdir)
    played_notes = _played_notes_for_session(sdir)

    alignment_payload = _read_json_dict(
        sdir / "alignment.json",
        missing_message="missing alignment for session; run /align first",
        invalid_message="invalid alignment payload in storage",
    )
    posture_payload: dict[str, Any] | None = None
    posture_path = sdir / "posture.json"
    if posture_path.exists():
        posture_payload = _read_json_dict(
            posture_path,
            missing_message="",
            invalid_message="invalid posture payload in storage",
        )

    diff_payload = _build_tutor_diff(
        reference_notes,
        played_notes,
        alignment_payload,
        posture_payload,
        piece_name="Mariage d'Amour (mariage_15s excerpt)",
    )
    tutor_script, gemini_model = _generate_tutor_script_with_gemini(diff_payload)
    tutor_word_count = _count_words(tutor_script)
    estimated_seconds = round(_estimate_tutor_seconds(tutor_script), 1)
    voice_id, audio_path = _synthesize_tutor_audio(tutor_script, sdir=sdir)

    tutor_payload = {
        "sessionId": session_id,
        "piece": diff_payload["piece"],
        "diff": diff_payload,
        "tutorScript": tutor_script,
        "tutorWordCount": tutor_word_count,
        "estimatedSpeechSeconds": estimated_seconds,
        "minimumTargetSeconds": MIN_TUTOR_SECONDS,
        "audioPath": str(audio_path.relative_to(STORAGE.parent)),
        "audioUrl": f"/audio/{session_id}/{audio_path.name}",
        "model": {"provider": "gemini", "model": gemini_model},
        "voice": {"voiceId": voice_id},
    }
    (sdir / "tutor.json").write_text(
        json.dumps(tutor_payload, ensure_ascii=True, separators=(",", ":")),
        encoding="utf-8",
    )

    return tutor_payload
