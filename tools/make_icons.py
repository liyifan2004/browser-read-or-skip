"""生成 Read or Skip 扩展图标（纯标准库，无依赖）。

设计（2025 UI 审查定稿）：单色 accent 蓝圆角方底 + 白色三段递减直角横条，
即「读 / 扫 / 跳」的刻度隐喻。用 4x 超采样降采样得到抗锯齿边缘。

光学尺寸调整：16px 只用两条（三条在 1x 屏上间距只剩 ~0.8px 会糊成一块），
32px 及以上才用完整的三条。这是尺寸特定的光学调整，不是两套图标。
"""
import struct
import zlib
import os
import math

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
OUT = os.path.abspath(OUT)
SS = 4  # 超采样倍数

ACCENT = (59, 130, 246)   # #3B82F6
WHITE = (255, 255, 255)

# 24 单位坐标空间的横条定义：(x, y, w, h, rx)
GLYPH_3 = [
    (4.0, 3.6, 16.0, 3.6, 1.8),
    (4.0, 10.2, 10.5, 3.6, 1.8),
    (4.0, 16.8, 5.0, 3.6, 1.8),
]
GLYPH_2 = [
    (3.5, 5.25, 17.0, 4.5, 2.25),
    (3.5, 14.25, 10.0, 4.5, 2.25),
]


def rounded_rect_cov(x, y, x0, y0, x1, y1, r):
    """点 (x,y) 是否在圆角矩形内（0/1 硬边，靠超采样做抗锯齿）。"""
    if x < x0 or x > x1 or y < y0 or y > y1:
        return 0.0
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return 1.0 if math.hypot(x - cx, y - cy) <= r else 0.0


def glyph_bars(size):
    """按图标尺寸挑选横条组，并把 24 单位空间映射到内边距盒。"""
    bars = GLYPH_2 if size <= 20 else GLYPH_3
    pad = size * 0.16
    inner = size - pad * 2
    scale = inner / 24.0
    return [
        (pad + x * scale, pad + y * scale, pad + (x + w) * scale, pad + (y + h) * scale, rx * scale)
        for (x, y, w, h, rx) in bars
    ]


def render(size):
    S = size * SS
    radius = size * 0.22
    bars = glyph_bars(size)
    acc = [[[0.0, 0.0, 0.0, 0.0] for _ in range(size)] for _ in range(size)]

    for sy in range(S):
        for sx in range(S):
            x = (sx + 0.5) / SS
            y = (sy + 0.5) / SS

            a = rounded_rect_cov(x, y, 0.0, 0.0, float(size), float(size), radius)
            if a <= 0:
                continue

            cr, cg, cb = ACCENT
            for (bx0, by0, bx1, by1, br) in bars:
                if rounded_rect_cov(x, y, bx0, by0, bx1, by1, br) > 0:
                    cr, cg, cb = WHITE
                    break

            bx, by = sx // SS, sy // SS
            acc[by][bx][0] += cr
            acc[by][bx][1] += cg
            acc[by][bx][2] += cb
            acc[by][bx][3] += a * 255.0

    n = float(SS * SS)
    rows = []
    for by in range(size):
        row = bytearray()
        for bx in range(size):
            r_, g_, b_, a_ = acc[by][bx]
            alpha = a_ / n
            if alpha <= 0.5:
                row += bytes((0, 0, 0, 0))
            else:
                row += bytes((int(round(r_ / n)), int(round(g_ / n)), int(round(b_ / n)), int(round(alpha))))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)
    return len(png)


def main():
    os.makedirs(OUT, exist_ok=True)
    for size in (16, 32, 48, 128):
        rows = render(size)
        p = os.path.join(OUT, "icon%d.png" % size)
        n = write_png(p, size, rows)
        print("icon%d.png  %d bytes" % (size, n))


if __name__ == "__main__":
    main()
