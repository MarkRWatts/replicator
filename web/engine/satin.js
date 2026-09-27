import { dist, dist2 } from './geom.js';

// Satin columns for thin areas, and traced area borders for outlines.
// A satin path is { points: [[x,y] mm], widths: [mm], closed }.
// A boundary chain is { points, closed, inwardSign }: walking along points, the area's inside is at
// normal (dy, -dx) × inwardSign.

/**
 * If the (cropped) mask is a thin stroke, nowhere much wider than `maxWidthMM`, returns its centre lines.
 * Returns null for areas that should be filled instead.
 */
export function centerlines(mask, maxWidthMM, pullCompMM) {
  const W = mask.width, H = mask.height, g = mask.cellMM;
  const d = distanceTransform(mask);
  let maxD = 0;
  for (const v of d) if (v > maxD) maxD = v;
  if ((2 * maxD - 1) * g > maxWidthMM * 1.6) return null;
  const widthAt = (i) => Math.max(g, (2 * d[i] - 1) * g);

  const skel = skeleton(mask);
  const pixels = [];
  for (let i = 0; i < skel.length; i++) if (skel[i]) pixels.push(i);
  if (!pixels.length) return null;
  const skelWidths = pixels.map(widthAt).sort((a, b) => a - b);
  if (skelWidths[Math.trunc((skelWidths.length - 1) * 0.9)] > maxWidthMM) return null;

  // Neighbours on the skeleton, using m-connectivity so staircase corners don't look like junctions.
  const on = (x, y) => x >= 0 && y >= 0 && x < W && y < H && skel[y * W + x] === 1;
  const neighbours = (i) => {
    const x = i % W, y = (i / W) | 0, r = [];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (on(x + dx, y + dy)) r.push((y + dy) * W + x + dx);
    for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      if (on(x + dx, y + dy) && !on(x + dx, y) && !on(x, y + dy)) r.push((y + dy) * W + x + dx);
    }
    return r;
  };
  const degree = new Int32Array(W * H);
  for (const p of pixels) degree[p] = neighbours(p).length;

  // Trace skeleton edges between nodes (pixels whose degree isn't 2), then any pure loops.
  let edges = [];
  const covered = new Uint8Array(W * H);
  const used = new Set();
  const key = (a, b) => a * W * H + b;
  for (const n of pixels) {
    if (degree[n] === 2) continue;
    covered[n] = 1;
    if (degree[n] === 0) { edges.push({ a: n, b: n, path: [n], closed: false, alive: true }); continue; }
    for (const m of neighbours(n)) {
      if (used.has(key(n, m))) continue;
      const path = [n, m];
      used.add(key(n, m)); used.add(key(m, n));
      let prev = n, cur = m;
      while (degree[cur] === 2) {
        covered[cur] = 1;
        const next = neighbours(cur).find((q) => q !== prev);
        if (next === undefined || used.has(key(cur, next))) break;
        used.add(key(cur, next)); used.add(key(next, cur));
        path.push(next);
        prev = cur; cur = next;
      }
      covered[cur] = 1;
      edges.push({ a: n, b: cur, path, closed: false, alive: true });
    }
  }
  for (const s of pixels) {
    if (covered[s]) continue;
    const path = [s];
    covered[s] = 1;
    let prev = s, cur = neighbours(s)[0];
    while (cur !== s && !covered[cur]) {
      covered[cur] = 1;
      path.push(cur);
      const next = neighbours(cur).find((q) => q !== prev);
      if (next === undefined) break;
      prev = cur; cur = next;
    }
    edges.push({ a: s, b: s, path, closed: true, alive: true });
  }

  // Prune short spurs: branches from a junction to a free end, shorter than the stroke is wide.
  if (edges.length > 1) {
    for (const e of edges) {
      if (e.closed) continue;
      const [end, junction] = degree[e.a] === 1 ? [e.a, e.b] : [e.b, e.a];
      if (degree[end] !== 1 || degree[junction] < 3) continue;
      if (e.path.length * g < Math.max(1.0, 1.2 * widthAt(junction))) e.alive = false;
    }
  }
  // Join edges that meet at a node with exactly two remaining edges.
  for (let merged = true; merged;) {
    merged = false;
    const incident = new Map();
    edges.forEach((e, i) => {
      if (!e.alive || e.closed || e.a === e.b) return;
      for (const node of [e.a, e.b]) { if (!incident.has(node)) incident.set(node, []); incident.get(node).push(i); }
    });
    for (const node of [...incident.keys()].sort((a, b) => a - b)) {
      const list = incident.get(node);
      if (list.length !== 2 || list[0] === list[1]) continue;
      const e1 = { ...edges[list[0]], path: edges[list[0]].path.slice() };
      const e2 = { ...edges[list[1]], path: edges[list[1]].path.slice() };
      if (e1.b !== node) { e1.path.reverse(); [e1.a, e1.b] = [e1.b, e1.a]; }
      if (e2.a !== node) { e2.path.reverse(); [e2.a, e2.b] = [e2.b, e2.a]; }
      edges[list[0]] = { a: e1.a, b: e2.b, path: e1.path.concat(e2.path.slice(1)), closed: e1.a === e2.b, alive: true };
      edges[list[1]].alive = false;
      merged = true;
      break;
    }
  }

  const live = edges.filter((e) => e.alive);
  const totalLength = live.reduce((s, e) => s + e.path.length * g, 0);
  const medianWidth = skelWidths[skelWidths.length >> 1];
  if (totalLength < Math.max(1.0, 1.5 * medianWidth)) return null;

  const result = [];
  for (const e of live) {
    if (e.path.length < 2) continue;
    let pts = e.path.map((i) => [((i % W) + mask.originX + 0.5) * g, (((i / W) | 0) + mask.originY + 0.5) * g]);
    let ws = e.path.map((i) => Math.min(maxWidthMM * 1.3, Math.max(0.8, widthAt(i) + pullCompMM)));
    pts = smooth(pts, e.closed, 2);
    ws = smooth(ws.map((w) => [w, 0]), e.closed, 3).map((p) => p[0]);
    if (!e.closed) {
      // The skeleton stops short of free ends; extend towards the tip.
      if (degree[e.a] <= 1) extend(pts, ws, true, ws[0] * 0.35);
      if (degree[e.b] <= 1) extend(pts, ws, false, ws[ws.length - 1] * 0.35);
    }
    result.push({ points: pts, widths: ws, closed: e.closed });
  }
  return result.length ? result : null;
}

