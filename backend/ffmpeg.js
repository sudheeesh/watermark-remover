// ffmpeg / ffprobe discovery + thin wrappers.
// Prefers the bundled static build in ../bin, falls back to PATH.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, "..", "bin");

function findRecursive(dir, name) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findRecursive(p, name);
      if (hit) return hit;
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return p;
    }
  }
  return null;
}

const exe = (n) => (process.platform === "win32" ? `${n}.exe` : n);

export const FFMPEG = findRecursive(BIN, exe("ffmpeg")) || "ffmpeg";
export const FFPROBE = findRecursive(BIN, exe("ffprobe")) || "ffprobe";

export function ffmpegAvailable() {
  const r = spawnSync(FFMPEG, ["-version"], { encoding: "utf8" });
  return r.status === 0;
}

// Probe basic video info.
export function probe(file) {
  const args = [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,r_frame_rate,nb_frames,duration",
    "-show_entries", "format=duration",
    "-of", "json", file,
  ];
  const r = spawnSync(FFPROBE, args, { encoding: "utf8", maxBuffer: 1 << 24 });
  if (r.status !== 0) throw new Error("ffprobe failed: " + (r.stderr || r.error));
  const data = JSON.parse(r.stdout);
  const s = (data.streams && data.streams[0]) || {};
  const fmt = data.format || {};
  const [num, den] = (s.r_frame_rate || "0/1").split("/");
  const fps = Number(den) ? Number(num) / Number(den) : 0;
  const duration = Number(s.duration || fmt.duration || 0);
  let nframes = Number(s.nb_frames);
  if (!Number.isFinite(nframes) || nframes <= 0) nframes = Math.round(fps * duration);
  return {
    width: Number(s.width || 0),
    height: Number(s.height || 0),
    fps,
    duration,
    nframes,
  };
}

// Extract a single JPEG frame at time `t` (seconds). Returns a Buffer.
export function extractFrame(file, t = 0, quality = 3) {
  const args = [
    "-ss", String(t), "-i", file,
    "-frames:v", "1", "-q:v", String(quality),
    "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
  ];
  const r = spawnSync(FFMPEG, args, { maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error("frame extract failed: " + r.stderr);
  return r.stdout;
}

// Run ffmpeg, streaming stderr lines to onLine. Returns a Promise<exitCode>.
export function run(args, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args);
    let buf = "";
    p.stderr.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0 || (i = buf.indexOf("\r")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (onLine && line.trim()) onLine(line.trim());
      }
    });
    p.on("error", reject);
    p.on("close", (code) => resolve(code));
  });
}

// Parse "time=00:00:03.45" from an ffmpeg progress line into seconds.
export function parseTime(line) {
  const m = line.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
