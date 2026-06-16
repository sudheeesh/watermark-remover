// Automatic static-watermark detection (Node port of the edge-persistence idea).
//
// A baked-in watermark sits on the same pixels every frame, so its edges are
// temporally stationary while real scene content moves. We sample frames
// (downscaled + grayscale via ffmpeg), build a per-pixel "edge persistence"
// map, keep the consistently-edged pixels, and turn the blobs into boxes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { FFMPEG, probe } from "./ffmpeg.js";

const DETECT_W = 384; // analyze at this width (boxes scaled back to full res)

function sampleFrames(file, info, maxFrames = 60) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-detect-"));
  const dur = info.duration || info.nframes / (info.fps || 25) || 1;
  let fps = maxFrames / Math.max(dur, 0.1);
  fps = Math.min(fps, info.fps || 30);
  const scale = DETECT_W / info.width;
  const args = [
    "-i", file,
    "-vf", `fps=${fps.toFixed(3)},scale=${DETECT_W}:-2,format=gray`,
    "-frames:v", String(maxFrames),
    path.join(dir, "f-%04d.png"),
  ];
  const r = spawnSync(FFMPEG, args, { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error("frame sampling failed: " + r.stderr);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".png")).map((f) => path.join(dir, f));
  return { dir, files, scale };
}

function quantile(arr, q) {
  const a = Float32Array.from(arr).sort();
  const i = Math.min(a.length - 1, Math.max(0, Math.floor(q * a.length)));
  return a[i];
}

async function edgePersistence(files, edgeQuantile = 0.9) {
  let acc = null, W = 0, H = 0, used = 0;
  for (const f of files) {
    const { data, info } = await sharp(f).greyscale().raw().toBuffer({ resolveWithObject: true });
    W = info.width; H = info.height;
    const ch = info.channels;
    // single-channel grayscale view
    const g = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) g[i] = data[i * ch];

    const mag = new Float32Array(W * H);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const o = y * W + x;
        const tl = g[o - W - 1], t = g[o - W], tr = g[o - W + 1];
        const l = g[o - 1], rr = g[o + 1];
        const bl = g[o + W - 1], b = g[o + W], br = g[o + W + 1];
        const gx = (tr + 2 * rr + br) - (tl + 2 * l + bl);
        const gy = (bl + 2 * b + br) - (tl + 2 * t + tr);
        mag[o] = Math.hypot(gx, gy);
      }
    }
    const thr = Math.max(quantile(mag, edgeQuantile), 1e-3);
    if (!acc) acc = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) if (mag[i] >= thr) acc[i] += 1;
    used++;
  }
  if (!used) throw new Error("no frames read for detection");
  for (let i = 0; i < acc.length; i++) acc[i] /= used;
  return { pmap: acc, W, H };
}

// 3x3 binary dilation, `iter` times.
function dilate(mask, W, H, iter = 2) {
  let cur = mask;
  for (let k = 0; k < iter; k++) {
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let v = 0;
        for (let dy = -1; dy <= 1 && !v; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ny = y + dy, nx = x + dx;
            if (ny >= 0 && ny < H && nx >= 0 && nx < W && cur[ny * W + nx]) { v = 1; break; }
          }
        }
        out[y * W + x] = v;
      }
    }
    cur = out;
  }
  return cur;
}

// Connected-components (4-neighbour BFS) -> bounding boxes.
function components(mask, W, H) {
  const seen = new Uint8Array(W * H);
  const boxes = [];
  const stack = [];
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || seen[i]) continue;
    let minX = W, minY = H, maxX = 0, maxY = 0;
    stack.length = 0; stack.push(i); seen[i] = 1;
    while (stack.length) {
      const p = stack.pop();
      const x = p % W, y = (p / W) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      const nb = [p - 1, p + 1, p - W, p + W];
      const nx = [x - 1, x + 1, x, x], ny = [y, y, y - 1, y + 1];
      for (let k = 0; k < 4; k++) {
        if (nx[k] < 0 || nx[k] >= W || ny[k] < 0 || ny[k] >= H) continue;
        const q = nb[k];
        if (mask[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
    }
    boxes.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
  }
  return boxes;
}

export async function detectBoxes(file, opts = {}) {
  const { persistence = 0.85, minAreaFrac = 0.0002, maxAreaFrac = 0.25, pad = 6, maxFrames = 60 } = opts;
  const info = probe(file);
  const { dir, files, scale } = sampleFrames(file, info, maxFrames);
  try {
    const { pmap, W, H } = await edgePersistence(files);
    let mask = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) mask[i] = pmap[i] >= persistence ? 1 : 0;
    mask = dilate(mask, W, H, 2);

    const frameArea = W * H;
    const padS = Math.max(1, Math.round(pad * scale)); // pad already in full-res terms -> back to small
    const raw = components(mask, W, H)
      .filter((b) => {
        const a = b.w * b.h;
        return a >= minAreaFrac * frameArea && a <= maxAreaFrac * frameArea;
      })
      .map((b) => {
        // pad in small space, then scale up to full resolution
        const x0 = Math.max(0, b.x - padS), y0 = Math.max(0, b.y - padS);
        const x1 = Math.min(W, b.x + b.w + padS), y1 = Math.min(H, b.y + b.h + padS);
        const s = 1 / scale;
        return {
          x: Math.round(x0 * s),
          y: Math.round(y0 * s),
          w: Math.round((x1 - x0) * s),
          h: Math.round((y1 - y0) * s),
        };
      });
    raw.sort((a, b) => b.w * b.h - a.w * a.h);
    return raw;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
