// Watermark Remover - Express API
//
//  POST /api/upload            multipart "video" -> { id, info }
//  GET  /api/frame/:id?t=SEC   JPEG frame at time t
//  POST /api/detect/:id        -> { boxes }
//  POST /api/process/:id       { engine, boxes?, mask?, crf?, preset? } -> { jobId }
//  GET  /api/progress/:jobId   Server-Sent Events: progress / done / error
//  GET  /api/download/:id      processed file
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { ffmpegAvailable, probe, extractFrame, FFMPEG, FFPROBE } from "./ffmpeg.js";
import { detectBoxes } from "./detect.js";
import {
  removeDelogo, removeRemovelogo, removeLama, writeMaskPng,
  buildDelogoFilter, previewFilterFrame, previewLamaFrame,
} from "./removal.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS = path.join(__dirname, "uploads");
const OUTPUTS = path.join(__dirname, "outputs");
fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(OUTPUTS, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (_req, file, cb) =>
      cb(null, crypto.randomUUID() + path.extname(file.originalname || ".mp4")),
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB
});

// in-memory registries
const videos = new Map(); // id -> { src, info, name }
const jobs = new Map();   // jobId -> { status, pct, output, error, listeners:Set }

function sse(job, event, data) {
  job[event === "progress" ? "pct" : "_"] = data?.pct ?? job.pct;
  for (const res of job.listeners) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: ffmpegAvailable(), ffmpeg: FFMPEG, ffprobe: FFPROBE });
});

app.post("/api/upload", upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no file" });
  try {
    const info = probe(req.file.path);
    const id = path.parse(req.file.filename).name;
    videos.set(id, { src: req.file.path, info, name: req.file.originalname });
    res.json({ id, info, name: req.file.originalname });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/frame/:id", (req, res) => {
  const v = videos.get(req.params.id);
  if (!v) return res.status(404).json({ error: "unknown id" });
  try {
    const t = Math.max(0, Number(req.query.t) || 0);
    const jpg = extractFrame(v.src, t);
    res.set("Content-Type", "image/jpeg").send(jpg);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/detect/:id", async (req, res) => {
  const v = videos.get(req.params.id);
  if (!v) return res.status(404).json({ error: "unknown id" });
  try {
    const boxes = await detectBoxes(v.src);
    res.json({ boxes });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Render the chosen engine on a SINGLE frame so the user can judge quality fast.
app.post("/api/preview/:id", async (req, res) => {
  const v = videos.get(req.params.id);
  if (!v) return res.status(404).json({ error: "unknown id" });
  const { engine = "delogo", boxes = [], mask, t = 0, fast = false } = req.body || {};
  try {
    const { width, height } = v.info;
    let jpg;
    if (engine === "delogo") {
      const vf = buildDelogoFilter(boxes, width, height);
      if (!vf) throw new Error("Draw at least one box for a delogo preview.");
      jpg = previewFilterFrame(v.src, t, vf);
    } else {
      if (!mask) throw new Error("Mark the watermark first.");
      const buf = Buffer.from(mask.replace(/^data:image\/\w+;base64,/, ""), "base64");
      const maskPath = path.join(OUTPUTS, crypto.randomUUID() + "_pmask.png");
      await writeMaskPng(buf, width, height, maskPath);
      try {
        if (engine === "lama") jpg = await previewLamaFrame(v.src, t, maskPath, v.info, { fast });
        else jpg = previewFilterFrame(v.src, t, `removelogo=${maskPath.replace(/\\/g, "/")}`);
      } finally {
        fs.rmSync(maskPath, { force: true });
      }
    }
    res.set("Content-Type", "image/jpeg").send(jpg);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/process/:id", async (req, res) => {
  const v = videos.get(req.params.id);
  if (!v) return res.status(404).json({ error: "unknown id" });
  const { engine = "delogo", boxes = [], mask, crf = 18, preset = "medium", fast = false } = req.body || {};

  const jobId = crypto.randomUUID();
  const dst = path.join(OUTPUTS, jobId + ".mp4");
  const baseName = (v.name ? v.name.replace(/\.[^.]+$/, "") : "video").replace(/[\\/:*?"<>|]/g, "_");
  const job = {
    status: "running", pct: 0, output: dst, error: null,
    listeners: new Set(), name: baseName + "_clean.mp4",
  };
  jobs.set(jobId, job);
  res.json({ jobId });

  // ETA from steady-state rate. We anchor on the FIRST progress event (not job
  // start) so one-time costs like the LaMa model load don't inflate the estimate.
  let anchorTs = null, anchorP = 0;
  const onProgress = (p) => {
    const now = Date.now();
    const pct = Math.round(p * 100);
    if (anchorTs === null) { anchorTs = now; anchorP = p; return sse(job, "progress", { pct, eta: null }); }
    let eta = null;
    const dp = p - anchorP;
    if (dp > 0.02) {
      const elapsed = (now - anchorTs) / 1000;
      eta = Math.max(0, Math.round((elapsed / dp) * (1 - p))); // seconds remaining
    }
    sse(job, "progress", { pct, eta });
  };

  (async () => {
    try {
      const { width, height, duration } = v.info;
      if (engine === "removelogo" || engine === "lama") {
        if (!mask) throw new Error(`${engine} requires a mask (brush or boxes).`);
        const buf = Buffer.from(mask.replace(/^data:image\/\w+;base64,/, ""), "base64");
        const maskPath = path.join(OUTPUTS, jobId + "_mask.png");
        await writeMaskPng(buf, width, height, maskPath);
        if (engine === "lama") {
          await removeLama(v.src, dst, maskPath, v.info, { crf, preset, onProgress, fast });
        } else {
          await removeRemovelogo(v.src, dst, maskPath, { crf, preset, duration, onProgress });
        }
      } else {
        if (!boxes.length) throw new Error("delogo requires at least one box.");
        await removeDelogo(v.src, dst, boxes, width, height, { crf, preset, duration, onProgress });
      }
      job.status = "done";
      sse(job, "done", { url: `/api/download/${jobId}`, pct: 100 });
    } catch (e) {
      job.status = "error";
      job.error = String(e.message || e);
      sse(job, "error", { error: job.error });
    } finally {
      for (const r of job.listeners) r.end();
      job.listeners.clear();
    }
  })();
});

app.get("/api/progress/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "unknown job" });
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();
  res.write(`event: progress\ndata: ${JSON.stringify({ pct: job.pct })}\n\n`);
  if (job.status === "done") {
    res.write(`event: done\ndata: ${JSON.stringify({ url: `/api/download/${req.params.jobId}` })}\n\n`);
    return res.end();
  }
  if (job.status === "error") {
    res.write(`event: error\ndata: ${JSON.stringify({ error: job.error })}\n\n`);
    return res.end();
  }
  job.listeners.add(res);
  req.on("close", () => job.listeners.delete(res));
});

app.get("/api/download/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== "done") return res.status(404).json({ error: "not ready" });
  res.download(job.output, job.name || "cleaned.mp4");
});

const PORT = process.env.PORT || 5200;
if (!ffmpegAvailable()) {
  console.error("WARNING: ffmpeg not found. Put a static build in ../bin or on PATH.");
}
app.listen(PORT, () => console.log(`Watermark Remover API on http://localhost:${PORT}`));
