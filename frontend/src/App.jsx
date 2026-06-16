import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "./api.js";

const MAX_DISP_W = 960;

function fmtEta(s) {
  if (s == null) return "";
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

export default function App() {
  const [video, setVideo] = useState(null);   // { id, info, name }
  const [busy, setBusy] = useState("");        // status text
  const [error, setError] = useState("");
  const [t, setT] = useState(0);               // current time (s)
  const [tool, setTool] = useState("box");     // 'box' | 'brush'
  const [brushSize, setBrushSize] = useState(24);
  const [engine, setEngine] = useState("lama");
  const [crf, setCrf] = useState(18);
  const [boxes, setBoxes] = useState([]);      // video-space {x,y,w,h}
  const [pct, setPct] = useState(0);
  const [resultUrl, setResultUrl] = useState("");
  const [over, setOver] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [fast, setFast] = useState(true);
  const [eta, setEta] = useState(null);
  const [lamaAvailable, setLamaAvailable] = useState(true);

  const imgRef = useRef(null);
  const overlayRef = useRef(null);
  const maskRef = useRef(null);                // offscreen, video-res brush mask
  const drag = useRef(null);                   // {x0,y0,x1,y1} display-space rect
  const painting = useRef(false);

  const info = video?.info;
  const dispW = info ? Math.min(info.width, MAX_DISP_W) : 0;
  const dispH = info ? Math.round(dispW * (info.height / info.width)) : 0;
  const s = info ? info.width / dispW : 1; // display -> video scale

  // ---- backend capabilities: hide the LaMa engine where it isn't available ----
  useEffect(() => {
    fetch(apiUrl("/api/health"))
      .then((r) => r.json())
      .then((h) => {
        const ok = !!h.lama;
        setLamaAvailable(ok);
        if (!ok) setEngine((e) => (e === "lama" ? "removelogo" : e));
      })
      .catch(() => {}); // keep defaults if health is unreachable
  }, []);

  // ---- upload ----
  async function handleFile(file) {
    if (!file) return;
    setError(""); setResultUrl(""); setBoxes([]); setPct(0);
    setBusy("Uploading & probing…");
    const fd = new FormData();
    fd.append("video", file);
    try {
      const r = await fetch(apiUrl("/api/upload"), { method: "POST", body: fd });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "upload failed");
      setVideo(data);
      setT(0);
      // reset mask canvas to video resolution
      const m = maskRef.current;
      m.width = data.info.width; m.height = data.info.height;
      m.getContext("2d").clearRect(0, 0, m.width, m.height);
      setBusy("");
    } catch (e) {
      setError(String(e.message || e)); setBusy("");
    }
  }

  // ---- frame loading on seek (clears any stale preview) ----
  useEffect(() => {
    if (!video) return;
    imgRef.current.src = apiUrl(`/api/frame/${video.id}?t=${t.toFixed(3)}`);
    setPreviewUrl((u) => { if (u) URL.revokeObjectURL(u); return ""; });
  }, [video, t]);

  // ---- overlay redraw ----
  const redraw = useCallback(() => {
    const cv = overlayRef.current;
    if (!cv || !info) return;
    cv.width = dispW; cv.height = dispH;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, dispW, dispH);

    // brush mask -> red tint
    const m = maskRef.current;
    const tint = document.createElement("canvas");
    tint.width = dispW; tint.height = dispH;
    const tctx = tint.getContext("2d");
    tctx.drawImage(m, 0, 0, dispW, dispH);
    tctx.globalCompositeOperation = "source-in";
    tctx.fillStyle = "rgba(255,40,60,0.55)";
    tctx.fillRect(0, 0, dispW, dispH);
    ctx.drawImage(tint, 0, 0);

    // boxes (filled translucent + outline)
    ctx.lineWidth = 2;
    for (const b of boxes) {
      const x = b.x / s, y = b.y / s, w = b.w / s, h = b.h / s;
      ctx.fillStyle = "rgba(24,182,255,0.25)";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "#18b6ff";
      ctx.strokeRect(x, y, w, h);
    }
    // in-progress box
    if (drag.current && tool === "box") {
      const { x0, y0, x1, y1 } = drag.current;
      ctx.setLineDash([5, 3]);
      ctx.strokeStyle = "#00e0ad";
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.setLineDash([]);
    }
  }, [boxes, info, dispW, dispH, s, tool]);

  useEffect(() => { redraw(); }, [redraw]);

  // ---- pointer helpers ----
  function ptr(e) {
    const r = overlayRef.current.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * dispW,
      y: ((e.clientY - r.top) / r.height) * dispH,
    };
  }
  function paintAt(p) {
    const m = maskRef.current;
    const ctx = m.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(p.x * s, p.y * s, brushSize * s, 0, Math.PI * 2);
    ctx.fill();
    redraw();
  }
  function onDown(e) {
    if (!info) return;
    const p = ptr(e);
    if (tool === "brush") { painting.current = true; paintAt(p); }
    else { drag.current = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }; }
  }
  function onMove(e) {
    if (!info) return;
    const p = ptr(e);
    if (tool === "brush" && painting.current) paintAt(p);
    else if (tool === "box" && drag.current) { drag.current.x1 = p.x; drag.current.y1 = p.y; redraw(); }
  }
  function onUp() {
    if (tool === "box" && drag.current) {
      const { x0, y0, x1, y1 } = drag.current;
      const x = Math.min(x0, x1) * s, y = Math.min(y0, y1) * s;
      const w = Math.abs(x1 - x0) * s, h = Math.abs(y1 - y0) * s;
      if (w > 6 && h > 6) setBoxes((b) => [...b, { x, y, w, h }]);
      drag.current = null; redraw();
    }
    painting.current = false;
  }

  function clearMarks() {
    setBoxes([]);
    const m = maskRef.current;
    m.getContext("2d").clearRect(0, 0, m.width, m.height);
    redraw();
  }

  async function autoDetect() {
    if (!video) return;
    setError(""); setBusy("Auto-detecting static watermark…");
    try {
      const r = await fetch(apiUrl(`/api/detect/${video.id}`), { method: "POST" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "detect failed");
      setBoxes((b) => [...b, ...data.boxes]);
      setEngine("delogo");
      setBusy(`Found ${data.boxes.length} region(s).`);
    } catch (e) { setError(String(e.message || e)); setBusy(""); }
  }

  // combine boxes + brush into one mask PNG (for removelogo)
  function buildMaskDataUrl() {
    const m = maskRef.current;
    const c = document.createElement("canvas");
    c.width = m.width; c.height = m.height;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(m, 0, 0);
    ctx.fillStyle = "#fff";
    for (const b of boxes) ctx.fillRect(b.x, b.y, b.w, b.h);
    return c.toDataURL("image/png");
  }

  function maskHasContent() {
    const m = maskRef.current;
    const d = m.getContext("2d").getImageData(0, 0, m.width, m.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
    return false;
  }

  async function previewFrame() {
    if (!video) return;
    setError("");
    const body = { engine, t, fast };
    if (engine === "delogo") {
      if (!boxes.length) { setError("Draw a box (or use Auto-detect) for a delogo preview."); return; }
      body.boxes = boxes;
    } else {
      if (!boxes.length && !maskHasContent()) { setError("Mark the watermark first (box or brush)."); return; }
      body.mask = buildMaskDataUrl();
    }
    setPreviewing(true);
    setBusy(engine === "lama" ? "Rendering LaMa preview… (a few seconds)" : "Rendering preview…");
    try {
      const r = await fetch(apiUrl(`/api/preview/${video.id}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || "preview failed"); }
      const blob = await r.blob();
      setPreviewUrl((u) => { if (u) URL.revokeObjectURL(u); return URL.createObjectURL(blob); });
      setBusy("Preview ready (this frame). Looks good? Hit Remove watermark.");
    } catch (e) { setError(String(e.message || e)); setBusy(""); }
    finally { setPreviewing(false); }
  }

  function triggerDownload(url) {
    const a = document.createElement("a");
    a.href = url;
    a.download = (video?.name ? video.name.replace(/\.[^.]+$/, "") : "video") + "_clean.mp4";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function process() {
    if (!video) return;
    setError(""); setResultUrl(""); setPct(0); setEta(null);
    const body = { engine, crf, fast };
    if (engine === "delogo") {
      if (!boxes.length) { setError("delogo needs at least one box. Draw a box or use Auto-detect."); return; }
      body.boxes = boxes;
    } else {
      if (!boxes.length && !maskHasContent()) { setError("Brush over the watermark (or add boxes) first."); return; }
      body.mask = buildMaskDataUrl();
    }
    setBusy("Processing…");
    try {
      const r = await fetch(apiUrl(`/api/process/${video.id}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "process failed");
      const es = new EventSource(apiUrl(`/api/progress/${data.jobId}`));
      es.addEventListener("progress", (ev) => {
        const d = JSON.parse(ev.data);
        setPct(d.pct || 0);
        if (d.eta != null) setEta(d.eta);
      });
      es.addEventListener("done", (ev) => {
        const url = apiUrl(JSON.parse(ev.data).url);
        setPct(100); setEta(null); setBusy("Done — downloaded. Marks cleared for the next clip.");
        setResultUrl(url);
        triggerDownload(url);
        es.close();
        clearMarks();
        setPreviewUrl((u) => { if (u) URL.revokeObjectURL(u); return ""; });
      });
      es.addEventListener("error", (ev) => {
        try { setError(JSON.parse(ev.data).error); } catch { setError("processing error"); }
        setBusy(""); es.close();
      });
    } catch (e) { setError(String(e.message || e)); setBusy(""); }
  }

  // ---- render ----
  return (
    <div className="app">
      <h1>Watermark Remover</h1>
      <div className="sub">Local · free · ffmpeg-powered. Mark the watermark, then remove it across the whole clip.</div>

      {!video && (
        <label
          className={"drop" + (over ? " over" : "")}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); handleFile(e.dataTransfer.files[0]); }}
        >
          <input type="file" accept="video/*" hidden onChange={(e) => handleFile(e.target.files[0])} />
          <div style={{ fontSize: 18, marginBottom: 6 }}>Drop a video here, or click to choose</div>
          <div>mp4 · mov · mkv · avi · webm</div>
        </label>
      )}

      {video && (
        <>
          <div className="panel">
            <div className="row">
              <span className="tag">{video.name}</span>
              <span className="meta">{info.width}×{info.height} · {info.fps.toFixed(2)} fps · {info.duration.toFixed(1)}s</span>
              <div className="spacer" />
              <button className="ghost" onClick={() => { setVideo(null); setResultUrl(""); }}>Change video</button>
            </div>
          </div>

          <div className="panel">
            <div className="row" style={{ marginBottom: 12 }}>
              <button className={tool === "box" ? "active" : ""} onClick={() => setTool("box")}>▭ Box</button>
              <button className={tool === "brush" ? "active" : ""} onClick={() => setTool("brush")}>🖌 Brush</button>
              {tool === "brush" && (
                <label className="field">size
                  <input type="range" min="6" max="80" value={brushSize} onChange={(e) => setBrushSize(+e.target.value)} />
                </label>
              )}
              <button onClick={autoDetect}>✨ Auto-detect</button>
              <button className="ghost" onClick={clearMarks}>Clear</button>
              <div className="spacer" />
              <label className="field">Engine
                <select value={engine} onChange={(e) => setEngine(e.target.value)}>
                  {lamaAvailable && <option value="lama">LaMa AI — best, real fill (slower)</option>}
                  <option value="removelogo">removelogo (mask)</option>
                  <option value="delogo">delogo — fast but BLURS</option>
                </select>
              </label>
              <label className="field">Quality
                <select value={crf} onChange={(e) => setCrf(+e.target.value)}>
                  <option value={16}>High (16)</option>
                  <option value={18}>Good (18)</option>
                  <option value={23}>Smaller (23)</option>
                </select>
              </label>
              {engine === "lama" && (
                <label className="field" title="Run the AI on a downscaled patch for big masks — much faster, slight quality trade-off. No effect on small/tight masks.">
                  <input type="checkbox" checked={fast} onChange={(e) => setFast(e.target.checked)} />
                  ⚡ Fast
                </label>
              )}
            </div>

            {engine === "delogo" && (
              <div className="hint warn" style={{ marginBottom: 10 }}>
                ⚠ delogo just smears the box — it blurs detailed areas. For a real, sharp fill
                switch Engine to <b>LaMa AI</b>. Tip: mark a <b>tight</b> region around only the
                watermark, then hit <b>Preview frame</b> first.
              </div>
            )}
            {engine === "lama" && (
              <div className="hint" style={{ marginBottom: 10 }}>
                💡 LaMa fills with real-looking texture. Keep the mark <b>tight</b> around the
                watermark for the best (and fastest) result — use <b>Preview frame</b> to check.
              </div>
            )}

            <div className="stage" style={{ width: dispW, height: dispH, position: "relative" }}>
              <img ref={imgRef} alt="frame" draggable={false} />
              <canvas
                ref={overlayRef}
                className="overlay"
                style={{ width: dispW, height: dispH }}
                onMouseDown={onDown}
                onMouseMove={onMove}
                onMouseUp={onUp}
                onMouseLeave={onUp}
              />
              {previewUrl && (
                <>
                  <img className="previewImg" src={previewUrl} alt="preview"
                       style={{ position: "absolute", inset: 0, width: dispW, height: dispH, zIndex: 5 }} />
                  <span className="previewBadge">PREVIEW · this frame</span>
                  <button className="previewClose" onClick={() =>
                    setPreviewUrl((u) => { if (u) URL.revokeObjectURL(u); return ""; })}>✕</button>
                </>
              )}
            </div>

            <input
              className="timeline"
              type="range"
              min="0" max={info.duration} step="0.05"
              value={t}
              onChange={(e) => setT(+e.target.value)}
            />
            <div className="row">
              <span className="meta">t = {t.toFixed(2)}s · {boxes.length} box(es){tool === "brush" ? " · brushing" : ""}</span>
              <div className="spacer" />
              <button onClick={previewFrame} disabled={previewing}>👁 {previewing ? "Rendering…" : "Preview frame"}</button>
              <button className="primary" onClick={process} disabled={busy === "Processing…"}>Remove watermark →</button>
            </div>
          </div>

          {(busy || pct > 0) && (
            <div className="panel">
              <div className="row" style={{ marginBottom: 8 }}>
                <span className="meta">{busy || "Working…"}</span>
                <div className="spacer" />
                <span className="meta">
                  {pct}%{eta != null && pct < 100 ? ` · ~${fmtEta(eta)} left` : ""}
                </span>
              </div>
              <div className="bar"><i style={{ width: `${pct}%` }} /></div>
            </div>
          )}

          {resultUrl && (
            <div className="panel">
              <div className="row" style={{ marginBottom: 10 }}>
                <strong>Result</strong>
                <span className="tag">✓ downloaded</span>
                <div className="spacer" />
                <button onClick={() => triggerDownload(resultUrl)}>⬇ Download again</button>
              </div>
              <video src={resultUrl} controls />
            </div>
          )}
        </>
      )}

      {error && <div className="panel"><span className="err">⚠ {error}</span></div>}

      {/* offscreen brush mask at full video resolution */}
      <canvas ref={maskRef} style={{ display: "none" }} />
    </div>
  );
}
