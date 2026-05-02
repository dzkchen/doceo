"use client";

import type { Stage } from "./Masthead";

type ProgressRailProps = {
  stage: Stage;
  hasFiles: boolean;
};

export function ProgressRail({ stage, hasFiles }: ProgressRailProps) {
  const steps: Array<{ id: Stage; label: string }> = [
    { id: "upload",    label: "Upload"  },
    { id: "analyzing", label: "Analyze" },
    { id: "results",   label: "Review"  },
  ];
  const stageIdx = stage === "upload" ? 0 : stage === "analyzing" ? 1 : 2;

  const statusText =
    stage === "upload"
      ? hasFiles ? "ready when you are" : "select two files to begin"
      : stage === "analyzing"
      ? "the tutor is listening…"
      : "your review is ready";

  return (
    <div className="row center-y" style={{ gap: 14, marginBottom: 24 }}>
      {steps.map((s, i) => {
        const done   = i < stageIdx;
        const active = i === stageIdx;
        return (
          <div key={s.id} className="row center-y" style={{ gap: 0 }}>
            <div className="row center-y" style={{ gap: 8 }}>
              <span
                style={{
                  width: 22, height: 22,
                  borderRadius: 999,
                  border: `1px solid ${active || done ? "var(--ink)" : "var(--rule)"}`,
                  background: done ? "var(--ink)" : active ? "var(--paper)" : "transparent",
                  color: done ? "var(--paper)" : active ? "var(--ink)" : "var(--ink-faint)",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                  fontFamily: "var(--mono)",
                }}
              >
                {done ? "✓" : i + 1}
              </span>
              <span
                className="serif"
                style={{
                  fontSize: 16,
                  color: active ? "var(--ink)" : done ? "var(--ink-soft)" : "var(--ink-faint)",
                  fontStyle: active ? "italic" : "normal",
                }}
              >
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                style={{
                  width: 60,
                  height: 1,
                  background: i < stageIdx ? "var(--ink)" : "var(--rule)",
                  opacity: i < stageIdx ? 0.6 : 0.4,
                  marginLeft: 14,
                }}
              />
            )}
          </div>
        );
      })}
      <div style={{ flex: 1 }} />
      <span className="serif-i" style={{ color: "var(--ink-faint)", fontSize: 13 }}>
        {statusText}
      </span>
    </div>
  );
}
