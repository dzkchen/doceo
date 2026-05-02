"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

const STATUS_COLORS: Record<Exclude<AnnotatedStatus, "correct">, string> = {
  wrongPitch: "#dc2626",
  missed: "#9ca3af",
  extra: "#f97316",
};
const DYNAMIC_DELTA_ALERT_THRESHOLD = 40;
const DYNAMIC_ALERT_COLOR = "#f59e0b";

const POSTURE_RULE_COLORS = {
  slouched_back: "#2563eb",
  raised_shoulders: "#f59e0b",
  collapsed_wrist: "#ef4444",
  flat_fingers: "#8b5cf6",
} as const;

type ReferenceNote = {
  pitch: number;
  onset: number;
  duration: number;
  velocity: number;
};

type MidiResponse = {
  sessionId: string;
  referenceNotes: ReferenceNote[];
  musicxml: string | null;
  tempoBpm: number | null;
  durationMs: number;
  noteCount: number;
  referenceAudioPath: string | null;
  referenceAudioUrl: string | null;
  referenceAudioSampleRate: number | null;
  referenceAudioRenderer: "fluidsynth_sf2" | "fallback_wave" | null;
};

type VideoResponse = {
  sessionId: string;
  videoPath: string;
  videoUrl: string;
  audioPath: string;
  performanceAudioUrl: string;
  audioSampleRate: number;
};

type PlayedNote = {
  pitch: number;
  onset_ms: number;
  duration_ms: number;
  velocity: number;
};

type AnalyzeResponse = {
  sessionId: string;
  noteCount: number;
  playedNotes: PlayedNote[];
};

type AnnotatedStatus = "correct" | "wrongPitch" | "missed" | "extra";

type AnnotatedReferenceNote = {
  refIdx: number;
  pitch: number;
  onset_ms: number;
  duration_ms: number;
  velocity: number;
  status: AnnotatedStatus;
  playedIdx: number | null;
  timingStatus: "on-time" | "early" | "late" | null;
  timingDeltaMs: number | null;
  pitchDelta: number | null;
  dynamicDelta: number | null;
  dynamicLabel: string | null;
};

type AlignmentSummary = {
  correct: number;
  wrongPitch: number;
  missed: number;
  extra: number;
  matched: number;
  referenceCount: number;
  playedCount: number;
  timingThresholdMs: number;
  early: number;
  late: number;
  onTime: number;
  tempoDeviationPct: number | null;
};

type AlignResponse = {
  sessionId: string;
  annotatedReferenceNotes: AnnotatedReferenceNote[];
  summary: AlignmentSummary;
};

type PostureSeverity = "mild" | "moderate" | "severe";
type PostureRule = keyof typeof POSTURE_RULE_COLORS;

type PostureFlag = {
  type: PostureRule;
  startMs: number;
  endMs: number;
  severity: PostureSeverity;
  peakScore: number;
};

type PostureTimelinePoint = {
  timestampMs: number;
  flags: Array<{
    type: PostureRule;
    severity: PostureSeverity;
    score: number;
  }>;
};

type LandmarkXY = { x: number; y: number };

type PoseBodyLandmarks = {
  leftShoulder: LandmarkXY;
  rightShoulder: LandmarkXY;
  leftHip: LandmarkXY;
  rightHip: LandmarkXY;
  leftEar: LandmarkXY;
  rightEar: LandmarkXY;
} | null;

type HandLandmarks = {
  label: "left" | "right";
  wrist: LandmarkXY;
  indexMcp: LandmarkXY;
  indexPip: LandmarkXY;
  middleMcp: LandmarkXY;
  middlePip: LandmarkXY;
  indexPipAngleDeg: number | null;
  wristCollapse: number | null;
};

type PoseFrame = {
  frameIndex: number;
  timestampMs: number;
  pose: PoseBodyLandmarks;
  hands: HandLandmarks[];
  metrics: {
    torsoSpan: number | null;
    earShoulderDistance: number | null;
    maxWristCollapse: number | null;
    maxFlatFingerAngle: number | null;
  };
};

type PoseResponse = {
  sessionId: string;
  sampleFps: number;
  sampledFrameCount: number;
  postureFlags: PostureFlag[];
  postureTimeline: PostureTimelinePoint[];
  postureSummary: {
    flagCount: number;
    byType: Partial<Record<PostureRule, number>>;
  };
  frames: PoseFrame[];
};

type TutorDiff = {
  piece: string;
  wrongNotes: Array<{
    timeSec: number;
    expected: string;
    played: string;
    timingStatus: "on-time" | "early" | "late" | null;
    timingDeltaMs: number | null;
  }>;
  missedNotes: Array<{
    timeSec: number;
    expected: string;
  }>;
  extraNotes: Array<{
    timeSec: number;
    played: string;
  }>;
  tempoDeviationPct: number | null;
  dynamicsDeltas: Array<{
    timeSec: number;
    expectedVelocity: number;
    playedVelocity: number;
    delta: number;
    label: string;
  }>;
  postureFlags: Array<{
    type: string;
    atSec: number;
    endSec: number;
    severity: PostureSeverity;
  }>;
};

type TutorResponse = {
  sessionId: string;
  piece: string;
  diff: TutorDiff;
  tutorScript: string;
  writtenNote: string | null;
  strengths: string[];
  audioPath: string;
  audioUrl: string;
  model: {
    provider: string;
    model: string;
  };
  voice: {
    voiceId: string;
  };
};

type FocusArea = {
  bucket: string;
  color: string;
  summary: string;
  drill: string;
};

function resolveApiUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  return `${API_BASE}${path}`;
}

function hasDynamicOutlier(note: AnnotatedReferenceNote): boolean {
  return note.dynamicDelta !== null && Math.abs(note.dynamicDelta) > DYNAMIC_DELTA_ALERT_THRESHOLD;
}

function dynamicTooltip(note: AnnotatedReferenceNote): string | null {
  if (!hasDynamicOutlier(note)) return null;
  const label = note.dynamicLabel ?? (note.dynamicDelta! > 0 ? "much louder than written" : "much softer than written");
  return `${label} (${note.dynamicDelta! > 0 ? "+" : ""}${note.dynamicDelta})`;
}

