// Runs colour analysis and digitizing off the main thread.
import { analyze } from './engine/analysis.js';
import { digitize } from './engine/digitizer.js';
import { findThread } from './engine/threads.js';

let quantized = null;

self.onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'analyze') {
      quantized = analyze(msg.small, msg.grid, msg.options);
      self.postMessage({ type: 'analyzed', seq: msg.seq, clusters: quantized.clusters,
        width: quantized.width, height: quantized.height });
    } else if (msg.type === 'digitize') {
      if (!quantized) return;
      const map = new Map(msg.assignments.map(([cluster, threadId]) => [cluster, findThread(threadId)]));
      const settings = { ...msg.settings, outlineThread: msg.settings.outlineThread ? findThread(msg.settings.outlineThread) : null };
      let lastReport = 0;
      const pattern = digitize(quantized, map, settings, (f) => {
        const now = performance.now();
        if (now - lastReport > 150) { lastReport = now; self.postMessage({ type: 'progress', seq: msg.seq, fraction: f }); }
      });
      // Pack stitches as x, y, kind triples for a cheap transfer.
      const packed = new Int32Array(pattern.stitches.length * 3);
      pattern.stitches.forEach((s, i) => { packed[i * 3] = s.x; packed[i * 3 + 1] = s.y; packed[i * 3 + 2] = s.k; });
      self.postMessage({ type: 'digitized', seq: msg.seq, stitches: packed, threads: pattern.threads.map((t) => t.id) },
        [packed.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', seq: msg.seq, message: String(err && err.message || err) });
  }
};