export function sewSatins(paths, settings, emitter) {
  const remaining = paths.slice();
  while (remaining.length) {
    const here = emitter.position || [0, 0];
    let best = [0, false, Infinity];
    remaining.forEach((p, i) => {
      const d0 = dist2(p.points[0], here), d1 = dist2(p.points[p.points.length - 1], here);
      if (d0 < best[2]) best = [i, false, d0];
      if (!p.closed && d1 < best[2]) best = [i, true, d1];
    });
    const path = remaining.splice(best[0], 1)[0];
    const points = best[1] ? path.points.slice().reverse() : path.points;
    const widths = best[1] ? path.widths.slice().reverse() : path.widths;

    const samples = resample(points, settings.satinSpacingMM / 2, path.closed);
    if (samples.length < 2) continue;
    // Width at each sample, interpolated along the original points by arc length.
    const cum = [0];
    for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + dist(points[i - 1], points[i]));
    const widthAt = (s) => {
      const j = cum.findIndex((c) => c >= s);
      if (j <= 0 || j >= widths.length) return s <= 0 ? widths[0] : widths[widths.length - 1];
      const t = (s - cum[j - 1]) / Math.max(1e-9, cum[j] - cum[j - 1]);
      return widths[j - 1] + (widths[j] - widths[j - 1]) * t;
    };
    const zig = [];
    for (let i = samples.length - 1; i >= 0; i--) {
      const s = samples[i];
      const half = (widthAt(s.arc) / 2) * (i % 2 === 0 ? 1 : -1);
      zig.push([s.point[0] + s.tangent[1] * half, s.point[1] - s.tangent[0] * half]);
    }
    if (settings.underlay) {
      // Centre run out, satin back over it.
      emitter.travel(samples[0].point);
      emitter.run(samples.map((s) => s.point), 2.0);
    } else {
      emitter.travel(zig[0]);
    }
    emitter.run(zig, 12);
  }
}

