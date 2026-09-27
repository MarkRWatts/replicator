import { Mask } from './mask.js';
import { Emitter } from './emitter.js';
import { fillRows, cells, sewCells } from './fill.js';
import { centerlines, sewSatins, resample, boundaryChains } from './satin.js';
import { dist2 } from './geom.js';

export const defaultSettings = {
  rowSpacingMM: 0.4,        // fill density
  stitchLengthMM: 3.5,      // fill stitch length
  fillAngle: 45,            // degrees
  underlay: true,           // sparse layer under fills, centre run under satins
  pullCompensationMM: 0.2,  // widen fills and satins to counter fabric pull-in
  trimThresholdMM: 2.0,     // longer travel that can't be hidden inside the area is trimmed
  satinForThinAreas: true,
  satinMaxWidthMM: 4.0,
  satinSpacingMM: 0.4,      // peak to peak, on the same side of the column
  outlineStyle: 'none',     // 'none' | 'running' | 'satin'
  outlineWidthMM: 1.2,
  outlineThread: null,      // null: each area's outline in its own thread; else one thread, sewn last
  outlineRGB: null,         // the colour the outline thread was chosen for (the app re-matches from it)
  sewingOrder: 'fewest',    // 'fewest' colour changes | 'layered' (back to front, may repeat threads)
};

/**
 * Turns a quantized image into stitches: tatami fills for areas, satin for thin areas and outlines.
 * @param threadForCluster Map cluster id -> thread; clusters absent from the map are not sewn.
 */
export function digitize(image, threadForCluster, settings, onProgress = () => {}) {
  const { width: w, height: h, cellMM: g } = image;

  // Clusters given the same thread become one layer.
  const layerThreads = [], layerOfThread = new Map();
  const layerOfCluster = image.clusters.map((c) => {
    const t = threadForCluster.get(c.id);
    if (!t) return -1;
    if (!layerOfThread.has(t.id)) { layerOfThread.set(t.id, layerThreads.length); layerThreads.push(t); }
    return layerOfThread.get(t.id);
  });
  if (!layerThreads.length) return { stitches: [], threads: [] };

  const layerMap = new Int32Array(w * h).fill(-1);
  for (let i = 0; i < w * h; i++) {
    const l = image.labels[i];
    if (l >= 0 && layerOfCluster[l] >= 0) layerMap[i] = layerOfCluster[l];
  }

  // Connected areas of every layer, and a map from cell to area.
  const layerMasks = layerThreads.map((_, layer) => {
    const bits = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) if (layerMap[i] === layer) bits[i] = 1;
    return new Mask(w, h, g, bits);
  });
  const comps = [];
  const compMap = new Int32Array(w * h).fill(-1);
  const minCells = Math.max(4, Math.trunc(0.5 / (g * g)));
  layerMasks.forEach((mask, layer) => {
    for (const c of mask.components(minCells)) {
      c.id = comps.length;
      c.layer = layer;
      for (const i of c.cells) compMap[i] = c.id;
      comps.push(c);
    }
  });
  if (!comps.length) return { stitches: [], threads: [] };

  // Thin areas become satin; work that out first, since satins should sew on top of their neighbours.
  const satinPaths = new Map();
  if (settings.satinForThinAreas) {
    for (const c of comps) {
      const paths = centerlines(layerMasks[c.layer].restricted(c), settings.satinMaxWidthMM, settings.pullCompensationMM);
      if (paths) satinPaths.set(c.id, paths);
    }
  }
  const satin = new Set(satinPaths.keys());
  const parent = enclosingComponents(comps, compMap, w, h, satin);
  const neighbours = adjacentComponents(comps, compMap, w, h);
  // A satin stroke goes after the largest area it touches.
  for (const id of satin) {
    let big = null;
    for (const n of neighbours[id]) {
      if (!satin.has(n) && (big === null || comps[n].cells.length > comps[big].cells.length)) big = n;
    }
    if (big !== null) parent[id] = big;
  }
  // Specks under 4 mm² shouldn't decide the thread order.
  const minWeightCells = 4 / (g * g);
  const groups = sewingGroups(comps, parent, neighbours, satin, layerThreads.length, settings.sewingOrder, minWeightCells);

  const emitter = new Emitter(settings);
  const total = comps.length;
  let done = 0;
  for (const group of groups) {
    const layer = comps[group[0]].layer;
    emitter.beginColor(layerThreads[layer]);
    const remaining = group.slice();
    while (remaining.length) {
      const here = emitter.position || [0, 0];
      let idx = 0;
      for (let i = 1; i < remaining.length; i++) {
        if (dist2(comps[remaining[i]].anchor, here) < dist2(comps[remaining[idx]].anchor, here)) idx = i;
      }
      const comp = comps[remaining.splice(idx, 1)[0]];
      sewComponent(comp, layerMasks[layer], compMap, image, satinPaths.get(comp.id), settings, emitter);
      onProgress(++done / total);
    }
  }

  // Outlines in a single thread, sewn last. Shared edges are outlined once.
  if (settings.outlineStyle !== 'none' && settings.outlineThread) {
    emitter.beginColor(settings.outlineThread);
    emitter.setRegion(null);
    const chains = comps.flatMap((c) => boundaryChains(c, compMap, w, h, g, true));
    while (chains.length) {
      const here = emitter.position || [0, 0];
      let best = [0, false, Infinity];
      chains.forEach((c, i) => {
        const d0 = dist2(c.points[0], here), d1 = dist2(c.points[c.points.length - 1], here);
        if (d0 < best[2]) best = [i, false, d0];
        if (!c.closed && d1 < best[2]) best = [i, true, d1];
      });
      const chain = chains.splice(best[0], 1)[0];
      if (best[1]) { chain.points = chain.points.slice().reverse(); chain.inwardSign = -chain.inwardSign; }
      sewOutline(chain, false, settings, emitter);
    }
  }

  emitter.finish();
  return { stitches: emitter.stitches, threads: emitter.threads };
}

