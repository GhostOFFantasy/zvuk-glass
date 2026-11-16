"""Растрирует фирменный знак Observatory без внешних зависимостей и сети."""
from pathlib import Path
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src-tauri" / "icons"
PREVIEW = ROOT / "verification" / "design-2.4.0" / "brand-preview.png"
S = 8
N = 128 * S
Y, X = np.mgrid[0:N, 0:N].astype(np.float32) / S


def rgb(hex_color):
    return np.array(tuple(int(hex_color[i:i + 2], 16) for i in (1, 3, 5)), dtype=np.float32)


def mix(a, b, t):
    t = np.clip(t, 0, 1)[..., None]
    return rgb(a) * (1 - t) + rgb(b) * t


def linear(a, b, c, start, end):
    d = ((X - start[0]) * (end[0] - start[0]) + (Y - start[1]) * (end[1] - start[1])) / ((end[0] - start[0]) ** 2 + (end[1] - start[1]) ** 2)
    t = np.clip(d, 0, 1)
    first = mix(a, b, t / 0.46)
    return np.where((t <= 0.46)[..., None], first, mix(b, c, (t - 0.46) / 0.54))


def layer_from_mask(mask, pixels, alpha=255):
    out = np.zeros((N, N, 4), dtype=np.uint8)
    out[:, :, :3] = np.clip(pixels, 0, 255).astype(np.uint8)
    out[:, :, 3] = np.asarray(mask, dtype=np.float32) * (alpha / 255)
    out[:, :, 3] = np.clip(out[:, :, 3], 0, 255).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def mask_layer(draw_fn):
    layer = Image.new("L", (N, N), 0)
    draw_fn(ImageDraw.Draw(layer))
    return layer


image = Image.new("RGBA", (N, N), (0, 0, 0, 0))
shell = mask_layer(lambda d: d.rounded_rectangle((3 * S, 3 * S, 125 * S, 125 * S), radius=34 * S, fill=255))
image.alpha_composite(layer_from_mask(shell, linear("#213b55", "#0c1727", "#171329", (18, 12), (110, 118))))
border = mask_layer(lambda d: d.rounded_rectangle((3.8 * S, 3.8 * S, 124.2 * S, 124.2 * S), radius=33 * S, outline=255, width=round(1.4 * S)))
image.alpha_composite(layer_from_mask(border, np.broadcast_to(rgb("#b6dbf5"), (N, N, 3)), 65))

ring = Image.new("L", (N, N), 0)
d = ImageDraw.Draw(ring)
d.ellipse((7 * S, 28 * S, 131 * S, 85 * S), outline=185, width=round(2.4 * S))
ring = ring.rotate(32, resample=Image.Resampling.BICUBIC, center=(64 * S, 64 * S))
ring_pixels = linear("#3a4d71", "#dcf3ff", "#9687cf", (16, 90), (113, 30))
image.alpha_composite(layer_from_mask(ring, ring_pixels, 230))

r = np.sqrt((X - 49) ** 2 + (Y - 43) ** 2)
planet = np.zeros((N, N, 3), dtype=np.float32)
stops = [(0, "#d9f4ff"), (10.2, "#87ccec"), (27.0, "#4e719d"), (40.8, "#263553"), (51, "#0a1020")]
for (r0, c0), (r1, c1) in zip(stops, stops[1:]):
    weights = np.clip((r - r0) / (r1 - r0), 0, 1)
    part = mix(c0, c1, weights)
    planet = np.where(((r >= r0) & (r <= r1))[..., None], part, planet)
planet = np.where((r < stops[0][0])[..., None], rgb(stops[0][1]), planet)
core = mask_layer(lambda d: d.ellipse((30 * S, 30 * S, 98 * S, 98 * S), fill=255))
image.alpha_composite(layer_from_mask(core, planet))
core_edge = mask_layer(lambda d: d.ellipse((30.5 * S, 30.5 * S, 97.5 * S, 97.5 * S), outline=255, width=S))
image.alpha_composite(layer_from_mask(core_edge, np.broadcast_to(rgb("#d8efff"), (N, N, 3)), 85))
shine = mask_layer(lambda d: d.arc((39 * S, 30 * S, 89 * S, 74 * S), start=205, end=310, fill=255, width=2 * S))
image.alpha_composite(layer_from_mask(shine, np.broadcast_to(rgb("#ffffff"), (N, N, 3)), 85))

zmask = Image.new("L", (N, N), 0)
zdraw = ImageDraw.Draw(zmask)
zpoints = [(45 * S, 45 * S), (84 * S, 45 * S), (45 * S, 83 * S), (84 * S, 83 * S)]
zdraw.line(zpoints, fill=255, width=7 * S, joint="curve")
for x, y in (zpoints[0], zpoints[-1]):
    zdraw.ellipse((x - 3.5 * S, y - 3.5 * S, x + 3.5 * S, y + 3.5 * S), fill=255)
zpix = mix("#ffffff", "#b8ddf7", (Y - 43) / 43)
image.alpha_composite(layer_from_mask(zmask, zpix))

front = Image.new("L", (N, N), 0)
fd = ImageDraw.Draw(front)
points = []
for i in range(161):
    t = i / 160
    u = 1 - t
    x = u ** 3 * 18 + 3 * u * u * t * 27 + 3 * u * t * t * 82 + t ** 3 * 130
    y = u ** 3 * 80 + 3 * u * u * t * 93 + 3 * u * t * t * 58 + t ** 3 * 31
    points.append((x * S, y * S))
fd.line(points, fill=230, width=round(2.8 * S), joint="curve")
front = Image.fromarray((np.asarray(front, dtype=np.float32) * np.clip((123 - X) / 22, 0, 1)).astype(np.uint8))
image.alpha_composite(layer_from_mask(front, ring_pixels))

sat_glow = mask_layer(lambda d: d.ellipse((100 * S, 20 * S, 116 * S, 36 * S), fill=110)).filter(ImageFilter.GaussianBlur(2 * S))
image.alpha_composite(layer_from_mask(sat_glow, np.broadcast_to(rgb("#a6dfff"), (N, N, 3)), 100))
sat = mask_layer(lambda d: d.ellipse((103.8 * S, 23.8 * S, 112.2 * S, 32.2 * S), fill=255))
image.alpha_composite(layer_from_mask(sat, np.broadcast_to(rgb("#d9f4ff"), (N, N, 3))))
for x, y, radius, alpha in [(26, 28, 1.4, 180), (100, 101, 1.2, 130)]:
    star = mask_layer(lambda d, x=x, y=y, radius=radius: d.ellipse(((x - radius) * S, (y - radius) * S, (x + radius) * S, (y + radius) * S), fill=255))
    image.alpha_composite(layer_from_mask(star, np.broadcast_to(rgb("#d9edff"), (N, N, 3)), alpha))

image.putalpha(Image.fromarray(np.minimum(np.asarray(image.getchannel("A")), np.asarray(shell))))
master = image.resize((512, 512), Image.Resampling.LANCZOS)
master.save(OUT / "icon.png")
master.resize((256, 256), Image.Resampling.LANCZOS).save(OUT / "128x128@2x.png")
master.resize((128, 128), Image.Resampling.LANCZOS).save(OUT / "128x128.png")
master.resize((32, 32), Image.Resampling.LANCZOS).save(OUT / "32x32.png")
master.save(OUT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
PREVIEW.parent.mkdir(parents=True, exist_ok=True)
master.save(PREVIEW)
print("Значки сохранены:", OUT)
