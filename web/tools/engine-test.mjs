// Runs the whole engine in Node on an image prepared by prep-image.py:
//   python3 prep-image.py image.png 100 /tmp/img && node engine-test.mjs /tmp/img out.pes [setting=value...]
import { readFileSync, writeFileSync } from 'node:fs';
import { analyze } from '../engine/analysis.js';
import { digitize, defaultSettings } from '../engine/digitizer.js';
import { nearestThread, guetermannThreads } from '../engine/threads.js';
import { writePES } from '../engine/pes.js';
import { stats, bounds } from '../engine/pattern.js';
const [prefix, out, ...opts] = process.argv.slice(2);
const meta = JSON.parse(readFileSync(prefix + '.json'));
const buf = (ext, [width, height]) => ({ width, height, data: new Uint8Array(readFileSync(prefix + ext)) });
const t0 = performance.now();
const q = analyze(buf('.small', meta.small), buf('.grid', meta.grid), { colorCount: 8 });
const map = new Map();
for (const c of q.clusters) if (c.coverage > 0.0005 && !c.looksLikeBackground) map.set(c.id, nearestThread('guetermann', c.r, c.g, c.b));
const settings = { ...defaultSettings };
for (const o of opts) {
  const [k, v] = o.split('=');
  settings[k] = k === 'outlineThread' ? guetermannThreads.find((t) => t.code === v) : isNaN(+v) ? v : +v;
}
const t1 = performance.now();
const p = digitize(q, map, settings);
const t2 = performance.now();
writeFileSync(out, writePES(p, out.split('/').pop().replace('.pes', '')));
const st = stats(p), b = bounds(p);
console.log(`${st.stitches} stitches, ${st.trims} trims, ${(b.width / 10).toFixed(1)}x${(b.height / 10).toFixed(1)} mm, ` +
  `analyze ${(t1 - t0).toFixed(0)} ms, digitize ${(t2 - t1).toFixed(0)} ms`);
console.log('  threads: ' + p.threads.map((t) => `${t.code} ${t.name}`).join(' → '));
