import { useState, useEffect, useRef, useCallback } from "react";
import { C, FONT } from "./lib/ui/tokens.js";

// ─── CHANNEL DEFINITIONS (matching MoTeC colour conventions) ─────────────────
const DEFAULT_CHANNELS = [
  { id: "throttle", label: "Throttle",  color: "#ffffff", unit: "%",    min: 0,   max: 100, bandY: 0.00, bandH: 0.13 },
  { id: "brake",    label: "Brake",     color: "#ff6d00", unit: "%",    min: 0,   max: 100, bandY: 0.13, bandH: 0.10 },
  { id: "speed",    label: "Speed",     color: "#00bcd4", unit: "km/h", min: 0,   max: 400, bandY: 0.23, bandH: 0.15 },
  { id: "steer",    label: "Steer",     color: "#4caf50", unit: "%",    min: -100,max: 100, bandY: 0.38, bandH: 0.13 },
  { id: "gear",     label: "Gear",      color: "#e040fb", unit: "",     min: 1,   max: 8,   bandY: 0.51, bandH: 0.12 },
  { id: "ersMode",  label: "ERS Mode",  color: "#f44336", unit: "",     min: 0,   max: 3,   bandY: 0.63, bandH: 0.11 },
  { id: "ersSpent", label: "ERS Spent", color: "#cddc39", unit: "kJ",   min: 0,   max: 4000,bandY: 0.74, bandH: 0.15 },
];

const STEPS = ["upload", "bands", "xcal", "ycal", "extract", "export"];
const STEP_LABELS = {
  upload:  "1 · Upload",
  bands:   "2 · Channels",
  xcal:    "3 · X Scale",
  ycal:    "4 · Y Scale",
  extract: "5 · Extract",
  export:  "6 · Export",
};

// ─── REFERENCE-LAP METADATA OPTIONS ─────────────────────────────────────────
const SESSIONS = ["Time Trial", "Qualifying", "Race Pace"];
const TYRES    = ["Softs", "Medium", "Hards", "Inters", "Wets"];

/** Parse "m:ss.mmm", "ss.mmm", or blank into seconds; null if blank/invalid. */
function parseLapTime(str) {
  if (!str || !str.trim()) return null;
  const m = str.trim().match(/^(?:(\d+):)?(\d{1,2}(?:\.\d+)?)$/);
  if (!m) return null;
  const mins = m[1] ? parseInt(m[1], 10) : 0;
  return mins * 60 + parseFloat(m[2]);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function lerp(a, b, t) { return a + (b - a) * t; }

/** Map a canvas-pixel Y within a channel band to a channel value */
function pixelToValue(py, bandTopPx, bandBotPx, ch) {
  const t = 1 - clamp((py - bandTopPx) / (bandBotPx - bandTopPx), 0, 1);
  return lerp(ch.min, ch.max, t);
}

/** Convert 0–255 RGB to [hue(0–360), sat(0–1), val(0–1)]. */
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r)      h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else                h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

// Matching tolerances
const HUE_TOL   = 24;    // degrees of hue a pixel may differ from the target and still match
const MIN_SAT   = 0.25;  // saturated targets: reject washed-out (grey) pixels below this
const MIN_VAL   = 0.22;  // reject near-black pixels
const WHITE_SAT = 0.18;  // targets below this saturation are treated as "white/grey"

/** Weight (0 = no match, →1 = perfect) for a pixel against a target colour's HSV.
 *  Hue-based for coloured traces (brightness-invariant); brightness-based for white. */
function colorWeight(r, g, b, [th, ts]) {
  const [ph, ps, pv] = rgbToHsv(r, g, b);

  if (ts < WHITE_SAT) {
    // White/grey target: match bright, low-saturation pixels (the trace), reject coloured ones.
    if (pv < 0.55 || ps > 0.30) return 0;
    return clamp((pv - 0.55) / 0.45, 0, 1) * (1 - ps / 0.30);
  }

  // Coloured target: match primarily on hue.
  if (pv < MIN_VAL || ps < MIN_SAT) return 0;
  let dh = Math.abs(ph - th);
  if (dh > 180) dh = 360 - dh;
  if (dh > HUE_TOL) return 0;
  return (1 - dh / HUE_TOL) ** 2; // quadratic falloff: closer hue = heavier
}

/** Scan a single column of ImageData within a band.
 *  Returns the weighted-centroid row of pixels matching the target colour,
 *  or -1 if nothing matches (avoids spurious spikes from bg/grid lines). */
function sampleColumn(imageData, x, bandTopPx, bandBotPx, targetColor, width) {
  const [tr, tg, tb] = hexToRgb(targetColor);
  const thsv = rgbToHsv(tr, tg, tb);
  let weightedY = 0;
  let totalWeight = 0;

  for (let y = Math.floor(bandTopPx); y <= Math.ceil(bandBotPx); y++) {
    const idx = (y * width + x) * 4;
    const r = imageData.data[idx];
    const g = imageData.data[idx + 1];
    const b = imageData.data[idx + 2];
    const a = imageData.data[idx + 3];
    if (a < 100) continue;

    const w = colorWeight(r, g, b, thsv);
    if (w <= 0) continue; // pixel doesn't match the channel colour

    weightedY += y * w;
    totalWeight += w;
  }

  if (totalWeight < 0.1) return -1; // no qualifying pixel — skip this column
  return Math.round(weightedY / totalWeight);
}

/** Median filter over a window of `half` points either side — kills isolated spikes. */
function medianFilter(pts, half = 3) {
  if (pts.length < 2) return pts;
  return pts.map((p, i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(pts.length - 1, i + half);
    const window = pts.slice(lo, hi + 1).map(q => q.value).sort((a, b) => a - b);
    const mid = Math.floor(window.length / 2);
    const median = window.length % 2 === 1 ? window[mid] : (window[mid - 1] + window[mid]) / 2;
    return { ...p, value: median };
  });
}

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}

function fmtVal(v, ch) {
  if (v === null || v === undefined) return "—";
  if (ch.unit === "" && ch.id === "gear") return Math.round(v).toString();
  if (ch.unit === "" && ch.id === "ersMode") return ["None","Medium","Hotlap","Boost"][clamp(Math.round(v),0,3)];
  return v.toFixed(ch.unit === "km/h" ? 0 : 1) + (ch.unit ? " " + ch.unit : "");
}

