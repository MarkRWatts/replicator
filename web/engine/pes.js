import { STITCH, JUMP, TRIM, COLOR, bounds } from './pattern.js';
import { brotherThread } from './threads.js';

/*
 * PES version 1 ("#PES0001"), laid out the same way as Brother-generated files:
 *
 *   "#PES0001"  u32 offset of PEC section
 *   u16 scale-to-fit, u16 hoop (1 = 130x180), u16 object count, FFFF 0000
 *   "CEmbOne" header: bounds x2, 2x3 float affine matrix, size, block count
 *   FFFF 0000 "CSewSeg": stitch blocks separated by 0x8003, colour log, u32 0
 *   PEC section: 512 byte header (label + thread table), 20 byte stitch header,
 *                delta-encoded stitches, 0xFF, 48x38 1-bit thumbnails (one + one per colour),
 *                128 byte copy of the colour table
 */

// ---------------------------------------------------------------- reading

/** Reads a PES file's stitches from its embedded PEC section (the part Brother machines sew from). */
export function readPES(buffer) {
  const d = new Uint8Array(buffer);
  if (d.length < 12 || String.fromCharCode(d[0], d[1], d[2], d[3]) !== '#PES') throw new Error('This is not a PES embroidery file.');
  const pec = d[8] | (d[9] << 8) | (d[10] << 16) | (d[11] << 24);
  if (pec + 532 >= d.length) throw new Error('The PES file is truncated or corrupt.');
  const label = String.fromCharCode(...d.subarray(pec + 3, pec + 19)).trim();
  const colorCount = d[pec + 48] + 1;
  const threads = [];
  for (let i = 0; i < colorCount; i++) threads.push(brotherThread(d[pec + 49 + i]));

  let p = pec + 512 + 20, x = 0, y = 0, pendingColor = false;
  const stitches = [];
  const value = () => {
    if (p >= d.length) throw new Error('The PES file is truncated or corrupt.');
    const v = d[p];
    if (v & 0x80) {
      let n = ((v & 0x0f) << 8) | d[p + 1];
      if (n & 0x800) n -= 0x1000;
      p += 2;
      return [n, v & 0x70];
    }
    p += 1;
    return [v > 0x3f ? v - 128 : v, 0];
  };
  while (p < d.length) {
    if (d[p] === 0xff) break;
    if (d[p] === 0xfe && d[p + 1] === 0xb0) { p += 3; pendingColor = true; continue; }
    const [dx, fx] = value();
    const [dy, fy] = value();
    x += dx; y += dy;
    const flags = fx | fy;
    let k = STITCH;
    if (pendingColor) { k = COLOR; pendingColor = false; }
    else if (flags & 0x20) k = TRIM;
    else if (flags & 0x10) k = JUMP;
    stitches.push({ x, y, k });
  }
  return { pattern: { stitches, threads }, label };
}

// ---------------------------------------------------------------- writing

class ByteWriter {
  constructor() { this.buf = new Uint8Array(1 << 16); this.length = 0; }
  ensure(n) {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const nb = new Uint8Array(size); nb.set(this.buf.subarray(0, this.length)); this.buf = nb;
  }
  byte(v) { this.ensure(1); this.buf[this.length++] = v & 0xff; }
  bytes(arr) { this.ensure(arr.length); for (const v of arr) this.buf[this.length++] = v & 0xff; }
  ascii(s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }
  u16(v) { this.byte(v); this.byte(v >> 8); }
  i16(v) { this.u16(Math.max(-32768, Math.min(32767, v)) & 0xffff); }
  u16be(v) { this.byte(v >> 8); this.byte(v); }
  u32(v) { this.byte(v); this.byte(v >> 8); this.byte(v >> 16); this.byte(v >>> 24); }
  f32(v) { const b = new Uint8Array(new Float32Array([v]).buffer); this.bytes(b); }
  string16(s) { this.u16(s.length); this.ascii(s); }
  patch(pos, arr) { arr.forEach((v, i) => { this.buf[pos + i] = v & 0xff; }); }
  result() { return this.buf.slice(0, this.length); }
}

