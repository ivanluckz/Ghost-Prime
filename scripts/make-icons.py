#!/usr/bin/env python3
"""Build every Ghost-Prime icon from the gem pictures in Icons/ (AI-generated, 1254 x 1254, on black).

    python3 scripts/make-icons.py                # writes assets/icons/, then the places the app reads from

The picture is treated as light: black becomes transparent (alpha = brightness) and each pixel's colour
is un-premultiplied, so the glow composites correctly on any dark ground. The solid crystal (not its
glow) sets the scale, so every size shows the gem the same way. Below 256 px the faint halo is cut and
the result sharpened: at 32 px a crisp edge reads, a haze does not.

Outputs (assets/icons/):
  ghost-prime-<size>.png       cyan, on the dark rounded tile: 16 32 48 64 128 256 512 1024
  ghost-prime-red-<size>.png   the red variant (the showcase's colour), same sizes
  ghost-prime.ico              Windows icon (16-256)
  ghost-prime-gem.png / ghost-prime-red-gem.png     the gem alone, transparent
  android/ic_launcher_foreground-<dpi>.png          adaptive-icon foreground layers (gem inside the safe zone)
Then copied into place: assets/icon-256.png (app window + launcher), extension/icon-128.png,
android-connector/.../mipmap-*/ic_launcher_foreground.png.
Needs Pillow and ImageMagick (for the .ico).
"""
import os, shutil, subprocess, sys
from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'assets', 'icons')
SOURCES = {
    # name: (picture, brightness lift). The red gem is darker than the cyan one and vanished at 32 px.
    'ghost-prime': (os.path.join(ROOT, 'Icons', '1st.png'), 1.0),
    'ghost-prime-red': (os.path.join(ROOT, 'Icons', '2nd.png'), 1.3),
}
SIZES = (1024, 512, 256, 128, 64, 48, 32, 16)
ANDROID = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}


def light_to_alpha(im, thresh, power):
    """Glow on black -> RGBA: alpha from the brightest channel, colour un-premultiplied."""
    r, g, b = im.split()
    lum = ImageChops.lighter(ImageChops.lighter(r, g), b)
    alpha = lum.point(lambda v: 0 if v <= thresh else min(255, int(255 * ((v - thresh) / (255 - thresh)) ** power)))
    px, ap = im.load(), alpha.load()
    w, h = im.size
    out = Image.new('RGBA', im.size)
    op = out.load()
    for y in range(h):
        for x in range(w):
            a = ap[x, y]
            if not a:
                continue
            rr, gg, bb = px[x, y]
            s = 255 / max(rr, gg, bb)
            op[x, y] = (min(255, int(rr * s)), min(255, int(gg * s)), min(255, int(bb * s)), a)
    return out


def crystal_box(gem):
    """The solid crystal: rows/columns where many pixels are fully lit. Glow and loose shards drop out."""
    solid = gem.split()[3].point(lambda a: 255 if a > 200 else 0)
    sp = solid.load()
    w, h = solid.size
    rows = [sum(1 for x in range(w) if sp[x, y]) for y in range(h)]
    cols = [sum(1 for y in range(h) if sp[x, y]) for x in range(w)]
    ry = [y for y, n in enumerate(rows) if n > 0.30 * max(rows)]
    rx = [x for x, n in enumerate(cols) if n > 0.30 * max(cols)]
    return (min(rx), min(ry), max(rx), max(ry))


def rounded_tile(size):
    """The dark navy rounded square every app icon sits on (the app's own ground colours)."""
    radius = round(size * 0.2237)
    grad = Image.new('RGBA', (size, size))
    gd = grad.load()
    for y in range(size):
        t = y / max(1, size - 1)
        c = (round(9 + (5 - 9) * t), round(14 + (7 - 14) * t), round(34 + (16 - 34) * t), 255)
        for x in range(size):
            gd[x, y] = c
    big = size * 4
    mask = Image.new('L', (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, big - 1, big - 1), radius=radius * 4, fill=255)
    tile = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    tile.paste(grad, (0, 0), mask.resize((size, size), Image.LANCZOS))
    if size >= 48:
        edge = Image.new('RGBA', (big, big), (0, 0, 0, 0))
        ImageDraw.Draw(edge).rounded_rectangle((2, 2, big - 3, big - 3), radius=radius * 4, outline=(60, 70, 120, 110), width=4)
        tile.alpha_composite(edge.resize((size, size), Image.LANCZOS))
    return tile


