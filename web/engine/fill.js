import { dist2 } from './geom.js';

// Tatami (brick-pattern) fills. Rows run along direction `dir`; a run is { row, u0, u1 } in
// rotated coordinates (u along the row, v across rows).

export function fillRows(mask, bbox, angle, spacing, extend, minLength) {
  const a = (angle * Math.PI) / 180;
  const dir = [Math.cos(a), Math.sin(a)], normal = [-Math.sin(a), Math.cos(a)];
  const g = mask.cellMM;
  const [bx0, by0, bx1, by1] = bbox;
  const corners = [[bx0 * g, by0 * g], [(bx1 + 1) * g, by0 * g], [bx0 * g, (by1 + 1) * g], [(bx1 + 1) * g, (by1 + 1) * g]];
  const us = corners.map((c) => c[0] * dir[0] + c[1] * dir[1]);
  const vs = corners.map((c) => c[0] * normal[0] + c[1] * normal[1]);
  const uMin = Math.min(...us), uMax = Math.max(...us);
  const vMin = Math.min(...vs) + spacing / 2, vMax = Math.max(...vs);
  const step = g / 2;
  const n = Math.max(0, Math.trunc((vMax - vMin) / spacing) + 1);
  const samples = Math.trunc((uMax - uMin) / step) + 2;
  const rows = [];
  for (let r = 0; r < n; r++) {
    const v = vMin + r * spacing;
    const row = [];
    let runStart = null, lastInside = 0;
    for (let k = 0; k < samples; k++) {
      const u = uMin + k * step;
      const inside = mask.contains(u * dir[0] + v * normal[0], u * dir[1] + v * normal[1]);
      if (inside) { if (runStart === null) runStart = u; lastInside = u; }
      if ((!inside || k === samples - 1) && runStart !== null) {
        const u0 = runStart - step / 2 - extend, u1 = lastInside + step / 2 + extend;
        if (u1 - u0 >= minLength) row.push({ row: r, u0, u1 });
        runStart = null;
      }
    }
    rows.push(row);
  }
  const point = (u, row) => {
    const v = vMin + row * spacing;
    return [u * dir[0] + v * normal[0], u * dir[1] + v * normal[1]];
  };
  return { rows, point };
}

/** Splits fill rows into cells that can each be sewn back and forth without jumping (boustrophedon). */
export function cells(fill) {
  const cells = [];
  let open = [], prev = [];
  for (const runs of fill.rows) {
    const next = new Array(runs.length).fill(-1);
    const prevHits = new Array(prev.length).fill(0);
    const curHits = runs.map(() => []);
    runs.forEach((r, i) => prev.forEach((p, j) => {
      if (r.u0 < p.u1 && p.u0 < r.u1) { curHits[i].push(j); prevHits[j]++; }
    }));
    runs.forEach((r, i) => {
      if (curHits[i].length === 1 && prevHits[curHits[i][0]] === 1) {
        const c = open[curHits[i][0]];
        cells[c].push(r);
        next[i] = c;
      } else {
        cells.push([r]);
        next[i] = cells.length - 1;
      }
    });
    open = next;
    prev = runs;
  }
  return cells;
}

export function sewCells(fill, cellList, stitchLength, emitter) {
  const remaining = cellList.slice();
  while (remaining.length) {
    const here = emitter.position || [0, 0];
    // Pick the cell (and which corner to start from) nearest the needle.
    let best = { cell: 0, reverse: false, right: false, d: Infinity };
    remaining.forEach((cell, ci) => {
      for (const reverse of [false, true]) {
        const run = reverse ? cell[cell.length - 1] : cell[0];
        for (const right of [false, true]) {
          const d = dist2(fill.point(right ? run.u1 : run.u0, run.row), here);
          if (d < best.d) best = { cell: ci, reverse, right, d };
        }
      }
    });
    let cell = remaining.splice(best.cell, 1)[0];
    if (best.reverse) cell = cell.slice().reverse();
    let forward = !best.right;
    const points = [];
    for (const run of cell) {
      points.push(...rowStitches(run, forward, stitchLength, fill));
      forward = !forward;
    }
    emitter.travel(points[0]);
    emitter.run(points, stitchLength);
  }
}

/** Stitch points along one fill row, staggered from row to row to form the tatami brick pattern. */
function rowStitches(run, forward, length, fill) {
  const offset = ((((run.row % 3) + 3) % 3) / 3) * length;
  const minGap = length * 0.3;
  const us = [run.u0];
  let k = Math.ceil((run.u0 - offset) / length);
  for (;;) {
    const u = offset + k * length;
    if (u >= run.u1 - minGap) break;
    if (u > run.u0 + minGap) us.push(u);
    k++;
  }
  us.push(run.u1);
  if (!forward) us.reverse();
  return us.map((u) => fill.point(u, run.row));
}
