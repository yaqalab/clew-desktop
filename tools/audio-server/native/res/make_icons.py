"""
Composes the native server's icons (res/icons/*.ico) from Clew's labyrinth app tile
(packages/kit/brand/app-icons/icon-{light,dark}-1024.png, the source of truth; nothing is drawn here):

- app.ico (the program, its window, the Start menu, the installer): the light tile, 16 to 256 px.
- tray-{on,off,busy}[-dark].ico: the dark tile on a light taskbar, the light tile on a dark one (-dark),
  so it always stands out. Running: the tile as it is. Stopped: faded and grey. Converting: a small
  badge in the accent colour.

At 64 px and below the labyrinth's lines are thinner than a pixel and would fade to grey, so they are
thickened a little (a 3x3 minimum or maximum filter at four times the size) before the last step down.

    python tools/audio-server/native/res/make_icons.py      (needs Pillow; only to regenerate)
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageOps

HERE = Path(__file__).resolve().parent
TILES = HERE.parents[3] / "packages" / "kit" / "brand" / "app-icons"
OUT = HERE / "icons"

ACCENT = {"light": (0x16, 0x53, 0x66), "dark": (0x8F, 0xBD, 0xD0)}  # --ar-accent, theme.css
APP_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
TRAY_SIZES = [16, 20, 24, 32, 40, 48, 64]


def tile(variant, size):
    """The tile at `size`, lines kept visible, corners rounded."""
    src = Image.open(TILES / f"icon-{variant}-1024.png").convert("RGB")
    if size <= 64:
        big = src.resize((size * 4, size * 4), Image.LANCZOS)
        # Ink lines on the light tile, cream lines on the dark one: widen whichever is the line.
        big = big.filter(ImageFilter.MinFilter(3) if variant == "light" else ImageFilter.MaxFilter(3))
        img = big.resize((size, size), Image.LANCZOS)
    else:
        img = src.resize((size, size), Image.LANCZOS)
    n = size * 4
    mask = Image.new("L", (n, n), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, n - 1, n - 1), radius=int(n * 0.2), fill=255)
    out = img.convert("RGBA")
    out.putalpha(mask.resize((size, size), Image.LANCZOS))
    return out


def tray_icon(size, taskbar, state):
    variant = "dark" if taskbar == "light" else "light"
    t = tile(variant, size)
    if state == "off":
        grey = ImageOps.grayscale(t.convert("RGB")).convert("RGBA")
        grey.putalpha(t.getchannel("A").point(lambda a: a * 45 // 100))
        return grey
    if state == "busy":
        n = size * 4
        big = t.resize((n, n), Image.LANCZOS)
        r = int(n * 0.24)
        c = n - r - 1
        # A gap around the badge so it reads apart from the tile.
        hole = Image.new("L", (n, n), 255)
        gap = int(n * 0.07)
        ImageDraw.Draw(hole).ellipse((c - r - gap, c - r - gap, c + r + gap, c + r + gap), fill=0)
        big.putalpha(Image.composite(big.getchannel("A"), Image.new("L", (n, n), 0), hole))
        ImageDraw.Draw(big).ellipse((c - r, c - r, c + r, c + r), fill=ACCENT[taskbar] + (255,))
        return big.resize((size, size), Image.LANCZOS)
    return t


def save(name, images):
    images = sorted(images, key=lambda i: i.size[0], reverse=True)
    images[0].save(OUT / name, format="ICO", sizes=[i.size for i in images], append_images=images[1:])
    print(name)


def main():
    OUT.mkdir(exist_ok=True)
    save("app.ico", [tile("light", s) for s in APP_SIZES])
    for taskbar in ("light", "dark"):
        for state in ("on", "off", "busy"):
            suffix = "" if taskbar == "light" else "-dark"
            save(f"tray-{state}{suffix}.ico", [tray_icon(s, taskbar, state) for s in TRAY_SIZES])


if __name__ == "__main__":
    main()
