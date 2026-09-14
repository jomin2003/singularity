"""Generate Google Play store listing assets.

Outputs (into ./store):
    feature-graphic-1024x500.png   Play feature graphic (no alpha, 24-bit)
    icon-512.png                   Play store icon (512x512, alpha allowed)

Run with the venv that has Pillow:
    <venv>/Scripts/python.exe tools/make_store_assets.py
"""
import math
import os
import random
from PIL import Image, ImageDraw, ImageFont, ImageFilter

FONTS = r"C:\Windows\Fonts"
BOLD = ["segoeuib.ttf", "arialbd.ttf", "verdanab.ttf", "DejaVuSans-Bold.ttf"]
REG = ["segoeui.ttf", "arial.ttf", "verdana.ttf", "DejaVuSans.ttf"]

BG = (5, 6, 15)
CYAN = (79, 240, 255)
VIOLET = (155, 107, 255)


def find_font(names, size):
    for n in names:
        p = os.path.join(FONTS, n)
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def fit_font(names, text, max_w, start, min_size=20):
    """Largest font size (stepping down by 2) whose text fits max_w."""
    size = start
    while size > min_size:
        f = find_font(names, size)
        if f.getlength(text) <= max_w:
            return f
        size -= 2
    return find_font(names, min_size)


def lerp(a, b, t):
    return a + (b - a) * t


def nebula(size, center_rgb, edge_rgb, focus=(0.28, 0.5)):
    """Cheap radial gradient: draw tiny, upscale smoothly."""
    gw, gh = 160, 80
    g = Image.new("RGB", (gw, gh))
    px = g.load()
    for y in range(gh):
        for x in range(gw):
            d = math.hypot((x / gw - focus[0]) * 1.6, (y / gh - focus[1]) * 2.0)
            t = min(1.0, d)
            px[x, y] = tuple(int(lerp(center_rgb[i], edge_rgb[i], t)) for i in range(3))
    return g.resize(size, Image.BICUBIC)


def add_stars(img, n=300, seed=7):
    w, h = img.size
    rnd = random.Random(seed)
    d = ImageDraw.Draw(img, "RGBA")
    for _ in range(n):
        x, y = rnd.randint(0, w - 1), rnd.randint(0, h - 1)
        r = rnd.choice([1, 1, 1, 2])
        a = rnd.randint(40, 190)
        d.ellipse([x - r, y - r, x + r, y + r], fill=(198, 228, 255, a))


def black_hole(img, cx, cy, r, halo_strength=46):
    """Black core, bright photon ring, cyan->violet halo. Drawn in place."""
    w, h = img.size

    halo = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    hd = ImageDraw.Draw(halo)
    steps = 90
    for i in range(steps, 0, -1):
        f = i / steps                      # 1 = outermost
        rr = r * (1.0 + f * 3.4)
        a = int(halo_strength * (1 - f) ** 2.1)
        t = min(1.0, f * 1.15)
        col = (int(lerp(79, 155, t)), int(lerp(240, 107, t)), 255, a)
        hd.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=col)
    img.alpha_composite(halo)

    ring = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    rd = ImageDraw.Draw(ring)
    for k in range(14):
        rr = r * (1.02 + k * 0.035)
        a = int(200 * (1 - k / 14.0) ** 1.5)
        rd.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                   outline=(150, 245, 255, a), width=max(1, int(r * 0.035)))
    img.alpha_composite(ring)

    core = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(core).ellipse([cx - r, cy - r, cx + r, cy + r], fill=(0, 0, 0, 255))
    img.alpha_composite(core)


def gradient_text(img, text, font, center, c1, c2):
    """Draw `text` centred on `center` filled with a horizontal gradient.

    PixelAccess does not accept `px[x, :] = (r, g, b)` slice assignment, so the
    gradient is built as a 1px-tall strip and stretched vertically.
    """
    layer = Image.new("L", img.size, 0)
    ImageDraw.Draw(layer).text(center, text, font=font, fill=255, anchor="mm")
    bbox = layer.getbbox()
    if not bbox:
        return None
    x0, y0, x1, y1 = bbox
    gw, gh = max(1, x1 - x0), max(1, y1 - y0)

    strip = Image.new("RGB", (gw, 1))
    strip.putdata([
        tuple(int(lerp(c1[i], c2[i], x / max(1, gw - 1))) for i in range(3))
        for x in range(gw)
    ])
    grad = strip.resize((gw, gh), Image.NEAREST)

    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(grad, (x0, y0), layer.crop(bbox))
    img.alpha_composite(out)
    return bbox


def feature_graphic(path):
    W, H = 1024, 500
    img = nebula((W, H), (14, 22, 44), (3, 3, 9)).convert("RGBA")
    add_stars(img)
    black_hole(img, 258, 250, 86)

    # Title block occupies x in [452, 972] so nothing important sits near the
    # edges (Play crops feature graphics on some surfaces).
    region_x0, region_w = 452, 520
    cx = region_x0 + region_w / 2

    title = fit_font(BOLD, "SINGULARITY", region_w, 96)
    glow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(glow).text((cx + 2, 214), "SINGULARITY", font=title,
                              fill=(79, 240, 255, 80), anchor="mm")
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(18)))

    bbox = gradient_text(img, "SINGULARITY", title, (cx, 212), (255, 255, 255), (150, 120, 255))

    sub = fit_font(REG, "Consume. Grow. Survive.", region_w, 34)
    sub_y = (bbox[3] + 44) if bbox else 300
    ImageDraw.Draw(img).text((cx, sub_y), "Consume. Grow. Survive.",
                             font=sub, fill=(150, 200, 230, 235), anchor="ma")

    out = img.convert("RGB")          # Play requires no alpha channel
    out.save(path, "PNG", optimize=True)
    return out.size


def store_icon(path, size=512):
    img = nebula((size, size), (12, 18, 38), (3, 3, 9)).convert("RGBA")
    add_stars(img, n=180, seed=11)
    # Slightly smaller than full-bleed so the ring never clips.
    black_hole(img, size / 2, size / 2, size * 0.235, halo_strength=60)
    img.save(path, "PNG", optimize=True)
    return img.size


def main():
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    store = os.path.join(base, "store")
    os.makedirs(store, exist_ok=True)

    fg = os.path.join(store, "feature-graphic-1024x500.png")
    ic = os.path.join(store, "icon-512.png")
    print("feature graphic ->", fg, feature_graphic(fg))
    print("store icon      ->", ic, store_icon(ic))


if __name__ == "__main__":
    main()
