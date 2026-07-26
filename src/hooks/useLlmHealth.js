import { useState, useEffect } from "react";
import { pingProvider } from "../lib/coach/provider.js";

// Live reachability of the coaching LLM, for the Race Engineer status dot. Probes
// on mount, whenever the config changes, and on a slow interval — so the
// "Online / Offline" indicator reflects whether the model can actually be
// reached, not just that one is configured. Returns "checking" | "online" |
// "offline". `llmConfig` is expected to be a stable (memoized) object so the
// effect only re-subscribes when the provider settings actually change.
//
// The interval only governs DRIFT detection (key revoked, network dropped): the
// effect re-probes immediately whenever the key or model changes, so the dot
// still turns green the moment a key is pasted into Settings. 60 s is therefore
// plenty — the old 20 s hit the provider three times a minute, mid-race included.
export function useLlmHealth(llmConfig, { intervalMs = 60000 } = {}) {
  const [status, setStatus] = useState("checking");

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();

    const probe = async () => {
      const ok = await pingProvider(llmConfig, { signal: ctrl.signal });
      if (!cancelled) setStatus(ok ? "online" : "offline");
    };

    setStatus("checking");
    probe();
    const timer = setInterval(probe, intervalMs);

    return () => { cancelled = true; ctrl.abort(); clearInterval(timer); };
  }, [llmConfig, intervalMs]);

  return status;
}
