import os
import sys
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("MPLCONFIGDIR", str(Path(tempfile.gettempdir()) / "privtor-matplotlib"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))

import pretty_midi

import main


def note(pitch: int, onset_ms: int, duration_ms: int, velocity: int = 64) -> dict[str, int]:
    return {
        "pitch": pitch,
        "onset_ms": onset_ms,
        "duration_ms": duration_ms,
        "velocity": velocity,
    }


class TranscriptionCleanupTest(unittest.TestCase):
    def test_merges_adjacent_fragments_of_same_pitch(self) -> None:
        cleaned = main._smooth_transcribed_notes(
            [
                note(60, 100, 60, 42),
                note(60, 155, 70, 88),
            ]
        )

        self.assertEqual(len(cleaned), 1)
        self.assertEqual(cleaned[0]["pitch"], 60)
        self.assertEqual(cleaned[0]["onset_ms"], 100)
        self.assertEqual(cleaned[0]["duration_ms"], 125)
        self.assertEqual(cleaned[0]["velocity"], 88)

    def test_collapses_near_pitch_duplicate_detection(self) -> None:
        cleaned = main._smooth_transcribed_notes(
            [
                note(60, 100, 260, 54),
                note(61, 118, 80, 92),
            ]
        )

        self.assertEqual(len(cleaned), 1)
        self.assertEqual(cleaned[0]["pitch"], 61)
        self.assertEqual(cleaned[0]["onset_ms"], 100)
        self.assertEqual(cleaned[0]["duration_ms"], 260)
        self.assertEqual(cleaned[0]["velocity"], 92)

    def test_keeps_legitimate_repeated_notes_separate(self) -> None:
        cleaned = main._smooth_transcribed_notes(
            [
                note(64, 100, 80, 70),
                note(64, 360, 90, 72),
            ]
        )

        self.assertEqual(
            [(n["pitch"], n["onset_ms"], n["duration_ms"]) for n in cleaned],
            [(64, 100, 80), (64, 360, 90)],
        )

    def test_filters_short_and_out_of_range_artifacts(self) -> None:
        cleaned = main._smooth_transcribed_notes(
            [
                note(20, 100, 100),
                note(109, 120, 100),
                note(60, 140, main.TRANSCRIBE_MIN_NOTE_DURATION_MS - 1),
                note(61, 200, main.TRANSCRIBE_MIN_NOTE_DURATION_MS),
            ]
        )

        self.assertEqual(len(cleaned), 1)
        self.assertEqual(cleaned[0]["pitch"], 61)

    def test_cleaned_midi_matches_cleaned_note_list(self) -> None:
        cleaned_notes = main._smooth_transcribed_notes(
            [
                note(60, 100, 60, 42),
                note(60, 155, 70, 88),
                note(64, 360, 90, 72),
            ]
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            midi_path = Path(tmpdir) / "performance.transcribed.mid"
            main._notes_to_pretty_midi(cleaned_notes).write(str(midi_path))
            pm = pretty_midi.PrettyMIDI(str(midi_path))

        midi_notes = [
            n
            for inst in pm.instruments
            if not inst.is_drum
            for n in inst.notes
        ]
        self.assertEqual(len(midi_notes), len(cleaned_notes))
        for midi_note, cleaned_note in zip(midi_notes, cleaned_notes):
            self.assertEqual(midi_note.pitch, cleaned_note["pitch"])
            self.assertLessEqual(abs(round(midi_note.start * 1000) - cleaned_note["onset_ms"]), 1)
            self.assertLessEqual(
                abs(round((midi_note.end - midi_note.start) * 1000) - cleaned_note["duration_ms"]),
                1,
            )

    def test_reference_guided_cleanup_keeps_played_reference_notes(self) -> None:
        reference = [
            note(60, 100, 120),
            note(64, 500, 120),
            note(67, 900, 120),
            note(72, 1300, 120),
        ]
        played = [
            note(60, 190, 110, 70),
            note(61, 205, 45, 55),
            note(64, 600, 110, 72),
            note(64, 620, 40, 48),
            note(67, 1010, 100, 74),
            note(72, 1410, 100, 76),
        ]

        cleaned = main._reference_guided_transcribed_notes(played, reference, offset_ms=100)

        self.assertEqual(
            [(n["pitch"], n["onset_ms"]) for n in cleaned],
            [(60, 190), (64, 600), (67, 1010), (72, 1410)],
        )

    def test_reference_guided_cleanup_keeps_wrong_pitch_candidate_when_no_match_exists(self) -> None:
        reference = [
            note(60, 100, 120),
            note(64, 500, 120),
            note(67, 900, 120),
            note(72, 1300, 120),
        ]
        played = [
            note(60, 100, 110, 70),
            note(64, 500, 110, 72),
            note(69, 900, 100, 74),
            note(72, 1300, 100, 76),
        ]

        cleaned = main._reference_guided_transcribed_notes(played, reference)

        self.assertIn((69, 900), [(n["pitch"], n["onset_ms"]) for n in cleaned])

    def test_reference_guided_cleanup_drops_leftover_candidates_near_reference_time(self) -> None:
        reference = [
            note(60, 100, 120),
            note(64, 500, 120),
            note(67, 900, 120),
            note(72, 1300, 120),
        ]
        played = [
            note(60, 100, 110, 80),
            note(62, 130, 120, 78),
            note(64, 500, 110, 80),
            note(67, 900, 110, 80),
            note(72, 1300, 110, 80),
            note(76, 1750, 120, 80),
        ]

        cleaned = main._reference_guided_transcribed_notes(played, reference)

        cleaned_pairs = [(n["pitch"], n["onset_ms"]) for n in cleaned]
        self.assertNotIn((62, 130), cleaned_pairs)
        self.assertIn((76, 1750), cleaned_pairs)


if __name__ == "__main__":
    unittest.main()
