"use client";

import { useEffect, useMemo, useRef } from "react";
import type {
  MidiResponse, VideoResponse, AlignResponse, PlayedNote,
  PoseResponse, TutorResponse, FocusArea, AnnotatedReferenceNote,
  PostureFlag, PostureRule, LandmarkXY, PoseFrame, ReferenceNote, TempoMapEntry,
} from "./types";
import {
  DYNAMIC_DELTA_ALERT_THRESHOLD, STATUS_COLORS, DYNAMIC_ALERT_COLOR,
  POSTURE_RULE_COLORS, hasDynamicOutlier, dynamicTooltip,
  prettyRuleName, midiToNoteName, postureSeverityOpacity,
} from "./types";

type ResultsStageProps = {
  midi: MidiResponse;
  video: VideoResponse | null;
  alignment: AlignResponse;
  playedNotes: PlayedNote[] | null;
  pose: PoseResponse | null;
  tutor: TutorResponse | null;
  tutorBusy: boolean;
  focusAreas: FocusArea[];
  dynamicsOutlierCount: number;
  analysisDurationMs: number;
  renderMode: "score" | "piano-roll";
  setRenderMode: (m: "score" | "piano-roll") => void;
  showPoseOverlay: boolean;
  setShowPoseOverlay: (v: boolean) => void;
  onGenerateTutor: () => void;
  onSeekVideo: (onsetMs: number) => void;
  performanceVideoRef: React.RefObject<HTMLVideoElement | null>;
  resolveApiUrl: (path: string) => string;
  postureWarning: string | null;
  tutorWarning: string | null;
  onReset?: () => void;
};

