// Removal engines, both ffmpeg-native:
//   delogo     - rectangular boxes, fast, best for solid logos/bugs/timestamps
//   removelogo - arbitrary bitmap mask (white = remove), for brushed/irregular marks
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { run, parseTime, FFMPEG } from "./ffmpeg.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function buildDelogoFilter(boxes, width, height) {
  const parts = [];
  for (const box of boxes) {
    let x = Math.max(1, Math.round(box.x));
    let y = Math.max(1, Math.round(box.y));
    let w = Math.round(box.w);
    let h = Math.round(box.h);
    if (x + w >= width) w = width - x - 1;
    if (y + h >= height) h = height - y - 1;
    if (w <= 0 || h <= 0) continue;
    parts.push(`delogo=x=${x}:y=${y}:w=${w}:h=${h}`);
  }
  return parts.join(",");
}

export async function removeDelogo(src, dst, boxes, width, height, opts = {}) {
  const { crf = 18, preset = "medium", duration = 0, onProgress } = opts;
  const vf = buildDelogoFilter(boxes, width, height);
  if (!vf) throw new Error("No valid boxes for delogo.");
  const args = [
    "-y", "-i", src,
    "-vf", vf,
    "-c:v", "libx264", "-crf", String(crf), "-preset", preset,
    "-pix_fmt", "yuv420p", "-c:a", "copy",
    dst,
  ];
  const code = await run(args, (line) => {
    if (onProgress && duration) {
      const t = parseTime(line);
      if (t != null) onProgress(Math.min(1, t / duration));
    }
  });
  if (code !== 0) throw new Error(`ffmpeg delogo failed (exit ${code}).`);
}

// Save a normalized black/white mask PNG (white = remove) at the video size.
export async function writeMaskPng(maskBuffer, width, height, outPath) {
  await sharp(maskBuffer)
    .resize(width, height, { fit: "fill", kernel: "nearest" })
    .greyscale()
    .threshold(80) // binarize: anything reasonably bright -> white
    .png()
    .toFile(outPath);
}

// --------------------------------------------------------------------------- //
//  Single-frame previews                                                        //
// --------------------------------------------------------------------------- //

// Render one frame (at time t) through an ffmpeg video filter -> JPEG Buffer.
export function previewFilterFrame(src, t, vf) {
  const r = spawnSync(
    FFMPEG,
    ["-ss", String(t), "-i", src, "-vf", vf, "-frames:v", "1",
     "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"],
    { maxBuffer: 1 << 26 }
  );
  if (r.status !== 0) throw new Error("preview failed: " + (r.stderr || r.error));
  return r.stdout;
}

const LAMA_DISABLED_MSG =
  "The AI (LaMa) engine isn't available in this deployment. Use delogo or removelogo.";

// Single-frame LaMa preview via the Python worker -> JPEG Buffer.
export function previewLamaFrame(src, t, maskPath, info, opts = {}) {
  if (process.env.DISABLE_LAMA) throw new Error(LAMA_DISABLED_MSG);
  const py = process.env.PYTHON || "python";
  const worker = path.join(__dirname, "lama_preview.py");
  return new Promise((resolve, reject) => {
    const p = spawn(py, [
      worker, "--src", src, "--t", String(t), "--mask", maskPath,
      "--ffmpeg", FFMPEG, "--width", String(info.width), "--height", String(info.height),
      ...(opts.fast ? ["--maxside", "512"] : []),
    ]);
    const chunks = [];
    let err = "";
    p.stdout.on("data", (d) => chunks.push(d));
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new Error("LaMa preview failed: " + err.slice(-300)))
    );
  });
}

// AI inpainting via the Python LaMa worker. Much better fill than delogo on
// detailed backgrounds. Needs: pip install simple-lama-inpainting torch
export function removeLama(src, dst, maskPath, info, opts = {}) {
  if (process.env.DISABLE_LAMA) throw new Error(LAMA_DISABLED_MSG);
  const { crf = 18, preset = "medium", onProgress, fast = false } = opts;
  const py = process.env.PYTHON || "python";
  const worker = path.join(__dirname, "lama_worker.py");
  const args = [
    worker,
    "--src", src, "--dst", dst, "--mask", maskPath,
    "--ffmpeg", FFMPEG,
    "--width", String(info.width), "--height", String(info.height),
    "--fps", String(info.fps || 25), "--total", String(info.nframes || 0),
    "--crf", String(crf), "--preset", preset,
    ...(fast ? ["--maxside", "512"] : []),
  ];
  return new Promise((resolve, reject) => {
    const p = spawn(py, args);
    let errTail = "";
    let buf = "";
    const handle = (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        if (line.startsWith("PROGRESS")) {
          const m = line.match(/PROGRESS\s+(\d+)\/(\d+)/);
          if (m && onProgress) {
            const done = Number(m[1]), total = Number(m[2]);
            if (total > 0) onProgress(Math.min(1, done / total));
          }
        } else if (line.startsWith("ERROR")) {
          errTail = line;
        }
      }
    };
    p.stdout.on("data", handle);
    p.stderr.on("data", (d) => { errTail = d.toString().slice(-500); });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`LaMa worker failed (exit ${code}). ${errTail}`));
    });
  });
}

export async function removeRemovelogo(src, dst, maskPath, opts = {}) {
  const { crf = 18, preset = "medium", duration = 0, onProgress } = opts;
  const args = [
    "-y", "-i", src,
    "-vf", `removelogo=${maskPath.replace(/\\/g, "/")}`,
    "-c:v", "libx264", "-crf", String(crf), "-preset", preset,
    "-pix_fmt", "yuv420p", "-c:a", "copy",
    dst,
  ];
  const code = await run(args, (line) => {
    if (onProgress && duration) {
      const t = parseTime(line);
      if (t != null) onProgress(Math.min(1, t / duration));
    }
  });
  if (code !== 0) throw new Error(`ffmpeg removelogo failed (exit ${code}).`);
}
