#!/usr/bin/env python3
"""Generate ClipHawk icons (no dependencies). Run: python3 scripts/make_icons.py"""
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(__file__), "..", "icons")
SS = 4  # supersampling


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def in_rounded(x, y, r):
    cx = min(max(x, r), 1 - r)
    cy = min(max(y, r), 1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_tri(x, y, a, b, c):
    def s(p, q, r):
        return (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1])
    d1, d2, d3 = s((x, y), a, b), s((x, y), b, c), s((x, y), c, a)
    neg = d1 < 0 or d2 < 0 or d3 < 0
    pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (neg and pos)


def pixel(x, y):
    """Return RGBA for normalized coords in [0,1]."""
    if not in_rounded(x, y, 0.22):
        return (0, 0, 0, 0)
    # warm gradient background
    bg = lerp((255, 122, 0), (255, 196, 84), (x + y) / 2)
    dark = (24, 18, 10)
    # play triangle (upper)
    if in_tri(x, y, (0.36, 0.18), (0.36, 0.56), (0.70, 0.37)):
        return dark + (255,)
    # download arrow: stem + head + tray
    if 0.455 <= x <= 0.545 and 0.56 <= y <= 0.70:
        return dark + (255,)
    if in_tri(x, y, (0.33, 0.66), (0.67, 0.66), (0.50, 0.82)):
        return dark + (255,)
    if 0.24 <= x <= 0.76 and 0.85 <= y <= 0.90:
        return dark + (255,)
    return bg + (255,)


def render(size):
    rows = []
    n = size * SS
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    r, g, b, a = pixel((px * SS + sx + 0.5) / n, (py * SS + sy + 0.5) / n)
                    acc[0] += r * a; acc[1] += g * a; acc[2] += b * a; acc[3] += a
            a = acc[3] / (SS * SS)
            if acc[3]:
                row += bytes([round(acc[0] / acc[3]), round(acc[1] / acc[3]), round(acc[2] / acc[3]), round(a)])
            else:
                row += bytes(4)
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for s in (16, 32, 48, 128):
        with open(os.path.join(OUT, f"icon{s}.png"), "wb") as f:
            f.write(render(s))
    print("icons written to", os.path.abspath(OUT))
