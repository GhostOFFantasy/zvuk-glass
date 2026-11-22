"""Растрирует минималистичный знак Zvuk Nova без сети и внешних зависимостей."""
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src-tauri" / "icons"
PREVIEW = ROOT / "verification" / "nova" / "brand-preview.png"
S = 8
N = 128 * S
Y, X = np.mgrid[0:N, 0:N].astype(np.float32) / S


def color(value):
    return np.array(tuple(int(value[i:i + 2], 16) for i in (1, 3, 5)), dtype=np.float32)


def mix(a, b, amount):
    t = np.clip(amount, 0, 1)[..., None]
    return color(a) * (1 - t) + color(b) * t


def layer(mask, pixels, alpha=255):
    if isinstance(pixels, str):
        pixels = color(pixels)
    out = np.zeros((N, N, 4), dtype=np.uint8)
    out[:, :, :3] = np.clip(pixels, 0, 255).astype(np.uint8)
    out[:, :, 3] = np.asarray(mask, dtype=np.float32) * (alpha / 255)
    out[:, :, 3] = np.clip(out[:, :, 3], 0, 255).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def mask(draw_fn, angle=0):
    canvas = Image.new("L", (N, N), 0)
    draw_fn(ImageDraw.Draw(canvas))
    if angle:
        canvas = canvas.rotate(angle, resample=Image.Resampling.BICUBIC, center=(64 * S, 64 * S))
    return canvas


image = Image.new("RGBA", (N, N), (0, 0, 0, 0))
shell = mask(lambda d: d.rounded_rectangle((4*S, 4*S, 124*S, 124*S), radius=34*S, fill=255))
t = np.clip((X + Y - 24) / 210, 0, 1)
image.alpha_composite(layer(shell, mix("#1d222b", "#101218", t)))
border = mask(lambda d: d.rounded_rectangle((4.6*S, 4.6*S, 123.4*S, 123.4*S), radius=33.4*S, outline=255, width=round(1.2*S)))
image.alpha_composite(layer(border, "#f0f3fa", 25))

# Три отдельных звуковых столбика; дуга проходит ниже них и ничего не перекрывает.
orbit_pixels = mix("#bcb2f4", "#ace8d0", np.clip(X/128, 0, 1))
signal = Image.new("L", (N, N), 0)
d = ImageDraw.Draw(signal)
for x, y, h in [(38, 50, 30), (59, 36, 44), (80, 46, 34)]:
    d.rounded_rectangle((x*S, y*S, (x+10)*S, (y+h)*S), radius=5*S, fill=255)
signal_pixels = mix("#d6fff0", "#bcb2f4", np.clip((Y-36)/58, 0, 1))
image.alpha_composite(layer(signal, signal_pixels))

front = Image.new("L", (N, N), 0)
d = ImageDraw.Draw(front)
points = []
for i in range(101):
    u = i / 100
    v = 1-u
    x = v**3*25 + 3*v*v*u*40 + 3*v*u*u*88 + u**3*103
    y = v**3*91 + 3*v*v*u*108 + 3*v*u*u*105 + u**3*87
    points.append((x*S, y*S))
d.line(points, fill=235, width=round(2.4*S), joint="curve")
image.alpha_composite(layer(front, orbit_pixels))
star = Image.new("L", (N, N), 0)
d = ImageDraw.Draw(star)
d.line(((102*S, 20*S), (102*S, 32*S)), fill=255, width=round(2.4*S))
d.line(((96*S, 26*S), (108*S, 26*S)), fill=255, width=round(2.4*S))
image.alpha_composite(layer(star, "#d6fff0"))
sat = mask(lambda d: d.ellipse((99.5*S, 83.5*S, 106.5*S, 90.5*S), fill=255))
image.alpha_composite(layer(sat, "#ace8d0"))

image.putalpha(Image.fromarray(np.minimum(np.asarray(image.getchannel("A")), np.asarray(shell))))
master = image.resize((512, 512), Image.Resampling.LANCZOS)
OUT.mkdir(parents=True, exist_ok=True)
master.save(OUT / "icon.png")
master.resize((256, 256), Image.Resampling.LANCZOS).save(OUT / "128x128@2x.png")
master.resize((128, 128), Image.Resampling.LANCZOS).save(OUT / "128x128.png")
master.resize((32, 32), Image.Resampling.LANCZOS).save(OUT / "32x32.png")
master.save(OUT / "icon.ico", sizes=[(16,16), (24,24), (32,32), (48,48), (64,64), (128,128), (256,256)])
master.save(ROOT / "src" / "renderer" / "brand.png")
PREVIEW.parent.mkdir(parents=True, exist_ok=True)
master.save(PREVIEW)
master.resize((32, 32), Image.Resampling.NEAREST).resize((256, 256), Image.Resampling.NEAREST).save(PREVIEW.with_name("brand-32-check.png"))
print("Значки Zvuk Nova сохранены:", OUT)