// Channels that can only be whole numbers — a gearbox is in 4th or 5th, never 4.5,
// and ERS mode is an enum index. Everything else is an analogue %/value reading.
const INTEGER_CHANNELS = new Set(["gear", "ersMode"]);

/** The single gate every exported/displayed reading passes through. Y-cal
 *  extrapolation can push a trace just past its physical limits (gear 5.5,
 *  throttle -1, brake 102) — clamp it back into the channel's range and snap
 *  integer channels to a whole number so impossible values never leave here. */
function sanitizeChannelValue(v, ch) {
  if (v === null || v === undefined || Number.isNaN(v)) return v;
  const clamped = clamp(v, ch.min, ch.max);
  return INTEGER_CHANNELS.has(ch.id) ? Math.round(clamped) : Math.round(clamped * 10) / 10;
}

// ─── BAND EDITOR ──────────────────────────────────────────────────────────────

function BandEditor({ channels, setChannels, imgHeight }) {
  const dragging = useRef(null); // { id, edge: 'top'|'bot'|'move', startY, startBandY, startBandH }

  const onMouseDown = (e, id, edge) => {
    e.preventDefault();
    dragging.current = { id, edge, startY: e.clientY, ch: channels.find(c => c.id === id) };
  };

  const onMouseMove = useCallback((e) => {
    if (!dragging.current) return;
    const { id, edge, startY, ch } = dragging.current;
    const dy = (e.clientY - startY) / imgHeight;
    setChannels(prev => prev.map(c => {
      if (c.id !== id) return c;
      if (edge === "top") {
        const newTop = clamp(ch.bandY + dy, 0, ch.bandY + ch.bandH - 0.02);
        return { ...c, bandY: newTop, bandH: ch.bandH - (newTop - ch.bandY) };
      }
      if (edge === "bot") {
        const newH = clamp(ch.bandH + dy, 0.02, 1 - ch.bandY);
        return { ...c, bandH: newH };
      }
      if (edge === "move") {
        const newY = clamp(ch.bandY + dy, 0, 1 - ch.bandH);
        return { ...c, bandY: newY };
      }
      return c;
    }));
    dragging.current = { ...dragging.current, startY: e.clientY, ch: channels.find(c => c.id === id) };
  }, [channels, imgHeight, setChannels]);

  const onMouseUp = useCallback(() => { dragging.current = null; }, []);

  useEffect(() => {
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => { window.removeEventListener("mousemove", onMouseMove); window.removeEventListener("mouseup", onMouseUp); };
  }, [onMouseMove, onMouseUp]);

  return (
    <>
      {channels.map(ch => {
        const top = ch.bandY * imgHeight;
        const h   = ch.bandH * imgHeight;
        return (
          <g key={ch.id}>
            {/* Band fill */}
            <rect x={0} y={top} width="100%" height={h}
              fill={ch.color} fillOpacity={0.08}
              stroke={ch.color} strokeOpacity={0.25} strokeWidth={1}
              style={{ cursor: "move" }}
              onMouseDown={e => onMouseDown(e, ch.id, "move")}
            />
            {/* Top handle */}
            <rect x={0} y={top - 3} width="100%" height={6}
              fill={ch.color} fillOpacity={0.5} style={{ cursor: "ns-resize" }}
              onMouseDown={e => onMouseDown(e, ch.id, "top")}
            />
            {/* Bottom handle */}
            <rect x={0} y={top + h - 3} width="100%" height={6}
              fill={ch.color} fillOpacity={0.5} style={{ cursor: "ns-resize" }}
              onMouseDown={e => onMouseDown(e, ch.id, "bot")}
            />
            {/* Label */}
            <text x={6} y={top + 14} fill={ch.color} fontSize={11} fontFamily={FONT.mono} fontWeight="700">{ch.label}</text>
          </g>
        );
      })}
    </>
  );
}

// ─── EXTRACTED CURVE OVERLAY ──────────────────────────────────────────────────