function computeFocusAreas(
  alignment: AlignResponse,
  pose: PoseResponse | null,
  dynamicsOutlierCount: number,
): FocusArea[] {
  const s = alignment.summary;
  const areas: FocusArea[] = [];

  if (s.wrongPitch + s.missed > 0) {
    areas.push({
      bucket: "Note Accuracy",
      color: "#2563eb",
      summary: `${s.wrongPitch} wrong-pitch and ${s.missed} missed notes`,
      drill: `${s.wrongPitch} wrong-pitch and ${s.missed} missed notes detected. Mark those passages in the score, then play through at 40% tempo — hands separately — until each one is clean.`,
    });
  }

  if (areas.length < 3 && s.early + s.late > 0) {
    areas.push({
      bucket: "Timing",
      color: "#d97706",
      summary: `${s.early} early and ${s.late} late notes (±${s.timingThresholdMs}ms window)`,
      drill: `${s.early} early and ${s.late} late notes (±${s.timingThresholdMs}ms window). Set a metronome to 60% of the target tempo and focus on landing each note exactly on the click.`,
    });
  }

  if (areas.length < 3 && dynamicsOutlierCount > 0) {
    areas.push({
      bucket: "Dynamics",
      color: "#ea580c",
      summary: `${dynamicsOutlierCount} notes played significantly louder or softer than written`,
      drill: `${dynamicsOutlierCount} notes played significantly louder or softer than written. Compare your performance against the reference audio using A/B playback, then replay the passage focusing on matching written velocity.`,
    });
  }

  if (areas.length < 3 && pose && pose.postureSummary.flagCount > 0) {
    const byType = pose.postureSummary.byType;
    const topEntry = Object.entries(byType).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0];
    const topIssueType = topEntry ? prettyRuleName(topEntry[0] as PostureRule) : "posture";
    const flagCount = pose.postureSummary.flagCount;
    areas.push({
      bucket: "Posture",
      color: "#7c3aed",
      summary: `${flagCount} posture flags (${topIssueType} most prominent)`,
      drill: `${flagCount} posture flags detected (${topIssueType} most prominent). Between run-throughs, reset your position: feet flat, back straight, wrists level before each take.`,
    });
  }

  if (
    areas.length < 3 &&
    s.tempoDeviationPct !== null &&
    Math.abs(s.tempoDeviationPct) > 10
  ) {
    areas.push({
      bucket: "Tempo",
      color: "#059669",
      summary: `Overall tempo drifted ${s.tempoDeviationPct.toFixed(1)}% from the reference`,
      drill: `Overall tempo drifted ${s.tempoDeviationPct.toFixed(1)}% from the reference. Run the piece with a metronome locked to the target BPM, counting out loud to anchor the beat.`,
    });
  }

  return areas;
}

