// node roundtrip-test.mjs file.pes... : reads each file, writes it back and counts differing bytes. Files this app
// wrote come back identical; Brother's own differ only in the 48x38 thumbnail pictures.
import { readFileSync } from 'node:fs';
import { readPES, writePES } from '../engine/pes.js';
for (const f of process.argv.slice(2)) {
  const orig = readFileSync(f);
  const { pattern, label } = readPES(orig.buffer.slice(orig.byteOffset, orig.byteOffset + orig.length));
  const out = writePES(pattern, label);
  let diff = 0;
  for (let i = 0; i < Math.max(out.length, orig.length); i++) if (out[i] !== orig[i]) diff++;
  console.log(f.split('/').pop().padEnd(34), 'bytes', orig.length, out.length, 'differing', diff);
}
