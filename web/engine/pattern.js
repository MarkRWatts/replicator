import { brotherThread, isBrother, threadHex } from './threads.js';

// A pattern is { stitches: [{x, y, k}], threads: [thread per colour block] }.
// Coordinates are in PES units: 0.1 mm, y axis pointing down.
// k: STITCH, JUMP (move without sewing), TRIM (cut, then move), COLOR (next thread, then move).
export const STITCH = 0, JUMP = 1, TRIM = 2, COLOR = 3;

export function bounds(pattern) {
  const s = pattern.stitches;
  if (!s.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  let minX = s[0].x, maxX = s[0].x, minY = s[0].y, maxY = s[0].y;
  for (const p of s) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function stats(pattern) {
  const st = { stitches: 0, jumps: 0, trims: 0, colorChanges: 0 };
  for (const p of pattern.stitches) {
    if (p.k === STITCH) st.stitches++;
    else if (p.k === JUMP) st.jumps++;
    else if (p.k === TRIM) st.trims++;
    else st.colorChanges++;
  }
  return st;
}

/** Sewn runs as polylines, with the colour block each belongs to (for previews). */
export function polylines(pattern) {
  const out = [];
  let block = 0, cur = [];
  const flush = () => { if (cur.length > 1) out.push({ block, points: cur }); cur = []; };
  for (const p of pattern.stitches) {
    if (p.k === STITCH) cur.push([p.x, p.y]);
    else {
      flush();
      if (p.k === COLOR) block++;
      cur = [[p.x, p.y]];
    }
  }
  flush();
  return out;
}

/** Human-readable thread sequence, saved next to exported files (the machine only shows Brother colours). */
export function threadListText(pattern, name) {
  const st = stats(pattern), b = bounds(pattern), usage = threadUsage(pattern);
  const lines = [
    `${name} — ${(b.width / 10).toFixed(1)} × ${(b.height / 10).toFixed(1)} mm, ${st.stitches} stitches, ` +
      `${Math.max(0, pattern.threads.length - 1)} colour changes`,
    '',
    'Sewing order (estimated top thread per colour, ±25%):',
  ];
  pattern.threads.forEach((t, i) => {
    const shown = isBrother(t) ? '' : `   (machine shows: ${brotherThread(t.pecIndex).name})`;
    const m = usage.blocks[i];
    const amount = (m < 10 ? m.toFixed(1) : Math.ceil(m).toString()).padStart(5) + ' m';
    lines.push(`  ${String(i + 1).padStart(2)}. ${amount}  ${t.brand} ${t.code} – ${t.name} ${threadHex(t)}${shown}`);
  });
  lines.push('', `Total: about ${Math.ceil(usage.top)} m of top thread and ${Math.ceil(usage.bobbin)} m of bobbin thread.`);
  return lines.join('\n') + '\n';
}

// Thread use per stitch beyond its visible length: down through the fabric, around the bobbin thread and
// back up. Set so a professionally digitised design (Brother's Phoenix sample, 2.6 mm average stitch) lands on
// the industry rule of thumb of about 5 m of top thread per 1,000 stitches.
const PENETRATION_MM = 2.4;
// Tail left at the start and end of each run of stitching (after a trim or colour change).
const TAIL_MM = 40;

/**
 * Estimated thread use. For each colour block: the sewn length (exact), plus an allowance per stitch
 * for passing through the fabric, plus tails where the thread is cut. Fabric, tension and speed move the
 * real figure, so treat it as ±25%.
 * @returns { blocks: [metres of top thread per colour block], top, bobbin } in metres
 */
export function threadUsage(pattern) {
  const blocks = pattern.threads.map(() => 0);
  let block = 0, prev = null, runs = 0;
  const add = (mm) => { if (block < blocks.length) blocks[block] += mm; };
  for (const s of pattern.stitches) {
    if (s.k === STITCH) {
      if (prev) {
        add(Math.hypot(s.x - prev.x, s.y - prev.y) / 10 + PENETRATION_MM);
      } else {
        add(2 * TAIL_MM); // a new run: tail at its start and at its end
        runs++;
      }
      prev = s;
    } else {
      if (s.k === COLOR) block++;
      // A plain jump carries the thread along uncut, so its length counts; a trim or colour change cuts it.
      if (s.k === JUMP) { if (prev) add(Math.hypot(s.x - prev.x, s.y - prev.y) / 10); prev = s; }
      else prev = null;
    }
  }
  const metres = blocks.map((mm) => mm / 1000);
  const top = metres.reduce((a, b) => a + b, 0);
  // The bobbin shows only on the back: about a third to a half of the top thread, depending on stitch type.
  return { blocks: metres, top, bobbin: top * 0.4, runs };
}
