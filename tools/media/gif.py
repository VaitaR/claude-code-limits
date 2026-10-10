"""Frames from record.py, rendered to PNG by ans2html.py and shot.py -> one looping GIF.

Usage: uv run --with pillow python gif.py frames/ out.gif [width]

One palette serves every frame, and the rounded corners stay transparent for dark and light pages.
"""
import json, pathlib, sys
from PIL import Image

D = pathlib.Path(sys.argv[1])
WIDTH = int(sys.argv[3]) if len(sys.argv) > 3 else 900
KEY = (255, 0, 255)
frames = json.loads((D / "frames.json").read_text())
imgs = [Image.open(D / n.replace(".ans", ".png")).convert("RGBA") for n, _ in frames]
w, h = max(i.width for i in imgs), max(i.height for i in imgs)
H = round(h * WIDTH / w)

rgb = []
for im in imgs:
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    canvas.paste(im, (0, h - im.height))
    canvas = canvas.resize((WIDTH, H), Image.LANCZOS)
    alpha = canvas.getchannel("A").point(lambda a: 255 if a >= 128 else 0)
    bg = Image.new("RGB", (WIDTH, H), KEY)
    bg.paste(canvas.convert("RGB"), mask=alpha)
    rgb.append(bg)

# one palette for all frames, built from a strip of every frame
strip = Image.new("RGB", (WIDTH, H * len(rgb)))
for i, im in enumerate(rgb):
    strip.paste(im, (0, H * i))
pal = strip.quantize(colors=255, method=Image.MEDIANCUT)
out = [im.quantize(palette=pal, dither=Image.Dither.NONE) for im in rgb]
p = pal.getpalette()[: 256 * 3]
key = min(range(len(p) // 3), key=lambda i: sum((p[3 * i + k] - KEY[k]) ** 2 for k in range(3)))
out[0].save(sys.argv[2], save_all=True, append_images=out[1:], duration=[d for _, d in frames],
            loop=0, optimize=False, transparency=key, disposal=2)
print(len(out), "frames", out[0].size, "key", key, p[3 * key:3 * key + 3])
