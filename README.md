# Watermark Remover (React + Node)

A local, free, fully-offline watermark/logo remover for video. **React** frontend
for marking the watermark (draw boxes, brush, or auto-detect), **Node/Express**
backend that does the removal with **FFmpeg**. Audio is preserved.

> For your own/internal use. You're responsible for only editing content you have
> the rights to.

```
watermark remover/
├── bin/         bundled FFmpeg (static build, reused — nothing installed system-wide)
├── backend/     Node + Express API (upload, frame preview, auto-detect, ffmpeg removal, SSE progress)
└── frontend/    React + Vite UI (timeline scrub, box/brush marking, live progress, download)
```

## Run it

Both servers at once (from this folder):

```powershell
npm run dev
```

Then open **http://localhost:5173**.

Or run them separately:

```powershell
npm run backend     # API on http://localhost:5200
npm run frontend    # UI  on http://localhost:5173
```

First-time setup (already done here): `npm run install:all`

## How to use

1. **Drop a video** onto the page (or click to choose).
2. Scrub the **timeline** to a frame where the watermark is visible.
3. Mark it:
   - **▭ Box** — drag a rectangle over the watermark (add several if needed).
   - **🖌 Brush** — paint over irregular marks (adjust size).
   - **✨ Auto-detect** — finds static watermarks automatically.
4. Pick an **Engine** and **Quality**, then **Remove watermark →**.
5. Watch the progress bar; the cleaned video appears inline with a **Download** button.

## Engines (both FFmpeg-native)

- **delogo** *(default, fast)* — for rectangular static logos, TV bugs,
  timestamps. Re-encodes video, copies audio losslessly, runs many× faster than
  real-time. Near-perfect on small/corner watermarks.
- **removelogo** — uses a bitmap mask from your **brush** strokes (and boxes),
  for irregular shapes.
- **LaMa AI** *(best quality, slower)* — a deep-learning inpainter that fills the
  hole with *believable texture* instead of a blur. Runs on CPU (no GPU needed)
  via a small Python worker; to stay fast it only processes the watermark region.
  Use this when delogo/removelogo leave a visible smudge over detailed backgrounds.

**Quality note:** delogo/removelogo fill the marked area by interpolating from its
edges — excellent for small logos, but they **blur** over detailed backgrounds
because they can't invent hidden content. **LaMa** reconstructs plausible detail
and is the right choice there.

### Enabling LaMa

```powershell
# torch (CPU build) + the LaMa package (installed without its over-strict
# numpy<2 pin, since we use numpy 2.x):
python -m pip install --user torch fire
python -m pip install --user --no-deps simple-lama-inpainting
```

The model (~200 MB) downloads automatically on first use. The backend finds
Python via the `python` command (override with the `PYTHON` env var).

## How auto-detect works

A baked-in watermark sits on the same pixels every frame, so its edges are
*temporally stationary* while real scene content moves. The backend samples
frames (downscaled, grayscale, via FFmpeg), measures how often a strong edge
appears at each pixel ("edge persistence"), keeps the consistently-edged pixels,
and turns the blobs into boxes. Best for static, fairly opaque watermarks; mark
moving/animated ones manually.

## API (if you want to script it)

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/api/upload` | multipart `video` → `{ id, info }` |
| GET  | `/api/frame/:id?t=SEC` | JPEG frame at time t |
| POST | `/api/detect/:id` | → `{ boxes }` |
| POST | `/api/process/:id` | `{ engine, boxes?, mask?, crf?, preset? }` → `{ jobId }` |
| GET  | `/api/progress/:jobId` | Server-Sent Events: `progress` / `done` / `error` |
| GET  | `/api/download/:jobId` | the cleaned MP4 |

Uploads/outputs live in `backend/uploads` and `backend/outputs` (git-ignored).

## Requirements

- Node 18+ (tested on v20)
- FFmpeg — bundled in `./bin`. If missing, drop a static build there or put
  `ffmpeg`/`ffprobe` on your PATH.
