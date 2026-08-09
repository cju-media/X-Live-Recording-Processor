"""
Generates a simple placeholder app icon for X-Live Processor: a multitrack audio meter motif
(rounded bars of varying height, like a mixer's channel meters) drawn directly with PIL (no
external SVG renderer needed). Produces packaging/AppIcon.png (1024x1024) as the source image,
which build_mac.sh then turns into a real macOS .icns via sips + iconutil.

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

mask = Image.new('L', (SIZE, SIZE), 0)
mask_draw = ImageDraw.Draw(mask)
mask_draw.rounded_rectangle([margin, margin, SIZE - margin, SIZE - margin], radius=corner_radius, fill=255)
img.paste(bg, (0, 0), mask)
draw = ImageDraw.Draw(img)

# --- Multitrack meter bars: seven rounded bars of varying height, evoking a mixer's channel
# meters / a multitrack waveform - the core idea of the app (splitting a multitrack recording
# into individual named tracks). ---
bar_count = 7
bar_width = 84
bar_gap = 40
total_width = bar_count * bar_width + (bar_count - 1) * bar_gap
start_x = (SIZE - total_width) // 2
baseline_y = SIZE // 2 + 260

# Heights as a fraction of a max bar height, tallest in the middle - like a level meter caught
# mid-signal across several channels at once.
heights_frac = [0.35, 0.58, 0.82, 1.0, 0.82, 0.58, 0.35]
max_bar_height = 560

for i, frac in enumerate(heights_frac):
    x0 = start_x + i * (bar_width + bar_gap)
    x1 = x0 + bar_width
    bar_height = int(max_bar_height * frac)
    y1 = baseline_y
    y0 = y1 - bar_height
    draw.rounded_rectangle([x0, y0, x1, y1], radius=bar_width // 2, fill=(255, 255, 255, 255))

img.save('/Users/c/Documents/Programming/X-Live-Recording-Processor/packaging/AppIcon.png')
print("Saved packaging/AppIcon.png")
