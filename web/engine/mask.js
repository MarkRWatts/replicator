import { dist } from './geom.js';

/** A connected area of one colour: { id, layer, cells (grid indices), bbox [minX,minY,maxX,maxY], anchor [mm] }. */

/** A boolean grid of cells, optionally cropped (origin = grid position of its (0,0) cell). */
export class Mask {
  constructor(width, height, cellMM, bits, originX = 0, originY = 0) {
    Object.assign(this, { width, height, cellMM, bits, originX, originY });
  }

  contains(x, y) {
    const cx = Math.floor(x / this.cellMM) - this.originX, cy = Math.floor(y / this.cellMM) - this.originY;
    if (cx < 0 || cy < 0 || cx >= this.width || cy >= this.height) return false;
    return this.bits[cy * this.width + cx] === 1;
  }

  /** Whether the straight segment between two points stays inside the mask. */
  containsSegment(a, b) {
    const n = Math.max(1, Math.trunc(dist(a, b) / (this.cellMM * 0.5)));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      if (!this.contains(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)) return false;
    }
    return true;
  }

  /** A mask containing only component `c`, cropped to its bounding box. `c` must come from this (uncropped) mask. */
  restricted(c) {
    const [x0, y0, x1, y1] = c.bbox;
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const bits = new Uint8Array(w * h);
    for (const i of c.cells) bits[(((i / this.width) | 0) - y0) * w + ((i % this.width) - x0)] = 1;
    return new Mask(w, h, this.cellMM, bits, x0, y0);
  }

  nearestInsideCell(p) {
    const cx = Math.floor(p[0] / this.cellMM) - this.originX, cy = Math.floor(p[1] / this.cellMM) - this.originY;
    let best = -1, bestD = Infinity;
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= this.width || y >= this.height || !this.bits[y * this.width + x]) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = y * this.width + x; }
      }
    }
    return best;
  }

  /** Shortest route between two points that stays inside the mask (BFS, then straightened), or null. */
  path(a, b) {
    const start = this.nearestInsideCell(a), goal = this.nearestInsideCell(b);
    if (start < 0 || goal < 0) return null;
    const { width: w, height: h, bits } = this;
    const prev = new Int32Array(bits.length).fill(-1);
    prev[start] = start;
    const queue = new Int32Array(bits.length);
    let head = 0, tail = 0;
    queue[tail++] = start;
    while (head < tail) {
      const i = queue[head++];
      if (i === goal) break;
      const x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (bits[j] && prev[j] < 0) { prev[j] = i; queue[tail++] = j; }
        }
      }
    }
    if (prev[goal] < 0) return null;
    const cells = [goal];
    while (cells[cells.length - 1] !== start) cells.push(prev[cells[cells.length - 1]]);
    cells.reverse();
    const g = this.cellMM;
    const pts = cells.map((c) => [((c % w) + this.originX + 0.5) * g, (((c / w) | 0) + this.originY + 0.5) * g]);
    // String-pull: keep only the points needed to stay inside.
    const out = [a];
    let i = 0;
    while (i < pts.length - 1) {
      let j = i + 1;
      while (j + 1 < pts.length && this.containsSegment(pts[i], pts[j + 1])) j++;
      out.push(pts[j]);
      i = j;
    }
    out.push(b);
    return out;
  }

  /** 8-connected components (only valid on an uncropped mask). */
  components(minCells) {
    const { width: w, height: h, bits } = this;
    const seen = new Uint8Array(bits.length);
    const result = [];
    const stack = [];
    for (let start = 0; start < bits.length; start++) {
      if (!bits[start] || seen[start]) continue;
      const cells = [];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      stack.push(start); seen[start] = 1;
      while (stack.length) {
        const i = stack.pop();
        cells.push(i);
        const x = i % w, y = (i / w) | 0;
        if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const j = ny * w + nx;
            if (bits[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
          }
        }
      }
      if (cells.length >= minCells) {
        const a = cells[0];
        result.push({ id: 0, layer: 0, cells, bbox: [x0, y0, x1, y1],
          anchor: [((a % w) + 0.5) * this.cellMM, (((a / w) | 0) + 0.5) * this.cellMM] });
      }
    }
    return result;
  }
}
