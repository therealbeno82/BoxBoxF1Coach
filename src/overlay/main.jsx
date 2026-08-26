// Entry point for the overlay window (overlay.html).
// ─────────────────────────────────────────────────────────────────────────────
// Deliberately NOT src/main.jsx. A second webview is a second JS context that
// parses whatever it is pointed at, so aiming it at the main app would parse the
// whole entry chunk — React tree, three.js, Kokoro's loader — a second time, per
// launch, to render four numbers. This root pulls in React and one component.

import React from "react";
import { createRoot } from "react-dom/client";
import OverlayApp from "./OverlayApp.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <OverlayApp />
  </React.StrictMode>
);
