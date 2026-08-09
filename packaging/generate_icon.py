"""
Generates a simple placeholder app icon for X-Live Processor: an SD card motif (the source
format this app processes) drawn directly with PIL (no external SVG renderer needed). Produces
packaging/AppIcon.png (1024x1024) as the source image, which build_mac.sh then turns into a
real macOS .icns via sips + iconutil.

Swap this out anytime by replacing packaging/AppIcon.png with real artwork (also 1024x1024,
square, no pre-rounded corners - macOS applies its own corner treatment) and skipping this
script.
"""
from PIL import Image, ImageDraw

SIZE = 1024
img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))

# --- Background: rounded square, teal gradient (top-left light -> bottom-right dark) ---
margin = 32
corner_radius = 210
top_color = (38, 198, 178)     # lighter teal
bottom_color = (0, 77, 89)     # darker teal

bg = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
bg_draw = ImageDraw.Draw(bg)
for y in range(SIZE):
    t = y / SIZE
    r = int(top_color[0] + (bottom_color[0] - top_color[0]) * t)
    g = int(top_color[1] + (bottom_color[1] - top_color[1]) * t)
    b = int(top_color[2] + (bottom_color[2] - top_color[2]) * t)
    bg_draw.line([(0, y), (SIZE, y)], fill=(r, g, b, 255))

bg_mask = Image.new('L', (SIZE, SIZE), 0)
bg_mask_draw = ImageDraw.Draw(bg_mask)
bg_mask_draw.rounded_rectangle([margin, margin, SIZE - margin, SIZE - margin], radius=corner_radius, fill=255)
img.paste(bg, (0, 0), bg_mask)

# --- SD card silhouette: portrait card with the top-left corner bevelled off (the detail that
# makes the shape instantly read as "SD card" rather than just a rounded rectangle). Built as a
# mask - a rounded rectangle with a triangle subtracted from the top-left corner - so the bevel
# cuts a clean straight edge rather than following the rectangle's own rounding. ---
card_w, card_h = 520, 720
card_x0 = (SIZE - card_w) // 2
card_y0 = (SIZE - card_h) // 2 + 10
card_x1 = card_x0 + card_w
card_y1 = card_y0 + card_h
card_radius = 48
notch = 150

card_mask = Image.new('L', (SIZE, SIZE), 0)
card_mask_draw = ImageDraw.Draw(card_mask)
card_mask_draw.rounded_rectangle([card_x0, card_y0, card_x1, card_y1], radius=card_radius, fill=255)
card_mask_draw.polygon(
    [(card_x0 - 5, card_y0 - 5), (card_x0 + notch, card_y0 - 5), (card_x0 - 5, card_y0 + notch)],
    fill=0,
)

card_layer = Image.new('RGBA', (SIZE, SIZE), (255, 255, 255, 255))
img.paste(card_layer, (0, 0), card_mask)

draw = ImageDraw.Draw(img)

# The bevel above leaves a raw diagonal edge with hard 90-degree corners at both ends - round
# those two corners off so the cut edge reads as a deliberately bevelled corner rather than a
# clipped one.
bevel_dx = card_x0 + notch - card_x0
bevel_dy = (card_y0 + notch) - card_y0
bevel_len = (bevel_dx ** 2 + bevel_dy ** 2) ** 0.5
r = 14
ux, uy = bevel_dx / bevel_len, bevel_dy / bevel_len
draw.ellipse([card_x0 + notch - r, card_y0 - r, card_x0 + notch + r, card_y0 + r], fill=(255, 255, 255, 255))
draw.ellipse([card_x0 - r, card_y0 + notch - r, card_x0 + r, card_y0 + notch + r], fill=(255, 255, 255, 255))

# --- Gold contact strip: a row of separate pins near the bottom of the card, like the metal
# contacts on the back of a real SD card. ---
pin_count = 6
strip_x0 = card_x0 + 60
strip_x1 = card_x1 - 60
strip_y0 = card_y1 - 240
strip_y1 = card_y1 - 110
gold = (222, 178, 79, 255)
gold_shadow = (181, 138, 45, 255)

total_w = strip_x1 - strip_x0
pin_gap = 14
pin_w = (total_w - pin_gap * (pin_count - 1)) / pin_count
for i in range(pin_count):
    px0 = strip_x0 + i * (pin_w + pin_gap)
    px1 = px0 + pin_w
    draw.rounded_rectangle([px0, strip_y0, px1, strip_y1], radius=10, fill=gold_shadow)
    draw.rounded_rectangle([px0, strip_y0, px1, strip_y1 - 14], radius=10, fill=gold)

# --- Label area: a couple of simple horizontal bars above the contacts, suggesting a printed
# label without needing real text at icon scale. ---
label_color = (200, 220, 220, 255)
label_x0 = card_x0 + 60
label_x1 = card_x1 - 60
draw.rounded_rectangle([label_x0, strip_y0 - 150, label_x1, strip_y0 - 110], radius=18, fill=label_color)
draw.rounded_rectangle([label_x0, strip_y0 - 90, label_x0 + (label_x1 - label_x0) * 0.6, strip_y0 - 50], radius=18, fill=label_color)

img.save('/Users/c/Documents/Programming/X-Live-Recording-Processor/packaging/AppIcon.png')
print("Saved packaging/AppIcon.png")