/** Evenly spaced points along a polyline, with unit tangents and arc length. */
export function resample(points, spacing, closed) {
  const pts = points.slice();
  if (closed && pts.length && dist2(pts[0], pts[pts.length - 1]) > 1e-6) pts.push(pts[0]);
  if (pts.length < 2) return [];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1];
  if (total <= 0.05) return [];
  const at = (s0) => {
    let s = s0;
    if (closed) { s %= total; if (s < 0) s += total; }
    s = Math.max(0, Math.min(total, s));
    let j = 1;
    while (j < cum.length - 1 && cum[j] < s) j++;
    const t = (s - cum[j - 1]) / Math.max(1e-9, cum[j] - cum[j - 1]);
    return [pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * t, pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * t];
  };
  const n = Math.max(1, Math.round(total / spacing));
  const step = total / n;
  const delta = Math.min(0.5, total / 4);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const s = i * step;
    const a = at(closed ? s - delta : Math.max(0, s - delta)), b = at(closed ? s + delta : Math.min(total, s + delta));
    const len = Math.max(1e-9, dist(a, b));
    out.push({ point: at(s), tangent: [(b[0] - a[0]) / len, (b[1] - a[1]) / len], arc: s });
  }
  return out;
}

export function smooth(pts, closed, k) {
  const n = pts.length;
  if (n <= 2) return pts;
  return pts.map((p, i) => {
    if (!closed && (i === 0 || i === n - 1)) return p;
    let sx = 0, sy = 0, c = 0;
    for (let j = -k; j <= k; j++) {
      let idx = i + j;
      idx = closed ? ((idx % n) + n) % n : Math.max(0, Math.min(n - 1, idx));
      sx += pts[idx][0]; sy += pts[idx][1]; c++;
    }
    return [sx / c, sy / c];
  });
}

function extend(pts, ws, atStart, d) {
  if (pts.length < 2 || d <= 0.05) return;
  const end = atStart ? pts[0] : pts[pts.length - 1];
  const inner = atStart ? pts[Math.min(3, pts.length - 1)] : pts[Math.max(0, pts.length - 4)];
  const len = dist(end, inner);
  if (len <= 1e-6) return;
  const p = [end[0] + ((end[0] - inner[0]) / len) * d, end[1] + ((end[1] - inner[1]) / len) * d];
  if (atStart) { pts.unshift(p); ws.unshift(ws[0]); } else { pts.push(p); ws.push(ws[ws.length - 1]); }
}

/** Chamfer distance (in cells) from each inside cell to the nearest outside cell. */
function distanceTransform(mask) {
  const { width: W, height: H, bits } = mask;
  const d = new Float64Array(W * H);
  for (let i = 0; i < d.length; i++) d[i] = bits[i] ? Infinity : 0;
  const get = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : d[y * W + x]);
  const r2 = Math.SQRT2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!bits[i]) continue;
      d[i] = Math.min(d[i], get(x - 1, y) + 1, get(x, y - 1) + 1, get(x - 1, y - 1) + r2, get(x + 1, y - 1) + r2);
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (!bits[i]) continue;
      d[i] = Math.min(d[i], get(x + 1, y) + 1, get(x, y + 1) + 1, get(x + 1, y + 1) + r2, get(x - 1, y + 1) + r2);
    }
  }
  return d;
}

