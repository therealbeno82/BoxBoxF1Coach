import { useState, useRef, useEffect } from "react";
import { useCoachChat } from "../hooks/useCoachChat.js";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition.js";
import { C, FONT } from "../lib/ui/tokens.js";

const SUGGESTIONS = [
  "Where am I losing time?",
  "How should I take the next corner?",
  "When do I deploy ERS here?",
  "Is my braking too early?",
];

// Conversational, telemetry-aware coach styled as the cockpit "Race Engineer"
// panel. `contextRef` is a ref the parent keeps pointed at the latest
// { tel, refSample, zone, trace } so the snapshot sent to the model is current at
// the moment the driver asks — even if the question arrives via a speech-
// recognition callback captured a moment earlier. Renders inside the Analytics
// chat card (no own outer border), so it just fills its container.
// `health` ("checking" | "online" | "offline") comes from the app's single
// useLlmHealth instance so the backend isn't pinged once per mounted consumer.
export default function CoachChat({ llmConfig, modelLabel, contextRef, speak, health = "checking" }) {
  const { messages, send, thinking, clear } = useCoachChat({ llmConfig });
  const { supported, listening, interim, start, stop } = useSpeechRecognition();
  const [input, setInput] = useState("");
  const [speakReplies, setSpeakReplies] = useState(true);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, thinking, interim]);

  const doSend = async (text) => {
    const t = (text ?? input).trim();
    if (!t || thinking) return;
    setInput("");
    const reply = await send(t, contextRef?.current);
    if (reply && speakReplies && speak) speak(reply, "normal");
  };

  const onMic = () => {
    if (listening) { stop(); return; }
    start((finalText) => { setInput(finalText); doSend(finalText); });
  };

  const empty = messages.length === 0;
  const canSend = !!input.trim() && !thinking;

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", fontFamily: FONT.ui }}>
      {/* ── Header ── */}
      <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 11, padding: "14px 16px", borderBottom: `1px solid ${C.line}` }}>
        <div style={{ width: 32, height: 32, flex: "none", borderRadius: 9, background: "linear-gradient(135deg,#3671C6,#b45bff)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 8V4H8"></path><rect x="4" y="8" width="16" height="12" rx="2"></rect>
            <path d="M2 14h2"></path><path d="M20 14h2"></path><path d="M15 13v2"></path><path d="M9 13v2"></path>
          </svg>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#eef1f6", letterSpacing: 0.3 }}>Race Engineer</div>
          <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 2 }}>
            <span style={{
              width: 6, height: 6, borderRadius: "50%", flex: "none",
              background: health === "online" ? C.green : health === "offline" ? C.red : C.textDim,
              animation: health === "checking" ? "coachPulse 1s ease-in-out infinite" : "none",
            }} />
            <span style={{ fontSize: 9, letterSpacing: 1.5, color: C.textDim, textTransform: "uppercase", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {health === "online" ? "Online" : health === "offline" ? "Offline" : "Connecting"} · {modelLabel}
            </span>
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={() => setSpeakReplies((s) => !s)} title="Speak replies aloud" style={chipBtn(speakReplies, C.ersYellow)}>
          {speakReplies ? "🔊 Voice" : "🔇 Voice"}
        </button>
        <button onClick={clear} disabled={empty} style={{ ...chipBtn(false, C.textFaint), opacity: empty ? 0.4 : 1 }}>Clear</button>
      </div>

      {/* ── Conversation ── */}
      <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        {empty && !thinking && (
          <div style={{ margin: "auto", textAlign: "center", maxWidth: 420 }}>
            <div style={{ fontSize: 30, marginBottom: 10 }}>🎙️</div>
            <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.6, marginBottom: 4 }}>Talk to your race engineer.</div>
            <div style={{ fontSize: 11, color: C.textDim, lineHeight: 1.6 }}>
              Tap the mic and ask anything — the coach can see your live telemetry and the reference lap.
            </div>
          </div>
        )}

        {messages.map((m, i) => <Bubble key={i} m={m} />)}

        {thinking && (
          <div style={{ alignSelf: "flex-start", display: "flex", alignItems: "center", gap: 6, padding: "10px 13px", borderRadius: "12px 12px 12px 3px", background: "#161b26", border: "1px solid #232b3a" }}>
            {[0, 1, 2].map((i) => (
              <span key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: C.textDim, animation: `coachPulse 1s ease-in-out ${i * 0.2}s infinite` }} />
            ))}
          </div>
        )}
      </div>

      {/* ── Listening indicator ── */}
      {listening && (
        <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 8, margin: "0 14px 8px", padding: "8px 12px", background: "#2a0f12", border: `1px solid ${C.red}`, borderRadius: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.red, animation: "coachPulse 1s infinite" }} />
          <span style={{ fontSize: 11, color: "#ffb3ba" }}>
            {interim ? <span style={{ color: "#fff" }}>{interim}</span> : "Listening… speak now"}
          </span>
        </div>
      )}

      {/* ── Suggestions (when the chat is empty) ── */}
      {empty && (
        <div style={{ flex: "none", padding: "0 14px 10px", display: "flex", flexWrap: "wrap", gap: 7 }}>
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => doSend(s)} style={suggestionChip}>{s}</button>
          ))}
        </div>
      )}

      {/* ── Input ── */}
      <div style={{ flex: "none", padding: "12px 14px", borderTop: `1px solid ${C.line}`, display: "flex", gap: 9, alignItems: "flex-end" }}>
        <button onClick={onMic} disabled={!supported}
          title={supported ? "Push to talk — offline speech recognition (Whisper)" : "Voice input needs microphone access — text still works"}
          style={{
            width: 40, height: 40, borderRadius: 9, flexShrink: 0,
            border: `1px solid ${listening ? C.red : supported ? C.borderStrong : C.line}`,
            background: listening ? C.red : C.inset,
            color: listening ? "#fff" : supported ? C.textMid : C.textFaintest,
            fontSize: 16, cursor: supported ? "pointer" : "not-allowed", opacity: supported ? 1 : 0.5,
          }}>
          {listening ? "⏹" : "🎤"}
        </button>

        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); } }}
          placeholder={supported ? "Ask the coach, or tap the mic…" : "Type your question…"}
          rows={1}
          style={{
            flex: 1, resize: "none", maxHeight: 96, background: C.inset, border: `1px solid ${C.borderStrong}`,
            borderRadius: 9, color: "#e3e7ef", fontFamily: "inherit", fontSize: 13, lineHeight: 1.4, padding: "10px 12px", outline: "none",
          }}
        />

        <button onClick={() => doSend()} disabled={!canSend} title="Send"
          style={{
            width: 40, height: 40, flexShrink: 0, borderRadius: 9, border: "none", display: "flex", alignItems: "center", justifyContent: "center",
            background: canSend ? C.blue : C.borderStrong, color: canSend ? "#fff" : C.textFaint, cursor: canSend ? "pointer" : "default",
          }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m22 2-7 20-4-9-9-4Z"></path><path d="M22 2 11 13"></path>
          </svg>
        </button>
      </div>
    </div>
  );
}

