"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "./types";
import { useSpeechRecognition } from "./useSpeechRecognition";

type TutorChatProps = {
  sessionId: string;
  history: ChatMessage[];
  busy: boolean;
  onSend: (text: string) => void | Promise<void>;
  resolveUrl: (path: string) => string;
};

function playAudio(url: string) {
  const audio = new Audio(url);
  void audio.play().catch(() => {});
}

export function TutorChat({
  sessionId,
  history,
  busy,
  onSend,
  resolveUrl,
}: TutorChatProps) {
  const [draft, setDraft] = useState("");
  const lastAutoPlayedRef = useRef<string | null>(null);
  const lastTranscriptRef = useRef("");
  const { supported, listening, start, stop, transcript } = useSpeechRecognition();

  const visibleMessages = useMemo(() => history.slice(-8), [history]);

  useEffect(() => {
    const latestTutorMessage = [...history].reverse().find((message) => message.role === "tutor" && message.audioUrl);
    if (!latestTutorMessage?.audioUrl) return;
    if (lastAutoPlayedRef.current === latestTutorMessage.audioUrl) return;
    lastAutoPlayedRef.current = latestTutorMessage.audioUrl;
    playAudio(resolveUrl(latestTutorMessage.audioUrl));
  }, [history, resolveUrl]);

  useEffect(() => {
    const trimmed = transcript.trim();
    if (!trimmed || trimmed === lastTranscriptRef.current || busy) return;
    lastTranscriptRef.current = trimmed;
    setDraft("");
    void onSend(trimmed);
  }, [busy, onSend, transcript]);

  useEffect(() => {
    if (!busy) return;
    stop();
  }, [busy, stop]);

  function submit() {
    const message = draft.trim();
    if (!message || busy) return;
    setDraft("");
    void onSend(message);
  }

  return (
    <div className="sheet col" style={{ padding: 0, overflow: "hidden" }}>
      <div className="row between center-y" style={{ padding: "16px 20px", borderBottom: "1px solid var(--paper-edge)" }}>
        <div className="col" style={{ gap: 2 }}>
          <span className="eyebrow">Tutor chat</span>
          <span className="serif-i" style={{ fontSize: 13, color: "var(--ink-mute)" }}>
            Session {sessionId.slice(0, 8)} | follow-up questions stay local to this page
          </span>
        </div>
        {busy && (
          <span className="chip chip-sepia">Tutor is thinking...</span>
        )}
      </div>

      <div className="col" style={{ gap: 12, padding: "18px 20px", maxHeight: 360, overflowY: "auto", background: "rgba(255,250,235,0.4)" }}>
        {visibleMessages.length === 0 ? (
          <div className="col" style={{ gap: 4 }}>
            <span className="serif" style={{ fontSize: 20 }}>Ask about a specific passage, issue, or practice strategy.</span>
            <span style={{ fontSize: 13, color: "var(--ink-mute)" }}>
              Try: &quot;Focus on the timing in the second half&quot; or &quot;What should I practice first?&quot;
            </span>
          </div>
        ) : (
          visibleMessages.map((message, index) => (
            <div
              key={`${message.role}-${index}-${message.text.slice(0, 24)}`}
              className="col"
              style={{
                alignSelf: message.role === "student" ? "flex-end" : "flex-start",
                maxWidth: "82%",
                gap: 6,
              }}
            >
              <div
                style={{
                  padding: "12px 14px",
                  border: "1px solid var(--paper-edge)",
                  background: message.role === "student" ? "var(--ink)" : "var(--paper)",
                  color: message.role === "student" ? "var(--paper)" : "var(--ink)",
                  borderRadius: 2,
                  boxShadow: "0 6px 18px -18px rgba(40,30,15,0.35)",
                }}
              >
                <div style={{ fontSize: 14, lineHeight: 1.5 }}>{message.text}</div>
              </div>
              {message.role === "tutor" && message.audioUrl && (
                <button
                  className="btn btn-sm"
                  onClick={() => playAudio(resolveUrl(message.audioUrl!))}
                  style={{ alignSelf: "flex-start" }}
                  type="button"
                >
                  <span style={{ fontSize: 12 }}>▶</span>
                  <span>Play reply</span>
                </button>
              )}
            </div>
          ))
        )}
      </div>

      <div className="row" style={{ gap: 10, padding: "16px 20px", borderTop: "1px solid var(--paper-edge)", alignItems: "center" }}>
        <button
          className="btn btn-sm"
          type="button"
          onClick={() => {
            if (listening) {
              stop();
              return;
            }
            lastTranscriptRef.current = "";
            start();
          }}
          disabled={!supported || busy}
          style={{
            minWidth: 120,
            justifyContent: "center",
            background: listening ? "var(--vermilion)" : undefined,
            color: listening ? "var(--paper)" : undefined,
            borderColor: listening ? "var(--vermilion)" : undefined,
            boxShadow: listening ? "0 0 0 8px rgba(192,52,29,0.12)" : undefined,
          }}
        >
          <span>{listening ? "REC" : "MIC"}</span>
          <span>{listening ? "Listening..." : "Ask the tutor"}</span>
        </button>

        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={supported ? "Or type your follow-up question" : "Type your follow-up question"}
          disabled={busy}
          style={{
            flex: 1,
            minWidth: 0,
            padding: "11px 12px",
            border: "1px solid var(--paper-edge)",
            borderRadius: 2,
            background: "var(--paper)",
            color: "var(--ink)",
            fontSize: 14,
          }}
        />

        <button className="btn btn-sm" type="button" onClick={submit} disabled={busy || !draft.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}
