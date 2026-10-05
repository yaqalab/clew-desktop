"""
Draws the program's icons (res/icons/*.ico): a rounded square with a waveform, in three colours for
the tray (running, stopped, converting). Standard library only:

    python tools/audio-server/native/res/make_icons.py
"""

import struct
import zlib
from pathlib import Path

SIZES = [16, 20, 24, 32, 40, 48, 64, 256]
COLOURS = {
    "app": (0x1F, 0x7A, 0x74),
    "tray-on": (0x1F, 0x7A, 0x74),
    "tray-off": (0x86, 0x8C, 0x96),
    "tray-busy": (0xC4, 0x7F, 0x17),
}
# The waveform: bar heights as a share of the square.
BARS = [0.28, 0.55, 0.78, 0.46, 0.64, 0.30]


def inside_round_rect(x, y, size, radius):
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius**2


def inside_bar(x, y, size):
    n = len(BARS)
    pitch = size * 0.72 / n
    left = size * 0.14
    width = pitch * 0.56
    for i, h in enumerate(BARS):
        x0 = left + i * pitch + (pitch - width) / 2
        half = size * h / 2
        y0, y1 = size / 2 - half, size / 2 + half
        r = width / 2
        if x0 <= x <= x0 + width and y0 <= y <= y1:
            # rounded ends
            cy = min(max(y, y0 + r), y1 - r)
            if (x - (x0 + r)) ** 2 + (y - cy) ** 2 <= r * r:
                return True
    return False


def render(size, colour):
    ss = 4 if size < 64 else 2  # supersampling for smooth edges
    radius = size * 0.22
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            bg = fg = 0
            for sy in range(ss):
                for sx in range(ss):
                    x = px + (sx + 0.5) / ss
                    y = py + (sy + 0.5) / ss
                    if inside_round_rect(x, y, size, radius):
                        if inside_bar(x, y, size):
                            fg += 1
                        else:
                            bg += 1
            total = ss * ss
            a = (bg + fg) / total
            if a == 0:
                row += b"\0\0\0\0"
                continue
            mix = fg / (bg + fg)
            r, g, b = (round(c * (1 - mix) + 255 * mix) for c in colour)
            row += bytes((r, g, b, round(a * 255)))
        rows.append(bytes(row))
    return rows


def png(size, rows):
    raw = b"".join(b"\0" + r for r in rows)

    def chunk(kind, data):
        c = struct.pack(">I", len(data)) + kind + data
        return c + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def ico(images):
    head = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries, data = b"", b""
    for size, blob in images:
        dim = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(blob), offset + len(data))
        data += blob
    return head + entries + data


def main():
    out = Path(__file__).resolve().parent / "icons"
    out.mkdir(exist_ok=True)
    for name, colour in COLOURS.items():
        sizes = SIZES if name == "app" else [16, 20, 24, 32, 40, 48, 64]
        images = [(s, png(s, render(s, colour))) for s in sizes]
        (out / f"{name}.ico").write_bytes(ico(images))
        print(f"{name}.ico")


if __name__ == "__main__":
    main()