function CurveOverlay({ extracted, channels, imgHeight, editChId }) {
  if (!extracted) return null;

  return (
    <>
      {channels.map(ch => {
        const pts = extracted[ch.id];
        if (!pts || pts.length < 2) return null;

        // Convert value → pixel Y within band
        const bandTopPx = ch.bandY * imgHeight;
        const bandBotPx = (ch.bandY + ch.bandH) * imgHeight;
        const yOf = (value) => bandBotPx - ((value - ch.min) / (ch.max - ch.min)) * (bandBotPx - bandTopPx);

        const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${yOf(p.value)}`).join(" ");
        const editing = ch.id === editChId;
        const dim = editChId && !editing;

        return (
          <g key={ch.id} opacity={dim ? 0.15 : 1}>
            <path d={d} fill="none"
              stroke={ch.color} strokeWidth={editing ? 2.5 : 1.5} opacity={0.9}
              strokeLinejoin="round" strokeLinecap="round" pointerEvents="none"
            />
            {editing && pts.map((p, i) => (
              <circle key={i} cx={p.x} cy={yOf(p.value)} r={2.2}
                fill={ch.color} stroke="#000" strokeWidth={0.4} pointerEvents="none" />
            ))}
          </g>
        );
      })}
    </>
  );
}

// ─── CROSSHAIR TOOLTIP ────────────────────────────────────────────────────────

function Crosshair({ pos, channels, extracted, imgWidth, imgHeight, applyYCal }) {
  if (!pos || !extracted) return null;
  const { x, y } = pos;

  // Find nearest extracted sample, applying Y calibration so the readout matches the export
  const values = {};
  channels.forEach(ch => {
    const pts = extracted[ch.id];
    if (!pts || pts.length === 0) return;
    const closest = pts.reduce((best, p) => Math.abs(p.x - x) < Math.abs(best.x - x) ? p : best, pts[0]);
    values[ch.id] = applyYCal ? sanitizeChannelValue(applyYCal(closest.value, ch), ch) : closest.value;
  });

  const tipX = x > imgWidth * 0.7 ? x - 170 : x + 12;
  const tipY = clamp(y - 10, 4, imgHeight - channels.length * 18 - 10);

  return (
    <g pointerEvents="none">
      <line x1={x} y1={0} x2={x} y2={imgHeight} stroke="#fff" strokeWidth={0.5} opacity={0.4} strokeDasharray="4 3" />
      <line x1={0} y1={y} x2={imgWidth} y2={y} stroke="#fff" strokeWidth={0.5} opacity={0.2} strokeDasharray="4 3" />
      <rect x={tipX} y={tipY} width={162} height={channels.length * 18 + 8} rx={6}
        fill={C.modal} fillOpacity={0.95} stroke={C.borderStrong} strokeWidth={1} />
      {channels.map((ch, i) => (
        <g key={ch.id}>
          <rect x={tipX + 6} y={tipY + 6 + i * 18} width={8} height={8} rx={2} fill={ch.color} />
          <text x={tipX + 20} y={tipY + 15 + i * 18}
            fill={C.textMid} fontSize={10} fontFamily={FONT.mono}>
            {ch.label}: <tspan fill={ch.color} fontWeight="700">{fmtVal(values[ch.id], ch)}</tspan>
          </text>
        </g>
      ))}
    </g>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────

export default function TraceCalibrator({ onExit }) {
  const [step, setStep]           = useState("upload");
  const [imgSrc, setImgSrc]       = useState(null);
  const [imgSize, setImgSize]     = useState({ w: 1, h: 1 });
  const [channels, setChannels]   = useState(DEFAULT_CHANNELS);
  const [xCal, setXCal]           = useState({ p1: null, p2: null, v1: "", v2: "" }); // p = pixel x, v = metre value
  const [yCals, setYCals]         = useState({}); // { chId: { p1, p2, v1, v2 } }
  const [calMode, setCalMode]     = useState(null); // { type: 'x'|'y', chId?, point: 1|2 }
  const [extracted, setExtracted] = useState(null);
  const [hoverPos, setHoverPos]   = useState(null);
  const [sampleCount, setSampleCount] = useState(300);
  const [driverName, setDriverName]   = useState("");
  const [trackName, setTrackName]     = useState("");
  const [session, setSession]         = useState(SESSIONS[0]);
  const [tyres, setTyres]             = useState(TYRES[0]);
  const [lapTimeStr, setLapTimeStr]   = useState("");
  const [sectorBreaks, setSectorBreaks] = useState({ p1: null, p2: null }); // pixel X of S1|S2, S2|S3
  const [sectorTimeStrs, setSectorTimeStrs] = useState(["", "", ""]);       // S1/S2/S3, "m:ss.mmm"
  const [toast, setToast]             = useState(null);
  const [editChId, setEditChId]       = useState(null); // channel being hand-corrected, or null

  const svgRef    = useRef(null);
  const canvasRef = useRef(null); // offscreen canvas for pixel sampling
  const imgRef    = useRef(null);
  const painting  = useRef(false); // mid drag-correction
  const lastPaint = useRef(null);  // last {x,y} painted, for interpolating fast drags

  // ── Image load ────────────────────────────────────────────────────────────
  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setImgSize({ w: img.width, h: img.height });
      setImgSrc(url);
      imgRef.current = img;

      // Draw to offscreen canvas for pixel sampling
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      canvasRef.current = canvas;

      setStep("bands");
    };
    img.src = url;
  };

  // ── SVG coordinate from mouse event ──────────────────────────────────────
  const svgCoord = (e) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const scaleX = imgSize.w / rect.width;
    const scaleY = imgSize.h / rect.height;
    return {
      x: clamp((e.clientX - rect.left) * scaleX, 0, imgSize.w - 1),
      y: clamp((e.clientY - rect.top)  * scaleY, 0, imgSize.h - 1),
    };
  };

  // ── Click on SVG ──────────────────────────────────────────────────────────
  const handleSvgClick = (e) => {
    if (!calMode) return;
    const { x, y } = svgCoord(e);

    if (calMode.type === "x") {
      if (calMode.point === 1) setXCal(c => ({ ...c, p1: x }));
      else                      setXCal(c => ({ ...c, p2: x }));
    } else if (calMode.type === "sector") {
      if (calMode.point === 1) setSectorBreaks(s => ({ ...s, p1: x }));
      else                      setSectorBreaks(s => ({ ...s, p2: x }));
    } else if (calMode.type === "y") {
      const id = calMode.chId;
      if (calMode.point === 1)
        setYCals(c => ({ ...c, [id]: { ...(c[id]||{}), p1: y } }));
      else
        setYCals(c => ({ ...c, [id]: { ...(c[id]||{}), p2: y } }));
    } else if (calMode.type === "color") {
      // Eyedropper: sample the clicked pixel as this channel's true trace colour.
      const ctx = canvasRef.current?.getContext("2d");
      if (ctx) {
        const px = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
        const hex = "#" + [px[0], px[1], px[2]]
          .map(v => v.toString(16).padStart(2, "0")).join("");
        setChannels(prev => prev.map(c => c.id === calMode.chId ? { ...c, color: hex } : c));
        showToast(`${calMode.chId} colour set to ${hex}`);
      }
    }
    setCalMode(null);
  };

  // ── Hand-correction: redraw points by dragging over the trace ──────────────
  const paintStroke = useCallback((x, y) => {
    if (!editChId) return;
    const ch = channels.find(c => c.id === editChId);
    if (!ch) return;
    const top = ch.bandY * imgSize.h;
    const bot = (ch.bandY + ch.bandH) * imgSize.h;
    const cy  = clamp(y, top, bot);
    const prev = lastPaint.current;
    lastPaint.current = { x, y: cy };

    setExtracted(ex => {
      if (!ex || !ex[editChId]) return ex;
      const arr = ex[editChId].slice();
      const setIdx = (i, yy) => {
        arr[i] = { ...arr[i], pixelY: yy, value: pixelToValue(yy, top, bot, ch) };
      };
      if (prev && Math.abs(x - prev.x) >= 1) {
        // Interpolate across every column the cursor swept since the last event
        const xLo = Math.min(prev.x, x), xHi = Math.max(prev.x, x);
        for (let i = 0; i < arr.length; i++) {
          const px = arr[i].pixelX;
          if (px < xLo || px > xHi) continue;
          const t = (px - prev.x) / (x - prev.x);
          setIdx(i, clamp(prev.y + (cy - prev.y) * t, top, bot));
        }
      } else {
        // Single point: grab the column nearest the cursor
        let bi = 0, bd = Infinity;
        for (let i = 0; i < arr.length; i++) {
          const d = Math.abs(arr[i].pixelX - x);
          if (d < bd) { bd = d; bi = i; }
        }
        setIdx(bi, cy);
      }
      return { ...ex, [editChId]: arr };
    });
  }, [editChId, channels, imgSize.h]);

  const handleSvgDown = (e) => {
    if (calMode || !editChId || step !== "export") return;
    e.preventDefault();
    painting.current = true;
    lastPaint.current = null;
    const { x, y } = svgCoord(e);
    paintStroke(x, y);
  };

  const handleSvgMove = (e) => {
    const c = svgCoord(e);
    if (painting.current) paintStroke(c.x, c.y);
    setHoverPos(c);
  };

  // Stop painting on mouse release, even if it happens outside the SVG
  useEffect(() => {
    const up = () => { painting.current = false; lastPaint.current = null; };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  // ── Extract traces ────────────────────────────────────────────────────────
  const extractTraces = useCallback(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const W = canvas.width, H = canvas.height;

    const result = {};
    channels.forEach(ch => {
      const bandTopPx = ch.bandY * H;
      const bandBotPx = (ch.bandY + ch.bandH) * H;
      const pts = [];

      for (let col = 0; col < W; col += Math.max(1, Math.floor(W / sampleCount))) {
        const row = sampleColumn(imageData, col, bandTopPx, bandBotPx, ch.color, W);
        if (row < 0) continue;
        const value = pixelToValue(row, bandTopPx, bandBotPx, ch);
        pts.push({ x: col, pixelX: col, pixelY: row, value });
      }

      // Median filter removes any remaining single-column spikes
      result[ch.id] = medianFilter(pts, 3);
    });

    setExtracted(result);
    setStep("export");
    showToast("Extraction complete — " + sampleCount + " samples per channel");
  }, [channels, sampleCount]);

  // ── Convert pixel X → distance ────────────────────────────────────────────
  const pixelToDistance = useCallback((px) => {
    if (!xCal.p1 || !xCal.p2 || !xCal.v1 || !xCal.v2) return null;
    const v1 = parseFloat(xCal.v1), v2 = parseFloat(xCal.v2);
    const t = (px - xCal.p1) / (xCal.p2 - xCal.p1);
    return lerp(v1, v2, t);
  }, [xCal]);

  // ── Apply Y calibration ───────────────────────────────────────────────────
  const applyYCal = useCallback((value, ch) => {
    const cal = yCals[ch.id];
    // p1/p2 are pixel Y (0 is a valid coordinate); v1/v2 are user-typed strings.
    if (!cal || cal.p1 == null || cal.p2 == null
        || cal.v1 === undefined || cal.v1 === "" || cal.v2 === undefined || cal.v2 === ""
        || isNaN(parseFloat(cal.v1)) || isNaN(parseFloat(cal.v2))) return value;
    // p1/p2 are pixel Y, v1/v2 are real values
    // pixel Y is inverted (top=small, bot=large typically in the raw extraction)
    const v1 = parseFloat(cal.v1), v2 = parseFloat(cal.v2);
    const bandTopPx = ch.bandY * imgSize.h;
    const bandBotPx = (ch.bandY + ch.bandH) * imgSize.h;
    const pct1 = 1 - (cal.p1 - bandTopPx) / (bandBotPx - bandTopPx);
    const pct2 = 1 - (cal.p2 - bandTopPx) / (bandBotPx - bandTopPx);
    // t = how far this raw value is from v_min
    const rawT = (value - ch.min) / (ch.max - ch.min);
    // Remap through the two calibration anchors
    const slope = (v2 - v1) / (pct2 - pct1 || 0.001);
    return v1 + slope * (rawT - pct1);
  }, [yCals, imgSize]);

  // ── Build export JSON ─────────────────────────────────────────────────────
  const buildExportJson = useCallback(() => {
    if (!extracted) return null;

    // Merge all channel arrays by distance
    const distMap = {};
    channels.forEach(ch => {
      const pts = extracted[ch.id] || [];
      pts.forEach(p => {
        const dist = pixelToDistance(p.pixelX);
        if (dist === null) return;
        const key = Math.round(dist);
        if (!distMap[key]) distMap[key] = { dist: key };
        distMap[key][ch.id] = sanitizeChannelValue(applyYCal(p.value, ch), ch);
      });
    });

    const samples = Object.values(distMap).sort((a, b) => a.dist - b.dist);

    // Two sector-break distances (S1|S2, S2|S3), sorted; null until X is calibrated.
    const sectors = [sectorBreaks.p1, sectorBreaks.p2]
      .map(px => px != null ? pixelToDistance(px) : null)
      .filter(d => d != null)
      .map(d => Math.round(d))
      .sort((a, b) => a - b);

    return {
      meta: {
        driver: driverName || "Reference Driver",
        track: trackName || "Unknown Track",
        session: session,
        tyres: tyres,
        lapTime: parseLapTime(lapTimeStr),
        sectors,
        sectorTimes: sectorTimeStrs.map(parseLapTime),
        exportedAt: new Date().toISOString(),
        sampleCount: samples.length,
        channels: channels.map(c => ({ id: c.id, label: c.label, unit: c.unit, min: c.min, max: c.max })),
        xCalibration: {
          point1: { pixelX: xCal.p1, distanceM: parseFloat(xCal.v1) },
          point2: { pixelX: xCal.p2, distanceM: parseFloat(xCal.v2) },
        },
      },
      samples,
    };
  }, [extracted, channels, pixelToDistance, applyYCal, driverName, trackName, session, tyres, lapTimeStr, sectorBreaks, sectorTimeStrs, xCal]);

  const downloadJson = () => {
    const json = buildExportJson();
    if (!json) return;
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(driverName||"ref").replace(/\s+/g,"_")}_${(trackName||"track").replace(/\s+/g,"_")}_trace.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("JSON downloaded");
  };

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  // ── Calibration point markers ─────────────────────────────────────────────
  const calMarkers = [];
  if (xCal.p1 !== null) calMarkers.push(
    <line key="xp1" x1={xCal.p1} y1={0} x2={xCal.p1} y2={imgSize.h}
      stroke={C.yellow} strokeWidth={1.5} strokeDasharray="6 3" opacity={0.8} />,
    <text key="xp1l" x={xCal.p1 + 4} y={14} fill={C.yellow} fontSize={10} fontFamily={FONT.mono}>
      X1={xCal.v1 || "?"}m
    </text>
  );
  if (xCal.p2 !== null) calMarkers.push(
    <line key="xp2" x1={xCal.p2} y1={0} x2={xCal.p2} y2={imgSize.h}
      stroke={C.yellow} strokeWidth={1.5} strokeDasharray="6 3" opacity={0.8} />,
    <text key="xp2l" x={xCal.p2 + 4} y={24} fill={C.yellow} fontSize={10} fontFamily={FONT.mono}>
      X2={xCal.v2 || "?"}m
    </text>
  );

  // Sector break markers (vertical) — drawn in the export step
  [["p1", "S1|S2"], ["p2", "S2|S3"]].forEach(([key, lbl], i) => {
    const px = sectorBreaks[key];
    if (px == null) return;
    const dist = pixelToDistance(px);
    calMarkers.push(
      <line key={`sec${i}`} x1={px} y1={0} x2={px} y2={imgSize.h}
        stroke={C.cyan} strokeWidth={1.5} strokeDasharray="5 4" opacity={0.85} />,
      <text key={`sec${i}l`} x={px + 4} y={imgSize.h - 6} fill={C.cyan} fontSize={10} fontFamily={FONT.mono}>
        {lbl}{dist != null ? ` ${Math.round(dist)}m` : ""}
      </text>
    );
  });

  // Y cal markers
  Object.entries(yCals).forEach(([chId, cal]) => {
    const ch = channels.find(c => c.id === chId);
    if (!ch) return;
    if (cal.p1 !== undefined) calMarkers.push(
      <line key={`${chId}y1`} x1={0} y1={cal.p1} x2={imgSize.w} y2={cal.p1}
        stroke={ch.color} strokeWidth={1} strokeDasharray="4 3" opacity={0.7} />,
      <text key={`${chId}y1l`} x={imgSize.w - 60} y={cal.p1 - 3}
        fill={ch.color} fontSize={9} fontFamily={FONT.mono}>{ch.label}={cal.v1}</text>
    );
    if (cal.p2 !== undefined) calMarkers.push(
      <line key={`${chId}y2`} x1={0} y1={cal.p2} x2={imgSize.w} y2={cal.p2}
        stroke={ch.color} strokeWidth={1} strokeDasharray="4 3" opacity={0.7} />,
      <text key={`${chId}y2l`} x={imgSize.w - 60} y={cal.p2 - 3}
        fill={ch.color} fontSize={9} fontFamily={FONT.mono}>{ch.label}={cal.v2}</text>
    );
  });

  // ── Cursor style ──────────────────────────────────────────────────────────
  const cursorStyle = (calMode || (editChId && step === "export")) ? "crosshair" : "default";

  // ── Progress steps ────────────────────────────────────────────────────────
  const stepOrder = STEPS;
  const stepIdx = stepOrder.indexOf(step);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: "#fff",
      fontFamily: FONT.ui, display: "flex", flexDirection: "column" }}>

      {/* ── Header ── */}
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.line}`,
        padding: "12px 20px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          {onExit && (
            <button onClick={onExit} title="Back to the Coach"
              style={{ background: C.inset, color: C.textMid, border: `1px solid ${C.borderStrong}`,
                borderRadius: 8, padding: "6px 12px", fontSize: 12, cursor: "pointer",
                fontFamily: FONT.ui, fontWeight: 700, letterSpacing: .3 }}>← Coach</button>
          )}
          <div style={{ width: 5, height: 24, background: C.blue, borderRadius: 3 }} />
          <span style={{ fontSize: 16, fontWeight: 800, letterSpacing: 1.5, textTransform: "uppercase" }}>Trace Calibrator</span>
        </div>
        {/* Step breadcrumb */}
        <div style={{ display: "flex", gap: 2, flex: 1, flexWrap: "wrap" }}>
          {stepOrder.map((s, i) => (
            <div key={s} style={{ display: "flex", alignItems: "center", gap: 2 }}>
              <button onClick={() => imgSrc && setStep(s)} style={{
                background: step === s ? C.elevated : "transparent",
                color: i < stepIdx ? C.green : step === s ? "#fff" : C.textFaint,
                border: `1px solid ${step === s ? C.blue : "transparent"}`,
                borderRadius: 7, padding: "5px 11px", fontSize: 10.5, cursor: imgSrc ? "pointer" : "default",
                fontFamily: FONT.ui, fontWeight: 700, letterSpacing: .5,
              }}>{STEP_LABELS[s]}</button>
              {i < stepOrder.length - 1 && <span style={{ color: C.textFaintest, fontSize: 10 }}>›</span>}
            </div>
          ))}
        </div>
        {/* Calibration mode indicator */}
        {calMode && (
          <div style={{ background: "rgba(255,196,0,0.10)", border: `1px solid ${C.yellow}`, borderRadius: 8,
            padding: "6px 13px", fontSize: 11, color: C.yellow, fontWeight: 600, animation: "pulse 1s infinite" }}>
            ✦ {calMode.type === "color"
                ? `Click the ${calMode.chId} trace to sample its colour`
                : calMode.type === "sector"
                ? `Click on image to set the ${calMode.point === 1 ? "S1|S2" : "S2|S3"} sector break`
                : `Click on image to set ${calMode.type === "x" ? `X point ${calMode.point}` : `${calMode.chId} Y point ${calMode.point}`}`}
            <button onClick={() => setCalMode(null)}
              style={{ marginLeft: 10, background: "none", border: "none", color: C.textDim, cursor: "pointer", fontSize: 12 }}>✕</button>
          </div>
        )}
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* ── Sidebar ── */}
        <div style={{ width: 300, background: C.surface, borderRight: `1px solid ${C.line}`,
          overflowY: "auto", display: "flex", flexDirection: "column", gap: 1, flexShrink: 0 }}>

          {/* Upload */}
          {step === "upload" && (
            <Panel title="Upload Trace Image">
              <label style={{
                display: "block", border: `2px dashed ${C.borderInput}`, borderRadius: 10,
                padding: 24, textAlign: "center", cursor: "pointer", color: C.textMuted,
                background: C.inset, transition: "border-color 0.2s",
              }}
                onMouseOver={e => e.currentTarget.style.borderColor = C.blue}
                onMouseOut={e => e.currentTarget.style.borderColor = C.borderInput}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>📊</div>
                <div style={{ fontSize: 12, marginBottom: 4, color: C.textBody }}>Drop or click to upload</div>
                <div style={{ fontSize: 10, color: C.textDim }}>PNG, JPG — MoTeC or similar</div>
                <input type="file" accept="image/*" onChange={handleFile} style={{ display: "none" }} />
              </label>
              <div style={{ marginTop: 12 }}>
                <SideLabel>Driver name</SideLabel>
                <SideInput value={driverName} onChange={e => setDriverName(e.target.value)} placeholder="e.g. Jarno Opmeer" />
                <SideLabel>Track</SideLabel>
                <SideInput value={trackName} onChange={e => setTrackName(e.target.value)} placeholder="e.g. Melbourne" />
                <SideLabel>Session</SideLabel>
                <SideSelect value={session} onChange={e => setSession(e.target.value)} options={SESSIONS} />
                <SideLabel>Tyres</SideLabel>
                <SideSelect value={tyres} onChange={e => setTyres(e.target.value)} options={TYRES} />
                <SideLabel>Lap time</SideLabel>
                <SideInput value={lapTimeStr} onChange={e => setLapTimeStr(e.target.value)} placeholder="e.g. 1:23.456" />
                {lapTimeStr.trim() && parseLapTime(lapTimeStr) === null && (
                  <div style={{ fontSize: 9, color: C.red, marginTop: 3 }}>Use m:ss.mmm (e.g. 1:23.456)</div>
                )}
              </div>
            </Panel>
          )}

          {/* Bands */}
          {step === "bands" && (
            <Panel title="Channel Bands">
              <p style={{ color: C.textDim, fontSize: 10, lineHeight: 1.6, margin: "0 0 12px" }}>
                Drag the coloured bands on the image to align each channel's region. Top/bottom handles resize, middle drags.
              </p>
              <p style={{ color: C.green, fontSize: 10, lineHeight: 1.6, margin: "0 0 12px" }}>
                ⬩ Click <b>⊹</b> then click that trace on the image to sample its real colour — this is what makes extraction accurate.
              </p>
              {channels.map((ch, i) => (
                <div key={ch.id} style={{ display: "flex", alignItems: "center", gap: 8,
                  padding: "6px 0", borderBottom: `1px solid ${C.line}` }}>
                  <div style={{ width: 10, height: 10, borderRadius: 2, background: ch.color, flexShrink: 0,
                    border: `1px solid ${C.borderStrong}` }} />
                  <span style={{ flex: 1, fontSize: 11, color: C.textBody }}>{ch.label}</span>
                  <span style={{ fontSize: 9, color: C.textFaint, fontFamily: FONT.mono }}>
                    {Math.round(ch.bandY * 100)}%–{Math.round((ch.bandY + ch.bandH) * 100)}%
                  </span>
                  <button
                    title="Sample this trace's colour from the image"
                    onClick={() => setCalMode({ type: "color", chId: ch.id })}
                    style={pickBtn(calMode?.type === "color" && calMode?.chId === ch.id)}>
                    ⊹
                  </button>
                </div>
              ))}
              <NavBtn onClick={() => setStep("xcal")}>Next: X Scale →</NavBtn>
            </Panel>
          )}

          {/* X Calibration */}
          {step === "xcal" && (
            <Panel title="X Axis Calibration">
              <p style={{ color: C.textDim, fontSize: 10, lineHeight: 1.6, margin: "0 0 12px" }}>
                Click two points on the X axis (lap distance) and enter their real-world distances in metres.
              </p>
              {[1, 2].map(pt => (
                <div key={pt} style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%",
                      background: (pt === 1 ? xCal.p1 : xCal.p2) !== null ? C.green : C.borderStrong }} />
                    <span style={{ fontSize: 10, color: C.textMuted }}>Point {pt}</span>
                    <button onClick={() => setCalMode({ type: "x", point: pt })} style={pickBtn(calMode?.point === pt && calMode?.type === "x")}>
                      {(pt === 1 ? xCal.p1 : xCal.p2) !== null ? "✓ Picked" : "Pick"}
                    </button>
                  </div>
                  <SideInput
                    placeholder="Distance in metres (e.g. 0)"
                    value={pt === 1 ? xCal.v1 : xCal.v2}
                    onChange={e => setXCal(c => pt === 1 ? {...c, v1: e.target.value} : {...c, v2: e.target.value})}
                  />
                </div>
              ))}
              <NavBtn onClick={() => setStep("ycal")}>Next: Y Scale →</NavBtn>
            </Panel>
          )}

          {/* Y Calibration */}
          {step === "ycal" && (
            <Panel title="Y Axis Calibration">
              <p style={{ color: C.textDim, fontSize: 10, lineHeight: 1.6, margin: "0 0 12px" }}>
                Optional but recommended. For each channel, pick two known points and enter their values. Skip to use default ranges.
              </p>
              {channels.map(ch => {
                const cal = yCals[ch.id] || {};
                return (
                  <div key={ch.id} style={{ marginBottom: 12, paddingBottom: 10, borderBottom: `1px solid ${C.line}` }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: ch.color }} />
                      <span style={{ fontSize: 11, fontWeight: 600, color: ch.color }}>{ch.label}</span>
                    </div>
                    {[1, 2].map(pt => (
                      <div key={pt} style={{ display: "flex", gap: 4, marginBottom: 4, alignItems: "center" }}>
                        <button onClick={() => setCalMode({ type: "y", chId: ch.id, point: pt })}
                          style={pickBtn(calMode?.chId === ch.id && calMode?.point === pt)}>
                          {(pt === 1 ? cal.p1 : cal.p2) !== undefined ? "✓" : `P${pt}`}
                        </button>
                        <SideInput
                          placeholder={`Value at P${pt} (${ch.unit || "int"})`}
                          value={pt === 1 ? (cal.v1 || "") : (cal.v2 || "")}
                          onChange={e => setYCals(c => ({
                            ...c, [ch.id]: { ...(c[ch.id]||{}), [pt===1?"v1":"v2"]: e.target.value }
                          }))}
                          style={{ flex: 1 }}
                        />
                      </div>
                    ))}
                  </div>
                );
              })}
              <NavBtn onClick={() => { extractTraces(); }}>Extract Traces →</NavBtn>
            </Panel>
          )}

          {/* Export */}
          {step === "export" && extracted && (
            <Panel title="Export">
              <div style={{ marginBottom: 12 }}>
                <SideLabel>Driver name</SideLabel>
                <SideInput value={driverName} onChange={e => setDriverName(e.target.value)} placeholder="e.g. Jarno Opmeer" />
                <SideLabel>Track</SideLabel>
                <SideInput value={trackName} onChange={e => setTrackName(e.target.value)} placeholder="e.g. Melbourne" />
                <SideLabel>Session</SideLabel>
                <SideSelect value={session} onChange={e => setSession(e.target.value)} options={SESSIONS} />
                <SideLabel>Tyres</SideLabel>
                <SideSelect value={tyres} onChange={e => setTyres(e.target.value)} options={TYRES} />
                <SideLabel>Lap time</SideLabel>
                <SideInput value={lapTimeStr} onChange={e => setLapTimeStr(e.target.value)} placeholder="e.g. 1:23.456" />
                {lapTimeStr.trim() && parseLapTime(lapTimeStr) === null && (
                  <div style={{ fontSize: 9, color: C.red, marginTop: 3 }}>Use m:ss.mmm (e.g. 1:23.456)</div>
                )}

                {/* Sector breaks + per-sector times */}
                <SideLabel>Sector breaks</SideLabel>
                <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
                  {[1, 2].map(pt => {
                    const px = pt === 1 ? sectorBreaks.p1 : sectorBreaks.p2;
                    const dist = px != null ? pixelToDistance(px) : null;
                    return (
                      <button key={pt} onClick={() => setCalMode({ type: "sector", point: pt })}
                        style={{ ...pickBtn(calMode?.type === "sector" && calMode?.point === pt), flex: 1 }}>
                        {px != null
                          ? `✓ ${pt === 1 ? "S1|S2" : "S2|S3"}${dist != null ? ` ${Math.round(dist)}m` : ""}`
                          : `Pick ${pt === 1 ? "S1|S2" : "S2|S3"}`}
                      </button>
                    );
                  })}
                </div>
                {sectorBreaks.p1 != null && sectorBreaks.p2 != null
                  && (!xCal.p1 || !xCal.p2 || !xCal.v1 || !xCal.v2) && (
                  <div style={{ fontSize: 9, color: C.red, marginBottom: 4 }}>
                    Calibrate the X axis (step 3) so breaks export as distances.
                  </div>
                )}
                {["S1", "S2", "S3"].map((lbl, i) => (
                  <div key={lbl} style={{ marginTop: 4 }}>
                    <SideLabel>{lbl} time</SideLabel>
                    <SideInput value={sectorTimeStrs[i]} placeholder="e.g. 28.123"
                      onChange={e => setSectorTimeStrs(arr => arr.map((v, j) => j === i ? e.target.value : v))} />
                    {sectorTimeStrs[i].trim() && parseLapTime(sectorTimeStrs[i]) === null && (
                      <div style={{ fontSize: 9, color: C.red, marginTop: 3 }}>Use m:ss.mmm or ss.mmm</div>
                    )}
                  </div>
                ))}

                <SideLabel>Sample count</SideLabel>
                <input type="range" min={50} max={1000} value={sampleCount}
                  onChange={e => setSampleCount(parseInt(e.target.value))}
                  style={{ width: "100%", accentColor: C.blue }} />
                <div style={{ color: C.textDim, fontSize: 10, textAlign: "right", fontFamily: FONT.mono }}>{sampleCount} samples</div>
              </div>

              {/* Summary */}
              <div style={{ background: C.inset, border: `1px solid ${C.line}`, borderRadius: 9, padding: 10, marginBottom: 10 }}>
                {channels.map(ch => {
                  const pts = extracted[ch.id] || [];
                  const vals = pts.map(p => sanitizeChannelValue(applyYCal(p.value, ch), ch)).filter(v => !isNaN(v));
                  const mn = vals.length ? Math.min(...vals).toFixed(1) : "—";
                  const mx = vals.length ? Math.max(...vals).toFixed(1) : "—";
                  return (
                    <div key={ch.id} style={{ display: "flex", gap: 6, marginBottom: 3, fontSize: 10 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: ch.color, marginTop: 1, flexShrink: 0 }} />
                      <span style={{ color: C.textMid, flex: 1 }}>{ch.label}</span>
                      <span style={{ color: C.textDim, fontFamily: FONT.mono }}>{mn}–{mx} {ch.unit}</span>
                      <span style={{ color: C.textFaint, fontFamily: FONT.mono }}>{pts.length}pts</span>
                    </div>
                  );
                })}
              </div>

              {/* Hand-correction */}
              <SideLabel>Correct traces by hand</SideLabel>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
                {channels.map(ch => {
                  const on = editChId === ch.id;
                  return (
                    <button key={ch.id} onClick={() => setEditChId(on ? null : ch.id)}
                      style={{
                        background: on ? C.elevated : C.inset,
                        color: on ? ch.color : C.textMuted,
                        border: `1px solid ${on ? ch.color : C.borderInput}`,
                        borderRadius: 6, padding: "4px 9px", fontSize: 10,
                        cursor: "pointer", fontFamily: FONT.ui, fontWeight: 600,
                      }}>{ch.label}</button>
                  );
                })}
              </div>
              {editChId ? (
                <p style={{ color: C.green, fontSize: 10, lineHeight: 1.5, margin: "0 0 10px" }}>
                  ✎ Click-drag across the <b style={{ color: channels.find(c => c.id === editChId)?.color }}>
                    {channels.find(c => c.id === editChId)?.label}</b> trace on the image to redraw it. Release to stop, then click the channel again to finish.
                </p>
              ) : (
                <p style={{ color: C.textDim, fontSize: 10, lineHeight: 1.5, margin: "0 0 10px" }}>
                  Pick a channel above, then drag over its trace on the image to fix any bad sections.
                </p>
              )}

              <button onClick={downloadJson} style={{
                width: "100%", background: C.green, color: "#04130a", border: "none",
                borderRadius: 9, padding: "11px", fontSize: 12, fontWeight: 800,
                cursor: "pointer", letterSpacing: 1, fontFamily: FONT.ui,
              }}>↓ Download JSON</button>

              <button onClick={() => { extractTraces(); showToast("Re-extracted"); }} style={{
                width: "100%", background: C.inset, color: C.textMid, border: `1px solid ${C.borderStrong}`,
                borderRadius: 9, padding: "9px", fontSize: 11, cursor: "pointer", marginTop: 8,
                fontFamily: FONT.ui, fontWeight: 700,
              }}>↺ Re-extract</button>

              {/* JSON preview */}
              <div style={{ marginTop: 12 }}>
                <SideLabel>JSON Preview (first 3 samples)</SideLabel>
                <pre style={{ background: C.inset, border: `1px solid ${C.line}`, borderRadius: 7,
                  padding: 8, fontSize: 9, color: C.textMuted, overflowX: "auto", maxHeight: 160,
                  margin: 0, fontFamily: FONT.mono }}>
                  {JSON.stringify(buildExportJson()?.samples?.slice(0,3), null, 2)}
                </pre>
              </div>
            </Panel>
          )}
        </div>

        {/* ── Image canvas ── */}
        <div style={{ flex: 1, overflow: "auto", background: C.bg, position: "relative" }}>
          {!imgSrc ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center",
              height: "100%", color: C.textFaintest, fontSize: 13, letterSpacing: 2, fontWeight: 700 }}>
              UPLOAD A TRACE IMAGE TO BEGIN
            </div>
          ) : (
            <div style={{ position: "relative", display: "inline-block", minWidth: "100%" }}>
              <svg
                ref={svgRef}
                width={imgSize.w}
                height={imgSize.h}
                viewBox={`0 0 ${imgSize.w} ${imgSize.h}`}
                style={{
                  display: "block",
                  maxWidth: "100%",
                  cursor: cursorStyle,
                  userSelect: "none",
                }}
                onClick={handleSvgClick}
                onMouseDown={handleSvgDown}
                onMouseMove={handleSvgMove}
                onMouseLeave={() => setHoverPos(null)}
              >
                <image href={imgSrc} x={0} y={0} width={imgSize.w} height={imgSize.h} />

                {/* Band overlays */}
                {(step === "bands" || step === "xcal" || step === "ycal") && (
                  <BandEditor channels={channels} setChannels={setChannels} imgHeight={imgSize.h} />
                )}

                {/* Calibration markers */}
                {calMarkers}

                {/* Extracted curves */}
                {extracted && (
                  <CurveOverlay
                    extracted={extracted}
                    channels={channels}
                    imgHeight={imgSize.h}
                    editChId={step === "export" ? editChId : null}
                  />
                )}

                {/* Crosshair */}
                {hoverPos && extracted && (
                  <Crosshair
                    pos={hoverPos}
                    channels={channels}
                    extracted={extracted}
                    imgWidth={imgSize.w}
                    imgHeight={imgSize.h}
                    applyYCal={applyYCal}
                  />
                )}

                {/* Picking cursor pulse */}
                {calMode && hoverPos && (
                  <circle cx={hoverPos.x} cy={hoverPos.y} r={6}
                    fill="none" stroke={C.yellow} strokeWidth={2} opacity={0.9} />
                )}
              </svg>
            </div>
          )}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div style={{
          position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
          background: C.modal, border: `1px solid ${C.borderStrong}`, borderRadius: 10,
          padding: "10px 20px", fontSize: 12, color: C.green, zIndex: 9999,
          fontFamily: FONT.ui, fontWeight: 700, boxShadow: "0 8px 30px rgba(0,0,0,0.6)",
        }}>{toast}</div>
      )}

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.6} }
        ::-webkit-scrollbar { width:8px; height:8px; background:transparent }
        ::-webkit-scrollbar-thumb { background:#2a3346; border-radius:6px }
      `}</style>
    </div>
  );
}

// ─── SMALL COMPONENTS ─────────────────────────────────────────────────────────

function Panel({ title, children }) {
  return (
    <div style={{ padding: "16px 16px", borderBottom: `1px solid ${C.line}` }}>
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: 2, color: C.textMuted,
        textTransform: "uppercase", marginBottom: 12 }}>{title}</div>
      {children}
    </div>
  );
}

function SideLabel({ children }) {
  return <div style={{ fontSize: 9, color: C.textMuted, letterSpacing: 1, textTransform: "uppercase", marginBottom: 3, marginTop: 8, fontWeight: 600 }}>{children}</div>;
}

function SideInput({ value, onChange, placeholder, style = {} }) {
  return (
    <input value={value} onChange={onChange} placeholder={placeholder}
      style={{
        width: "100%", background: C.inset, border: `1px solid ${C.borderInput}`,
        borderRadius: 8, color: C.textBody, padding: "8px 10px", fontSize: 12,
        fontFamily: FONT.mono, letterSpacing: .5, outline: "none", boxSizing: "border-box", ...style,
      }} />
  );
}

function SideSelect({ value, onChange, options, style = {} }) {
  return (
    <select value={value} onChange={onChange}
      style={{
        width: "100%", background: C.inset, border: `1px solid ${C.borderInput}`,
        borderRadius: 8, color: C.textBody, padding: "8px 10px", fontSize: 12,
        fontFamily: FONT.ui, outline: "none", boxSizing: "border-box", ...style,
      }}>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function NavBtn({ onClick, children }) {
  return (
    <button onClick={onClick} style={{
      width: "100%", marginTop: 14, background: "linear-gradient(135deg,#3671C6,#2a5aa0)", color: "#fff",
      border: `1px solid ${C.blue}`, borderRadius: 9, padding: "11px", fontSize: 12,
      fontWeight: 800, cursor: "pointer", letterSpacing: .5, fontFamily: FONT.ui,
    }}>{children}</button>
  );
}

function pickBtn(active) {
  return {
    background: active ? "rgba(255,196,0,0.12)" : C.inset,
    color: active ? C.yellow : C.textMuted,
    border: `1px solid ${active ? C.yellow : C.borderInput}`,
    borderRadius: 6, padding: "4px 9px", fontSize: 10,
    cursor: "pointer", flexShrink: 0, fontFamily: FONT.ui, fontWeight: 600,
  };
}
