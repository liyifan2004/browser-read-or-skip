"""生成 Read or Skip 扩展图标（纯标准库，无依赖）。

设计：圆角方形 + 蓝紫渐变底 + 白色对勾。
用 4x 超采样后降采样得到抗锯齿边缘。
"""
import struct
import zlib
import os
import math

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
OUT = os.path.abspath(OUT)
SS = 4  # 超采样倍数

C1 = (59, 130, 246)   # #3B82F6
C2 = (139, 92, 246)   # #8B5CF6


def rounded_rect_alpha(x, y, w, h, r):
    """点 (x,y) 在圆角矩形内的覆盖率（0~1，硬边）。"""
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    d = math.hypot(x - cx, y - cy)
    if d <= r:
        return 1.0
    return 0.0


def seg_dist(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    L2 = vx * vx + vy * vy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / L2))
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy))


def render(size):
    S = size * SS
    # 像素累积缓冲
    acc = [[[0.0, 0.0, 0.0, 0.0] for _ in range(size)] for _ in range(size)]

    r = S * 0.22
    stroke = S * 0.115
    # 对勾三点
    p1 = (S * 0.255, S * 0.520)
    p2 = (S * 0.437, S * 0.700)
    p3 = (S * 0.757, S * 0.310)

    for sy in range(S):
        for sx in range(S):
            x = sx + 0.5
            y = sy + 0.5
            a = rounded_rect_alpha(x, y, S, S, r)
            if a <= 0:
                continue
            t = (x + y) / (2.0 * S)
            cr = C1[0] + (C2[0] - C1[0]) * t
            cg = C1[1] + (C2[1] - C1[1]) * t
            cb = C1[2] + (C2[2] - C1[2]) * t

            d = min(seg_dist(x, y, p1[0], p1[1], p2[0], p2[1]),
                    seg_dist(x, y, p2[0], p2[1], p3[0], p3[1]))
            half = stroke / 2.0
            if d <= half:
                k = 1.0
            elif d <= half + 1.0 * SS:
                k = 1.0 - (d - half) / (1.0 * SS)
            else:
                k = 0.0
            if k > 0:
                cr = cr + (255 - cr) * k
                cg = cg + (255 - cg) * k
                cb = cb + (255 - cb) * k

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
            a = a_ / n
            if a <= 0.5:
                row += bytes((0, 0, 0, 0))
            else:
                row += bytes((int(round(r_ / n)), int(round(g_ / n)), int(round(b_ / n)), int(round(a))))
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
