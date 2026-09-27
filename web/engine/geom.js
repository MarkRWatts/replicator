// Small geometry helpers. Points are [x, y] in millimetres.
export const dist2 = (a, b) => { const dx = a[0] - b[0], dy = a[1] - b[1]; return dx * dx + dy * dy; };
export const dist = (a, b) => Math.sqrt(dist2(a, b));
export const pathLength = (p) => { let s = 0; for (let i = 1; i < p.length; i++) s += dist(p[i - 1], p[i]); return s; };
/** Rounds halves away from zero, so a coordinate exactly between two 0.1 mm steps rounds the same way either side of 0. */
export const roundHalfAway = (v) => Math.sign(v) * Math.round(Math.abs(v));