function sewComponent(comp, mask, compMap, image, satinPaths, settings, emitter) {
  const g = image.cellMM;
  const compMask = mask.restricted(comp);
  emitter.setRegion(compMask);

  if (satinPaths) {
    sewSatins(satinPaths, settings, emitter);
    return; // satin edges are already crisp; no outline needed
  }
  const areaMM2 = comp.cells.length * g * g;
  if (settings.underlay && areaMM2 > 12) {
    const rows = fillRows(compMask, comp.bbox, settings.fillAngle + 90, Math.max(1.5, settings.rowSpacingMM * 5), -0.4, 1.0);
    sewCells(rows, cells(rows), 3.0, emitter);
  }
  const rows = fillRows(compMask, comp.bbox, settings.fillAngle, settings.rowSpacingMM, settings.pullCompensationMM, 0.2);
  sewCells(rows, cells(rows), settings.stitchLengthMM, emitter);

  if (settings.outlineStyle !== 'none' && !settings.outlineThread) {
    for (const chain of boundaryChains(comp, compMap, image.width, image.height, g, false)) {
      sewOutline(chain, true, settings, emitter);
    }
  }
}

/**
 * Sews one outline. `inward` keeps a satin border inside the area (so neighbouring borders sit side by
 * side); otherwise it is centred on the edge.
 */
function sewOutline(chain, inward, settings, emitter) {
  if (settings.outlineStyle === 'running') {
    emitter.travel(chain.points[0]);
    emitter.run(chain.points, 2.5);
    return;
  }
  if (settings.outlineStyle !== 'satin') return;
  const w = settings.outlineWidthMM;
  const samples = resample(chain.points, settings.satinSpacingMM / 2, chain.closed);
  if (samples.length < 2) return;
  // Inward normal for a tangent (dx, dy) is (dy, -dx) times the chain's orientation sign.
  const normal = (t) => [t[1] * chain.inwardSign, -t[0] * chain.inwardSign];
  const lo = inward ? -settings.pullCompensationMM * 0.5 : -w / 2;
  const hi = inward ? w : w / 2;
  const m = (lo + hi) / 2;
  const centre = samples.map((s) => { const n = normal(s.tangent); return [s.point[0] + n[0] * m, s.point[1] + n[1] * m]; });
  const zig = [];
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i], n = normal(s.tangent), d = i % 2 === 0 ? lo : hi;
    zig.push([s.point[0] + n[0] * d, s.point[1] + n[1] * d]);
  }
  if (settings.underlay) {
    emitter.travel(centre[0]);
    emitter.run(centre, 2.0);
  } else {
    emitter.travel(zig[0]);
  }
  emitter.run(zig, 12);
}

// ---------------------------------------------------------------- sewing order

