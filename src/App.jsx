import { useState } from "react";
import BoxBoxApp from "./BoxBoxApp.jsx";
import TraceCalibrator from "./TraceCalibrator.jsx";

// Two full-screen tools: the live Coach (the default view) and the Trace
// Calibrator that produces the reference-trace JSON the Coach compares you
// against. The Calibrator is reached from the Coach's Settings tab rather than a
// global switcher — most sessions never need it — and exits back to the Coach.
export default function App() {
  const [mode, setMode] = useState("coach");

  return (
    <>
      <div style={{ display: mode === "coach" ? "contents" : "none" }}>
        <BoxBoxApp onOpenCalibrator={() => setMode("calibrator")} />
      </div>
      <div style={{ display: mode === "calibrator" ? "contents" : "none" }}>
        <TraceCalibrator onExit={() => setMode("coach")} />
      </div>
    </>
  );
}
