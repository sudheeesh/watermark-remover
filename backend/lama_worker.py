"""LaMa AI inpainting worker (called by the Node backend for engine="lama").

Streams frames through ffmpeg, inpaints the masked region of each frame with the
LaMa model, and re-encodes (muxing the original audio back). To stay fast on CPU
it crops to the mask's bounding box (+ context margin) and only runs the model on
that patch, then pastes it back.

Usage:
  python lama_worker.py --src in.mp4 --dst out.mp4 --mask mask.png \
      --ffmpeg /path/ffmpeg --width W --height H --fps FPS --total N \
      [--crf 18] [--preset medium]

Progress is printed to stdout as `PROGRESS done/total` lines for the parent.
"""
import argparse
import sys
import subprocess
import numpy as np
import cv2
from PIL import Image


def log(msg):
    print(msg, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--dst", required=True)
    ap.add_argument("--mask", required=True)
    ap.add_argument("--ffmpeg", required=True)
    ap.add_argument("--width", type=int, required=True)
    ap.add_argument("--height", type=int, required=True)
    ap.add_argument("--fps", type=float, required=True)
    ap.add_argument("--total", type=int, default=0)
    ap.add_argument("--crf", type=int, default=18)
    ap.add_argument("--preset", default="medium")
    ap.add_argument("--margin", type=int, default=64)
    ap.add_argument("--maxside", type=int, default=0)  # >0 = fast mode: infer at this max side
    args = ap.parse_args()

    W, H = args.width, args.height

    # mask: white = remove
    mask_full = cv2.imread(args.mask, cv2.IMREAD_GRAYSCALE)
    if mask_full is None:
        log("ERROR mask not readable")
        sys.exit(2)
    if mask_full.shape[:2] != (H, W):
        mask_full = cv2.resize(mask_full, (W, H), interpolation=cv2.INTER_NEAREST)
    mask_full = (mask_full > 127).astype(np.uint8) * 255

    ys, xs = np.where(mask_full > 0)
    if len(xs) == 0:
        log("ERROR empty mask")
        sys.exit(2)
    m = args.margin
    x0 = max(0, int(xs.min()) - m); y0 = max(0, int(ys.min()) - m)
    x1 = min(W, int(xs.max()) + 1 + m); y1 = min(H, int(ys.max()) + 1 + m)
    crop_mask = mask_full[y0:y1, x0:x1]
    log(f"INFO crop region x={x0} y={y0} w={x1-x0} h={y1-y0}")

    # load model once (CPU or CUDA auto)
    try:
        from simple_lama_inpainting import SimpleLama
    except Exception as e:
        log(f"ERROR import simple_lama_inpainting failed: {e}")
        sys.exit(3)
    lama = SimpleLama()
    cw, ch = x1 - x0, y1 - y0
    mbool = crop_mask > 0
    # fast mode: run the model on a downscaled patch, upscale the result back
    if args.maxside and max(cw, ch) > args.maxside:
        sc = args.maxside / max(cw, ch)
        sw, sh = max(1, round(cw * sc)), max(1, round(ch * sc))
        mask_in = Image.fromarray(
            cv2.resize(crop_mask, (sw, sh), interpolation=cv2.INTER_NEAREST)).convert("L")
        log(f"INFO fast mode: inferring at {sw}x{sh} (from {cw}x{ch})")
    else:
        sw, sh = cw, ch
        mask_in = Image.fromarray(crop_mask).convert("L")

    # ffmpeg reader: raw bgr24 frames on stdout
    rd = subprocess.Popen(
        [args.ffmpeg, "-i", args.src, "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    # ffmpeg writer: raw bgr24 in (video) + original file (audio) -> mp4
    wr = subprocess.Popen(
        [args.ffmpeg, "-y",
         "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}",
         "-r", f"{args.fps}", "-i", "-",
         "-i", args.src,
         "-map", "0:v:0", "-map", "1:a:0?",
         "-c:v", "libx264", "-crf", str(args.crf), "-preset", args.preset,
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
         args.dst],
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

    frame_bytes = W * H * 3
    n = 0
    try:
        while True:
            buf = rd.stdout.read(frame_bytes)
            if not buf or len(buf) < frame_bytes:
                break
            frame = np.frombuffer(buf, np.uint8).reshape(H, W, 3)

            rgb = cv2.cvtColor(frame[y0:y1, x0:x1], cv2.COLOR_BGR2RGB)
            if (sw, sh) != (cw, ch):
                rgb_in = cv2.resize(rgb, (sw, sh), interpolation=cv2.INTER_AREA)
                out = np.array(lama(Image.fromarray(rgb_in), mask_in))[:sh, :sw]
                out = cv2.resize(out, (cw, ch), interpolation=cv2.INTER_CUBIC)
            else:
                out = np.array(lama(Image.fromarray(rgb), mask_in))[:ch, :cw]
            out_bgr = cv2.cvtColor(out, cv2.COLOR_RGB2BGR)

            frame = frame.copy()
            region = frame[y0:y1, x0:x1]
            region[mbool] = out_bgr[mbool]   # only overwrite masked pixels
            wr.stdin.write(frame.tobytes())

            n += 1
            if args.total:
                log(f"PROGRESS {n}/{args.total}")
            elif n % 10 == 0:
                log(f"PROGRESS {n}/0")
    finally:
        rd.stdout.close()
        try:
            wr.stdin.close()
        except Exception:
            pass
        wr.wait()
        rd.wait()

    log(f"DONE {n}")


if __name__ == "__main__":
    main()
