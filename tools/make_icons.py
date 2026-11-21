"""Gera os ícones PNG da app (bandeira de xadrez sobre laranja), sem bibliotecas externas.
Uso: python tools/make_icons.py
"""
import os
import struct
import zlib

ORANGE = (255, 122, 26)
WHITE = (255, 255, 255)
DARK = (20, 23, 28)


def pixel(x, y, n):
    # zona da bandeira: 47% do ícone, centrada (fica dentro da zona segura "maskable")
    side = n * 240 / 512
    x0 = (n - side) / 2
    if x0 <= x < x0 + side and x0 <= y < x0 + side:
        cell = side / 4
        cx, cy = int((x - x0) // cell), int((y - x0) // cell)
        return DARK if (cx + cy) % 2 == 0 else WHITE
    return ORANGE


def write_png(path, n):
    rows = bytearray()
    for y in range(n):
        rows.append(0)
        for x in range(n):
            rows.extend(pixel(x, y, n))

    def chunk(tag, data):
        body = tag + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', n, n, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(rows), 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


if __name__ == '__main__':
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons')
    for size in (192, 512):
        write_png(os.path.join(out, f'icon-{size}.png'), size)
        print('icon', size, 'ok')
