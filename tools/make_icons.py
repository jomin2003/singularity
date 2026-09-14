"""Generate SINGULARITY PWA icons as PNGs using only the stdlib."""
import zlib, struct, math, os

def clamp(v, a=0.0, b=1.0):
    return a if v < a else (b if v > b else v)

def mix(c1, c2, t):
    t = clamp(t)
    return tuple(c1[i] + (c2[i] - c1[i]) * t for i in range(3))

def write_png(path, size, px):
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)                                  # filter type 0
        raw += px[y * stride:(y + 1) * stride]

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    out = b'\x89PNG\r\n\x1a\n'
    out += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    out += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    out += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(out)

def render(size):
    px = bytearray(size * size * 4)
    c = (size - 1) / 2.0
    R = size / 2.0
    core, ring, halo = 0.25, 0.295, 0.74
    for y in range(size):
        for x in range(size):
            d = math.hypot((x - c) / R, (y - c) / R)
            bgl = 1.0 - clamp(d / 1.45) * 0.55
            r, g, b = 5 * bgl, 6 * bgl, 15 * bgl

            if d <= core:
                r = g = b = 0.0
            elif d < ring + 0.035:
                t = (d - core) / (ring + 0.035 - core)
                k = clamp(1.0 - abs(t - 0.42) / 0.58) ** 1.5
                cr, cg, cb = mix((255, 255, 255), (110, 235, 255), t)
                r += cr * k; g += cg * k; b += cb * k
            else:
                gl = math.exp(-(((d - ring) / 0.185) ** 2) * 2.0)
                f = clamp((d - ring) / (halo - ring))
                cr, cg, cb = mix((79, 240, 255), (155, 107, 255), f)
                r += cr * gl * 0.9; g += cg * gl * 0.9; b += cb * gl * 0.9

            i = (y * size + x) * 4
            px[i]     = int(clamp(r / 255.0) * 255)
            px[i + 1] = int(clamp(g / 255.0) * 255)
            px[i + 2] = int(clamp(b / 255.0) * 255)
            px[i + 3] = 255
    return px

base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out_dir = os.path.join(base, 'www', 'icons')
os.makedirs(out_dir, exist_ok=True)
for s in (192, 512):
    write_png(os.path.join(out_dir, 'icon-%d.png' % s), s, render(s))
    print('wrote icons/icon-%d.png' % s)