function Bubble({ m }) {
  const isUser = m.role === "user";
  const style = m.error
    ? { bg: "#2a0f12", border: C.red, color: "#ffb3ba" }
    : isUser
      ? { bg: "#13243f", border: "#26405f", color: "#dbe7f7" }
      : { bg: "#1a1330", border: "#3a2b5c", color: "#e7ddf5" };
  return (
    <div style={{ alignSelf: isUser ? "flex-end" : "flex-start", maxWidth: "82%" }}>
      <div style={{
        background: style.bg, border: `1px solid ${style.border}`, borderRadius: 12,
        borderTopRightRadius: isUser ? 3 : 12, borderTopLeftRadius: isUser ? 12 : 3,
        padding: "9px 13px", fontSize: 12.5, lineHeight: 1.55, color: style.color, whiteSpace: "pre-wrap",
      }}>
        {m.content}
      </div>
      <div style={{ fontSize: 8, color: C.textFaintest, marginTop: 3, textAlign: isUser ? "right" : "left", padding: "0 4px" }}>
        {isUser ? "You" : "Coach"} · {new Date(m.time).toLocaleTimeString()}
      </div>
    </div>
  );
}

const suggestionChip = {
  background: "#161b26", border: "1px solid #232b3a", borderRadius: 8, color: "#9aa3b5",
  padding: "7px 11px", fontSize: 11, cursor: "pointer", fontFamily: "inherit", textAlign: "left",
};

function chipBtn(active, color) {
  return {
    background: active ? color + "1a" : C.inset,
    color: active ? color : C.textFaint,
    border: `1px solid ${active ? color : C.borderInput}`,
    borderRadius: 7, padding: "5px 10px", fontSize: 10, cursor: "pointer", fontFamily: "inherit", fontWeight: 600, whiteSpace: "nowrap",
  };
}
