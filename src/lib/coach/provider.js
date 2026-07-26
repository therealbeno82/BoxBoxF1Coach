// ─── COACH PROVIDER ───────────────────────────────────────────────────────────
// LLM backend. createProvider(cfg) returns { complete } that normalizes to
// { text, json }. OpenRouter (cloud) hits its OpenAI-compatible REST API with plain
// fetch, fronting 300+ models from many vendors through one key.
//
//   complete({ system, messages, prompt, params, schema, signal }) -> { text, json }
//     - messages present  → chat completion (system + history)
//     - prompt present     → single-shot generation; with `schema` → structured JSON

import { DEFAULT_OPENROUTER_MODEL, DEFAULT_OPENROUTER_URL } from "./config.js";

// Lenient JSON extraction — models sometimes wrap JSON in prose.
function tryParse(text) {
  const s = String(text ?? "");
  try { return JSON.parse(s); } catch { /* fall through */ }
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* give up */ } }
  return undefined;
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

export function createProvider(cfg = {}) {
  return openRouterProvider(cfg);
}

// Lightweight reachability check for the status indicator — is the backend up
// AND is the configured key actually good? Returns a plain boolean and never
// throws, so callers can poll it on an interval. A short timeout keeps a dead
// host from leaving the dot stuck on "checking".
//
// Deliberately /auth/key, NOT /models. /models is a PUBLIC catalogue: it answers
// 200 even for a garbage key, so probing it lit the status dot green on an
// invalid key — the coach then reported itself online and every debrief failed.
// It is also ~535 kB, which this used to download in full every poll (the body
// was never read, but fetch still transfers it) purely to look at res.ok.
// /auth/key returns the key's own quota row: ~60 bytes, and 401 when the key is
// bad — the question the dot is actually asking.
export async function pingProvider(cfg = {}, { signal, timeoutMs = 3000 } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    if (!cfg.openRouterKey) return false;
    const base = (cfg.openRouterUrl || DEFAULT_OPENROUTER_URL).replace(/\/+$/, "");
    const res = await fetch(`${base}/auth/key`, {
      signal: sig,
      headers: { Authorization: `Bearer ${cfg.openRouterKey}` },
    });
    // Drain the (tiny) body so the connection returns to the pool promptly.
    await res.arrayBuffer().catch(() => {});
    return res.ok;
  } catch {
    return false;
  }
}
