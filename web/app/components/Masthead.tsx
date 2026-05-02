"use client";

export type Stage = "upload" | "analyzing" | "results";

type MastheadProps = {
  sessionId: string | null;
  stage: Stage;
  onReset: () => void;
};

function PrivotrMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <ellipse cx="11" cy="22" rx="6" ry="4.5" transform="rotate(-22 11 22)" fill="currentColor" />
      <path d="M16 21.5 L18 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path
        d="M18 7 C 22 8, 25 11, 24 16 C 27 13, 27 8, 22 5"
        stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none"
      />
      <circle cx="25.5" cy="6.5" r="1.5" fill="var(--vermilion)" />
    </svg>
  );
}

function Wordmark() {
  return (
    <div className="row center-y" style={{ gap: 10 }}>
      <span style={{ color: "var(--ink)" }}>
        <PrivotrMark size={26} />
      </span>
      <span
        className="serif"
        style={{ fontSize: 24, letterSpacing: "0.005em", fontWeight: 500, color: "var(--ink)" }}
      >
        privotr<span style={{ color: "var(--vermilion)" }}>.</span>
      </span>
    </div>
  );
}

export function Masthead({ sessionId, stage, onReset }: MastheadProps) {
  const today = new Date().toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric",
  });

  return (
    <header className="col" style={{ gap: 14, marginBottom: 32 }}>
      <div className="row between center-y">
        <Wordmark />
        <div className="row center-y gap-2">
          <span className="eyebrow" style={{ color: "var(--ink-mute)" }}>{today}</span>
          {sessionId && (
            <>
              <span style={{ color: "var(--ink-faint)" }}>·</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--ink-mute)" }}>
                session {sessionId.slice(0, 8)}
              </span>
            </>
          )}
          {stage === "results" && (
            <button className="btn btn-sm btn-ghost" onClick={onReset} style={{ marginLeft: 8 }}>
              ↺ New session
            </button>
          )}
        </div>
      </div>
      <div className="double-rule" />
      <div className="row between" style={{ marginTop: -2 }}>
        <span className="serif-i" style={{ fontSize: 14, color: "var(--ink-mute)" }}>
          A patient ear for solitary practice — Vol. I, No. 47
        </span>
        <span className="eyebrow">The Practice Journal</span>
      </div>
    </header>
  );
}
