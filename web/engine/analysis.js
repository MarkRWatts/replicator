import { rgbToLab, labToRgb, labDist2 } from './color.js';

// Reduces an image to a few colours on a grid of fixed physical size.
// Images arrive as { width, height, data } RGBA (un-premultiplied, row 0 at the top), already resampled.

const opaque = (img, i) => img.data[i * 4 + 3] >= 128;
const labAt = (img, i) => rgbToLab(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]);

/**
 * @param small  the image at ~200 px, used to find the colours (so they stay stable as the size changes)
 * @param grid   the image resampled to one pixel per `cellMM`
 * @returns { cellMM, width, height, labels: Int32Array (cluster per cell or -1), clusters }
 */
export function analyze(small, grid, { colorCount, minRegionMM2 = 1.5, cellMM = 0.2 }) {
  const samples = [];
  for (let i = 0; i < small.width * small.height; i++) if (opaque(small, i)) samples.push(labAt(small, i));
  const centers = kMeans(samples, Math.max(1, colorCount));

  const w = grid.width, h = grid.height;
  let labels = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) labels[i] = opaque(grid, i) ? nearest(labAt(grid, i), centers) : -1;

  // Clean up: majority filter, then absorb specks too small to sew and thin anti-aliasing slivers.
  labels = majorityFilter(majorityFilter(labels, w, h), w, h);
  const minCells = Math.max(1, Math.floor(minRegionMM2 / (cellMM * cellMM)));
  labels = removeSmallRegions(labels, w, h, minCells, false);
  labels = removeSmallRegions(labels, w, h, minCells, true);

  const counts = new Array(centers.length).fill(0);
  let opaqueCount = 0;
  for (const l of labels) if (l >= 0) { counts[l]++; opaqueCount++; }
  const border = new Array(centers.length).fill(0);
  let borderTotal = 0;
  const sample = (x, y) => { borderTotal++; const l = labels[y * w + x]; if (l >= 0) border[l]++; };
  for (let x = 0; x < w; x++) { sample(x, 0); sample(x, h - 1); }
  for (let y = 0; y < h; y++) { sample(0, y); sample(w - 1, y); }
  const bgIndex = border.indexOf(Math.max(...border));
  const transparentBorder = border.reduce((a, b) => a + b, 0) < borderTotal / 2;

  const clusters = centers.map((c, i) => {
    const [r, g, b] = labToRgb(c);
    return {
      id: i, r, g, b,
      coverage: opaqueCount ? counts[i] / opaqueCount : 0,
      looksLikeBackground: !transparentBorder && i === bgIndex && border[i] >= 0.4 * borderTotal,
    };
  });
  return { cellMM, width: w, height: h, labels, clusters };
}

function nearest(p, centers) {
  let best = 0, bestD = Infinity;
  for (let j = 0; j < centers.length; j++) {
    const d = labDist2(p, centers[j]);
    if (d < bestD) { bestD = d; best = j; }
  }
  return best;
}

/** Small deterministic PRNG, so the same image always gives the same colours. */
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** k-means++ in Lab space. */
function kMeans(samples, k) {
  if (!samples.length) return [[0, 0, 0]];
  const rand = mulberry32(12345);
  const centers = [samples[samples.length >> 1]];
  const dist = samples.map((s) => labDist2(s, centers[0]));
  while (centers.length < k) {
    const total = dist.reduce((a, b) => a + b, 0);
    if (total <= 0) break;
    let t = rand() * total, pick = samples.length - 1;
    for (let i = 0; i < dist.length; i++) { t -= dist[i]; if (t <= 0) { pick = i; break; } }
    const c = samples[pick];
    centers.push(c);
    for (let i = 0; i < samples.length; i++) dist[i] = Math.min(dist[i], labDist2(samples[i], c));
  }
  for (let iter = 0; iter < 20; iter++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (const s of samples) {
      const j = nearest(s, centers);
      sums[j][0] += s[0]; sums[j][1] += s[1]; sums[j][2] += s[2]; sums[j][3]++;
    }
    let moved = false;
    for (let j = 0; j < centers.length; j++) {
      const n = sums[j][3];
      if (!n) continue;
      const c = [sums[j][0] / n, sums[j][1] / n, sums[j][2] / n];
      if (labDist2(c, centers[j]) > 0.01) moved = true;
      centers[j] = c;
    }
    if (!moved) break;
  }
  return centers;
}

