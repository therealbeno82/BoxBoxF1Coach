// ─── COACH PROVIDER ───────────────────────────────────────────────────────────
// Pluggable LLM backend. createProvider(cfg) returns { complete } that normalizes
// to { text, json }. Ollama (default, local, offline) wraps the existing fetch
// calls; OpenRouter (optional cloud) hits its OpenAI-compatible REST API with plain
// fetch, fronting 300+ models from many vendors through one key.
//
//   complete({ system, messages, prompt, params, schema, signal }) -> { text, json }
//     - messages present  → chat completion (system + history)
//     - prompt present     → single-shot generation; with `schema` → structured JSON

import { DEFAULT_OPENROUTER_MODEL, DEFAULT_OPENROUTER_URL, DEFAULT_OLLAMA_MODEL, DEFAULT_OLLAMA_URL } from "./config.js";

// Some "thinking" models emit their chain-of-thought wrapped in <think>…</think>
// inside the reply content. Strip it so the driver hears the answer, not the
// reasoning. Also drops an unterminated <think> (the model ran out of budget
// mid-reasoning). Models that expose reasoning in a separate `thinking` field
// already keep it out of content; this only catches the inline-tag variant.
function stripThinking(text) {
  return String(text ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trim();
}

// Lenient JSON extraction — small models sometimes wrap JSON in prose.
function tryParse(text) {
  const s = String(text ?? "");
  try { return JSON.parse(s); } catch { /* fall through */ }
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* give up */ } }
  return undefined;
}

function ollamaProvider(cfg) {
  const base = (cfg.ollamaUrl || DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
  const model = cfg.ollamaModel || DEFAULT_OLLAMA_MODEL;

  async function complete({ system, messages, prompt, params = {}, schema, signal }) {
    const options = {
      temperature: params.temperature,
      num_predict: params.maxTokens,
      top_p: params.topP,
      repeat_penalty: params.repeatPenalty,
      // A stop sequence can clip structured JSON — only apply it to free text.
      ...(!schema && params.stop && params.stop.length ? { stop: params.stop } : {}),
    };

    // think:false asks reasoning models to answer directly — no chain-of-thought.
    // Models that honour it (e.g. qwen) stay terse and fast; models that don't
    // (e.g. deepseek-r1) ignore it harmlessly, and stripThinking is the backstop.
    let url, body;
    if (messages) {
      url = `${base}/api/chat`;
      body = {
        model,
        messages: system ? [{ role: "system", content: system }, ...messages] : messages,
        stream: false,
        think: false,
        options,
      };
    } else {
      url = `${base}/api/generate`;
      body = { model, prompt, stream: false, think: false, options, ...(schema ? { format: schema } : {}) };
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    const data = await res.json();
    const text = stripThinking(messages ? data.message?.content : data.response);
    return { text, json: schema ? tryParse(text) : undefined };
  }

  return { complete, label: model };
}

function openRouterProvider(cfg) {
  const base = (cfg.openRouterUrl || DEFAULT_OPENROUTER_URL).replace(/\/+$/, "");
  const model = cfg.openRouterModel || DEFAULT_OPENROUTER_MODEL;

  async function complete({ system, messages, prompt, params = {}, schema, signal }) {
    if (!cfg.openRouterKey) throw new Error("OpenRouter API key not set (Setup tab)");

    // OpenAI-compatible chat schema: history goes in `messages`, system is just a
    // message with role "system" prepended.
    const chat = messages || [{ role: "user", content: prompt }];
    const body = {
      model,
      messages: system ? [{ role: "system", content: system }, ...chat] : chat,
      max_tokens: Math.max(params.maxTokens || 128, schema ? 256 : 128),
      ...(typeof params.temperature === "number" ? { temperature: params.temperature } : {}),
      ...(typeof params.topP === "number" ? { top_p: params.topP } : {}),
      // A stop sequence can clip structured JSON — only apply it to free text.
      ...(!schema && params.stop && params.stop.length ? { stop: params.stop } : {}),
      ...(schema
        ? { response_format: { type: "json_schema", json_schema: { name: "coaching_tip", strict: true, schema } } }
        : {}),
    };

    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.openRouterKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
    const data = await res.json();
    const text = (data.choices?.[0]?.message?.content || "").trim();
    // Some models ignore response_format — tryParse recovers JSON from prose.
    return { text, json: schema ? tryParse(text) : undefined };
  }

  return { complete, label: model };
}

// Fetch OpenRouter's public model catalogue for the Setup-tab picker. The key is
// optional for the public list, but we send it as Bearer when present.
export async function listOpenRouterModels({ url, key, signal } = {}) {
  const base = (url || DEFAULT_OPENROUTER_URL).replace(/\/+$/, "");
  const res = await fetch(`${base}/models`, {
    signal,
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.data) ? data.data : [];
}

// List the models actually installed in the local Ollama server, for the Setup-tab
// picker and the connection test. Returns an array of model names (e.g.
// "gemma4:latest"); throws if the server is unreachable so callers can tell
// "server down" apart from "server up, model not pulled".
export async function listOllamaModels({ url, signal } = {}) {
  const base = (url || DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
  const res = await fetch(`${base}/api/tags`, { signal });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.models) ? data.models.map((m) => m.name).filter(Boolean) : [];
}

export function createProvider(cfg = {}) {
  return cfg.provider === "openrouter" ? openRouterProvider(cfg) : ollamaProvider(cfg);
}

// Lightweight reachability check for the status indicator — does the backend
// actually respond? OpenRouter needs a key, then we confirm its REST API answers;
// Ollama just needs its local server reachable. Returns a plain boolean and never
// throws, so callers can poll it on an interval. A short timeout keeps a dead
// host from leaving the dot stuck on "checking".
export async function pingProvider(cfg = {}, { signal, timeoutMs = 3000 } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    if (cfg.provider === "openrouter") {
      if (!cfg.openRouterKey) return false;
      const base = (cfg.openRouterUrl || DEFAULT_OPENROUTER_URL).replace(/\/+$/, "");
      const res = await fetch(`${base}/models`, {
        signal: sig,
        headers: { Authorization: `Bearer ${cfg.openRouterKey}` },
      });
      return res.ok;
    }
    const base = (cfg.ollamaUrl || DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
    const res = await fetch(`${base}/api/tags`, { signal: sig });
    return res.ok;
  } catch {
    return false;
  }
}
