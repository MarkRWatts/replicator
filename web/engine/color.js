// CIE L*a*b* colour maths, used for colour clustering and thread matching.

export function rgbToLab(r, g, b) {
  const lin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const rl = lin(r), gl = lin(g), bl = lin(b);
  const x = (0.4124 * rl + 0.3576 * gl + 0.1805 * bl) / 0.95047;
  const y = 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
  const z = (0.0193 * rl + 0.1192 * gl + 0.9505 * bl) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToRgb([l, a, b]) {
  const fy = (l + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (t) => (t * t * t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787);
  const x = inv(fx) * 0.95047, y = inv(fy), z = inv(fz) * 1.08883;
  const rl = 3.2406 * x - 1.5372 * y - 0.4986 * z;
  const gl = -0.9689 * x + 1.8758 * y + 0.0415 * z;
  const bl = 0.0557 * x - 0.2040 * y + 1.0570 * z;
  const gam = (c) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, v * 255));
  };
  return [gam(rl), gam(gl), gam(bl)];
}

/** Squared Euclidean Lab distance (fast; used for clustering). */
export function labDist2(p, q) {
  const dl = p[0] - q[0], da = p[1] - q[1], db = p[2] - q[2];
  return dl * dl + da * da + db * db;
}

/** CIEDE2000 colour difference: much better than plain Lab distance for blues and saturated colours. */
export function deltaE2000([l1, a1, b1], [l2, a2, b2]) {
  const rad = Math.PI / 180;
  const c1 = Math.hypot(a1, b1), c2 = Math.hypot(a2, b2);
  const cb7 = Math.pow((c1 + c2) / 2, 7);
  const g = 0.5 * (1 - Math.sqrt(cb7 / (cb7 + Math.pow(25, 7))));
  const a1p = (1 + g) * a1, a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1), c2p = Math.hypot(a2p, b2);
  const hue = (y, x) => { const h = Math.atan2(y, x) / rad; return h < 0 ? h + 360 : h; };
  const h1p = hue(b1, a1p), h2p = hue(b2, a2p);
  const dL = l2 - l1, dC = c2p - c1p;
  let dh = h2p - h1p;
  if (c1p * c2p === 0) dh = 0; else if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(c1p * c2p) * Math.sin((dh / 2) * rad);
  const lb = (l1 + l2) / 2, cbp = (c1p + c2p) / 2;
  let hb = h1p + h2p;
  if (c1p * c2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hb /= 2; else if (h1p + h2p < 360) hb = (hb + 360) / 2; else hb = (hb - 360) / 2;
  }
  const t = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad)
    + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad);
  const dTheta = 30 * Math.exp(-Math.pow((hb - 275) / 25, 2));
  const cbp7 = Math.pow(cbp, 7);
  const rc = 2 * Math.sqrt(cbp7 / (cbp7 + Math.pow(25, 7)));
  const sl = 1 + (0.015 * Math.pow(lb - 50, 2)) / Math.sqrt(20 + Math.pow(lb - 50, 2));
  const sc = 1 + 0.045 * cbp, sh = 1 + 0.015 * cbp * t;
  const rt = -Math.sin(2 * dTheta * rad) * rc;
  const x = dL / sl, y = dC / sc, z = dH / sh;
  return Math.sqrt(x * x + y * y + z * z + rt * y * z);
}

/** A short plain-English colour description ("dark red", "pale grey"), since the shade card only lists numbers. */
export function describeColor(r, g, b) {
  const [l, a, bb] = rgbToLab(r, g, b);
  const chroma = Math.hypot(a, bb);
  let hue = (Math.atan2(bb, a) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  // Very dark shades read as black even when the card's print gives them a slight cast.
  if (l < 20 && chroma < 15) return 'black';
  if (chroma < 9) {
    if (l < 18) return 'black';
    if (l > 92) return 'white';
    if (l > 80) return 'off-white';
    return l < 40 ? 'dark grey' : l < 65 ? 'grey' : 'light grey';
  }
  // Bands set against reference colours: CIELab puts pure blue near 300°, purple near 320°.
  let name;
  if (hue < 12 || hue >= 350) name = 'pink';
  else if (hue < 50) name = 'red';
  else if (hue < 78) name = 'orange';
  else if (hue < 90) name = 'gold';
  else if (hue < 108) name = 'yellow';
  else if (hue < 135) name = 'olive';
  else if (hue < 185) name = 'green';
  else if (hue < 215) name = 'teal';
  else if (hue < 304) name = 'blue';
  else if (hue < 335) name = 'purple';
  else name = 'magenta';
  // Low-chroma warm colours read as browns/beiges rather than orange/red.
  if (hue >= 15 && hue < 100 && l < 55 && chroma < 70 && name !== 'red') name = 'brown';
  if (hue >= 12 && hue < 45 && l < 35) name = 'maroon';
  if (hue >= 45 && hue < 110 && l > 70 && chroma < 35) name = 'beige';
  if (name === 'pink' && l < 40) name = 'burgundy';
  if (name === 'olive' && l > 75) name = 'lime';
  if (name === 'yellow' && l < 60) name = 'olive';
  if (['brown', 'beige', 'maroon', 'burgundy'].includes(name)) return name;
  if (l < 35) return 'dark ' + name;
  if (l > 80 && chroma < 40) return 'pale ' + name;
  if (l > 70) return 'light ' + name;
  return name;
}