def place(canvas, gem, box, crystal_frac, top_frac, sharpen):
    """Scale the gem so its crystal is crystal_frac of the canvas height, centred, crystal top at top_frac."""
    size = canvas.width
    bx0, by0, bx1, by1 = box
    scale = (size * crystal_frac) / (by1 - by0)
    g = gem.resize((max(1, round(gem.width * scale)), max(1, round(gem.height * scale))), Image.LANCZOS)
    if sharpen:
        g = g.filter(ImageFilter.UnsharpMask(radius=1, percent=60, threshold=2))
    cx = (bx0 + bx1) / 2 * scale
    canvas.alpha_composite(g, (round(size / 2 - cx), round(size * top_frac - by0 * scale)))
    return canvas


def build(name, src, lift):
    im = Image.open(src).convert('RGB')
    if lift != 1.0:
        im = ImageEnhance.Brightness(im).enhance(lift)
    soft = light_to_alpha(im, 16, 1.4)   # keeps the glow: big sizes
    tight = light_to_alpha(im, 48, 1.2)  # crisp edge: small sizes
    box = crystal_box(tight)
    soft.crop(soft.getbbox()).save(os.path.join(OUT, f'{name}-gem.png'))
    for size in SIZES:
        gem = soft if size >= 256 else tight
        place(rounded_tile(size), gem, box, 0.58, 0.12, size <= 64).save(os.path.join(OUT, f'{name}-{size}.png'))
    print(f'{name}: crystal box {box}, {len(SIZES)} sizes')
    return soft, tight, box


os.makedirs(OUT, exist_ok=True)
os.makedirs(os.path.join(OUT, 'android'), exist_ok=True)
built = {name: build(name, src, lift) for name, (src, lift) in SOURCES.items()}

# Android adaptive icon: a 108 dp layer of which only the middle 66 dp circle is guaranteed visible,
# so the whole gem (crystal, shards and glow) is kept inside 60 % of the layer.
soft, tight, box = built['ghost-prime']
whole = soft.getbbox()
for dpi, px in ANDROID.items():
    layer = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    scale = (px * 0.60) / (whole[3] - whole[1])
    g = soft.resize((max(1, round(soft.width * scale)), max(1, round(soft.height * scale))), Image.LANCZOS)
    cx = (whole[0] + whole[2]) / 2 * scale
    cy = (whole[1] + whole[3]) / 2 * scale
    layer.alpha_composite(g, (round(px / 2 - cx), round(px / 2 - cy)))
    layer.save(os.path.join(OUT, 'android', f'ic_launcher_foreground-{dpi}.png'))
print('android foreground layers:', ', '.join(f'{k} {v}px' for k, v in ANDROID.items()))

# Windows .ico from the small sizes
ico = os.path.join(OUT, 'ghost-prime.ico')
subprocess.run(['magick'] + [os.path.join(OUT, f'ghost-prime-{s}.png') for s in (16, 32, 48, 64, 128, 256)] + [ico], check=True)
print('wrote', os.path.relpath(ico, ROOT))

# Into place
shutil.copy(os.path.join(OUT, 'ghost-prime-256.png'), os.path.join(ROOT, 'assets', 'icon-256.png'))
shutil.copy(os.path.join(OUT, 'ghost-prime-128.png'), os.path.join(ROOT, 'extension', 'icon-128.png'))
res = os.path.join(ROOT, 'android-connector', 'app', 'src', 'main', 'res')
for dpi in ANDROID:
    d = os.path.join(res, f'mipmap-{dpi}')
    os.makedirs(d, exist_ok=True)
    shutil.copy(os.path.join(OUT, 'android', f'ic_launcher_foreground-{dpi}.png'), os.path.join(d, 'ic_launcher_foreground.png'))
print('copied: assets/icon-256.png, extension/icon-128.png, android mipmap-*/ic_launcher_foreground.png')
