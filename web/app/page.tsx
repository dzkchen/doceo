"use client";

import { useEffect, useRef, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

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
};

type VideoResponse = {
  sessionId: string;
  videoPath: string;
  audioPath: string;
};

export default function Home() {
  const [midi, setMidi] = useState<MidiResponse | null>(null);
  const [video, setVideo] = useState<VideoResponse | null>(null);
  const [busy, setBusy] = useState<"midi" | "video" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function uploadMidi(file: File) {
    setBusy("midi");
    setError(null);
    setVideo(null);
    setMidi(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${API_BASE}/midi`, { method: "POST", body: fd });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      setMidi(await res.json());
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
    try {
      const fd = new FormData();
      fd.append("session_id", midi.sessionId);
      fd.append("file", file);
      const res = await fetch(`${API_BASE}/video`, { method: "POST", body: fd });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      setVideo(await res.json());
    } catch (e) {
      setError(`Video upload failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

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
          disabled={!midi || !video}
          className="rounded bg-black px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-30 dark:bg-white dark:text-black"
          onClick={() => {
            console.log("ready to analyze", midi?.sessionId);
          }}
        >
          Start analysis
        </button>
        {midi && video && (
          <p className="mt-2 text-sm text-zinc-500">
            Analysis pipeline lands in step 11. Session: {midi.sessionId}
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-xl font-semibold">Score</h2>
        {midi?.musicxml ? (
          <ScoreView musicxml={midi.musicxml} />
        ) : (
          <p className="text-zinc-400">Upload a MIDI to see the score render here.</p>
        )}
      </section>
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
      {hint && !status && !loading && (
        <p className="mt-2 text-sm text-zinc-400">{hint}</p>
      )}
    </div>
  );
}

function ScoreView({ musicxml }: { musicxml: string }) {
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
        inst.render();
      } catch (e) {
        console.error("OSMD load/render failed", e);
        container.innerHTML = `<p style="color:#b91c1c">Failed to render score: ${
          (e as Error).message
        }</p>`;
      }
    })();

    return () => {
      cancelled = true;
      container.innerHTML = "";
    };
  }, [musicxml]);

  return (
    <div
      ref={ref}
      className="overflow-auto rounded border border-zinc-200 bg-white p-4 dark:border-zinc-800"
    />
  );
}
