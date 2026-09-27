import { STITCH, JUMP, TRIM, COLOR } from './pattern.js';
import { dist, dist2, pathLength, roundHalfAway } from './geom.js';

/** Accumulates stitches, handling travel between areas, trims and lock stitches. Positions are in mm. */
export class Emitter {
  constructor(settings) {
    this.settings = settings;
    this.stitches = [];
    this.threads = [];
    this.position = null;
    this.mask = null;
    this.pendingColor = false;
    this.pendingTrim = false;
    this.tieInPending = false;
    this.lastDir = [1, 0];
  }

  /** Region the needle may travel through without trimming. */
  setRegion(mask) { this.mask = mask; }

  /** Switches thread, unless `thread` is already loaded. */
  beginColor(thread) {
    if (this.threads.length && this.threads[this.threads.length - 1].id === thread.id) return;
    if (this.threads.length) { this.tieOff(); this.pendingColor = true; }
    this.threads.push(thread);
  }

  /** Moves the needle to `p`: sewing a hidden running stitch when possible, otherwise trim and jump. */
  travel(p) {
    const cur = this.position;
    if (!cur || this.pendingColor) { this.move(p); return; }
    const d = dist(cur, p);
    if (d < 0.05) return;
    const mask = this.mask, trim = this.settings.trimThresholdMM;
    if (d <= Math.min(trim, 1.5) || (mask && mask.containsSegment(cur, p))) {
      this.run([cur, p], 3.0);
      return;
    }
    const path = mask ? mask.path(cur, p) : null;
    if (path && pathLength(path) < Math.max(3 * d, d + 20)) {
      // Walk around obstacles inside the region; later fill rows cover most of it.
      this.run([cur, ...path.slice(1, -1), p], 3.0);
    } else if (d <= trim) {
      this.run([cur, p], 3.0);
    } else {
      this.tieOff();
      this.pendingTrim = true;
      this.move(p);
    }
  }

  move(p) {
    this.position = p;
    const [x, y] = units(p);
    if (!this.stitches.length) this.stitches.push({ x, y, k: STITCH });
    else {
      this.stitches.push({ x, y, k: this.pendingColor ? COLOR : this.pendingTrim ? TRIM : JUMP });
      this.stitches.push({ x, y, k: STITCH });
    }
    const needsTie = this.pendingColor || this.pendingTrim || this.stitches.length === 1;
    this.pendingColor = false;
    this.pendingTrim = false;
    if (needsTie) this.tieInPending = true;
  }

  /** Sews through `points` (the first is where the needle should already be), subdividing long stitches. */
  run(points, maxLength) {
    if (!points.length) return;
    if (!this.position || dist2(this.position, points[0]) > 0.01) this.travel(points[0]);
    if (this.tieInPending && points.length > 1) {
      this.tieInPending = false;
      const p = points[0], q = points[1];
      const len = dist(p, q);
      if (len > 0.01) {
        const d = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
        const t = Math.min(0.6, len);
        this.stitch([p[0] + d[0] * t, p[1] + d[1] * t]);
        this.stitch(p);
      }
    }
    for (let k = 1; k < points.length; k++) {
      const p = points[k], cur = this.position;
      const len = dist(cur, p);
      if (len < 0.05) continue;
      const n = Math.ceil(len / maxLength);
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        this.stitch([cur[0] + (p[0] - cur[0]) * t, cur[1] + (p[1] - cur[1]) * t]);
      }
    }
  }

  stitch(p) {
    const cur = this.position;
    if (cur) {
      const len = dist(cur, p);
      if (len > 0.01) this.lastDir = [(p[0] - cur[0]) / len, (p[1] - cur[1]) / len];
    }
    const [x, y] = units(p);
    const last = this.stitches[this.stitches.length - 1];
    if (last && last.k === STITCH && last.x === x && last.y === y) { this.position = p; return; }
    this.stitches.push({ x, y, k: STITCH });
    this.position = p;
  }

  /** Small back-and-forth stitches so the thread doesn't unravel before a cut. */
  tieOff() {
    const p = this.position;
    if (!p || !this.stitches.length) return;
    const dir = this.lastDir;
    this.stitch([p[0] - dir[0] * 0.6, p[1] - dir[1] * 0.6]);
    this.stitch(p);
    this.lastDir = dir;
  }

  finish() { this.tieOff(); }
}

const units = (p) => [roundHalfAway(p[0] * 10), roundHalfAway(p[1] * 10)];