export function writePES(input, label) {
  let stitches = input.stitches.map((s) => ({ ...s }));
  const threads = input.threads.length ? input.threads : [brotherThread(20)];
  // The PEC stitch stream starts at (0,0), so make the first stitch the origin.
  if (stitches.length) {
    const { x: fx, y: fy } = stitches[0];
    for (const s of stitches) { s.x -= fx; s.y -= fy; }
  }
  // The PEC header stores the offset to the top-left corner in 12 bits. For very large
  // designs start from the centre instead, with a jump to the first stitch.
  const pre = bounds({ stitches });
  if (stitches.length && (-pre.minX > 2047 || -pre.minY > 2047 || pre.maxX > 2047 || pre.maxY > 2047)) {
    const cx = Math.trunc((pre.minX + pre.maxX) / 2), cy = Math.trunc((pre.minY + pre.maxY) / 2);
    for (const s of stitches) { s.x -= cx; s.y -= cy; }
    stitches.unshift({ x: stitches[0].x, y: stitches[0].y, k: JUMP });
  }
  const pattern = { stitches, threads };
  const colors = threads.map((t) => t.pecIndex);
  const b = bounds(pattern);
  const out = new ByteWriter();

  // ---- PES header
  out.ascii('#PES0001');
  const pecOffsetPos = out.length;
  out.u32(0);
  out.u16(0); // scale to fit
  out.u16(1); // hoop: 130x180
  out.u16(1); // one design object
  out.u16(0xffff); out.u16(0);
  out.string16('CEmbOne');
  // Place the design centred on (1000, 1000), as Brother's software does.
  const left = 1000 - Math.trunc(b.width / 2), top = 1000 - Math.trunc(b.height / 2);
  const right = left + b.width, bottom = top + b.height;
  for (let i = 0; i < 2; i++) { out.i16(left); out.i16(top); out.i16(right); out.i16(bottom); }
  for (const v of [1, 0, 0, 1, left, bottom]) out.f32(v);
  out.u16(1); out.i16(0); out.i16(0); out.i16(b.width); out.i16(b.height);
  out.bytes(new Array(8).fill(0));

  const blocks = pesBlocks(pattern, colors, b);
  out.u16(blocks.length);
  out.u16(0xffff); out.u16(0);
  out.string16('CSewSeg');
  const colorLog = [];
  blocks.forEach((block, i) => {
    if (i > 0) out.u16(0x8003);
    out.u16(block.flag); out.u16(block.color); out.u16(block.points.length);
    for (const [x, y] of block.points) { out.i16(x); out.i16(y); }
    if (!colorLog.length || colorLog[colorLog.length - 1][1] !== block.color) colorLog.push([i, block.color]);
  });
  out.u16(colorLog.length);
  for (const [section, color] of colorLog) { out.u16(section); out.u16(color); }
  out.u32(0);

  // ---- PEC section
  const pec = out.length;
  out.patch(pecOffsetPos, [pec, pec >> 8, pec >> 16, pec >>> 24]);
  const name = machineLabel(label).padEnd(16, ' ');
  out.ascii('LA:' + name + '\r');
  out.bytes(new Array(12).fill(0x20));
  out.bytes([0xff, 0x00, 0x06, 0x26]);
  out.bytes(new Array(12).fill(0x20));
  out.byte(colors.length - 1);
  out.bytes(colors);
  out.bytes(new Array(463 - colors.length).fill(0x20));

  const blockStart = out.length;
  out.bytes([0x00, 0x00]);
  const lengthPos = out.length;
  out.bytes([0, 0, 0]);
  out.bytes([0x31, 0xff, 0xf0]);
  out.i16(b.width); out.i16(b.height);
  out.u16(0x1e0); out.u16(0x1b0);
  out.u16be(0x9000 | (-b.minX & 0xfff));
  out.u16be(0x9000 | (-b.minY & 0xfff));
  encodeStitches(stitches, out);
  out.byte(0xff);
  const length = out.length - blockStart;
  out.patch(lengthPos, [length, length >> 8, length >> 16]);

  out.bytes(thumbnail(pattern, null, b));
  for (let i = 0; i < colors.length; i++) out.bytes(thumbnail(pattern, i, b));
  // Newer Brother software appends a 128 byte copy of the colour table.
  out.byte(colors.length - 1);
  out.bytes(colors);
  out.bytes(new Array(127 - colors.length).fill(0x20));
  return out.result();
}

