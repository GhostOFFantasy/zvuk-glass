from pathlib import Path
import sys
from PIL import Image

src = Path(sys.argv[1])
dst = Path(sys.argv[2])
with Image.open(src) as image:
    image = image.convert("RGB")
    image.thumbnail((1400, 1000), Image.Resampling.LANCZOS)
    dst.parent.mkdir(parents=True, exist_ok=True)
    image.save(dst, "JPEG", quality=86, optimize=True)
print(f"{src.name}: {src.stat().st_size} -> {dst.stat().st_size} bytes")