function majorityFilter(labels, w, h) {
  const out = new Int32Array(labels.length);
  const tally = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      tally.clear();
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const l = labels[yy * w + xx];
          tally.set(l, (tally.get(l) || 0) + 1);
        }
      }
      const own = labels[y * w + x];
      let best = own, bestN = tally.get(own) || 0;
      for (const [l, n] of tally) if (n > bestN) { best = l; bestN = n; }
      out[y * w + x] = bestN >= 5 ? best : own;
    }
  }
  return out;
}

/**
 * Merges connected regions smaller than `minCells` into their most common neighbouring label. With
 * `requireCore`, regions of any size are also merged if they are nowhere more than ~2 cells thick.
 */
function removeSmallRegions(input, w, h, minCells, requireCore) {
  const labels = Int32Array.from(input);
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    const seen = new Uint8Array(w * h);
    const stack = [];
    for (let start = 0; start < w * h; start++) {
      if (seen[start]) continue;
      const l = labels[start];
      const region = [];
      let neighbours = new Map();
      stack.push(start); seen[start] = 1;
      while (stack.length) {
        const i = stack.pop();
        region.push(i);
        const x = i % w, y = (i / w) | 0;
        for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (labels[j] === l) { if (!seen[j]) { seen[j] = 1; stack.push(j); } }
          else if (region.length < minCells) neighbours.set(labels[j], (neighbours.get(labels[j]) || 0) + 1);
        }
      }
      let remove = region.length < minCells;
      if (!remove && requireCore && l >= 0) {
        remove = !region.some((i) => {
          const x = i % w, y = (i / w) | 0;
          if (x <= 0 || y <= 0 || x >= w - 1 || y >= h - 1) return false;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (labels[(y + dy) * w + x + dx] !== l) return false;
          return true;
        });
        if (remove) {
          neighbours = new Map();
          for (const i of region) {
            const x = i % w, y = (i / w) | 0;
            for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const n = labels[ny * w + nx];
              if (n !== l) neighbours.set(n, (neighbours.get(n) || 0) + 1);
            }
          }
        }
      }
      if (remove && neighbours.size) {
        let target = null, bestN = -1;
        for (const [n, c] of neighbours) if (c > bestN) { bestN = c; target = n; }
        for (const i of region) labels[i] = target;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return labels;
}

/**
 * Bounding box of the design inside a plain border (transparent, or the colour of the corners), with a
 * small margin, so that the chosen size refers to the design rather than the canvas.
 * `img` is a downscaled copy; the result is in its pixel units.
 */
export function contentBox(img) {
  const { width: w, height: h } = img;
  const corners = [0, w - 1, (h - 1) * w, h * w - 1];
  const transparent = corners.every((i) => !opaque(img, i));
  const bg = labAt(img, corners[0]);
  if (!transparent && !corners.every((i) => opaque(img, i) && labDist2(labAt(img, i), bg) < 100)) return null;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const isBG = transparent ? !opaque(img, i) : opaque(img, i) && labDist2(labAt(img, i), bg) < 150;
      if (!isBG) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
  }
  if (maxX < minX) return null;
  const m = 2;
  const x0 = Math.max(0, minX - m), y0 = Math.max(0, minY - m);
  return { x: x0, y: y0, width: Math.min(w, maxX + m + 1) - x0, height: Math.min(h, maxY + m + 1) - y0 };
}
