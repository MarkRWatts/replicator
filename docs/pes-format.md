# PES format

As worked out from Brother-generated files (a Brother Innov-is 750E's designs). The writer in
[`web/engine/pes.js`](../web/engine/pes.js) follows this layout, and reproduces Brother's own files byte for byte apart
from the thumbnail pixels.

All integers are little-endian unless noted. Units are 0.1 mm.

**PES v1 header**
| bytes | meaning |
|---|---|
| `#PES0001` | magic |
| u32 | offset of PEC section |
| u16, u16, u16 | scale-to-fit (0/1), hoop (1 = 130×180), object count (1) |
| `FFFF 0000`, u16 len + `CEmbOne` | object header |
| 8 × i16 | bounds left, top, right, bottom (twice); design centred on (1000,1000) |
| 6 × f32 | affine matrix `1 0 0 1 left bottom` |
| u16 1, i16 0, i16 0, i16 width, i16 height, 8 zero bytes | |
| u16 | number of stitch blocks |
| `FFFF 0000`, u16 len + `CSewSeg` | |
| blocks | u16 type (0 stitches / 1 jump), u16 thread, u16 count, count × (i16 x, i16 y) relative to (left, bottom); separated by `0x8003`; stitch blocks split at 1000 points |
| colour log | u16 count, then (u16 block index, u16 thread) at each colour change |
| u32 0 | |

**PEC section** (what the machine actually sews from)
- `LA:` + 16-char label + `\r`, 12 spaces, `FF 00 06 26`, 12 spaces, (colours − 1), thread indexes into Brother's
  fixed 64-colour palette, padded with spaces to 512 bytes.
- Stitch header (20 bytes): `00 00`, u24 length of this block, `31 FF F0`, u16 width, u16 height, `E0 01 B0 01`,
  big-endian `0x9000 | −minX` and `0x9000 | −minY`.
- Stitches: deltas from the previous point, each coordinate independently either 1 byte (7-bit two's
  complement, −64…63) or 2 bytes big-endian `1 f f f n n n n n n n n n n n n`, 12-bit value, flag `0x10` = jump,
  `0x20` = trim. `FE B0 xx` = colour change (xx alternates 2, 1, …), followed by a jump. `FF` ends.
- Thumbnails: 48×38 1-bit bitmaps (6 bytes/row, LSB = leftmost), one for the whole design and one per colour.
- Newer Brother software appends a 128-byte copy of the colour table.