export function ResultsStage({
  midi, video, alignment, playedNotes, pose, tutor, tutorBusy,
  focusAreas, dynamicsOutlierCount, analysisDurationMs,
  renderMode, setRenderMode, showPoseOverlay, setShowPoseOverlay,
  onGenerateTutor, onSeekVideo, performanceVideoRef,
  resolveApiUrl, postureWarning, tutorWarning,
}: ResultsStageProps) {
  const s = alignment.summary;

  return (
    <div className="col gap-3 fade-in">
      {/* Warnings */}
      {postureWarning && (
        <div style={{ padding: "10px 14px", background: "rgba(176,122,45,0.08)", border: "1px solid rgba(176,122,45,0.3)", borderRadius: 2, fontSize: 13, color: "var(--sepia)", fontFamily: "var(--mono)" }}>
          {postureWarning}
        </div>
      )}
      {tutorWarning && (
        <div style={{ padding: "10px 14px", background: "rgba(176,122,45,0.08)", border: "1px solid rgba(176,122,45,0.3)", borderRadius: 2, fontSize: 13, color: "var(--sepia)", fontFamily: "var(--mono)" }}>
          {tutorWarning}
        </div>
      )}

      {/* Header */}
      <ResultsHeader midi={midi} summary={s} />

      {/* Tutor verdict */}
      <TutorVerdict
        tutor={tutor}
        alignment={alignment}
        busy={tutorBusy}
        onGenerate={onGenerateTutor}
        resolveUrl={resolveApiUrl}
      />

      {/* Stats strip */}
      <StatsStrip alignment={alignment} dynamicsOutlierCount={dynamicsOutlierCount} pose={pose} />

      {/* Score + A/B playback side by side */}
      <div className="row gap-3" style={{ alignItems: "flex-start" }}>
        <div className="col gap-2" style={{ flex: 2.1 }}>
          {/* Toolbar */}
          <div className="sheet row between center-y" style={{ padding: "10px 16px", gap: 12 }}>
            <span className="serif" style={{ fontSize: 16 }}>Score</span>
            <div
              className="row"
              style={{ border: "1px solid var(--paper-edge)", borderRadius: 2, padding: 2, background: "var(--paper-deep)" }}
            >
              {(["score", "piano-roll"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setRenderMode(mode)}
                  style={{
                    fontFamily: "var(--sans)", fontSize: 12, padding: "5px 12px",
                    border: "none", borderRadius: 1,
                    background: renderMode === mode ? "var(--ink)" : "transparent",
                    color: renderMode === mode ? "var(--paper)" : "var(--ink-soft)",
                    cursor: "pointer", fontWeight: 500,
                  }}
                >
                  {mode === "score" ? "OSMD" : "Piano roll"}
                </button>
              ))}
            </div>
          </div>

          {renderMode === "score" && midi.musicxml ? (
            <ScoreView
              musicxml={midi.musicxml}
              annotatedReferenceNotes={alignment.annotatedReferenceNotes}
              onColoringFailure={() => setRenderMode("piano-roll")}
              onNoteScrub={onSeekVideo}
              videoRef={performanceVideoRef}
            />
          ) : (
            <PianoRollView
              referenceNotes={midi.referenceNotes}
              annotatedReferenceNotes={alignment.annotatedReferenceNotes}
              playedNotes={playedNotes}
              onNoteScrub={onSeekVideo}
            />
          )}

          {/* Legend */}
          <div className="row center-y" style={{ gap: 18, flexWrap: "wrap", padding: "0 4px" }}>
            <span className="eyebrow">Legend</span>
            {[
              { color: "#5e6b3a",        label: "Correct",          outlined: false },
              { color: STATUS_COLORS.wrongPitch, label: "Wrong pitch", outlined: false },
              { color: STATUS_COLORS.missed,     label: "Missed",      outlined: true  },
              { color: DYNAMIC_ALERT_COLOR,      label: "Dynamics",    outlined: false },
              { color: STATUS_COLORS.extra,      label: "Extra",       outlined: false },
            ].map((it) => (
              <div key={it.label} className="row center-y" style={{ gap: 6 }}>
                <span style={{
                  width: 16, height: 8,
                  background: it.outlined ? "transparent" : it.color,
                  border: it.outlined ? `1px dashed ${it.color}` : "none",
                  display: "inline-block",
                }} />
                <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>{it.label}</span>
              </div>
            ))}
          </div>

          {/* Tempo map */}
          {alignment.tempoMap && alignment.tempoMap.length >= 2 && (
            <TempoMapView tempoMap={alignment.tempoMap} onSeekVideo={onSeekVideo} />
          )}

          {/* Posture timeline */}
          {pose && (
            <PostureTimelineView
              totalDurationMs={analysisDurationMs}
              postureFlags={pose.postureFlags}
              sampleFps={pose.sampleFps}
              onFlagClick={onSeekVideo}
            />
          )}
        </div>

        {/* Right column: video + focus areas */}
        <div className="col gap-2" style={{ flex: 1.05, minWidth: 360 }}>
          {/* A/B playback */}
          {(video?.videoUrl || midi.referenceAudioUrl) && (
            <div className="sheet col" style={{ padding: 0, overflow: "hidden" }}>
              <div className="row between center-y" style={{ padding: "12px 16px", borderBottom: "1px solid var(--paper-edge)" }}>
                <span className="serif" style={{ fontSize: 18 }}>
                  A / B playback
                  <span className="serif-i" style={{ color: "var(--ink-mute)", fontSize: 13, marginLeft: 6 }}>
                    — yours alongside the model
                  </span>
                </span>
              </div>

              {video?.videoUrl && (
                <div className="col" style={{ padding: "10px 16px 0" }}>
                  <div className="row between center-y" style={{ marginBottom: 6 }}>
                    <span className="eyebrow">Your performance</span>
                    {pose && (
                      <label className="row center-y" style={{ gap: 6, fontSize: 12, color: "var(--ink-mute)", cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={showPoseOverlay}
                          onChange={(e) => setShowPoseOverlay(e.target.checked)}
                          style={{ accentColor: "var(--vermilion)" }}
                        />
                        Pose overlay
                      </label>
                    )}
                  </div>
                  <div style={{ position: "relative", width: "100%" }}>
                    <video
                      ref={performanceVideoRef}
                      controls
                      preload="metadata"
                      src={resolveApiUrl(video.videoUrl)}
                      style={{ width: "100%", borderRadius: 2, border: "1px solid var(--paper-edge)", display: "block" }}
                    />
                    {pose && showPoseOverlay && (
                      <PoseOverlay videoRef={performanceVideoRef} frames={pose.frames} />
                    )}
                  </div>
                </div>
              )}

              {midi.referenceAudioUrl && (
                <div className="col" style={{ padding: "10px 16px 14px", borderTop: video?.videoUrl ? "1px solid var(--paper-edge)" : "none", marginTop: video?.videoUrl ? 12 : 0 }}>
                  <span className="eyebrow" style={{ marginBottom: 8 }}>Correct version</span>
                  <audio
                    controls
                    preload="metadata"
                    src={resolveApiUrl(midi.referenceAudioUrl)}
                    style={{ width: "100%" }}
                  />
                  <span style={{ fontSize: 11, color: "var(--ink-mute)", marginTop: 4 }}>
                    {midi.referenceAudioRenderer === "fluidsynth_sf2"
                      ? "sampled piano (SoundFont)"
                      : "synth fallback"}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Focus + drills */}
          {focusAreas.length > 0 && (
            <div className="sheet col" style={{ padding: 24, gap: 18 }}>
              <div className="col" style={{ gap: 4 }}>
                <span className="eyebrow">Focus areas</span>
                <span className="serif-i" style={{ color: "var(--ink-mute)", fontSize: 13 }}>
                  three things to mend, in order
                </span>
              </div>
              <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 14 }}>
                {focusAreas.map((f, i) => (
                  <li key={f.bucket} className="row" style={{ gap: 12 }}>
                    <span className="serif-i" style={{ fontSize: 26, color: "var(--vermilion)", lineHeight: 1, minWidth: 22 }}>
                      {["i", "ii", "iii"][i]}
                    </span>
                    <div className="col" style={{ gap: 4 }}>
                      <span className="serif" style={{ fontSize: 17, fontWeight: 500 }}>{f.bucket}</span>
                      <span style={{ fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.45 }}>{f.summary}</span>
                    </div>
                  </li>
                ))}
              </ol>
              <div className="hr" />
              <div className="col" style={{ gap: 8 }}>
                <span className="eyebrow">Tonight&apos;s drills</span>
                <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
                  {focusAreas.map((f) => (
                    <li key={f.bucket} className="row" style={{ gap: 8, alignItems: "baseline" }}>
                      <input type="checkbox" style={{ accentColor: "var(--vermilion)" }} />
                      <span style={{ fontSize: 13, color: "var(--ink-soft)" }}>{f.drill}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Marginalia */}
      <MarginaliaSection alignment={alignment} playedNotes={playedNotes} />
    </div>
  );
}

// ===== ResultsHeader =====

function ResultsHeader({ midi, summary }: { midi: MidiResponse; summary: AlignResponse["summary"] }) {
  const grade = summary.correct / (summary.referenceCount || 1) >= 0.85 ? "A"
              : summary.correct / (summary.referenceCount || 1) >= 0.70 ? "B"
              : summary.correct / (summary.referenceCount || 1) >= 0.55 ? "C" : "D";

  const pieceTitle = midi.musicxml
    ? (midi.musicxml.match(/<movement-title>([^<]+)<\/movement-title>/)?.[1] ?? "Untitled")
    : "Performance";

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row between" style={{ alignItems: "flex-end" }}>
        <div className="col" style={{ gap: 4 }}>
          <span className="eyebrow">
            Practice review · {new Date().toLocaleDateString("en-US", { weekday: "long" })}
          </span>
          <h1 className="display" style={{ fontSize: 56 }}>
            {pieceTitle}
          </h1>
          <div className="row center-y gap-2" style={{ marginTop: 4 }}>
            <span className="chip">{midi.noteCount} notes</span>
            <span className="chip">{(midi.durationMs / 1000).toFixed(1)} sec</span>
            {midi.tempoBpm && <span className="chip">♩ = {midi.tempoBpm.toFixed(0)}</span>}
          </div>
        </div>
        <ScoreDial value={Math.round((summary.correct / Math.max(1, summary.referenceCount)) * 100)} grade={grade} />
      </div>
      <div className="hr" />
    </div>
  );
}

// ===== ScoreDial =====

function ScoreDial({ value, grade }: { value: number; grade: string }) {
  const r = 44;
  const c = 2 * Math.PI * r;
  const filled = (value / 100) * c;
  return (
    <div className="row center-y gap-2">
      <div style={{ position: "relative", width: 110, height: 110 }}>
        <svg width="110" height="110" viewBox="0 0 110 110" style={{ transform: "rotate(-90deg)" }}>
          <circle cx="55" cy="55" r={r} fill="none" stroke="var(--paper-edge)" strokeWidth="3" />
          <circle
            cx="55" cy="55" r={r}
            fill="none" stroke="var(--ink)" strokeWidth="3"
            strokeDasharray={`${filled} ${c - filled}`}
            strokeLinecap="butt"
          />
        </svg>
        <div className="col center-x center-y" style={{ position: "absolute", inset: 0, gap: 0 }}>
          <span className="serif" style={{ fontSize: 40, lineHeight: 1, fontWeight: 500 }}>{value}</span>
          <span className="eyebrow" style={{ fontSize: 9 }}>of 100</span>
        </div>
      </div>
      <div className="col" style={{ gap: 2 }}>
        <span className="eyebrow">Tutor&apos;s grade</span>
        <span className="serif" style={{ fontSize: 56, lineHeight: 0.95, color: "var(--vermilion)" }}>{grade}</span>
        <span className="serif-i" style={{ color: "var(--ink-mute)", fontSize: 13 }}>
          {grade === "A" ? "Excellent work." : grade === "B" ? "Promising — clean it up." : "Keep practicing."}
        </span>
      </div>
    </div>
  );
}

// ===== TutorVerdict =====

function TutorVerdict({
  tutor, alignment, busy, onGenerate, resolveUrl,
}: {
  tutor: TutorResponse | null;
  alignment: AlignResponse;
  busy: boolean;
  onGenerate: () => void;
  resolveUrl: (p: string) => string;
}) {
  const s = alignment.summary;
  return (
    <div className="sheet" style={{ padding: 0, overflow: "hidden" }}>
      <div className="row" style={{ alignItems: "stretch" }}>
        {/* Left: tutor speaks */}
        <div className="col" style={{ flex: 2, padding: "32px 36px", gap: 16, position: "relative" }}>
          <div className="row between center-y">
            <span className="eyebrow">A patient note from your tutor —</span>
            <button className="btn btn-sm" onClick={onGenerate} disabled={busy}>
              <span style={{ fontSize: 12 }}>▶</span>
              <span>{busy ? "Generating…" : tutor ? "Replay tutor" : "Play tutor feedback"}</span>
            </button>
          </div>

          {tutor ? (
            <>
              <p
                className="serif"
                style={{ fontSize: 26, lineHeight: 1.32, margin: 0, color: "var(--ink)", fontWeight: 400, letterSpacing: "-0.005em" }}
              >
                <span className="serif-i" style={{ color: "var(--vermilion)", fontSize: 36, lineHeight: 0, position: "relative", top: 6, marginRight: 4 }}>&ldquo;</span>
                {tutor.writtenNote ?? tutor.tutorScript}
                <span className="serif-i" style={{ color: "var(--vermilion)", fontSize: 36, lineHeight: 0, position: "relative", top: 6, marginLeft: 4 }}>&rdquo;</span>
              </p>
              <audio
                key={tutor.audioUrl}
                controls
                preload="auto"
                src={resolveUrl(tutor.audioUrl)}
                style={{ width: "100%", marginTop: 8 }}
              />
              {tutor.strengths?.length > 0 && (
                <div className="row gap-3" style={{ marginTop: 4 }}>
                  <div className="col" style={{ flex: 1, gap: 4 }}>
                    <span className="eyebrow" style={{ color: "var(--moss)" }}>Strengths</span>
                    <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
                      {tutor.strengths.map((st, i) => (
                        <li key={i} className="serif-i" style={{ fontSize: 14, color: "var(--ink-soft)" }}>+ {st}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="serif-i" style={{ fontSize: 18, color: "var(--ink-mute)" }}>
              Click &ldquo;Play tutor feedback&rdquo; to generate personalized audio coaching.
            </p>
          )}

          {/* Quill ornament */}
          <svg width="48" height="48" viewBox="0 0 48 48" style={{ position: "absolute", bottom: 14, right: 16, opacity: 0.15 }}>
            <path d="M6 42 L20 28 M22 26 L38 10 Q 42 6, 44 6 Q 44 10, 38 14 L24 28 Z" stroke="var(--ink)" strokeWidth="1" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M14 34 L18 30 M16 36 L20 32 M18 38 L22 34" stroke="var(--ink)" strokeWidth="0.6" />
          </svg>
        </div>

        {/* Right: alignment summary */}
        <div className="col" style={{ flex: 1, padding: "28px 28px", background: "var(--paper-deep)", borderLeft: "1px solid var(--paper-edge)", gap: 14 }}>
          <span className="eyebrow">Alignment</span>
          <AlignmentBars summary={s} />
          <div className="hr" style={{ marginTop: 4 }} />
          <span className="eyebrow">Timing (±{s.timingThresholdMs}ms)</span>
          <TimingBar summary={s} />
          {s.tempoDeviationPct !== null && (
            <div className="serif-i" style={{ fontSize: 13, color: "var(--ink-mute)" }}>
              You play{" "}
              <strong style={{ color: "var(--vermilion)", fontStyle: "normal" }}>
                {Math.abs(s.tempoDeviationPct).toFixed(1)}%
              </strong>{" "}
              {s.tempoDeviationPct > 0 ? "behind" : "ahead of"} tempo on average.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AlignmentBars({ summary }: { summary: AlignResponse["summary"] }) {
  const total = summary.correct + summary.wrongPitch + summary.missed + summary.extra;
  const items = [
    { label: "Correct",     value: summary.correct,    color: "var(--moss)" },
    { label: "Wrong pitch", value: summary.wrongPitch, color: "var(--vermilion)" },
    { label: "Missed",      value: summary.missed,     color: "#b8a98a" },
    { label: "Extra",       value: summary.extra,      color: "var(--slate)" },
  ];
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row" style={{ height: 14, borderRadius: 1, overflow: "hidden", border: "1px solid var(--paper-edge)" }}>
        {items.map((it) => (
          total > 0 && <div key={it.label} style={{ width: `${(it.value / total) * 100}%`, background: it.color }} title={`${it.label}: ${it.value}`} />
        ))}
      </div>
      <div className="col" style={{ gap: 2 }}>
        {items.map((it) => (
          <div key={it.label} className="row between" style={{ fontSize: 12 }}>
            <div className="row center-y" style={{ gap: 6 }}>
              <span style={{ width: 8, height: 8, background: it.color, display: "inline-block" }} />
              <span style={{ color: "var(--ink-soft)" }}>{it.label}</span>
            </div>
            <span className="mono" style={{ color: "var(--ink-mute)" }}>{it.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TimingBar({ summary }: { summary: AlignResponse["summary"] }) {
  const total = summary.onTime + summary.early + summary.late;
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row" style={{ height: 10, borderRadius: 1, overflow: "hidden", border: "1px solid var(--paper-edge)" }}>
        <div style={{ width: `${total > 0 ? (summary.early / total) * 100 : 0}%`, background: "var(--sepia)" }} />
        <div style={{ width: `${total > 0 ? (summary.onTime / total) * 100 : 0}%`, background: "var(--moss)" }} />
        <div style={{ width: `${total > 0 ? (summary.late / total) * 100 : 0}%`, background: "var(--vermilion)" }} />
      </div>
      <div className="row between mono" style={{ fontSize: 11, color: "var(--ink-mute)" }}>
        <span>{summary.early} early</span>
        <span>{summary.onTime} on time</span>
        <span style={{ color: summary.late > 0 ? "var(--vermilion)" : undefined }}>{summary.late} late</span>
      </div>
    </div>
  );
}

// ===== StatsStrip =====

function StatsStrip({
  alignment, dynamicsOutlierCount, pose,
}: {
  alignment: AlignResponse;
  dynamicsOutlierCount: number;
  pose: PoseResponse | null;
}) {
  const s = alignment.summary;
  const stats = [
    { label: "Notes correct",   value: s.correct,           sub: `of ${s.referenceCount} reference`,  emphasize: false },
    { label: "Wrong pitch",     value: s.wrongPitch,         sub: "notes misidentified",                emphasize: true,  color: "var(--vermilion)" },
    { label: "Missed",          value: s.missed,             sub: "from reference",                     emphasize: false },
    { label: "Tempo drift",     value: s.tempoDeviationPct !== null ? `${s.tempoDeviationPct.toFixed(1)}%` : "n/a", sub: "vs reference", emphasize: false },
    { label: "Dynamics alerts", value: dynamicsOutlierCount, sub: `|Δvel| > ${DYNAMIC_DELTA_ALERT_THRESHOLD}`, emphasize: false, color: "var(--sepia)" },
    { label: "Posture flags",   value: pose?.postureSummary.flagCount ?? "—", sub: "across video",     emphasize: false, color: "var(--plum)" },
  ];
  return (
    <div className="row" style={{ borderTop: "1px solid var(--paper-edge)", borderBottom: "1px solid var(--paper-edge)" }}>
      {stats.map((stat, i) => (
        <div key={i} className="col" style={{
          flex: 1,
          padding: "14px 18px",
          borderRight: i < stats.length - 1 ? "1px solid var(--paper-edge)" : "none",
          gap: 2,
          background: stat.emphasize ? "rgba(192,52,29,0.05)" : "transparent",
        }}>
          <span className="eyebrow" style={{ fontSize: 10 }}>{stat.label}</span>
          <span className="serif" style={{ fontSize: 28, color: (stat as { color?: string }).color ?? "var(--ink)", lineHeight: 1.05 }}>
            {String(stat.value)}
          </span>
          <span className="serif-i" style={{ fontSize: 12, color: "var(--ink-mute)" }}>{stat.sub}</span>
        </div>
      ))}
    </div>
  );
}

// ===== TempoMapView =====

function TempoMapView({
  tempoMap, onSeekVideo,
}: {
  tempoMap: TempoMapEntry[];
  onSeekVideo: (ms: number) => void;
}) {
  const svgW = 980, svgH = 80;
  const padX = 36, padY = 12;
  const drawW = svgW - padX * 2;
  const drawH = svgH - padY * 2;
  const maxDev = 30;

  const zeroY = padY + drawH / 2;
  const barW = Math.max(2, drawW / tempoMap.length - 1);

  return (
    <div className="sheet col" style={{ padding: "14px 18px 10px", gap: 6 }}>
      <div className="row between center-y">
        <span className="eyebrow">Tempo map</span>
        <span className="serif-i" style={{ fontSize: 12, color: "var(--ink-mute)" }}>
          bar-by-bar deviation from reference — click to jump
        </span>
      </div>
      <svg
        width="100%"
        viewBox={`0 0 ${svgW} ${svgH}`}
        role="img"
        aria-label="Tempo map"
        style={{ display: "block" }}
      >
        <rect x={0} y={0} width={svgW} height={svgH} fill="#faf5e8" />
        {/* threshold lines at ±10% */}
        {[-10, 10].map((pct) => {
          const y = zeroY - (pct / maxDev) * (drawH / 2);
          return (
            <line
              key={pct}
              x1={padX} y1={y} x2={padX + drawW} y2={y}
              stroke="var(--paper-edge)" strokeWidth={0.8} strokeDasharray="3 3"
            />
          );
        })}
        {/* zero line */}
        <line x1={padX} y1={zeroY} x2={padX + drawW} y2={zeroY} stroke="var(--rule)" strokeWidth={1} />
        {/* bars */}
        {tempoMap.map((entry, idx) => {
          const x = padX + (idx / tempoMap.length) * drawW;
          const dev = entry.deviationPct;
          if (dev === null) {
            return (
              <g key={idx} style={{ cursor: "pointer" }} onClick={() => onSeekVideo(entry.startMs)}>
                <rect
                  x={x} y={zeroY - 3} width={barW} height={6}
                  fill="var(--paper-edge)" opacity={0.7}
                />
                <title>{`Measure ${entry.measureNumber}: insufficient data`}</title>
              </g>
            );
          }
          const clampedDev = Math.max(-maxDev, Math.min(maxDev, dev));
          const barH = Math.abs(clampedDev / maxDev) * (drawH / 2);
          const barY = dev >= 0 ? zeroY - barH : zeroY;
          const neutral = Math.abs(dev) <= 5;
          const color = neutral ? "var(--rule)" : dev > 0 ? "#c8853a" : "#4a7ab5";
          const label = Math.abs(dev) <= 5 ? "on tempo" : dev > 0 ? "rushed" : "dragged";
          return (
            <g key={idx} style={{ cursor: "pointer" }} onClick={() => onSeekVideo(entry.startMs)}>
              <rect
                x={x} y={barY} width={barW} height={Math.max(2, barH)}
                fill={color} opacity={0.85}
                className="tempo-bar"
              />
              <title>{`Measure ${entry.measureNumber}: ${dev > 0 ? "+" : ""}${dev.toFixed(1)}% (${label})`}</title>
            </g>
          );
        })}
        {/* x-axis measure labels — every 4 measures */}
        {tempoMap.filter((e) => e.measureNumber % 4 === 1).map((entry, idx) => {
          const x = padX + ((entry.measureNumber - 1) / tempoMap.length) * drawW;
          return (
            <text
              key={idx}
              x={x} y={svgH - 1}
              fontSize={9} fill="var(--ink-faint)"
              fontFamily="var(--mono)"
              textAnchor="middle"
            >
              {entry.measureNumber}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

// ===== PostureTimelineView =====

function PostureTimelineView({
  totalDurationMs, postureFlags, sampleFps, onFlagClick,
}: {
  totalDurationMs: number;
  postureFlags: PostureFlag[];
  sampleFps: number;
  onFlagClick?: (startMs: number) => void;
}) {
  const lanes: PostureRule[] = ["slouched_back", "raised_shoulders", "collapsed_wrist", "flat_fingers"];
  return (
    <div className="sheet col" style={{ padding: 18, gap: 12 }}>
      <div className="row between center-y">
        <div className="col" style={{ gap: 2 }}>
          <span className="eyebrow">Posture timeline</span>
          <span className="serif-i" style={{ fontSize: 13, color: "var(--ink-mute)" }}>
            colored blocks are time-aligned posture flags from the video — click to jump
          </span>
        </div>
        <span className="mono" style={{ fontSize: 11, color: "var(--ink-mute)" }}>
          ~{sampleFps.toFixed(1)} fps
        </span>
      </div>
      <div className="col" style={{ gap: 7 }}>
        {lanes.map((lane) => {
          const laneFlags = postureFlags.filter((f) => f.type === lane);
          return (
            <div key={lane} className="row center-y" style={{ gap: 12 }}>
              <span style={{ width: 130, fontSize: 12, color: laneFlags.length === 0 ? "var(--ink-faint)" : "var(--ink-soft)", textTransform: "capitalize" }}>
                {prettyRuleName(lane)}
              </span>
              <div className="posture-track" style={{ flex: 1 }}>
                {laneFlags.map((flag, idx) => {
                  const leftPct  = (flag.startMs / totalDurationMs) * 100;
                  const widthPct = Math.max(0.8, ((flag.endMs - flag.startMs) / totalDurationMs) * 100);
                  return (
                    <div
                      key={`${lane}-${idx}`}
                      className="posture-flag"
                      style={{
                        left: `${leftPct}%`,
                        width: `${widthPct}%`,
                        background: POSTURE_RULE_COLORS[lane],
                        opacity: postureSeverityOpacity(flag.severity),
                        cursor: onFlagClick ? "pointer" : undefined,
                        transition: "opacity .12s ease",
                      }}
                      title={`${prettyRuleName(flag.type)} · ${flag.severity} · ${(flag.startMs / 1000).toFixed(1)}s – ${(flag.endMs / 1000).toFixed(1)}s. Click to jump to this moment.`}
                      onClick={onFlagClick ? () => onFlagClick(flag.startMs) : undefined}
                      onMouseEnter={onFlagClick ? (e) => { (e.currentTarget as HTMLDivElement).style.opacity = "1"; } : undefined}
                      onMouseLeave={onFlagClick ? (e) => { (e.currentTarget as HTMLDivElement).style.opacity = String(postureSeverityOpacity(flag.severity)); } : undefined}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {postureFlags.length === 0 && (
        <p className="serif-i" style={{ fontSize: 13, color: "var(--ink-mute)" }}>No posture flags detected for this take.</p>
      )}
    </div>
  );
}

// ===== MarginaliaSection =====

type MarginaliaEntry = { timeMs: number; text: string };

function buildMarginalia(alignment: AlignResponse, playedNotes: PlayedNote[] | null): MarginaliaEntry[] {
  const entries: MarginaliaEntry[] = [];
  for (const note of alignment.annotatedReferenceNotes) {
    const timeSec = (note.onset_ms / 1000).toFixed(1);
    if (note.status === "wrongPitch") {
      const expectedName = midiToNoteName(note.pitch);
      const playedNote = playedNotes && note.playedIdx !== null ? playedNotes[note.playedIdx] : null;
      const playedName = playedNote ? midiToNoteName(playedNote.pitch) : "?";
      entries.push({ timeMs: note.onset_ms, text: `${timeSec}s  wrong pitch  played ${playedName}  expected ${expectedName}` });
    } else if (note.status === "missed") {
      entries.push({ timeMs: note.onset_ms, text: `${timeSec}s  missed  ${midiToNoteName(note.pitch)}` });
    } else if (note.status === "extra") {
      const playedNote = playedNotes && note.playedIdx !== null ? playedNotes[note.playedIdx] : null;
      const noteName = playedNote ? `  ${midiToNoteName(playedNote.pitch)}` : "";
      entries.push({ timeMs: note.onset_ms, text: `${timeSec}s  extra note${noteName}` });
    }
    if (hasDynamicOutlier(note)) {
      const delta = note.dynamicDelta!;
      const label = note.dynamicLabel ?? (delta > 0 ? "too forceful" : "too soft");
      entries.push({ timeMs: note.onset_ms, text: `${timeSec}s  dynamics  ${label} (Δ ${delta > 0 ? "+" : ""}${delta})` });
    }
  }
  return entries.sort((a, b) => a.timeMs - b.timeMs);
}

function MarginaliaSection({
  alignment, playedNotes,
}: {
  alignment: AlignResponse;
  playedNotes: PlayedNote[] | null;
}) {
  const entries = useMemo(() => buildMarginalia(alignment, playedNotes), [alignment, playedNotes]);

  return (
    <div className="sheet col" style={{ padding: 24, gap: 16 }}>
      <div className="col" style={{ gap: 4 }}>
        <span className="eyebrow">Marginalia</span>
        <h2 className="section">Every flagged note, in order</h2>
      </div>
      <div className="hr" />
      {entries.length === 0 ? (
        <p className="serif-i" style={{ color: "var(--ink-mute)", fontSize: 14 }}>No errors detected.</p>
      ) : (
        <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 0 }}>
          {entries.map((entry, idx) => (
            <li
              key={idx}
              className="mono"
              style={{
                fontSize: 13,
                color: "var(--ink-soft)",
                padding: "10px 6px",
                borderBottom: idx < entries.length - 1 ? "1px solid var(--paper-edge)" : "none",
              }}
            >
              {entry.text}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ===== ScoreView (OSMD) =====

type OsmdLike = {
  Sheet?: { SourceMeasures?: Array<{ VerticalSourceStaffEntryContainers?: Array<{ StaffEntries?: Array<{ VoiceEntries?: Array<{ Notes?: unknown[] } | null> } | null> }> }> };
  EngravingRules?: { GNote?: (sourceNote: unknown) => { setColor?: (color: string, opts: object) => void; getSVGGElement?: () => SVGGElement } | null };
};

function collectSourceNotes(osmd: OsmdLike): unknown[] {
  const sourceNotes: unknown[] = [];
  for (const measure of osmd.Sheet?.SourceMeasures ?? []) {
    for (const vc of measure.VerticalSourceStaffEntryContainers ?? []) {
      for (const se of vc.StaffEntries ?? []) {
        if (!se) continue;
        for (const ve of se.VoiceEntries ?? []) {
          if (!ve) continue;
          for (const note of ve.Notes ?? []) sourceNotes.push(note);
        }
      }
    }
  }
  return sourceNotes;
}

function applyAlignmentColors(osmd: OsmdLike, annotatedReferenceNotes: AnnotatedReferenceNote[], phase: "pre-render" | "post-render") {
  const sourceNotes = collectSourceNotes(osmd);
  const byRefIdx = new Map(annotatedReferenceNotes.map((n) => [n.refIdx, n]));
  let refIdx = 0;
  for (const sn of sourceNotes) {
    if (typeof sn === "object" && sn && "isRest" in sn) {
      const rn = sn as { isRest?: () => boolean };
      if (typeof rn.isRest === "function" && rn.isRest()) continue;
    }
    const annotated = byRefIdx.get(refIdx);
    const status = annotated?.status;
    const dynamicOutlier = annotated ? hasDynamicOutlier(annotated) : false;
    const color = dynamicOutlier ? DYNAMIC_ALERT_COLOR
      : status && status !== "correct" ? STATUS_COLORS[status as keyof typeof STATUS_COLORS] : null;
    if (color) {
      const note = sn as { NoteheadColor?: string; ParentVoiceEntry?: { StemColor?: string } };
      if (phase === "pre-render") {
        note.NoteheadColor = color;
        if (note.ParentVoiceEntry) note.ParentVoiceEntry.StemColor = color;
      } else {
        const gn = osmd.EngravingRules?.GNote?.(sn);
        gn?.setColor?.(color, { applyToNoteheads: true, applyToStem: true, applyToBeams: true, applyToFlag: true, applyToLedgerLines: true, applyToModifiers: true, applyToTies: false, applyToSlurs: false });
      }
    }
    refIdx += 1;
  }
}

type NoteTimeEntry = { onset_ms: number; element: SVGGElement };

function bindScoreScrubClicks(
  osmd: OsmdLike,
  annotatedReferenceNotes: AnnotatedReferenceNote[],
  onNoteScrub: (ms: number) => void,
): NoteTimeEntry[] {
  const sourceNotes = collectSourceNotes(osmd);
  const byRefIdx = new Map(annotatedReferenceNotes.map((n) => [n.refIdx, n]));
  let refIdx = 0;
  const entries: NoteTimeEntry[] = [];
  for (const sn of sourceNotes) {
    if (typeof sn === "object" && sn && "isRest" in sn) {
      const rn = sn as { isRest?: () => boolean };
      if (typeof rn.isRest === "function" && rn.isRest()) continue;
    }
    const annotated = byRefIdx.get(refIdx);
    if (!annotated) { refIdx++; continue; }
    const dynamicHint = dynamicTooltip(annotated);
    const gn = osmd.EngravingRules?.GNote?.(sn);
    const group = gn?.getSVGGElement?.();
    if (group) {
      group.style.cursor = "pointer";
      group.setAttribute("tabindex", "0");
      group.setAttribute("role", "button");
      const baseText = `${(annotated.onset_ms / 1000).toFixed(2)}s`;
      const statusHint = annotated.status !== "correct" ? ` · ${annotated.status}` : "";
      group.setAttribute("title", dynamicHint ? `${baseText} · ${dynamicHint}` : `${baseText}${statusHint}`);
      group.onclick = () => onNoteScrub(annotated.onset_ms);
      group.onkeydown = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onNoteScrub(annotated.onset_ms); } };
      entries.push({ onset_ms: annotated.onset_ms, element: group });
    }
    refIdx++;
  }
  return entries.sort((a, b) => a.onset_ms - b.onset_ms);
}

function ScoreView({
  musicxml, annotatedReferenceNotes, onColoringFailure, onNoteScrub, videoRef,
}: {
  musicxml: string;
  annotatedReferenceNotes: AnnotatedReferenceNote[];
  onColoringFailure: () => void;
  onNoteScrub: (ms: number) => void;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const noteTimeMapRef = useRef<NoteTimeEntry[]>([]);
  const cursorLineRef = useRef<SVGLineElement | null>(null);
  const cursorSvgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    let cancelled = false;
    noteTimeMapRef.current = [];
    (async () => {
      const mod = await import("opensheetmusicdisplay");
      if (cancelled) return;
      container.innerHTML = "";
      const inst = new mod.OpenSheetMusicDisplay(container, { autoResize: true, backend: "svg", drawTitle: true });
      try {
        await inst.load(musicxml);
        if (cancelled) return;
        if (annotatedReferenceNotes?.length) applyAlignmentColors(inst as unknown as OsmdLike, annotatedReferenceNotes, "pre-render");
        inst.render();
        if (annotatedReferenceNotes?.length) {
          applyAlignmentColors(inst as unknown as OsmdLike, annotatedReferenceNotes, "post-render");
          noteTimeMapRef.current = bindScoreScrubClicks(inst as unknown as OsmdLike, annotatedReferenceNotes, onNoteScrub);
        }
      } catch (e) {
        container.innerHTML = `<p style="color:var(--vermilion)">Failed to render score: ${(e as Error).message}</p>`;
        onColoringFailure();
      }
    })();
    return () => {
      cancelled = true;
      noteTimeMapRef.current = [];
      cursorLineRef.current = null;
      cursorSvgRef.current = null;
      container.innerHTML = "";
    };
  }, [musicxml, annotatedReferenceNotes, onColoringFailure, onNoteScrub]);

  // Cursor tracking — listens to video timeupdate and moves a line in the OSMD SVG
  useEffect(() => {
    const video = videoRef?.current;
    if (!video) return;

    let rafId: number | null = null;

    function moveCursor() {
      const map = noteTimeMapRef.current;
      if (!map.length) return;
      const currentMs = video!.currentTime * 1000;

      // Binary-search for last note whose onset <= currentMs
      let lo = 0, hi = map.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (map[mid].onset_ms <= currentMs) lo = mid; else hi = mid - 1;
      }
      const noteEl = map[lo].element;
      const ownerSvg = noteEl.ownerSVGElement;
      if (!ownerSvg) return;

      // Move cursor element to the correct SVG if the system changed
      if (cursorSvgRef.current !== ownerSvg) {
        if (cursorLineRef.current && cursorSvgRef.current) {
          try { cursorSvgRef.current.removeChild(cursorLineRef.current); } catch { /* already removed */ }
        }
        if (!cursorLineRef.current) {
          const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
          line.setAttribute("stroke", "rgba(192,52,29,0.65)");
          line.setAttribute("stroke-width", "1.5");
          line.style.pointerEvents = "none";
          cursorLineRef.current = line;
        }
        ownerSvg.appendChild(cursorLineRef.current);
        cursorSvgRef.current = ownerSvg;
      }

      const bbox = noteEl.getBBox();
      const noteX = String(bbox.x + bbox.width / 2);
      const svgH = String(ownerSvg.viewBox?.baseVal?.height || ownerSvg.clientHeight || 9999);
      cursorLineRef.current!.setAttribute("x1", noteX);
      cursorLineRef.current!.setAttribute("x2", noteX);
      cursorLineRef.current!.setAttribute("y1", "0");
      cursorLineRef.current!.setAttribute("y2", svgH);
    }

    function onTimeUpdate() {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(moveCursor);
    }

    video.addEventListener("timeupdate", onTimeUpdate);
    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (cursorLineRef.current && cursorSvgRef.current) {
        try { cursorSvgRef.current.removeChild(cursorLineRef.current); } catch { /* already removed */ }
        cursorLineRef.current = null;
        cursorSvgRef.current = null;
      }
    };
  }, [videoRef]);

  return (
    <div
      ref={containerRef}
      style={{
        overflowX: "auto",
        background: "#fefaf0",
        border: "1px solid var(--paper-edge)",
        padding: "28px 32px",
        borderRadius: 2,
      }}
    />
  );
}

// ===== PianoRollView =====

function PianoRollView({
  referenceNotes, annotatedReferenceNotes, playedNotes, onNoteScrub,
}: {
  referenceNotes: ReferenceNote[];
  annotatedReferenceNotes: AnnotatedReferenceNote[];
  playedNotes: PlayedNote[] | null;
  onNoteScrub: (ms: number) => void;
}) {
  const width = 980, height = 360, padX = 22, padY = 18;
  const annotatedByRefIdx = useMemo(
    () => new Map((annotatedReferenceNotes ?? []).map((n) => [n.refIdx, n])),
    [annotatedReferenceNotes],
  );
  const maxTime = useMemo(() => {
    const refMax = referenceNotes.reduce((acc, n) => Math.max(acc, n.onset + n.duration), 0);
    const playedMax = (playedNotes ?? []).reduce((acc, n) => Math.max(acc, n.onset_ms + n.duration_ms), 0);
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
  const drawW = width - padX * 2, drawH = height - padY * 2;

  return (
    <div className="roll-stage" style={{ width: "100%", overflow: "hidden" }}>
      <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Piano roll">
        <rect x="0" y="0" width={width} height={height} fill="#faf5e8" />
        {referenceNotes.map((note, idx) => {
          const x = padX + (note.onset / maxTime) * drawW;
          const w = Math.max(1.5, (note.duration / maxTime) * drawW);
          const y = padY + ((maxPitch - note.pitch) / pitchSpan) * drawH;
          const annotated = annotatedByRefIdx.get(idx);
          const status = annotated?.status ?? "correct";
          const dHint = annotated ? dynamicTooltip(annotated) : null;
          const color = dHint ? DYNAMIC_ALERT_COLOR : status === "correct" ? "var(--rule)" : STATUS_COLORS[status as keyof typeof STATUS_COLORS];
          const opacity = dHint ? 0.92 : status === "correct" ? 0.45 : 0.8;
          const clickable = Boolean(annotated) && (status !== "correct" || dHint !== null);
          const onsetMs = annotated?.onset_ms ?? note.onset;
          return (
            <rect
              key={`ref-${idx}`}
              x={x} y={y} width={w} height={4}
              fill={color} opacity={opacity}
              onClick={clickable ? () => onNoteScrub(onsetMs) : undefined}
              className={clickable ? "scrub-note" : undefined}
              style={clickable ? { cursor: "pointer" } : undefined}
            >
              <title>{dHint ?? `${(onsetMs / 1000).toFixed(2)}s · ${status}`}</title>
            </rect>
          );
        })}
        {(playedNotes ?? []).map((note, idx) => {
          const x = padX + (note.onset_ms / maxTime) * drawW;
          const w = Math.max(1.5, (note.duration_ms / maxTime) * drawW);
          const y = padY + ((maxPitch - note.pitch) / pitchSpan) * drawH;
          return <rect key={`played-${idx}`} x={x} y={y + 5} width={w} height={3} fill="var(--ink)" opacity={0.55} />;
        })}
      </svg>
    </div>
  );
}

// ===== PoseOverlay =====

function PoseOverlay({
  videoRef, frames,
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
      const w = video.clientWidth, h = video.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr; canvas.height = h * dpr;
        const ctx = canvas.getContext("2d");
        if (ctx) ctx.scale(dpr, dpr);
      }
    }

    function findNearestFrame(currentMs: number): PoseFrame {
      let best = frames[0], bestDiff = Math.abs(frames[0].timestampMs - currentMs);
      for (let i = 1; i < frames.length; i++) {
        const diff = Math.abs(frames[i].timestampMs - currentMs);
        if (diff < bestDiff) { bestDiff = diff; best = frames[i]; }
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
      const W = canvas.width / dpr, H = canvas.height / dpr;
      ctx.clearRect(0, 0, W, H);
      const frame = findNearestFrame(video.currentTime * 1000);

      ctx.lineWidth = 2; ctx.lineCap = "round";
      const pose = frame.pose;
      if (pose) {
        const connections: Array<[LandmarkXY, LandmarkXY]> = [
          [pose.leftEar, pose.leftShoulder], [pose.rightEar, pose.rightShoulder],
          [pose.leftShoulder, pose.rightShoulder], [pose.leftShoulder, pose.leftHip],
          [pose.rightShoulder, pose.rightHip], [pose.leftHip, pose.rightHip],
        ];
        ctx.strokeStyle = "rgba(255,255,255,0.6)"; ctx.lineWidth = 2;
        for (const [a, b] of connections) {
          const [ax, ay] = pt(a, W, H), [bx, by] = pt(b, W, H);
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        }
        for (const [lm, color] of [
          [pose.leftEar, "#a78bfa"], [pose.rightEar, "#a78bfa"],
          [pose.leftShoulder, "#60a5fa"], [pose.rightShoulder, "#60a5fa"],
          [pose.leftHip, "#34d399"], [pose.rightHip, "#34d399"],
        ] as [LandmarkXY, string][]) {
          const [x, y] = pt(lm, W, H);
          ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2);
          ctx.fillStyle = color; ctx.fill();
          ctx.strokeStyle = "white"; ctx.lineWidth = 1.5; ctx.stroke();
        }
      }

      for (const hand of frame.hands ?? []) {
        const handColor = hand.label === "left" ? "#fb923c" : "#f472b6";
        const chains: Array<LandmarkXY[]> = [
          [hand.wrist, hand.indexMcp, hand.indexPip],
          [hand.wrist, hand.middleMcp, hand.middlePip],
        ];
        ctx.strokeStyle = handColor; ctx.lineWidth = 1.5;
        for (const chain of chains) {
          ctx.beginPath();
          const [sx, sy] = pt(chain[0], W, H); ctx.moveTo(sx, sy);
          for (let i = 1; i < chain.length; i++) { const [cx, cy] = pt(chain[i], W, H); ctx.lineTo(cx, cy); }
          ctx.stroke();
        }
        for (const lm of [hand.wrist, hand.indexMcp, hand.indexPip, hand.middleMcp, hand.middlePip]) {
          const [x, y] = pt(lm, W, H);
          ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = handColor; ctx.fill();
          ctx.strokeStyle = "white"; ctx.lineWidth = 1; ctx.stroke();
        }
      }
    }

    const ro = new ResizeObserver(() => { syncCanvasSize(); drawFrame(); });
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
      style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none" }}
    />
  );
}