/**
 * The design name as the machine shows it: the PEC label holds 16 plain ASCII characters, so accents are
 * dropped from letters (ü → u) and anything else outside printable ASCII is removed.
 */
export function machineLabel(name) {
  return (name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
}

function pesBlocks(pattern, colors, b) {
  const blocks = [];
  let colorIndex = 0;
  const color = () => colors[Math.min(colorIndex, colors.length - 1)];
  let last = [0, -b.height]; // top-left corner of the design
  let jumpFrom = last, jumpTo = null;
  for (const s of pattern.stitches) {
    const p = [s.x - b.minX, s.y - b.maxY];
    if (s.k === STITCH) {
      if (jumpFrom) {
        const to = jumpTo || p;
        blocks.push({ flag: 1, color: color(), points: [jumpFrom, to] });
        blocks.push({ flag: 0, color: color(), points: [to] });
        jumpFrom = null; jumpTo = null;
      } else if (blocks[blocks.length - 1].points.length >= 1000) {
        blocks.push({ flag: 0, color: color(), points: [last] });
      }
      blocks[blocks.length - 1].points.push(p);
    } else {
      if (s.k === COLOR) colorIndex++;
      if (!jumpFrom) jumpFrom = last;
      jumpTo = p;
    }
    last = p;
  }
  return blocks;
}

function encodeStitches(stitches, out) {
  let x = 0, y = 0, colorToggle = true;
  const long = (v, flag) => { const n = (v & 0x0fff) | 0x8000 | (flag << 8); out.byte(n >> 8); out.byte(n); };
  // Move with long-form coordinates, splitting moves beyond the 12-bit range.
  const move = (tx, ty, flag) => {
    let f = flag;
    do {
      const dx = Math.max(-2047, Math.min(2047, tx - x)), dy = Math.max(-2047, Math.min(2047, ty - y));
      long(dx, f); long(dy, f);
      x += dx; y += dy;
      if (f === 0x20) f = 0x10; // only cut once
    } while (x !== tx || y !== ty);
  };
  for (const s of stitches) {
    if (s.k === STITCH) {
      const dx = s.x - x, dy = s.y - y;
      if (Math.abs(dx) <= 2047 && Math.abs(dy) <= 2047) {
        // Each coordinate independently uses the 1-byte form when it fits.
        for (const v of [dx, dy]) { if (v >= -64 && v <= 63) out.byte(v & 0x7f); else long(v, 0); }
        x = s.x; y = s.y;
      } else move(s.x, s.y, 0x10);
    } else if (s.k === JUMP) move(s.x, s.y, 0x10);
    else if (s.k === TRIM) move(s.x, s.y, 0x20);
    else {
      out.bytes([0xfe, 0xb0, colorToggle ? 2 : 1]);
      colorToggle = !colorToggle;
      move(s.x, s.y, 0x10);
    }
  }
}

/** 48x38 pixel 1-bit thumbnail (6 bytes per row, LSB = leftmost pixel) with Brother's rounded frame. */
function thumbnail(pattern, block, b) {
  const img = new Uint8Array(228);
  const set = (px, py) => {
    if (px < 0 || px >= 48 || py < 0 || py >= 38) return;
    img[py * 6 + (px >> 3)] |= 1 << (px & 7);
  };
  for (let px = 4; px <= 43; px++) { set(px, 1); set(px, 36); }
  set(3, 2); set(44, 2); set(3, 35); set(44, 35);
  set(2, 3); set(45, 3); set(2, 34); set(45, 34);
  for (let py = 4; py <= 33; py++) { set(1, py); set(46, py); }
  const areaW = 38, areaH = 28, areaX = 5, areaY = 5;
  const w = Math.max(b.width, 1), h = Math.max(b.height, 1);
  const scale = Math.min(areaW / w, areaH / h);
  const ox = areaX + (areaW - w * scale) / 2, oy = areaY + (areaH - h * scale) / 2;
  let colorIndex = 0;
  for (const s of pattern.stitches) {
    if (s.k === COLOR) colorIndex++;
    if (s.k !== STITCH || (block !== null && block !== colorIndex)) continue;
    set(Math.trunc(ox + (s.x - b.minX) * scale), Math.trunc(oy + (s.y - b.minY) * scale));
  }
  return img;
}
