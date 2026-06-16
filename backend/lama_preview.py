"""Single-frame LaMa preview. Extracts one frame at time t, inpaints the masked
region, and writes the result as JPEG bytes to stdout (for the Node backend)."""
import argparse, sys, subprocess
import numpy as np, cv2
from PIL import Image


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--t", type=float, default=0)
    ap.add_argument("--mask", required=True)
    ap.add_argument("--ffmpeg", required=True)
    ap.add_argument("--width", type=int, required=True)
    ap.add_argument("--height", type=int, required=True)
    ap.add_argument("--margin", type=int, default=64)
    ap.add_argument("--maxside", type=int, default=0)  # >0 = fast mode
    args = ap.parse_args()
    W, H = args.width, args.height

    raw = subprocess.run(
        [args.ffmpeg, "-ss", str(args.t), "-i", args.src, "-frames:v", "1",
         "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
        capture_output=True).stdout
    if len(raw) < W * H * 3:
        print("ERROR could not read frame", file=sys.stderr); sys.exit(2)
    frame = np.frombuffer(raw[: W * H * 3], np.uint8).reshape(H, W, 3).copy()

    mask = cv2.imread(args.mask, cv2.IMREAD_GRAYSCALE)
    if mask is None:
        print("ERROR mask unreadable", file=sys.stderr); sys.exit(2)
    if mask.shape[:2] != (H, W):
        mask = cv2.resize(mask, (W, H), interpolation=cv2.INTER_NEAREST)
    mask = (mask > 127).astype(np.uint8) * 255
    ys, xs = np.where(mask > 0)
    if len(xs) == 0:
        print("ERROR empty mask", file=sys.stderr); sys.exit(2)

    m = args.margin
    x0, y0 = max(0, int(xs.min()) - m), max(0, int(ys.min()) - m)
    x1, y1 = min(W, int(xs.max()) + 1 + m), min(H, int(ys.max()) + 1 + m)

    from simple_lama_inpainting import SimpleLama
    lama = SimpleLama()
    cw, ch = x1 - x0, y1 - y0
    cmask = mask[y0:y1, x0:x1]
    mbool = cmask > 0
    rgb = cv2.cvtColor(frame[y0:y1, x0:x1], cv2.COLOR_BGR2RGB)
    if args.maxside and max(cw, ch) > args.maxside:
        sc = args.maxside / max(cw, ch)
        sw, sh = max(1, round(cw * sc)), max(1, round(ch * sc))
        rgb_in = cv2.resize(rgb, (sw, sh), interpolation=cv2.INTER_AREA)
        mask_in = Image.fromarray(
            cv2.resize(cmask, (sw, sh), interpolation=cv2.INTER_NEAREST)).convert("L")
        out = np.array(lama(Image.fromarray(rgb_in), mask_in))[:sh, :sw]
        out = cv2.resize(out, (cw, ch), interpolation=cv2.INTER_CUBIC)
    else:
        out = np.array(lama(Image.fromarray(rgb), Image.fromarray(cmask).convert("L")))[:ch, :cw]
    region = frame[y0:y1, x0:x1]
    region[mbool] = cv2.cvtColor(out, cv2.COLOR_RGB2BGR)[mbool]

    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 92])
    if not ok:
        print("ERROR encode failed", file=sys.stderr); sys.exit(2)
    sys.stdout.buffer.write(buf.tobytes())


if __name__ == "__main__":
    main()
