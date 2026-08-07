import { useState } from "react";
import BoxBoxApp from "./BoxBoxApp.jsx";
import TraceCalibrator from "./TraceCalibrator.jsx";
import { isAndroid } from "./lib/env.js";
import { ViewportProvider } from "./hooks/useViewport.jsx";

// Two full-screen tools: the live Coach (the default view) and the Trace
// Calibrator that produces the reference-trace JSON the Coach compares you
// against. The Calibrator is reached from the Coach's Settings tab rather than a
// global switcher — most sessions never need it — and exits back to the Coach.
//
// The Calibrator is DESKTOP-ONLY: it drives panel move/resize off raw mouse
// events on thin edge hit-areas, which a finger can't hit, so Android never
// mounts it. `isAndroid` is a folded build constant, so it isn't bundled there.
export default function App() {
  const [mode, setMode] = useState("coach");

  return (
    <ViewportProvider>
      <div style={{ display: mode === "coach" ? "contents" : "none" }}>
        <BoxBoxApp onOpenCalibrator={isAndroid ? null : () => setMode("calibrator")} />
      </div>
      {!isAndroid && (
        <div style={{ display: mode === "calibrator" ? "contents" : "none" }}>
          <TraceCalibrator onExit={() => setMode("coach")} />
        </div>
      )}
    </ViewportProvider>
  );
}