/** For each area, the innermost area that completely surrounds it (it sits in one of that area's holes). */
function enclosingComponents(comps, compMap, w, h, excluding) {
  const holeOwner = new Int32Array(w * h).fill(-1);
  // Larger areas first, so smaller (inner) enclosing areas overwrite them.
  const bySize = comps.filter((c) => !excluding.has(c.id)).sort((a, b) => b.cells.length - a.cells.length);
  for (const c of bySize) {
    const [x0, y0, x1, y1] = c.bbox;
    const bw = x1 - x0 + 3, bh = y1 - y0 + 3; // bbox plus a one-cell frame
    if (bw <= 4 || bh <= 4) continue;
    // Flood the outside of this area from the frame; unreached non-area cells are holes.
    const reached = new Uint8Array(bw * bh);
    const isArea = (lx, ly) => {
      const gx = lx + x0 - 1, gy = ly + y0 - 1;
      return gx >= 0 && gy >= 0 && gx < w && gy < h && compMap[gy * w + gx] === c.id;
    };
    const stack = [0];
    reached[0] = 1;
    while (stack.length) {
      const i = stack.pop();
      const lx = i % bw, ly = (i / bw) | 0;
      for (const [nx, ny] of [[lx - 1, ly], [lx + 1, ly], [lx, ly - 1], [lx, ly + 1]]) {
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
        const j = ny * bw + nx;
        if (!reached[j] && !isArea(nx, ny)) { reached[j] = 1; stack.push(j); }
      }
    }
    for (let ly = 1; ly < bh - 1; ly++) {
      for (let lx = 1; lx < bw - 1; lx++) {
        if (!reached[ly * bw + lx] && !isArea(lx, ly)) holeOwner[(ly + y0 - 1) * w + (lx + x0 - 1)] = c.id;
      }
    }
  }
  return comps.map((c) => {
    const owner = holeOwner[c.cells[0]];
    return owner >= 0 && owner !== c.id ? owner : null;
  });
}

/** Areas sharing an edge with each area. */
function adjacentComponents(comps, compMap, w, h) {
  const result = comps.map(() => new Set());
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = compMap[y * w + x];
      if (c < 0) continue;
      if (x + 1 < w) { const n = compMap[y * w + x + 1]; if (n >= 0 && n !== c) { result[c].add(n); result[n].add(c); } }
      if (y + 1 < h) { const n = compMap[(y + 1) * w + x]; if (n >= 0 && n !== c) { result[c].add(n); result[n].add(c); } }
    }
  }
  return result;
}

/** Groups of areas to sew in order; every group uses a single thread. */
function sewingGroups(comps, parent, neighbours, satin, layerCount, order, minWeightCells) {
  // Thread order that best puts surrounding areas before the areas they surround.
  const weight = Array.from({ length: layerCount }, () => new Float64Array(layerCount));
  const area = new Float64Array(layerCount);
  for (const c of comps) {
    area[c.layer] += c.cells.length;
    if (c.cells.length < minWeightCells) continue;
    const p = parent[c.id];
    if (p !== null && comps[p].layer !== c.layer) weight[comps[p].layer][c.layer] += c.cells.length;
    // Satin strokes should lie over everything they touch.
    if (satin.has(c.id)) {
      for (const n of neighbours[c.id]) {
        if (comps[n].layer !== c.layer && !satin.has(n)) weight[comps[n].layer][c.layer] += c.cells.length;
      }
    }
  }
  const remaining = new Set(comps.map((c) => c.layer));
  const rank = new Array(layerCount).fill(0);
  const layerOrder = [];
  while (remaining.size) {
    // Choose the thread whose early placement breaks the fewest "should be underneath" relations.
    let next = null, nextV = Infinity;
    for (const a of [...remaining].sort((x, y) => x - y)) {
      let v = 0;
      for (const r of remaining) if (r !== a) v += weight[r][a];
      if (v < nextV || (v === nextV && area[a] > area[next])) { next = a; nextV = v; }
    }
    rank[next] = layerOrder.length;
    layerOrder.push(next);
    remaining.delete(next);
  }

  if (order !== 'layered') return layerOrder.map((l) => comps.filter((c) => c.layer === l).map((c) => c.id));

  const depthCache = new Map();
  const depth = (i) => {
    if (depthCache.has(i)) return depthCache.get(i);
    depthCache.set(i, 0); // guards against cycles
    let d = 0, cur = i;
    while (parent[cur] !== null && d < 64) { d++; cur = parent[cur]; }
    // Satin strokes sit above every area they touch.
    if (satin.has(i)) {
      for (const n of neighbours[i]) if (!satin.has(n) && n !== parent[i]) d = Math.max(d, depth(n) + 1);
    }
    depthCache.set(i, d);
    return d;
  };
  const sorted = comps.map((c) => c.id).sort((a, b) =>
    depth(a) - depth(b) || rank[comps[a].layer] - rank[comps[b].layer] || a - b);
  const groups = [];
  for (const id of sorted) {
    const last = groups[groups.length - 1];
    if (last && comps[last[0]].layer === comps[id].layer) last.push(id); else groups.push([id]);
  }
  return groups;
}
