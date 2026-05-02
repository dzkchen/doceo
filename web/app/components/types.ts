export const DYNAMIC_DELTA_ALERT_THRESHOLD = 40;

export const STATUS_COLORS: Record<"wrongPitch" | "missed" | "extra", string> = {
  wrongPitch: "#c0341d",
  missed:     "#b8a98a",
  extra:      "#6e7a85",
};

export const DYNAMIC_ALERT_COLOR = "#b07a2d";

export const POSTURE_RULE_COLORS = {
  slouched_back:     "#2563eb",
  raised_shoulders:  "#b07a2d",
  collapsed_wrist:   "#c0341d",
  flat_fingers:      "#6b3e6e",
} as const;

export const FLAT_NOTE_NAMES = ["c","db","d","eb","e","f","gb","g","ab","a","bb","b"];

export type PostureRule = keyof typeof POSTURE_RULE_COLORS;
export type PostureSeverity = "mild" | "moderate" | "severe";
export type AnnotatedStatus = "correct" | "wrongPitch" | "missed" | "extra";

export type ReferenceNote = {
  pitch: number;
  onset: number;
  duration: number;
  velocity: number;
};

export type MidiResponse = {
  sessionId: string;
  referenceNotes: ReferenceNote[];
  musicxml: string | null;
  tempoBpm: number | null;
  isPianoOnly: boolean;
  durationMs: number;
  noteCount: number;
  referenceAudioPath: string | null;
  referenceAudioUrl: string | null;
  referenceAudioSampleRate: number | null;
  referenceAudioRenderer: "fluidsynth_sf2" | "fallback_wave" | null;
};

export type VideoResponse = {
  sessionId: string;
  videoPath: string;
  videoUrl: string;
  audioPath: string;
  performanceAudioUrl: string;
  audioSampleRate: number;
};

export type PlayedNote = {
  pitch: number;
  onset_ms: number;
  duration_ms: number;
  velocity: number;
};

export type DynamicInfo = {
  refDynamic: string;
  playedDynamic: string;
  direction: "too loud" | "too soft";
  steps: number;
};

export type AnnotatedReferenceNote = {
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
  dynamicInfo: DynamicInfo | null;
};

export type AlignmentSummary = {
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

export type TempoMapEntry = {
  measureNumber: number;
  deviationPct: number | null;
  startMs: number;
};

export type AlignResponse = {
  sessionId: string;
  annotatedReferenceNotes: AnnotatedReferenceNote[];
  summary: AlignmentSummary;
  tempoMap: TempoMapEntry[] | null;
};

export type PostureFlag = {
  type: PostureRule;
  startMs: number;
  endMs: number;
  severity: PostureSeverity;
  peakScore: number;
};

export type PostureTimelinePoint = {
  timestampMs: number;
  flags: Array<{ type: PostureRule; severity: PostureSeverity; score: number }>;
};

export type LandmarkXY = { x: number; y: number };

export type PoseBodyLandmarks = {
  leftShoulder: LandmarkXY;
  rightShoulder: LandmarkXY;
  leftHip: LandmarkXY;
  rightHip: LandmarkXY;
  leftEar: LandmarkXY;
  rightEar: LandmarkXY;
} | null;

export type HandLandmarks = {
  label: "left" | "right";
  wrist: LandmarkXY;
  indexMcp: LandmarkXY;
  indexPip: LandmarkXY;
  middleMcp: LandmarkXY;
  middlePip: LandmarkXY;
  indexPipAngleDeg: number | null;
  wristCollapse: number | null;
};

export type PoseFrame = {
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

export type PoseResponse = {
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

export type TutorResponse = {
  sessionId: string;
  piece: string;
  diff: unknown;
  tutorScript: string;
  writtenNote: string | null;
  strengths: string[];
  audioPath: string;
  audioUrl: string;
  model: { provider: string; model: string };
  voice: { voiceId: string };
};

export type ChatMessage = {
  role: "student" | "tutor";
  text: string;
  audioUrl?: string;
};

export type TutorChatResponse = {
  sessionId: string;
  reply: string;
  audioUrl: string | null;
  model: { provider: string; model: string };
  voice: { voiceId: string };
};

export type DrillResponse = {
  sessionId: string;
  excerptMidiUrl: string | null;
  aiDrillMidiUrl: string | null;
  aiDrillDescription: string | null;
};

export type FocusArea = {
  bucket: string;
  color: string;
  summary: string;
  drill: string;
};

export function hasDynamicOutlier(note: AnnotatedReferenceNote): boolean {
  if (note.dynamicInfo !== null && note.dynamicInfo !== undefined) {
    return note.dynamicInfo.steps >= 2;
  }
  return note.dynamicDelta !== null && Math.abs(note.dynamicDelta) > DYNAMIC_DELTA_ALERT_THRESHOLD;
}

export function dynamicTooltip(note: AnnotatedReferenceNote): string | null {
  if (!hasDynamicOutlier(note)) return null;
  if (note.dynamicInfo) {
    const { playedDynamic, refDynamic, steps, direction } = note.dynamicInfo;
    return `Played ${playedDynamic}, expected ${refDynamic} (${steps} level${steps > 1 ? "s" : ""} ${direction})`;
  }
  const label =
    note.dynamicLabel ??
    (note.dynamicDelta! > 0 ? "much louder than written" : "much softer than written");
  return `${label} (${note.dynamicDelta! > 0 ? "+" : ""}${note.dynamicDelta})`;
}

export function prettyRuleName(rule: PostureRule): string {
  return rule.replaceAll("_", " ");
}

export function midiToNoteName(pitch: number): string {
  const octave = Math.floor(pitch / 12) - 1;
  const name = FLAT_NOTE_NAMES[pitch % 12];
  return `${name}${octave}`;
}

export function postureSeverityOpacity(severity: PostureSeverity): number {
  if (severity === "severe") return 0.95;
  if (severity === "moderate") return 0.75;
  return 0.55;
}