export default function Home() {
  const [midi, setMidi] = useState<MidiResponse | null>(null);
  const [video, setVideo] = useState<VideoResponse | null>(null);
  const [alignment, setAlignment] = useState<AlignResponse | null>(null);
  const [playedNotes, setPlayedNotes] = useState<PlayedNote[] | null>(null);
  const [pose, setPose] = useState<PoseResponse | null>(null);
  const [tutor, setTutor] = useState<TutorResponse | null>(null);
  const [busy, setBusy] = useState<"midi" | "video" | "analyze" | "tutor" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [postureWarning, setPostureWarning] = useState<string | null>(null);
  const [tutorWarning, setTutorWarning] = useState<string | null>(null);
  const [renderMode, setRenderMode] = useState<"score" | "piano-roll">("score");
  const [showPoseOverlay, setShowPoseOverlay] = useState(true);
  const performanceVideoRef = useRef<HTMLVideoElement | null>(null);

  async function uploadMidi(file: File) {
    setBusy("midi");
    setError(null);
    setPostureWarning(null);
    setAlignment(null);
    setPlayedNotes(null);
    setPose(null);
    setTutor(null);
    setVideo(null);
    setMidi(null);
    setTutorWarning(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${API_BASE}/midi`, { method: "POST", body: fd });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      setMidi((await res.json()) as MidiResponse);
    } catch (e) {
      setError(`MIDI upload failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function uploadVideo(file: File) {
    if (!midi) return;
    setBusy("video");
    setError(null);
    setPostureWarning(null);
    setAlignment(null);
    setPlayedNotes(null);
    setPose(null);
    setTutor(null);
    setTutorWarning(null);
    try {
      const fd = new FormData();
      fd.append("session_id", midi.sessionId);
      fd.append("file", file);
      const res = await fetch(`${API_BASE}/video`, { method: "POST", body: fd });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      setVideo((await res.json()) as VideoResponse);
    } catch (e) {
      setError(`Video upload failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function runAnalysis() {
    if (!midi || !video) return;
    setBusy("analyze");
    setError(null);
    setPostureWarning(null);
    setAlignment(null);
    setPlayedNotes(null);
    setPose(null);
    setTutor(null);
    setTutorWarning(null);
    try {
      const analyzeRes = await fetch(`${API_BASE}/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: midi.sessionId }),
      });
      if (!analyzeRes.ok) {
        throw new Error(`Analyze failed (${analyzeRes.status}): ${await analyzeRes.text()}`);
      }
      const analyze = (await analyzeRes.json()) as AnalyzeResponse;
      setPlayedNotes(analyze.playedNotes);

      const alignRes = await fetch(`${API_BASE}/align`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: midi.sessionId }),
      });
      if (!alignRes.ok) {
        throw new Error(`Align failed (${alignRes.status}): ${await alignRes.text()}`);
      }
      setAlignment((await alignRes.json()) as AlignResponse);

      const poseRes = await fetch(`${API_BASE}/pose`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: midi.sessionId }),
      });
      if (!poseRes.ok) {
        const detail = (await poseRes.text()).slice(0, 180);
        setPostureWarning(`Posture analysis unavailable (${poseRes.status}): ${detail}`);
      } else {
        setPose((await poseRes.json()) as PoseResponse);
      }
    } catch (e) {
      setError(`Analysis failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function generateTutorFeedback() {
    if (!midi || !alignment) return;
    setBusy("tutor");
    setError(null);
    setTutorWarning(null);
    try {
      const tutorRes = await fetch(`${API_BASE}/tutor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: midi.sessionId }),
      });
      if (!tutorRes.ok) {
        throw new Error(`Tutor failed (${tutorRes.status}): ${await tutorRes.text()}`);
      }
      setTutor((await tutorRes.json()) as TutorResponse);
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

  const redCount = alignment ? alignment.summary.wrongPitch : 0;
  const dynamicsOutlierCount = useMemo(() => {
    if (!alignment) return 0;
    return alignment.annotatedReferenceNotes.filter(hasDynamicOutlier).length;
  }, [alignment]);
  const analysisDurationMs = useMemo(() => {
    const midiDuration = midi?.durationMs ?? 0;
    const playedDuration = (playedNotes ?? []).reduce(
      (max, note) => Math.max(max, note.onset_ms + note.duration_ms),
      0,
    );
    const postureDuration = pose?.postureTimeline.reduce(
      (max, point) => Math.max(max, point.timestampMs),
      0,
    ) ?? 0;
    return Math.max(1, midiDuration, playedDuration, postureDuration);
  }, [midi?.durationMs, playedNotes, pose?.postureTimeline]);

  const focusAreas = useMemo(
    () => (alignment ? computeFocusAreas(alignment, pose, dynamicsOutlierCount) : []),
    [alignment, pose, dynamicsOutlierCount],
  );

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8 font-sans">
      <header>
        <h1 className="text-3xl font-bold">Piano Tutor</h1>
        <p className="text-zinc-500">
          Upload the MIDI of your piece and a side-view video of you playing it.
        </p>
      </header>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}
      {postureWarning && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          {postureWarning}
        </div>
      )}
      {tutorWarning && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          {tutorWarning}
        </div>
      )}

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <UploadCard
          step="1"
          label="Reference MIDI"
          accept=".mid,.midi"
          disabled={busy !== null}
          loading={busy === "midi"}
          onFile={uploadMidi}
          status={
            midi
              ? `${midi.noteCount} notes · ${(midi.durationMs / 1000).toFixed(1)}s${
                  midi.tempoBpm ? ` · ~${midi.tempoBpm.toFixed(0)} BPM` : ""
                }`
              : null
          }
        />
        <UploadCard
          step="2"
          label="Performance video"
          accept="video/*"
          disabled={busy !== null || !midi}
          loading={busy === "video"}
          onFile={uploadVideo}
          status={
            video
              ? `Audio extracted · session ${midi?.sessionId.slice(0, 8)}…`
              : null
          }
          hint={!midi ? "Upload MIDI first." : undefined}
        />
      </section>

      <section>
        <button
          disabled={!midi || !video || busy !== null}
          className="rounded bg-black px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-30 dark:bg-white dark:text-black"
          onClick={runAnalysis}
        >
          {busy === "analyze" ? "Analyzing…" : "Start analysis"}
        </button>
        {midi && video && !alignment && (
          <p className="mt-2 text-sm text-zinc-500">Ready to analyze session: {midi.sessionId}</p>
        )}
        {alignment && (
          <p className="mt-2 text-sm text-zinc-600">
            Alignment: {alignment.summary.correct} correct, {alignment.summary.wrongPitch} wrong pitch,
            {" "}{alignment.summary.missed} missed, {alignment.summary.extra} extra, tempo deviation{" "}
            {alignment.summary.tempoDeviationPct === null
              ? "n/a"
              : `${alignment.summary.tempoDeviationPct.toFixed(1)}%`}.
          </p>
        )}
        {alignment && (
          <p className="mt-1 text-sm text-zinc-600">
            Timing (±{alignment.summary.timingThresholdMs}ms): {alignment.summary.onTime} on-time, {alignment.summary.early} early, {alignment.summary.late} late.
          </p>
        )}
        {alignment && (
          <p className="mt-1 text-sm text-zinc-600">
            Dynamics alerts (|delta| &gt; {DYNAMIC_DELTA_ALERT_THRESHOLD}): {dynamicsOutlierCount}.
          </p>
        )}
        {pose && (
          <p className="mt-1 text-sm text-zinc-600">
            Posture flags: {pose.postureSummary.flagCount} total across {pose.sampledFrameCount} sampled frames at ~{pose.sampleFps.toFixed(1)}fps.
          </p>
        )}
        {(video?.videoUrl || midi?.referenceAudioUrl) && (
          <div className="mt-3 rounded border border-zinc-200 p-3 dark:border-zinc-800">
            <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">A/B playback</h3>
            <div className="mt-2 grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Your performance
                  </p>
                  {video?.videoUrl && pose && (
                    <label className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-500">
                      <input
                        type="checkbox"
                        checked={showPoseOverlay}
                        onChange={(e) => setShowPoseOverlay(e.target.checked)}
                        className="h-3.5 w-3.5"
                      />
                      Pose overlay
                    </label>
                  )}
                </div>
                {video?.videoUrl ? (
                  <div className="relative w-full">
                    <video
                      ref={performanceVideoRef}
                      controls
                      preload="metadata"
                      src={resolveApiUrl(video.videoUrl)}
                      className="w-full rounded border border-zinc-200 dark:border-zinc-800"
                    />
                    {pose && showPoseOverlay && (
                      <PoseOverlay
                        videoRef={performanceVideoRef}
                        frames={pose.frames}
                      />
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-zinc-500">Upload performance video to enable scrubbing.</p>
                )}
              </div>
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                  Correct version
                </p>
                {midi?.referenceAudioUrl ? (
                  <>
                    <audio
                      controls
                      preload="metadata"
                      src={resolveApiUrl(midi.referenceAudioUrl)}
                      className="w-full"
                    />
                    <p className="text-xs text-zinc-500">
                      Renderer:{" "}
                      {midi.referenceAudioRenderer === "fluidsynth_sf2"
                        ? "sampled piano (SoundFont)"
                        : "synth fallback"}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-zinc-500">
                    Reference audio synthesis unavailable for this MIDI.
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
        {alignment && (
          <div className="mt-3">
            <button
              disabled={busy !== null}
              className="rounded bg-zinc-900 px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-30 dark:bg-zinc-100 dark:text-zinc-900"
              onClick={generateTutorFeedback}
            >
              {busy === "tutor"
                ? "Generating tutor feedback…"
                : tutor
                  ? "Regenerate tutor feedback"
                  : "Play tutor feedback"}
            </button>
          </div>
        )}
      </section>

      {alignment && (
        <TutorReportCard
          tutor={tutor}
          alignment={alignment}
          busy={busy === "tutor"}
          onGenerate={generateTutorFeedback}
          resolveUrl={resolveApiUrl}
        />
      )}

      {focusAreas.length > 0 && (
        <>
          <section>
            <h2 className="mb-3 text-xl font-semibold">Focus Areas</h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {focusAreas.map((area) => (
                <div
                  key={area.bucket}
                  className="rounded border border-zinc-200 p-3 pl-4 dark:border-zinc-800"
                  style={{ borderLeftColor: area.color, borderLeftWidth: 4 }}
                >
                  <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{area.bucket}</p>
                  <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">{area.summary}</p>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold">Today&apos;s Drills</h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {focusAreas.map((area, idx) => (
                <div
                  key={area.bucket}
                  className="rounded border border-zinc-200 p-3 pl-4 dark:border-zinc-800"
                  style={{ borderLeftColor: area.color, borderLeftWidth: 4 }}
                >
                  <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                    Drill {idx + 1}
                  </p>
                  <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">{area.drill}</p>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold">Score</h2>
          <div className="flex gap-2">
            <button
              onClick={() => setRenderMode("score")}
              className={`rounded px-3 py-1 text-sm ${renderMode === "score" ? "bg-black text-white dark:bg-white dark:text-black" : "bg-zinc-200 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200"}`}
            >
              OSMD
            </button>
            <button
              onClick={() => setRenderMode("piano-roll")}
              className={`rounded px-3 py-1 text-sm ${renderMode === "piano-roll" ? "bg-black text-white dark:bg-white dark:text-black" : "bg-zinc-200 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200"}`}
            >
              Piano Roll
            </button>
          </div>
        </div>

        {renderMode === "score" && midi?.musicxml ? (
          <ScoreView
            musicxml={midi.musicxml}
            annotatedReferenceNotes={alignment?.annotatedReferenceNotes ?? null}
            onColoringFailure={() => setRenderMode("piano-roll")}
            onNoteScrub={seekPerformanceVideo}
          />
        ) : renderMode === "piano-roll" && midi ? (
          <PianoRollView
            referenceNotes={midi.referenceNotes}
            annotatedReferenceNotes={alignment?.annotatedReferenceNotes ?? null}
            playedNotes={playedNotes}
            onNoteScrub={seekPerformanceVideo}
          />
        ) : (
          <p className="text-zinc-400">Upload a MIDI to see the score render here.</p>
        )}

        {alignment && redCount > 0 && (
          <p className="mt-2 text-sm text-zinc-600">
            Done condition check: {redCount} red wrong-pitch notes detected. Click highlighted notes to scrub the performance video.
          </p>
        )}
        {pose && (
          <PostureTimeline
            totalDurationMs={analysisDurationMs}
            postureFlags={pose.postureFlags}
          />
        )}
      </section>
      {alignment && (
        <MarginaliaSection alignment={alignment} playedNotes={playedNotes} />
      )}
    </main>
  );
}

function UploadCard(props: {
  step: string;
  label: string;
  accept: string;
  disabled: boolean;
  loading: boolean;
  onFile: (f: File) => void;
  status: string | null;
  hint?: string;
}) {
  const { step, label, accept, disabled, loading, onFile, status, hint } = props;
  return (
    <div className="rounded border border-zinc-200 p-4 dark:border-zinc-800">
      <h3 className="font-medium">
        <span className="mr-2 text-zinc-400">{step}.</span>
        {label}
      </h3>
      <input
        type="file"
        accept={accept}
        disabled={disabled}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
        className="mt-2 block w-full text-sm"
      />
      {loading && <p className="mt-2 text-sm text-zinc-500">Uploading…</p>}
      {status && <p className="mt-2 text-sm text-emerald-700">{status}</p>}
      {hint && !status && !loading && <p className="mt-2 text-sm text-zinc-400">{hint}</p>}
    </div>
  );
}

function ScoreView({
  musicxml,
  annotatedReferenceNotes,
  onColoringFailure,
  onNoteScrub,
}: {
  musicxml: string;
  annotatedReferenceNotes: AnnotatedReferenceNote[] | null;
  onColoringFailure: () => void;
  onNoteScrub: (onsetMs: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const container = ref.current;
    let cancelled = false;

    (async () => {
      const mod = await import("opensheetmusicdisplay");
      if (cancelled) return;
      container.innerHTML = "";
      const inst = new mod.OpenSheetMusicDisplay(container, {
        autoResize: true,
        backend: "svg",
        drawTitle: true,
      });
      try {
        await inst.load(musicxml);
        if (cancelled) return;
        if (annotatedReferenceNotes?.length) {
          applyAlignmentColors(inst as unknown as OsmdLike, annotatedReferenceNotes, "pre-render");
        }
        inst.render();
        if (annotatedReferenceNotes?.length) {
          applyAlignmentColors(inst as unknown as OsmdLike, annotatedReferenceNotes, "post-render");
          bindScoreScrubClicks(inst as unknown as OsmdLike, annotatedReferenceNotes, onNoteScrub);
        }
      } catch (e) {
        console.error("OSMD load/render failed", e);
        container.innerHTML = `<p style=\"color:#b91c1c\">Failed to render score: ${
          (e as Error).message
        }</p>`;
        onColoringFailure();
      }
    })();

    return () => {
      cancelled = true;
      container.innerHTML = "";
    };
  }, [musicxml, annotatedReferenceNotes, onColoringFailure, onNoteScrub]);

  return (
    <div
      ref={ref}
      className="overflow-auto rounded border border-zinc-200 bg-white p-4 dark:border-zinc-800"
    />
  );
}

type OsmdLike = {
  Sheet?: {
    SourceMeasures?: Array<{
      VerticalSourceStaffEntryContainers?: Array<{
        StaffEntries?: Array<{
          VoiceEntries?: Array<{
            Notes?: unknown[];
          } | null>;
        } | null>;
      }>;
    }>;
  };
  EngravingRules?: {
    GNote?: (sourceNote: unknown) => {
      setColor?: (
        color: string,
        options: {
          applyToNoteheads: boolean;
          applyToStem: boolean;
          applyToBeams: boolean;
          applyToFlag: boolean;
          applyToLedgerLines: boolean;
          applyToModifiers: boolean;
          applyToTies: boolean;
          applyToSlurs: boolean;
        },
      ) => void;
      getSVGGElement?: () => SVGGElement;
    } | null;
  };
};

function collectSourceNotes(osmd: OsmdLike): unknown[] {
  const sourceNotes: unknown[] = [];
  const sourceMeasures = osmd.Sheet?.SourceMeasures ?? [];

  for (const measure of sourceMeasures) {
    for (const verticalContainer of measure.VerticalSourceStaffEntryContainers ?? []) {
      for (const staffEntry of verticalContainer.StaffEntries ?? []) {
        if (!staffEntry) continue;
        for (const voiceEntry of staffEntry.VoiceEntries ?? []) {
          if (!voiceEntry) continue;
          for (const note of voiceEntry.Notes ?? []) {
            sourceNotes.push(note);
          }
        }
      }
    }
  }
  return sourceNotes;
}

function applyAlignmentColors(
  osmd: OsmdLike,
  annotatedReferenceNotes: AnnotatedReferenceNote[],
  phase: "pre-render" | "post-render",
) {
  const sourceNotes = collectSourceNotes(osmd);
  const byRefIdx = new Map<number, AnnotatedReferenceNote>(
    annotatedReferenceNotes.map((note) => [note.refIdx, note]),
  );

  let refIdx = 0;
  for (const sourceNote of sourceNotes) {
    if (typeof sourceNote === "object" && sourceNote && "isRest" in sourceNote) {
      const restNote = sourceNote as { isRest?: () => boolean };
      if (typeof restNote.isRest === "function" && restNote.isRest()) {
        continue;
      }
    }

    const annotated = byRefIdx.get(refIdx);
    const status = annotated?.status;
    const dynamicOutlier = annotated ? hasDynamicOutlier(annotated) : false;
    const color = dynamicOutlier
      ? DYNAMIC_ALERT_COLOR
      : status && status !== "correct"
        ? STATUS_COLORS[status]
        : null;

    if (color) {
      const note = sourceNote as {
        NoteheadColor?: string;
        ParentVoiceEntry?: { StemColor?: string };
      };
      if (phase === "pre-render") {
        note.NoteheadColor = color;
        if (note.ParentVoiceEntry) {
          note.ParentVoiceEntry.StemColor = color;
        }
      } else {
        const graphicalNote = osmd.EngravingRules?.GNote?.(sourceNote);
        graphicalNote?.setColor?.(color, {
          applyToNoteheads: true,
          applyToStem: true,
          applyToBeams: true,
          applyToFlag: true,
          applyToLedgerLines: true,
          applyToModifiers: true,
          applyToTies: false,
          applyToSlurs: false,
        });
      }
    }
    refIdx += 1;
  }
}

function bindScoreScrubClicks(
  osmd: OsmdLike,
  annotatedReferenceNotes: AnnotatedReferenceNote[],
  onNoteScrub: (onsetMs: number) => void,
) {
  const sourceNotes = collectSourceNotes(osmd);
  const byRefIdx = new Map<number, AnnotatedReferenceNote>(
    annotatedReferenceNotes.map((note) => [note.refIdx, note]),
  );

  let refIdx = 0;
  for (const sourceNote of sourceNotes) {
    if (typeof sourceNote === "object" && sourceNote && "isRest" in sourceNote) {
      const restNote = sourceNote as { isRest?: () => boolean };
      if (typeof restNote.isRest === "function" && restNote.isRest()) {
        continue;
      }
    }

    const annotated = byRefIdx.get(refIdx);
    if (!annotated) {
      refIdx += 1;
      continue;
    }
    const dynamicHint = dynamicTooltip(annotated);
    const clickable = annotated.status !== "correct" || dynamicHint !== null;
    if (!clickable) {
      refIdx += 1;
      continue;
    }

    const graphicalNote = osmd.EngravingRules?.GNote?.(sourceNote);
    const group = graphicalNote?.getSVGGElement?.();
    if (!group) {
      refIdx += 1;
      continue;
    }

    group.style.cursor = "pointer";
    group.setAttribute("tabindex", "0");
    group.setAttribute("role", "button");
    const baseText = `${(annotated.onset_ms / 1000).toFixed(2)}s`;
    const titleText = dynamicHint
      ? `${baseText} · ${dynamicHint}`
      : `${baseText} · ${annotated.status}`;
    group.setAttribute("title", titleText);
    group.onclick = () => onNoteScrub(annotated.onset_ms);
    group.onkeydown = (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onNoteScrub(annotated.onset_ms);
      }
    };
    refIdx += 1;
  }
}

const FLAT_NOTE_NAMES = ["c", "db", "d", "eb", "e", "f", "gb", "g", "ab", "a", "bb", "b"];

function midiToNoteName(pitch: number): string {
  const octave = Math.floor(pitch / 12) - 1;
  const name = FLAT_NOTE_NAMES[pitch % 12];
  return `${name}${octave}`;
}

type MarginaliaEntry = {
  timeMs: number;
  text: string;
};

function buildMarginalia(
  alignment: AlignResponse,
  playedNotes: PlayedNote[] | null,
): MarginaliaEntry[] {
  const entries: MarginaliaEntry[] = [];

  for (const note of alignment.annotatedReferenceNotes) {
    const timeSec = (note.onset_ms / 1000).toFixed(1);

    if (note.status === "wrongPitch") {
      const expectedName = midiToNoteName(note.pitch);
      const playedNote =
        playedNotes && note.playedIdx !== null ? playedNotes[note.playedIdx] : null;
      const playedName = playedNote ? midiToNoteName(playedNote.pitch) : "?";
      entries.push({
        timeMs: note.onset_ms,
        text: `${timeSec}s  wrong pitch  played ${playedName}  expected ${expectedName}`,
      });
    } else if (note.status === "missed") {
      const expectedName = midiToNoteName(note.pitch);
      entries.push({
        timeMs: note.onset_ms,
        text: `${timeSec}s  missed  ${expectedName}`,
      });
    } else if (note.status === "extra") {
      const playedNote =
        playedNotes && note.playedIdx !== null ? playedNotes[note.playedIdx] : null;
      const noteName = playedNote ? `  ${midiToNoteName(playedNote.pitch)}` : "";
      entries.push({
        timeMs: note.onset_ms,
        text: `${timeSec}s  extra note${noteName}`,
      });
    }

    if (hasDynamicOutlier(note)) {
      const delta = note.dynamicDelta!;
      const label = note.dynamicLabel ?? (delta > 0 ? "too forceful" : "too soft");
      const sign = delta > 0 ? "+" : "";
      entries.push({
        timeMs: note.onset_ms,
        text: `${timeSec}s  dynamics  ${label} (Δ ${sign}${delta})`,
      });
    }
  }

  return entries.sort((a, b) => a.timeMs - b.timeMs);
}

function MarginaliaSection({
  alignment,
  playedNotes,
}: {
  alignment: AlignResponse;
  playedNotes: PlayedNote[] | null;
}) {
  const entries = useMemo(
    () => buildMarginalia(alignment, playedNotes),
    [alignment, playedNotes],
  );

  if (entries.length === 0) {
    return (
      <section>
        <h2 className="mb-3 text-xl font-semibold">Marginalia</h2>
        <p className="text-sm text-zinc-400">No errors detected.</p>
      </section>
    );
  }

  return (
    <section>
      <h2 className="mb-3 text-xl font-semibold">Marginalia</h2>
      <ol className="space-y-1 rounded border border-zinc-200 bg-white p-4 font-mono text-sm dark:border-zinc-800 dark:bg-zinc-950">
        {entries.map((entry, idx) => (
          <li key={idx} className="text-zinc-700 dark:text-zinc-300">
            {entry.text}
          </li>
        ))}
      </ol>
    </section>
  );
}

function postureSeverityOpacity(severity: PostureSeverity): number {
  if (severity === "severe") return 0.95;
  if (severity === "moderate") return 0.75;
  return 0.55;
}

function prettyRuleName(rule: PostureRule): string {
  return rule.replaceAll("_", " ");
}

function PoseOverlay({
  videoRef,
  frames,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  frames: PoseFrame[];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || frames.length === 0) return;

    function syncCanvasSize() {
      if (!video || !canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const w = video.clientWidth;
      const h = video.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        const ctx = canvas.getContext("2d");
        if (ctx) ctx.scale(dpr, dpr);
      }
    }

    function findNearestFrame(currentMs: number): PoseFrame {
      let best = frames[0];
      let bestDiff = Math.abs(frames[0].timestampMs - currentMs);
      for (let i = 1; i < frames.length; i++) {
        const diff = Math.abs(frames[i].timestampMs - currentMs);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = frames[i];
        }
      }
      return best;
    }

    function pt(lm: LandmarkXY, w: number, h: number): [number, number] {
      return [lm.x * w, lm.y * h];
    }

    function drawFrame() {
      if (!video || !canvas) return;
      syncCanvasSize();
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const W = canvas.width / dpr;
      const H = canvas.height / dpr;
      ctx.clearRect(0, 0, W, H);

      const currentMs = video.currentTime * 1000;
      const frame = findNearestFrame(currentMs);

      ctx.lineWidth = 2;
      ctx.lineCap = "round";

      // Body skeleton
      const pose = frame.pose;
      if (pose) {
        const joints: Array<[LandmarkXY, string]> = [
          [pose.leftEar, "#a78bfa"],
          [pose.rightEar, "#a78bfa"],
          [pose.leftShoulder, "#60a5fa"],
          [pose.rightShoulder, "#60a5fa"],
          [pose.leftHip, "#34d399"],
          [pose.rightHip, "#34d399"],
        ];

        const connections: Array<[LandmarkXY, LandmarkXY]> = [
          [pose.leftEar, pose.leftShoulder],
          [pose.rightEar, pose.rightShoulder],
          [pose.leftShoulder, pose.rightShoulder],
          [pose.leftShoulder, pose.leftHip],
          [pose.rightShoulder, pose.rightHip],
          [pose.leftHip, pose.rightHip],
        ];

        ctx.strokeStyle = "rgba(255,255,255,0.6)";
        ctx.lineWidth = 2;
        for (const [a, b] of connections) {
          const [ax, ay] = pt(a, W, H);
          const [bx, by] = pt(b, W, H);
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.stroke();
        }

        for (const [lm, color] of joints) {
          const [x, y] = pt(lm, W, H);
          ctx.beginPath();
          ctx.arc(x, y, 5, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.strokeStyle = "white";
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }

      // Hand landmarks
      for (const hand of frame.hands ?? []) {
        const handColor = hand.label === "left" ? "#fb923c" : "#f472b6";
        const joints: LandmarkXY[] = [
          hand.wrist,
          hand.indexMcp,
          hand.indexPip,
          hand.middleMcp,
          hand.middlePip,
        ];
        const chains: Array<LandmarkXY[]> = [
          [hand.wrist, hand.indexMcp, hand.indexPip],
          [hand.wrist, hand.middleMcp, hand.middlePip],
        ];

        ctx.strokeStyle = handColor;
        ctx.lineWidth = 1.5;
        for (const chain of chains) {
          ctx.beginPath();
          const [sx, sy] = pt(chain[0], W, H);
          ctx.moveTo(sx, sy);
          for (let i = 1; i < chain.length; i++) {
            const [cx, cy] = pt(chain[i], W, H);
            ctx.lineTo(cx, cy);
          }
          ctx.stroke();
        }

        for (const lm of joints) {
          const [x, y] = pt(lm, W, H);
          ctx.beginPath();
          ctx.arc(x, y, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = handColor;
          ctx.fill();
          ctx.strokeStyle = "white";
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }

    const ro = new ResizeObserver(() => {
      syncCanvasSize();
      drawFrame();
    });
    ro.observe(video);

    video.addEventListener("timeupdate", drawFrame);
    video.addEventListener("seeked", drawFrame);
    video.addEventListener("loadedmetadata", drawFrame);

    drawFrame();

    return () => {
      video.removeEventListener("timeupdate", drawFrame);
      video.removeEventListener("seeked", drawFrame);
      video.removeEventListener("loadedmetadata", drawFrame);
      ro.disconnect();
    };
  }, [videoRef, frames]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    />
  );
}

function PostureTimeline({
  totalDurationMs,
  postureFlags,
}: {
  totalDurationMs: number;
  postureFlags: PostureFlag[];
}) {
  const lanes: PostureRule[] = [
    "slouched_back",
    "raised_shoulders",
    "collapsed_wrist",
    "flat_fingers",
  ];

  return (
    <div className="mt-4 rounded border border-zinc-200 bg-white p-4 dark:border-zinc-800">
      <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">Posture Timeline</h3>
      <p className="mt-1 text-xs text-zinc-500">
        Colored blocks are time-aligned posture flags from the video.
      </p>

      <div className="mt-3 space-y-2">
        {lanes.map((lane) => {
          const laneFlags = postureFlags.filter((flag) => flag.type === lane);
          return (
            <div key={lane} className="grid grid-cols-[140px_1fr] items-center gap-3">
              <span className="text-xs capitalize text-zinc-600 dark:text-zinc-300">
                {prettyRuleName(lane)}
              </span>
              <div className="relative h-6 rounded bg-zinc-100 dark:bg-zinc-900">
                {laneFlags.map((flag, idx) => {
                  const leftPct = (flag.startMs / totalDurationMs) * 100;
                  const widthPct = Math.max(
                    0.8,
                    ((flag.endMs - flag.startMs) / totalDurationMs) * 100,
                  );
                  return (
                    <div
                      key={`${lane}-${idx}`}
                      className="absolute top-0 h-6 rounded"
                      style={{
                        left: `${leftPct}%`,
                        width: `${widthPct}%`,
                        background: POSTURE_RULE_COLORS[lane],
                        opacity: postureSeverityOpacity(flag.severity),
                      }}
                      title={`${prettyRuleName(flag.type)} · ${flag.severity} · ${(flag.startMs / 1000).toFixed(1)}s - ${(flag.endMs / 1000).toFixed(1)}s`}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {postureFlags.length === 0 && (
        <p className="mt-2 text-xs text-zinc-500">No posture flags detected for this take.</p>
      )}
    </div>
  );
}


function estimatePracticeMinutes(summary: AlignmentSummary): number {
  const errorCount = summary.wrongPitch + summary.missed;
  if (errorCount === 0) return 5;
  return Math.max(5, Math.round(errorCount * 0.38));
}

function StackedBar({ segments }: { segments: { value: number; color: string; label: string }[] }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (total === 0) return <div className="h-3 w-full rounded bg-zinc-200" />;
  return (
    <div className="flex h-3 w-full overflow-hidden rounded">
      {segments.map((s) => {
        if (s.value === 0) return null;
        return (
          <div
            key={s.label}
            style={{ width: `${(s.value / total) * 100}%`, background: s.color }}
            title={`${s.label}: ${s.value}`}
          />
        );
      })}
    </div>
  );
}

function AlignmentPanel({ summary }: { summary: AlignmentSummary }) {
  const alignSegments = [
    { value: summary.correct, color: "#166534", label: "Correct" },
    { value: summary.wrongPitch, color: "#dc2626", label: "Wrong pitch" },
    { value: summary.missed, color: "#9ca3af", label: "Missed" },
    { value: summary.extra, color: "#64748b", label: "Extra" },
  ];
  const timingSegments = [
    { value: summary.early, color: "#166534", label: "Early" },
    { value: summary.onTime, color: "#16a34a", label: "On time" },
    { value: summary.late, color: "#dc2626", label: "Late" },
  ];
  const tempoText = summary.tempoDeviationPct !== null
    ? summary.tempoDeviationPct > 0
      ? `You play ${summary.tempoDeviationPct.toFixed(1)}% behind tempo on average.`
      : `You play ${Math.abs(summary.tempoDeviationPct).toFixed(1)}% ahead of tempo on average.`
    : null;

  return (
    <div className="border-l border-zinc-200 p-6 dark:border-zinc-800">
      <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Alignment</p>
      <div className="mt-3">
        <StackedBar segments={alignSegments} />
        <div className="mt-2 space-y-1">
          {alignSegments.map((s) => (
            <div key={s.label} className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
                <span className="text-zinc-600 dark:text-zinc-300">{s.label}</span>
              </span>
              <span className="font-medium text-zinc-800 dark:text-zinc-100">{s.value}</span>
            </div>
          ))}
        </div>
      </div>

      <p className="mt-5 text-xs font-semibold uppercase tracking-widest text-zinc-500">
        Timing (±{summary.timingThresholdMs}ms)
      </p>
      <div className="mt-3">
        <StackedBar segments={timingSegments} />
        <div className="mt-2 flex justify-between text-sm text-zinc-500">
          <span>{summary.early} early</span>
          <span>{summary.onTime} on time</span>
          <span className={summary.late > 0 ? "font-medium text-red-600" : ""}>{summary.late} late</span>
        </div>
        {tempoText && (
          <p className="mt-2 text-xs italic text-zinc-500">{tempoText}</p>
        )}
      </div>
    </div>
  );
}

function TutorReportCard({
  tutor,
  alignment,
  busy,
  onGenerate,
  resolveUrl,
}: {
  tutor: TutorResponse | null;
  alignment: AlignResponse;
  busy: boolean;
  onGenerate: () => void;
  resolveUrl: (path: string) => string;
}) {
  const practiceMinutes = estimatePracticeMinutes(alignment.summary);
  const errorDomain = alignment.summary.wrongPitch + alignment.summary.missed > 0
    ? "pitch errors"
    : alignment.summary.late + alignment.summary.early > 0
      ? "timing issues"
      : "remaining issues";

  return (
    <section className="overflow-hidden rounded border border-zinc-200 dark:border-zinc-800">
      <div className="grid grid-cols-1 md:grid-cols-[1fr_260px]">
        <div className="p-6">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
              A Patient Note From Your Tutor —
            </span>
            <button
              disabled={busy}
              onClick={onGenerate}
              className="flex items-center gap-1.5 rounded border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              <span>▶</span>
              {busy ? "Generating…" : tutor ? "Replay tutor" : "Play tutor"}
            </button>
          </div>

          {tutor ? (
            <>
              <blockquote className="mt-4 text-xl leading-relaxed text-zinc-800 dark:text-zinc-100">
                &ldquo;{tutor.writtenNote ?? tutor.tutorScript}&rdquo;
              </blockquote>
              <audio
                key={tutor.audioUrl}
                autoPlay
                controls
                preload="auto"
                src={resolveUrl(tutor.audioUrl)}
                className="mt-4 w-full"
              />
              <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
                {tutor.strengths?.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Strengths</p>
                    <ul className="mt-2 space-y-1">
                      {tutor.strengths.map((s, i) => (
                        <li key={i} className="text-sm italic text-zinc-600 dark:text-zinc-300">
                          + {s}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">This Week</p>
                  <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">
                    Estimated {practiceMinutes} minutes of focused practice should clear most {errorDomain}.
                  </p>
                </div>
              </div>
            </>
          ) : (
            <p className="mt-4 text-sm text-zinc-400">
              Click &ldquo;Play tutor&rdquo; to generate personalized feedback.
            </p>
          )}
        </div>

        <AlignmentPanel summary={alignment.summary} />
      </div>
    </section>
  );
}

function PianoRollView({
  referenceNotes,
  annotatedReferenceNotes,
  playedNotes,
  onNoteScrub,
}: {
  referenceNotes: ReferenceNote[];
  annotatedReferenceNotes: AnnotatedReferenceNote[] | null;
  playedNotes: PlayedNote[] | null;
  onNoteScrub: (onsetMs: number) => void;
}) {
  const width = 980;
  const height = 360;
  const padX = 22;
  const padY = 18;

  const annotatedByRefIdx = useMemo(
    () => new Map((annotatedReferenceNotes ?? []).map((n) => [n.refIdx, n])),
    [annotatedReferenceNotes],
  );

  const maxTime = useMemo(() => {
    const refMax = referenceNotes.reduce((acc, n) => Math.max(acc, n.onset + n.duration), 0);
    const playedMax = (playedNotes ?? []).reduce(
      (acc, n) => Math.max(acc, n.onset_ms + n.duration_ms),
      0,
    );
    return Math.max(refMax, playedMax, 1);
  }, [referenceNotes, playedNotes]);

  const minPitch = useMemo(() => {
    const refMin = referenceNotes.reduce((acc, n) => Math.min(acc, n.pitch), 127);
    const playedMin = (playedNotes ?? []).reduce((acc, n) => Math.min(acc, n.pitch), 127);
    return Math.min(refMin, playedMin);
  }, [referenceNotes, playedNotes]);

  const maxPitch = useMemo(() => {
    const refMax = referenceNotes.reduce((acc, n) => Math.max(acc, n.pitch), 0);
    const playedMax = (playedNotes ?? []).reduce((acc, n) => Math.max(acc, n.pitch), 0);
    return Math.max(refMax, playedMax);
  }, [referenceNotes, playedNotes]);

  const pitchSpan = Math.max(1, maxPitch - minPitch);
  const drawW = width - padX * 2;
  const drawH = height - padY * 2;

  return (
    <div className="rounded border border-zinc-200 bg-white p-4 dark:border-zinc-800">
      <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Piano roll">
        <rect x="0" y="0" width={width} height={height} fill="#ffffff" />

        {referenceNotes.map((note, idx) => {
          const x = padX + (note.onset / maxTime) * drawW;
          const w = Math.max(1.5, (note.duration / maxTime) * drawW);
          const y = padY + ((maxPitch - note.pitch) / pitchSpan) * drawH;
          const annotated = annotatedByRefIdx.get(idx);
          const status = annotated?.status ?? "correct";
          const dynamicHint = annotated ? dynamicTooltip(annotated) : null;
          const color = dynamicHint
            ? DYNAMIC_ALERT_COLOR
            : status === "correct"
              ? "#cbd5e1"
              : STATUS_COLORS[status];
          const opacity = dynamicHint ? 0.92 : status === "correct" ? 0.45 : 0.8;
          const clickable = Boolean(annotated) && (status !== "correct" || dynamicHint !== null);
          const onsetMs = annotated?.onset_ms ?? note.onset;
          const title = dynamicHint
            ? `${(onsetMs / 1000).toFixed(2)}s · ${dynamicHint}`
            : `${(onsetMs / 1000).toFixed(2)}s · ${status}`;
          return (
            <rect
              key={`ref-${idx}`}
              x={x}
              y={y}
              width={w}
              height={4}
              fill={color}
              opacity={opacity}
              onClick={clickable ? () => onNoteScrub(onsetMs) : undefined}
              style={clickable ? { cursor: "pointer" } : undefined}
            >
              <title>{title}</title>
            </rect>
          );
        })}

        {(playedNotes ?? []).map((note, idx) => {
          const x = padX + (note.onset_ms / maxTime) * drawW;
          const w = Math.max(1.5, (note.duration_ms / maxTime) * drawW);
          const y = padY + ((maxPitch - note.pitch) / pitchSpan) * drawH;
          return (
            <rect
              key={`played-${idx}`}
              x={x}
              y={y + 5}
              width={w}
              height={3}
              fill="#111827"
              opacity={0.55}
            />
          );
        })}
      </svg>
      <p className="mt-2 text-sm text-zinc-600">
        Legend: red = wrong pitch, gray = missed reference note, orange = dynamic outlier (|delta| &gt; 40), black = played notes.
      </p>
    </div>
  );
}
