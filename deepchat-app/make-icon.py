#!/usr/bin/env python3
"""Build the DeepChat icon: the DeepSeek whale on a DeepSeek-blue rounded square."""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / 'assets'
SRC = Path('/Applications/DeepSeek Harness.app/Contents/Resources/icon.png')

SIZE = 1024
MARGIN = 92
TILE = SIZE - MARGIN * 2
RADIUS = 196

# ── whale mask ────────────────────────────────────────────────────────────
source = np.asarray(Image.open(SRC).convert('RGBA')).astype(np.float32)
opaque = source[..., 3:4] / 255.0
# Compose the transparent corners onto white first: the mask must see the whale,
# not the transparent border of the shipped rounded-square icon.
flat = source[..., :3] * opaque + 255.0 * (1.0 - opaque)
lum = flat[..., 0] * 0.2126 + flat[..., 1] * 0.7152 + flat[..., 2] * 0.0722
alpha = np.clip((150.0 - lum) / (150.0 - 50.0), 0.0, 1.0)
alpha[alpha < 0.12] = 0.0
mask = Image.fromarray((alpha * 255).astype(np.uint8), 'L')
bbox = mask.getbbox()
whale = mask.crop(bbox)
# Fit the whale into a comfortable area of the tile.
target_w, target_h = 720, 566
scale = min(target_w / whale.width, target_h / whale.height)
whale = whale.resize((max(1, round(whale.width * scale)), max(1, round(whale.height * scale))), Image.LANCZOS)

# ── blue rounded tile ─────────────────────────────────────────────────────
yy, xx = np.mgrid[0:TILE, 0:TILE].astype(np.float32)
t = np.clip((xx / TILE) * 0.55 + (yy / TILE) * 0.45, 0, 1)
top = np.array([104, 137, 255], dtype=np.float32)     # #6889FF
bottom = np.array([43, 63, 214], dtype=np.float32)    # #2B3FD6
grad = (top[None, None, :] * (1 - t[..., None]) + bottom[None, None, :] * t[..., None]).astype(np.uint8)
tile = Image.fromarray(grad, 'RGB').convert('RGBA')
# Diagonal sheen across the top-left corner.
sheen = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
sheen_draw = ImageDraw.Draw(sheen)
sheen_draw.ellipse([-TILE * 0.25, -TILE * 0.55, TILE * 0.9, TILE * 0.55], fill=(255, 255, 255, 38))
sheen = sheen.filter(ImageFilter.GaussianBlur(60))
tile = Image.alpha_composite(tile, sheen)

# Rounded-square alpha mask.
tile_mask = Image.new('L', (TILE, TILE), 0)
ImageDraw.Draw(tile_mask).rounded_rectangle([0, 0, TILE - 1, TILE - 1], radius=RADIUS, fill=255)
tile.putalpha(tile_mask)

# Subtle rim light.
rim = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
rim_draw = ImageDraw.Draw(rim)
rim_draw.rounded_rectangle([1, 1, TILE - 2, TILE - 2], radius=RADIUS - 1, outline=(255, 255, 255, 66), width=3)
rim.putalpha(Image.composite(rim.getchannel('A'), Image.new('L', (TILE, TILE), 0), tile_mask))
tile = Image.alpha_composite(tile, rim)

# ── shadow + white whale ──────────────────────────────────────────────────
tile_image = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
tile_image.alpha_composite(tile, (MARGIN, MARGIN))

whale_x = (SIZE - whale.width) // 2
whale_y = (SIZE - whale.height) // 2 + 14

shadow_mask = Image.new('L', (SIZE, SIZE), 0)
shadow_mask.paste(whale, (whale_x, whale_y + 26))
shadow_mask = shadow_mask.filter(ImageFilter.GaussianBlur(26))
shadow = Image.new('RGBA', (SIZE, SIZE), (13, 22, 70, 0))
shadow.putalpha(shadow_mask.point(lambda value: int(value * 0.34)))
tile_image = Image.alpha_composite(tile_image, shadow)

white = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
white_layer = Image.new('RGBA', whale.size, (255, 255, 255, 255))
white_layer.putalpha(whale.point(lambda value: int(value * 0.985)))
white.alpha_composite(Image.merge('RGBA', (*white_layer.split()[:3], white_layer.getchannel('A'))), (whale_x, whale_y))
tile_image = Image.alpha_composite(tile_image, white)

# ── write sources ─────────────────────────────────────────────────────────
ASSETS.mkdir(parents=True, exist_ok=True)
tile_image.save(ASSETS / 'DeepChat-1024.png')
tile_image.resize((512, 512), Image.LANCZOS).save(ASSETS / 'DeepChat-512.png')
tile_image.resize((256, 256), Image.LANCZOS).save(ASSETS / 'DeepChat-256.png')
print('wrote', ASSETS / 'DeepChat-1024.png', tile_image.size)
