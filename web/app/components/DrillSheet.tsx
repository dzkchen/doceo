"use client";

import type { DrillResponse } from "./types";

type DrillSheetProps = {
  drill: DrillResponse | null;
  resolveUrl: (path: string) => string;
  troubleSpotLabel: string;
  practiceTempoLabel: string;
};

export function DrillSheet({
  drill,
  resolveUrl,
  troubleSpotLabel,
  practiceTempoLabel,
}: DrillSheetProps) {
  const hasExcerpt = Boolean(drill?.excerptMidiUrl);
  const hasAiDrill = Boolean(drill?.aiDrillMidiUrl);

  return (
    <div className="sheet col" style={{ padding: 24, gap: 18 }}>
      <div className="col" style={{ gap: 4 }}>
        <span className="eyebrow">Tonight&apos;s drill sheet</span>
        <span className="serif-i" style={{ color: "var(--ink-mute)", fontSize: 13 }}>
          targeted piano MIDI practice material from this run-through
        </span>
      </div>

      {drill && (
        <div className="col" style={{ gap: 18 }}>
          {hasExcerpt && (
            <div className="col" style={{ gap: 6 }}>
              <span className="serif" style={{ fontSize: 17, fontWeight: 500 }}>Trouble-spot excerpt</span>
              <span style={{ fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.45 }}>
                {troubleSpotLabel} at {practiceTempoLabel}
              </span>
              <a
                href={resolveUrl(drill.excerptMidiUrl!)}
                download="drill-excerpt.mid"
                style={{ fontSize: 13, color: "var(--vermilion)", textDecoration: "none" }}
              >
                ↓ Download MIDI
              </a>
            </div>
          )}

          {hasAiDrill && (
            <div className="col" style={{ gap: 6 }}>
              <span className="serif" style={{ fontSize: 17, fontWeight: 500 }}>Custom exercise (AI-generated)</span>
              {drill.aiDrillDescription && (
                <span style={{ fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.45 }}>
                  {drill.aiDrillDescription}
                </span>
              )}
              <a
                href={resolveUrl(drill.aiDrillMidiUrl!)}
                download="drill-ai.mid"
                style={{ fontSize: 13, color: "var(--vermilion)", textDecoration: "none" }}
              >
                ↓ Download MIDI
              </a>
            </div>
          )}

          {!hasExcerpt && !hasAiDrill && (
            <span style={{ fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.45 }}>
              No drill files were generated for this take.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
