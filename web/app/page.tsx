"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Masthead, type Stage } from "./components/Masthead";
import { ProgressRail } from "./components/ProgressRail";
import { Footer } from "./components/Footer";
import { UploadStage } from "./components/UploadStage";
import { AnalyzingStage } from "./components/AnalyzingStage";
import { ResultsStage } from "./components/ResultsStage";
import type {
  MidiResponse, VideoResponse, PlayedNote, AlignResponse,
  PoseResponse, TutorResponse, FocusArea,
} from "./components/types";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const DYNAMIC_DELTA_ALERT_THRESHOLD = 40;

function resolveApiUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return `${API_BASE}${path}`;
}

export default function Home() {
  const [midi,  setMidi]  = useState<MidiResponse | null>(null);
  const [video, setVideo] = useState<VideoResponse | null>(null);
  const [alignment, setAlignment] = useState<AlignResponse | null>(null);
  const [playedNotes, setPlayedNotes] = useState<PlayedNote[] | null>(null);
  const [pose,  setPose]  = useState<PoseResponse | null>(null);
  const [tutor, setTutor] = useState<TutorResponse | null>(null);
  const [busy,  setBusy]  = useState<"midi" | "video" | "analyze" | "tutor" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [postureWarning,  setPostureWarning]  = useState<string | null>(null);
  const [tutorWarning,    setTutorWarning]    = useState<string | null>(null);
  const [renderMode,      setRenderMode]      = useState<"score" | "piano-roll">("score");
  const [showPoseOverlay, setShowPoseOverlay] = useState(true);
  const performanceVideoRef = useRef<HTMLVideoElement | null>(null);

  // Derived stage
  const stage: Stage =
    busy === "analyze" ? "analyzing"
    : alignment !== null ? "results"
    : "upload";

  async function uploadMidi(file: File) {
    setBusy("midi"); setError(null);
    setAlignment(null); setPlayedNotes(null); setPose(null); setTutor(null); setVideo(null); setMidi(null);
    setPostureWarning(null); setTutorWarning(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${API_BASE}/midi`, { method: "POST", body: fd });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      setMidi((await res.json()) as MidiResponse);
    } catch (e) {
      setError(`MIDI upload failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function uploadVideo(file: File) {
    if (!midi) return;
    setBusy("video"); setError(null);
    setAlignment(null); setPlayedNotes(null); setPose(null); setTutor(null);
    setPostureWarning(null); setTutorWarning(null);
    try {
      const fd = new FormData();
      fd.append("session_id", midi.sessionId);
      fd.append("file", file);
      const res = await fetch(`${API_BASE}/video`, { method: "POST", body: fd });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      setVideo((await res.json()) as VideoResponse);
    } catch (e) {
      setError(`Video upload failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function runAnalysis() {
    if (!midi || !video) return;
    setBusy("analyze"); setError(null);
    setAlignment(null); setPlayedNotes(null); setPose(null); setTutor(null);
    setPostureWarning(null); setTutorWarning(null);
    try {
      const analyzeRes = await fetch(`${API_BASE}/analyze`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: midi.sessionId }),
      });
      if (!analyzeRes.ok) throw new Error(`Analyze failed (${analyzeRes.status}): ${await analyzeRes.text()}`);
      const analyze = await analyzeRes.json();
      setPlayedNotes(analyze.playedNotes);

      const alignRes = await fetch(`${API_BASE}/align`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: midi.sessionId }),
      });
      if (!alignRes.ok) throw new Error(`Align failed (${alignRes.status}): ${await alignRes.text()}`);
      setAlignment(await alignRes.json());

      const poseRes = await fetch(`${API_BASE}/pose`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: midi.sessionId }),
      });
      if (!poseRes.ok) {
        setPostureWarning(`Posture analysis unavailable (${poseRes.status}): ${(await poseRes.text()).slice(0, 180)}`);
      } else {
        setPose(await poseRes.json());
      }

      const tutorRes = await fetch(`${API_BASE}/tutor`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: midi.sessionId }),
      });
      if (!tutorRes.ok) {
        setTutorWarning(`Tutor feedback unavailable (${tutorRes.status}): ${(await tutorRes.text()).slice(0, 180)}`);
      } else {
        setTutor(await tutorRes.json());
      }
    } catch (e) {
      setError(`Analysis failed: ${(e as Error).message}`);
      setBusy(null);
    } finally {
      setBusy((b) => b === "analyze" ? null : b);
    }
  }

  async function generateTutorFeedback() {
    if (!midi || !alignment) return;
    setBusy("tutor"); setError(null); setTutorWarning(null);
    try {
      const res = await fetch(`${API_BASE}/tutor`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: midi.sessionId }),
      });
      if (!res.ok) throw new Error(`Tutor failed (${res.status}): ${await res.text()}`);
      setTutor(await res.json());
    } catch (e) {
      setTutorWarning(`Tutor feedback unavailable: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  function seekPerformanceVideo(onsetMs: number) {
    const player = performanceVideoRef.current;
    if (!player) return;
    player.currentTime = Math.max(0, onsetMs / 1000);
  }

  function reset() {
    setMidi(null); setVideo(null); setAlignment(null); setPlayedNotes(null);
    setPose(null); setTutor(null); setBusy(null); setError(null);
    setPostureWarning(null); setTutorWarning(null);
  }

  const dynamicsOutlierCount = useMemo(() => {
    if (!alignment) return 0;
    return alignment.annotatedReferenceNotes.filter(
      (n) => n.dynamicDelta !== null && Math.abs(n.dynamicDelta) > DYNAMIC_DELTA_ALERT_THRESHOLD,
    ).length;
  }, [alignment]);

  const analysisDurationMs = useMemo(() => {
    const midiDuration   = midi?.durationMs ?? 0;
    const playedDuration = (playedNotes ?? []).reduce((max, n) => Math.max(max, n.onset_ms + n.duration_ms), 0);
    const postureDuration = pose?.postureTimeline.reduce((max, p) => Math.max(max, p.timestampMs), 0) ?? 0;
    return Math.max(1, midiDuration, playedDuration, postureDuration);
  }, [midi?.durationMs, playedNotes, pose?.postureTimeline]);

  const focusAreas = useMemo<FocusArea[]>(() => {
    if (!alignment) return [];
    const s = alignment.summary;
    const areas: FocusArea[] = [];
    if (s.wrongPitch + s.missed > 0) areas.push({ bucket: "Note Accuracy", color: "#2563eb", summary: `${s.wrongPitch} wrong-pitch and ${s.missed} missed notes`, drill: `${s.wrongPitch} wrong-pitch and ${s.missed} missed notes detected. Mark those passages and play at 40% tempo — hands separately — until clean.` });
    if (areas.length < 3 && s.early + s.late > 0) areas.push({ bucket: "Timing", color: "#d97706", summary: `${s.early} early and ${s.late} late notes (±${s.timingThresholdMs}ms window)`, drill: `Set a metronome to 60% of target tempo and focus on landing each note exactly on the click.` });
    if (areas.length < 3 && dynamicsOutlierCount > 0) areas.push({ bucket: "Dynamics", color: "#ea580c", summary: `${dynamicsOutlierCount} notes played significantly louder or softer than written`, drill: `Compare performance against reference audio, then replay focusing on matching written velocity.` });
    if (areas.length < 3 && pose && pose.postureSummary.flagCount > 0) {
      const topEntry = Object.entries(pose.postureSummary.byType).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0];
      const topIssueType = topEntry ? topEntry[0].replaceAll("_", " ") : "posture";
      areas.push({ bucket: "Posture", color: "#7c3aed", summary: `${pose.postureSummary.flagCount} posture flags (${topIssueType} most prominent)`, drill: `Between run-throughs, reset: feet flat, back straight, wrists level before each take.` });
    }
    if (areas.length < 3 && s.tempoDeviationPct !== null && Math.abs(s.tempoDeviationPct) > 10) {
      areas.push({ bucket: "Tempo", color: "#059669", summary: `Overall tempo drifted ${s.tempoDeviationPct.toFixed(1)}% from reference`, drill: `Run the piece with a metronome locked to the target BPM, counting out loud to anchor the beat.` });
    }
    return areas;
  }, [alignment, pose, dynamicsOutlierCount]);

  return (
    <div className="frame">
      <Masthead sessionId={midi?.sessionId ?? null} stage={stage} onReset={reset} />
      <ProgressRail stage={stage} hasFiles={midi !== null && video !== null} />

      {stage === "upload" && (
        <UploadStage
          midi={midi}
          video={video}
          busy={busy === "midi" ? "midi" : busy === "video" ? "video" : null}
          error={error}
          onMidiFile={uploadMidi}
          onVideoFile={uploadVideo}
          onAnalyze={runAnalysis}
        />
      )}
      {stage === "analyzing" && (
        <AnalyzingStage midi={midi} video={video} />
      )}
      {stage === "results" && alignment && midi && (
        <ResultsStage
          midi={midi}
          video={video}
          alignment={alignment}
          playedNotes={playedNotes}
          pose={pose}
          tutor={tutor}
          tutorBusy={busy === "tutor"}
          focusAreas={focusAreas}
          dynamicsOutlierCount={dynamicsOutlierCount}
          analysisDurationMs={analysisDurationMs}
          renderMode={renderMode}
          setRenderMode={setRenderMode}
          showPoseOverlay={showPoseOverlay}
          setShowPoseOverlay={setShowPoseOverlay}
          onGenerateTutor={generateTutorFeedback}
          onSeekVideo={seekPerformanceVideo}
          performanceVideoRef={performanceVideoRef}
          resolveApiUrl={resolveApiUrl}
          postureWarning={postureWarning}
          tutorWarning={tutorWarning}
          onReset={reset}
        />
      )}

      <Footer />
    </div>
  );
}
