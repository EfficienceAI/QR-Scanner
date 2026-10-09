#!/usr/bin/env python3
"""
Builds every image the pass needs from the source artwork in pass-art/.

  python3 scripts/build-pass-art.py

Outputs, per theme (pass-template/<theme>/):
  strip-N.png, strip-N@2x.png, strip-N@3x.png   N = 0..9 beans filled
and shared (pass-template/common/):
  logo.png / @2x / @3x   icon.png / @2x / @3x

The strip is Apple's storeCard size, 375 x 123 points. The source strips
are 1125 x 432 (PassKit's size), so they are scaled to width and centre-
cropped. The stamp row - nine circles, N of them holding a coffee bean -
sits in a soft dark band across the bottom so it reads over the photo.
"""
from PIL import Image, ImageDraw, ImageFilter
import os, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
ART = os.path.join(ROOT, 'pass-art')
OUT = os.path.join(ROOT, 'pass-template')
STAMPS = 9
THEMES = {'default': 'strip-default.png', 'christmas': 'strip-christmas.png'}

# Apple point sizes
STRIP_PT = (375, 123)
LOGO_PT = 50          # square logo, height-limited (Apple allows up to 160 x 50)
ICON_PT = 29

def load(name):
    return Image.open(os.path.join(ART, name)).convert('RGBA')

def fit_strip(src, scale):
    w, h = STRIP_PT[0] * scale, STRIP_PT[1] * scale
    s = w / src.width
    im = src.resize((w, max(h, round(src.height * s))), Image.LANCZOS)
    top = (im.height - h) // 2
    return im.crop((0, top, w, top + h))

def stamp_row(strip, filled, scale, bean):
    """Draw the nine circles over the bottom of the strip."""
    w, h = strip.size
    out = strip.copy()
    # soft band so the circles read over any photo
    band = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    bd = ImageDraw.Draw(band)
    band_top = int(h * 0.56)
    for y in range(band_top, h):
        a = int(170 * ((y - band_top) / (h - band_top)) ** 0.9)
        bd.line([(0, y), (w, y)], fill=(0, 0, 0, a))
    out = Image.alpha_composite(out, band)

    d = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    dd = ImageDraw.Draw(d)
    diameter = int(h * 0.23)
    margin = int(w * 0.055)
    pitch = (w - 2 * margin - diameter) / (STAMPS - 1)
    cy = int(h * 0.80)
    ring = max(1, round(1.5 * scale))
    bean_img = bean.resize((int(diameter * 0.62), int(diameter * 0.62)), Image.LANCZOS)
    for i in range(STAMPS):
        cx = int(margin + diameter / 2 + i * pitch)
        box = (cx - diameter // 2, cy - diameter // 2, cx + diameter // 2, cy + diameter // 2)
        if i < filled:
            dd.ellipse(box, fill=(245, 236, 222, 255), outline=(245, 236, 222, 255), width=ring)
        else:
            dd.ellipse(box, fill=(255, 255, 255, 38), outline=(255, 255, 255, 170), width=ring)
    out = Image.alpha_composite(out, d)
    for i in range(filled):
        cx = int(margin + diameter / 2 + i * pitch)
        out.alpha_composite(bean_img, (cx - bean_img.width // 2, cy - bean_img.height // 2))
    return out

def trim(im):
    bbox = im.getchannel('A').getbbox()
    return im.crop(bbox) if bbox else im

def build_logo(src):
    im = trim(src)
    for scale, suffix in ((1, ''), (2, '@2x'), (3, '@3x')):
        box = LOGO_PT * scale
        s = min(box / im.width, box / im.height)
        r = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)
        canvas = Image.new('RGBA', (box, box), (0, 0, 0, 0))
        canvas.alpha_composite(r, ((box - r.width) // 2, (box - r.height) // 2))
        canvas.save(os.path.join(OUT, 'common', f'logo{suffix}.png'), optimize=True)

def build_icon(src):
    # the crest only: the wordmark is unreadable at 29 points
    w, h = src.size
    crest = src.crop((int(w * 0.30), int(h * 0.17), int(w * 0.70), int(h * 0.57)))
    side = max(crest.size)
    sq = Image.new('RGBA', (side, side), (0, 0, 0, 255))
    sq.alpha_composite(crest, ((side - crest.width) // 2, (side - crest.height) // 2))
    pad = int(side * 0.12)
    padded = Image.new('RGBA', (side + 2 * pad, side + 2 * pad), (0, 0, 0, 255))
    padded.alpha_composite(sq, (pad, pad))
    for scale, suffix in ((1, ''), (2, '@2x'), (3, '@3x')):
        px = ICON_PT * scale
        padded.resize((px, px), Image.LANCZOS).convert('RGB').save(os.path.join(OUT, 'common', f'icon{suffix}.png'), optimize=True)

def main():
    os.makedirs(os.path.join(OUT, 'common'), exist_ok=True)
    bean = trim(load('bean.png'))
    build_logo(load('logo-white.png'))
    build_icon(load('logo-on-black.png'))
    for theme, src_name in THEMES.items():
        src = load(src_name)
        tdir = os.path.join(OUT, theme)
        os.makedirs(tdir, exist_ok=True)
        for scale, suffix in ((1, ''), (2, '@2x'), (3, '@3x')):
            base = fit_strip(src, scale)
            for n in range(STAMPS + 1):
                stamp_row(base, n, scale, bean).convert('RGB').save(os.path.join(tdir, f'strip-{n}{suffix}.png'), optimize=True)
        print(f'{theme}: {3 * (STAMPS + 1)} strip images')
    print('common: logo + icon at 3 sizes')

if __name__ == '__main__':
    main()