/** Zhang–Suen thinning to a one-cell-wide skeleton. */
function skeleton(mask) {
  const W = mask.width + 2, H = mask.height + 2;
  const p = new Uint8Array(W * H);
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) if (mask.bits[y * mask.width + x]) p[(y + 1) * W + x + 1] = 1;
  }
  const n = new Uint8Array(8);
  const toDelete = [];
  for (let changed = true; changed;) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      toDelete.length = 0;
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          if (!p[y * W + x]) continue;
          n[0] = p[(y - 1) * W + x]; n[1] = p[(y - 1) * W + x + 1]; n[2] = p[y * W + x + 1]; n[3] = p[(y + 1) * W + x + 1];
          n[4] = p[(y + 1) * W + x]; n[5] = p[(y + 1) * W + x - 1]; n[6] = p[y * W + x - 1]; n[7] = p[(y - 1) * W + x - 1];
          let b = 0;
          for (let k = 0; k < 8; k++) b += n[k];
          if (b < 2 || b > 6) continue;
          let a = 0;
          for (let k = 0; k < 8; k++) if (!n[k] && n[(k + 1) % 8]) a++;
          if (a !== 1) continue;
          const [p2, p4, p6, p8] = [n[0], n[2], n[4], n[6]];
          const ok = step === 0 ? !(p2 && p4 && p6) && !(p4 && p6 && p8) : !(p2 && p4 && p8) && !(p2 && p6 && p8);
          if (ok) toDelete.push(y * W + x);
        }
      }
      for (const i of toDelete) p[i] = 0;
      if (toDelete.length) changed = true;
    }
  }
  const out = new Uint8Array(mask.width * mask.height);
  for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) out[y * mask.width + x] = p[(y + 1) * W + x + 1];
  return out;
}

/**
 * Borders of a component as chains of points (mm), smoothed. With `dedupe`, an edge shared with another
 * stitched area is only returned for the area with the lower id, so it is outlined once.
 */
export function boundaryChains(c, compMap, width, height, g, dedupe) {
  const id = c.id;
  const at = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? -1 : compMap[y * width + x]);
  const vw = width + 1;
  const vid = (x, y) => y * vw + x;
  const out = new Map(), indeg = new Map();
  const add = (a, b, other) => {
    if (other === id || (dedupe && other >= 0 && other < id)) return;
    if (!out.has(a)) out.set(a, []);
    out.get(a).push(b);
    indeg.set(b, (indeg.get(b) || 0) + 1);
  };
  // Directed so that the area is on the side of normal (dy, -dx).
  for (const i of c.cells) {
    const x = i % width, y = (i / width) | 0;
    add(vid(x + 1, y), vid(x, y), at(x, y - 1));
    add(vid(x, y + 1), vid(x + 1, y + 1), at(x, y + 1));
    add(vid(x, y), vid(x, y + 1), at(x - 1, y));
    add(vid(x + 1, y + 1), vid(x + 1, y), at(x + 1, y));
  }
  const trace = (s) => {
    const path = [s];
    let cur = s;
    for (;;) {
      const nexts = out.get(cur);
      if (!nexts || !nexts.length) break;
      const nxt = nexts.shift();
      if (!nexts.length) out.delete(cur);
      path.push(nxt);
      cur = nxt;
      if (cur === s) return [path, true];
    }
    return [path, false];
  };
  const raw = [];
  const starts = [...out.keys()].filter((v) => out.get(v).length > (indeg.get(v) || 0)).sort((a, b) => a - b);
  for (const s of starts) while (out.has(s)) raw.push(trace(s));
  while (out.size) {
    let min = Infinity;
    for (const v of out.keys()) if (v < min) min = v;
    raw.push(trace(min));
  }

  const chains = [];
  for (const [vertices, closed] of raw) {
    let pts = vertices.map((v) => [(v % vw) * g, ((v / vw) | 0) * g]);
    if (closed) pts.pop();
    if (pts.length < 3) continue;
    pts = smooth(pts, closed, 2);
    const thin = [pts[0]];
    for (const p of pts.slice(1)) if (dist2(p, thin[thin.length - 1]) >= 0.25) thin.push(p);
    if (!closed && dist2(pts[pts.length - 1], thin[thin.length - 1]) > 0.01) thin.push(pts[pts.length - 1]);
    let length = 0;
    for (let i = 1; i < thin.length; i++) length += dist(thin[i - 1], thin[i]);
    if (length < 1.5 || thin.length < 2) continue;
    if (closed) thin.push(thin[0]);
    chains.push({ points: thin, closed, inwardSign: 1 });
  }
  return chains;
}
