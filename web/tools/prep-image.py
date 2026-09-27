# Writes small (~200px) and grid (0.2mm/px) RGBA buffers for the Node engine test.
import sys, json
from PIL import Image
src, width_mm, out = sys.argv[1], float(sys.argv[2]), sys.argv[3]
im = Image.open(src).convert('RGBA')
# crop plain border like the app does (approximate: use getbbox on difference from corner colour)
from PIL import ImageChops
bg = Image.new('RGBA', im.size, im.getpixel((0, 0)))
diff = ImageChops.difference(im, bg).convert('L').point(lambda v: 255 if v > 12 else 0)
box = diff.getbbox()
if box: im = im.crop((max(0, box[0]-4), max(0, box[1]-4), min(im.width, box[2]+4), min(im.height, box[3]+4)))
a = im.width / im.height
sw, sh = (200, max(8, int(200 / a))) if a >= 1 else (max(8, int(200 * a)), 200)
small = im.resize((sw, sh), Image.LANCZOS)
gw = round(width_mm / 0.2); gh = round(width_mm / a / 0.2)
grid = im.resize((gw, gh), Image.LANCZOS)
open(out + '.small', 'wb').write(small.tobytes()); open(out + '.grid', 'wb').write(grid.tobytes())
json.dump({'small': [sw, sh], 'grid': [gw, gh]}, open(out + '.json', 'w'))
