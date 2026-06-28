import { useState, useRef, useEffect, useCallback } from "react";
import { loadWhisper, transcribeBlob, isWhisperLoaded } from "../lib/whisperSTT.js";

// Speech-to-text wrapper. Uses OpenAI Whisper run fully offline in the
// browser/WebView via Transformers.js (see src/lib/whisperSTT.js) — replacing the
// old Web Speech API, which was cloud-backed and unreliable offline. The public
// interface (supported / listening / interim / start / stop) is unchanged, so
// CoachChat and anything else using this hook needs no changes.
//
// Push-to-talk: start() begins recording, stop() ends it and transcribes the clip
// — then onFinal(text) fires once. There are no live interim words (Whisper
// transcribes the whole clip at once), so `interim` instead carries a short status
// string ("Loading…", "Transcribing…") for UI feedback.
export function useSpeechRecognition() {
  // Supported wherever we can capture a mic; the model itself loads on first use.
  const supported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function" &&
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined";

  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");

  const recRef = useRef(null);     // MediaRecorder
  const streamRef = useRef(null);  // MediaStream (to stop tracks)
  const chunksRef = useRef([]);
  const onFinalRef = useRef(null);

  const cleanupStream = () => {
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
    streamRef.current = null;
    recRef.current = null;
    chunksRef.current = [];
  };

  const start = useCallback(
    async (onFinal) => {
      if (!supported || recRef.current) return;
      onFinalRef.current = onFinal;

      // Warm the model up front so the first transcription isn't a long stall;
      // surface download progress in the interim status line.
      if (!isWhisperLoaded()) {
        setInterim("Loading speech model…");
        loadWhisper().catch(() => {}); // fire-and-forget; transcribe awaits it too
      }

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        setListening(false);
        setInterim("");
        return;
      }
      streamRef.current = stream;
      chunksRef.current = [];

      const rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => { if (e.data?.size) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        cleanupStream();
        if (!blob.size) { setListening(false); setInterim(""); return; }
        setInterim("Transcribing…");
        try {
          const text = await transcribeBlob(blob);
          setInterim("");
          setListening(false);
          if (text) onFinalRef.current?.(text);
        } catch {
          setInterim("");
          setListening(false);
        }
      };

      recRef.current = rec;
      rec.start();
      setListening(true);
      setInterim((s) => (s === "Loading speech model…" ? s : "")); // keep load hint if downloading
    },
    [supported]
  );

  const stop = useCallback(() => {
    const rec = recRef.current;
    if (rec && rec.state !== "inactive") {
      try { rec.stop(); } catch { cleanupStream(); setListening(false); setInterim(""); }
    }
  }, []);

  // Tear down the mic if the component unmounts mid-recording.
  useEffect(
    () => () => {
      try { recRef.current?.stop(); } catch {}
      cleanupStream();
    },
    []
  );

  return { supported, listening, interim, start, stop };
}
