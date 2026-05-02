"use client";

import { useRef } from "react";
import type { MidiResponse, VideoResponse } from "./types";

type UploadStageProps = {
  midi: MidiResponse | null;
  video: VideoResponse | null;
  busy: "midi" | "video" | null;
  error: string | null;
  onMidiFile: (f: File) => void;
  onVideoFile: (f: File) => void;
  onAnalyze: () => void;
};

export function UploadStage({
  midi, video, busy, error, onMidiFile, onVideoFile, onAnalyze,
}: UploadStageProps) {
  const ready = midi !== null && video !== null;

  return (
    <div className="col gap-3 fade-in">
      {error && (
        <div
          style={{
            padding: "12px 16px",
            background: "rgba(192,52,29,0.08)",
            border: "1px solid rgba(192,52,29,0.3)",
            borderRadius: 2,
            fontSize: 13,
            color: "var(--vermilion)",
            fontFamily: "var(--mono)",
          }}
        >
          {error}
        </div>
      )}

      <div className="col" style={{ gap: 6 }}>
        <span className="eyebrow">Begin a new session</span>
        <h1 className="display" style={{ maxWidth: 760 }}>
          Bring your <span className="serif-i">score</span>, then play it.{" "}
          <span style={{ color: "var(--ink-mute)" }}>
            We&apos;ll listen, watch, and tell you what to practice next.
          </span>
        </h1>
        <p style={{ maxWidth: 640, color: "var(--ink-soft)", fontSize: 16, lineHeight: 1.55, marginTop: 6 }}>
          Privotr cross-references a reference MIDI with a side-view recording of you at the keyboard —
          every wrong pitch, missed beat, and slipping shoulder lands in one tidy review.
        </p>
      </div>

      <div className="row gap-3" style={{ marginTop: 18 }}>
        <UploadSheet
          step={1}
          label="Reference MIDI"
          subtitle="The piece you intend to play. Exported from any notation app."
          accept=".mid,.midi"
          loading={busy === "midi"}
          metaChips={midi ? [
            `${midi.noteCount} notes`,
            `${(midi.durationMs / 1000).toFixed(1)}s`,
            ...(midi.tempoBpm ? [`~${midi.tempoBpm.toFixed(0)} BPM`] : []),
          ] : null}
          onFile={onMidiFile}
        />
        <UploadSheet
          step={2}
          label="Performance video"
          subtitle="A side-view clip of you playing. We extract the audio and watch your posture."
          accept=".mov,.mp4,.webm"
          loading={busy === "video"}
          disabled={midi === null}
          metaChips={video ? [
            "Audio extracted",
            `session ${video.sessionId.slice(0, 8)}`,
          ] : null}
          hint={midi === null ? "Upload MIDI first." : undefined}
          onFile={onVideoFile}
        />
      </div>

      <div className="row between center-y" style={{ marginTop: 14 }}>
        <div className="row center-y gap-2">
          <button
            className="btn btn-primary"
            disabled={!ready || busy !== null}
            onClick={onAnalyze}
          >
            <span>Begin analysis</span>
            <span style={{ fontSize: 16, lineHeight: 1 }}>→</span>
          </button>
          {!ready && (
            <span className="serif-i" style={{ color: "var(--ink-faint)", fontSize: 14 }}>
              waiting for both files…
            </span>
          )}
        </div>
        <div className="row center-y" style={{ gap: 18 }}>
          <Hint icon="♪" text="MIDI ≤ 5 min" />
          <Hint icon="▶" text="Video ≤ 200 MB" />
          <Hint icon="◐" text="Side view, hands visible" />
        </div>
      </div>
    </div>
  );
}

type UploadSheetProps = {
  step: number;
  label: string;
  subtitle: string;
  accept: string;
  loading?: boolean;
  disabled?: boolean;
  metaChips: string[] | null;
  hint?: string;
  onFile: (f: File) => void;
};

function UploadSheet({
  step, label, subtitle, accept, loading, disabled, metaChips, hint, onFile,
}: UploadSheetProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hasMeta = metaChips !== null;

  return (
    <div
      className="sheet col"
      style={{
        flex: 1,
        padding: 26,
        gap: 14,
        cursor: hasMeta || disabled ? "default" : "pointer",
        position: "relative",
        overflow: "hidden",
        opacity: disabled && !hasMeta ? 0.55 : 1,
      }}
      onClick={hasMeta || disabled ? undefined : () => inputRef.current?.click()}
    >
      {/* Accept hint in corner */}
      <div
        style={{
          position: "absolute",
          top: 12, right: 14,
          fontFamily: "var(--mono)",
          fontSize: 10,
          color: "var(--ink-faint)",
          letterSpacing: "0.1em",
        }}
      >
        {accept}
      </div>

      <div className="row center-y gap-2">
        <span className="step-num">{step}.</span>
        <span className="serif" style={{ fontSize: 22, lineHeight: 1.1 }}>{label}</span>
      </div>

      <p style={{ margin: 0, color: "var(--ink-mute)", fontSize: 13, maxWidth: 360 }}>
        {subtitle}
      </p>

      {loading ? (
        <div className="col center-x center-y" style={{ minHeight: 80, gap: 8 }}>
          <span className="pulse-dot" />
          <span className="serif-i" style={{ color: "var(--ink-mute)", fontSize: 14 }}>Uploading…</span>
        </div>
      ) : hasMeta ? (
        <div className="row gap-1" style={{ flexWrap: "wrap" }}>
          {metaChips!.map((m) => (
            <span className="chip chip-moss" key={m}>{m}</span>
          ))}
        </div>
      ) : (
        <div className="dropzone col center-x center-y" style={{ minHeight: 110, gap: 6 }}>
          <div className="serif-i" style={{ color: "var(--ink-soft)", fontSize: 18 }}>
            {hint ?? "drop a file or click to choose"}
          </div>
          <div className="mono" style={{ fontSize: 11, color: "var(--ink-faint)" }}>{accept}</div>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        disabled={disabled || loading}
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) { onFile(f); e.target.value = ""; }
        }}
      />
    </div>
  );
}

function Hint({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="row center-y" style={{ gap: 6 }}>
      <span style={{ color: "var(--vermilion)", fontFamily: "var(--serif)", fontStyle: "italic" }}>{icon}</span>
      <span className="mono" style={{ fontSize: 11, color: "var(--ink-mute)", letterSpacing: "0.04em" }}>{text}</span>
    </div>
  );
}
