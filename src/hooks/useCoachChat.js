import { useState, useRef, useEffect, useCallback } from "react";
import { buildChatSystemPrompt } from "../lib/coach/prompts.js";
import { cleanOutput } from "../lib/coach/guardrails.js";
import { createProvider } from "../lib/coach/provider.js";
import { PARAMS, OUTPUT_LIMITS } from "../lib/coach/config.js";

// Conversational coach. Keeps multi-turn history and rebuilds a FRESH telemetry
// snapshot as the system prompt on every turn — so "where am I losing time?"
// reasons about where the driver actually is right now. All LLM specifics
// (persona, guardrails, model params, provider) live in src/lib/coach; this hook
// just wires the conversation to them and post-processes the reply.

export function useCoachChat({ llmConfig }) {
  const [messages, setMessages] = useState([]); // { role, content, time, error? }
  const [thinking, setThinking] = useState(false);
  const messagesRef = useRef([]);
  const abortRef = useRef(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const send = useCallback(
    async (text, ctx) => {
      const clean = (text || "").trim();
      if (!clean) return null;

      const userMsg = { role: "user", content: clean, time: Date.now() };
      setMessages((prev) => [...prev, userMsg]);
      setThinking(true);

      if (abortRef.current) abortRef.current.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        // Only real conversation turns go to the model; the system prompt is
        // rebuilt fresh each call so telemetry context is never stale.
        const history = [...messagesRef.current, userMsg]
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map(({ role, content }) => ({ role, content }));

        const provider = createProvider(llmConfig);
        const { text: raw } = await provider.complete({
          system: buildChatSystemPrompt(ctx),
          messages: history,
          params: PARAMS.chat,
          signal: ctrl.signal,
        });

        const reply = cleanOutput(raw, OUTPUT_LIMITS.chat);
        if (reply) {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: reply, time: Date.now() },
          ]);
        }
        return reply || null;
      } catch (e) {
        if (e.name === "AbortError") return null;
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            error: true,
            time: Date.now(),
            content:
              "⚠ Couldn't reach OpenRouter. Check your API key and model in the Setup tab.",
          },
        ]);
        return null;
      } finally {
        // Only the current request may clear the spinner. A newer send() aborts
        // this one and sets thinking=true; without this guard the aborted call's
        // finally would switch it back off while the new request is still in flight.
        if (abortRef.current === ctrl) setThinking(false);
      }
    },
    [llmConfig]
  );

  const clear = useCallback(() => setMessages([]), []);

  useEffect(() => () => abortRef.current?.abort(), []);

  return { messages, send, thinking, clear };
}
