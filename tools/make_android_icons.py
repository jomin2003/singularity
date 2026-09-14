"""Regenerate the Android launcher icons and splash screens with the
SINGULARITY black hole, replacing Capacitor's placeholder artwork.

Run with the venv that has Pillow:
    <venv>/Scripts/python.exe tools/make_android_icons.py
"""
import os
import sys

from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_store_assets import black_hole, nebula, add_stars  # noqa: E402

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(BASE, "android", "app", "src", "main", "res")

BG = (5, 6, 15)

# Adaptive icon layers are 108dp; legacy launcher icons are 48dp.
DENSITY = {
    "mdpi": 1.0,
    "hdpi": 1.5,
    "xhdpi": 2.0,
    "xxhdpi": 3.0,
    "xxxhdpi": 4.0,
}


def px(dp, density):
    return int(round(dp * DENSITY[density]))


def adaptive_foreground(size, path):
    """108dp canvas, transparent. Visible art must sit inside the centre
    72dp safe zone or launcher masks will clip it."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    r = size * 0.28                      # diameter = 56% of canvas < 66.7% safe zone
    black_hole(img, size / 2.0, size / 2.0, r, halo_strength=70)
    img.save(path, "PNG", optimize=True)


def legacy_icon(size, path, round_mask=False):
    img = nebula((size, size), (12, 18, 38), (3, 3, 9)).convert("RGBA")
    add_stars(img, n=int(size / 3), seed=11)
    black_hole(img, size / 2.0, size / 2.0, size * 0.30, halo_strength=60)
    if round_mask:
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).ellipse([0, 0, size - 1, size - 1], fill=255)
        out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        out.paste(img, (0, 0), mask)
        img = out
    img.save(path, "PNG", optimize=True)


def splash(w, h, path):
    """Keeps the existing per-density dimensions, just repaints them."""
    img = Image.new("RGB", (w, h), BG)
    img = img.convert("RGBA")
    add_stars(img, n=int((w * h) / 6000), seed=5)
    black_hole(img, w / 2.0, h / 2.0, min(w, h) * 0.11, halo_strength=55)
    img.convert("RGB").save(path, "PNG", optimize=True)


def main():
    written = []

    for d in DENSITY:
        s = px(108, d)
        for name, fn in (
            ("ic_launcher_foreground.png", adaptive_foreground),
        ):
            p = os.path.join(RES, "mipmap-%s" % d, name)
            fn(s, p)
            written.append(p)

        s48 = px(48, d)
        p = os.path.join(RES, "mipmap-%s" % d, "ic_launcher.png")
        legacy_icon(s48, p, round_mask=False)
        written.append(p)

        p = os.path.join(RES, "mipmap-%s" % d, "ic_launcher_round.png")
        legacy_icon(s48, p, round_mask=True)
        written.append(p)

    # Splash: repaint every existing splash.png at its current size.
    for root, _dirs, files in os.walk(RES):
        if "splash.png" in files:
            p = os.path.join(root, "splash.png")
            w, h = Image.open(p).size
            splash(w, h, p)
            written.append(p)

    # Neutralise the unused Android-Studio template drawables so nothing
    # teal/green can ever leak into the launcher.
    solid_bg = """<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportHeight="108"
    android:viewportWidth="108">
    <path
        android:fillColor="#05060F"
        android:pathData="M0,0h108v108h-108z" />
</vector>
"""
    p = os.path.join(RES, "drawable", "ic_launcher_background.xml")
    with open(p, "w", encoding="utf-8") as f:
        f.write(solid_bg)
    written.append(p)

    print("rewrote %d files" % len(written))
    for p in sorted(written):
        print("  ", os.path.relpath(p, BASE))


if __name__ == "__main__":
    main()
