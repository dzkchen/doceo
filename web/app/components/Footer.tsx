export function Footer() {
  return (
    <div className="col" style={{ marginTop: 56, gap: 8 }}>
      <div className="double-rule" />
      <div className="row between center-y" style={{ paddingTop: 8 }}>
        <span className="serif-i" style={{ color: "var(--ink-mute)", fontSize: 13 }}>
          &ldquo;What was difficult yesterday is the music of tomorrow.&rdquo; — Doceo.
        </span>
        <div
          className="row gap-2"
          style={{ fontSize: 11, color: "var(--ink-faint)", fontFamily: "var(--mono)", letterSpacing: "0.04em" }}
        >
          <span>v0.7</span>
          <span>·</span>
          <span>analysis runs locally</span>
          <span>·</span>
          <span>privacy-first</span>
        </div>
      </div>
    </div>
  );
}
