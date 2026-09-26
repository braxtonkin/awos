import { inflateSync } from 'node:zlib';

export type Pixels = { readonly width: number; readonly height: number; readonly rgba: Uint8Array };

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const channelsOf: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(left: number, up: number, upLeft: number): number {
  const p = left + up - upLeft;
  const [dl, du, dul] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
  return dl <= du && dl <= dul ? left : du <= dul ? up : upLeft;
}

export function decode(png: Buffer): Pixels {
  if (!png.subarray(0, 8).equals(signature)) throw new Error('the file is not a PNG');
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body.readUInt8(8);
      channels = channelsOf[body.readUInt8(9)] ?? 0;
      if (depth !== 8 || channels === 0 || body.readUInt8(12) !== 0) throw new Error('only 8-bit, non-interlaced grey, RGB, and RGBA PNGs are supported');
    } else if (type === 'IDAT') data.push(body);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x] ?? 0;
      const left = x >= channels ? (out[y * stride + x - channels] ?? 0) : 0;
      const up = y > 0 ? (out[(y - 1) * stride + x] ?? 0) : 0;
      const upLeft = x >= channels && y > 0 ? (out[(y - 1) * stride + x - channels] ?? 0) : 0;
      const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter] ?? 0;
      out[y * stride + x] = (value + predicted) & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const pixel = [...out.subarray(i * channels, i * channels + channels)];
    const [r = 0, g = r, b = r] = channels <= 2 ? [pixel[0] ?? 0] : pixel;
    rgba.set([r, g, b, channels === 4 ? (pixel[3] ?? 255) : channels === 2 ? (pixel[1] ?? 255) : 255], i * 4);
  }
  return { width, height, rgba };
}

export function differing(a: Pixels, b: Pixels, tolerance: number): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`the images are ${String(a.width)}x${String(a.height)} and ${String(b.width)}x${String(b.height)}`);
  let count = 0;
  for (let i = 0; i < a.rgba.length; i += 4) {
    if ([0, 1, 2].some(c => Math.abs((a.rgba[i + c] ?? 0) - (b.rgba[i + c] ?? 0)) > tolerance)) count += 1;
  }
  return count / (a.width * a.height);
}
