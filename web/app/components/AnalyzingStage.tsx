"use client";

import { useEffect, useMemo, useState } from "react";
import type { MidiResponse, VideoResponse } from "./types";

const LOG_LINES = [
  "Transcribing audio from performance video…",
  "Extracting pitch events with CREPE…",
  "Aligning performance to reference MIDI…",
  "Analyzing posture from video frames with MediaPipe…",
  "Generating AI tutor voice feedback…",
  "Compiling results…",
];

type AnalyzingStageProps = {
  midi: MidiResponse | null;
  video: VideoResponse | null;
};

export function AnalyzingStage({ midi, video }: AnalyzingStageProps) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (step >= LOG_LINES.length) return;
    const delay = LOG_LINES[step].length * 22 + 900;
    const timeout = setTimeout(() => {
      if (step < LOG_LINES.length - 1) {
        setStep((s) => s + 1);
      }
    }, delay);
    return () => clearTimeout(timeout);
  }, [step]);

  const pct = Math.min(100, ((step + 0.5) / LOG_LINES.length) * 100);

  return (
    <div className="col gap-3 fade-in">
      <div className="col" style={{ gap: 6 }}>
        <span className="eyebrow">
          <span className="pulse-dot" style={{ marginRight: 8, verticalAlign: 1 }} />
          Listening
        </span>
        <h1 className="display" style={{ maxWidth: 760 }}>
          One moment —{" "}
          <span className="serif-i" style={{ color: "var(--vermilion)" }}>the tutor is listening.</span>
        </h1>
      </div>

      <div className="sheet sheet-padded col gap-3">
        <Waveform />

        <div style={{ position: "relative", height: 2, background: "var(--paper-edge)" }}>
          <div
            style={{
              position: "absolute", left: 0, top: 0, bottom: 0,
              width: `${pct}%`,
              background: "var(--ink)",
              transition: "width .4s ease",
            }}
          />
          <div className="shimmer" style={{ position: "absolute", inset: 0 }} />
        </div>

        <div className="row between center-y">
          <div className="mono" style={{ fontSize: 12, color: "var(--ink-mute)" }}>
            stage {Math.min(step + 1, LOG_LINES.length).toString().padStart(2, "0")} /{" "}
            {LOG_LINES.length.toString().padStart(2, "0")}
          </div>
          <div className="mono" style={{ fontSize: 12, color: "var(--ink-mute)" }}>
            {Math.round(pct)}%
          </div>
        </div>

        <div className="col" style={{ gap: 6, marginTop: 4 }}>
          {LOG_LINES.map((line, i) => {
            const done   = i < step;
            const active = i === step;
            return (
              <div
                key={i}
                className="row center-y mono"
                style={{
                  fontSize: 13,
                  color: done ? "var(--ink-mute)" : active ? "var(--ink)" : "var(--ink-faint)",
                  opacity: i > step ? 0.4 : 1,
                gap: 10,
                }}
              >
                <span
                  style={{
                    width: 18,
                    color: done ? "var(--moss)" : active ? "var(--vermilion)" : "var(--ink-faint)",
                  }}
                >
                  {done ? "✓" : active ? "→" : "·"}
                </span>
                <span className={active ? "cursor" : ""}>
                  {active ? <TypingLine text={line} /> : line}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="row gap-2" style={{ marginTop: 4 }}>
        <FactCard
          label="Reference"
          value={midi ? `${midi.noteCount} notes` : "—"}
          sub={midi ? `${(midi.durationMs / 1000).toFixed(1)}s${midi.tempoBpm ? ` · ~${midi.tempoBpm.toFixed(0)} BPM` : ""}` : ""}
        />
        <FactCard
          label="Performance"
          value={video ? `session ${video.sessionId.slice(0, 8)}` : "—"}
          sub="Audio extracted"
        />
        <FactCard
          label="Method"
          value="Audio + pose"
          sub="CREPE pitch · DTW align · MediaPipe pose"
        />
      </div>
    </div>
  );
}

function Waveform() {
  const [seed, setSeed] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setSeed((s) => s + 1), 150);
    return () => clearInterval(t);
  }, []);

  const bars = 96;
  const heights = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < bars; i++) {
      const x = (i / bars) * Math.PI * 4 + seed * 0.14;
      const h =
        Math.abs(Math.sin(x)) * 0.6 +
        Math.abs(Math.sin(x * 2.3 + 1.1)) * 0.35 +
        0.05;
      out.push(h);
    }
    return out;
  }, [bars, seed]);

  return (
    <div className="row" style={{ height: 64, alignItems: "center", gap: 2 }}>
      {heights.map((h, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            height: `${h * 100}%`,
            background: i / bars < 0.5 ? "var(--ink)" : "var(--ink-soft)",
            opacity: 0.4 + h * 0.6,
            transition: "height .12s linear",
          }}
        />
      ))}
    </div>
  );
}

function TypingLine({ text }: { text: string }) {
  const [typed, setTyped] = useState("");

  useEffect(() => {
    let i = 0;
    const tick = setInterval(() => {
      i++;
      setTyped(text.slice(0, i));
      if (i >= text.length) {
        clearInterval(tick);
      }
    }, 22);
    return () => clearInterval(tick);
  }, [text]);

  return <>{typed}</>;
}

function FactCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="sheet col" style={{ flex: 1, padding: 16, gap: 4 }}>
      <span className="eyebrow">{label}</span>
      <span className="mono" style={{ fontSize: 13, color: "var(--ink)" }}>{value}</span>
      <span style={{ fontSize: 12, color: "var(--ink-mute)" }}>{sub}</span>
    </div>
  );
}
