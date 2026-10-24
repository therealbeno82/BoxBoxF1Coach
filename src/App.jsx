import { useState, lazy, Suspense } from "react";
import BoxBoxApp from "./BoxBoxApp.jsx";
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
//
// It is also the clearest case in the app for a lazy chunk, and it used to be the
// worst: 1,167 lines kept MOUNTED from first paint behind `display: none`, so a
// tool whose own comment says most sessions never need it had its state
// initialised and a global window mouseup listener live for the whole process.
// Now the chunk loads, and the component mounts, on first open.
const TraceCalibrator = isAndroid ? null : lazy(() => import("./TraceCalibrator.jsx"));

export default function App() {
  const [mode, setMode] = useState("coach");
  // Has the Calibrator ever been opened? It STAYS mounted once it has, hidden
  // rather than unmounted, so flipping back to the Coach to check a lap doesn't
  // throw away calibration work in progress. That is the one thing the old
  // mounted-from-boot arrangement got right, and it costs nothing to keep.
  const [calibratorUsed, setCalibratorUsed] = useState(false);

  const openCalibrator = () => { setCalibratorUsed(true); setMode("calibrator"); };

  return (
    <ViewportProvider>
      <div style={{ display: mode === "coach" ? "contents" : "none" }}>
        <BoxBoxApp onOpenCalibrator={isAndroid ? null : openCalibrator} />
      </div>
      {!isAndroid && calibratorUsed && (
        <div style={{ display: mode === "calibrator" ? "contents" : "none" }}>
          {/* The chunk is a local file, so this is a frame or two on first open.
              It covers the window in the app's own background rather than letting
              the hidden Coach show through or flashing white. */}
          <Suspense fallback={<div style={{ position: "fixed", inset: 0, background: "var(--bg)" }} />}>
            <TraceCalibrator onExit={() => setMode("coach")} />
          </Suspense>
        </div>
      )}
    </ViewportProvider>
  );
}
