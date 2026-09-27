// Regenerates the README screenshots in docs/images/ by driving headless Chrome over the DevTools protocol.
//   node web/tools/screenshots.mjs
// Needs Google Chrome (set CHROME to another Chromium-based browser's binary if you like). No npm packages.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..');
const OUT = join(WEB, '..', 'docs', 'images');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

// ---- a static server for web/
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  const file = join(WEB, path || 'index.html');
  if (!file.startsWith(WEB) || !existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const APP = `http://127.0.0.1:${server.address().port}/`;

// ---- headless Chrome with a throwaway profile (so no saved settings leak in)
const profile = mkdtempSync(join(tmpdir(), 'replicator-shots-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ }
}
if (!target) throw new Error('Chrome did not start');

// ---- minimal DevTools protocol client
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let nextId = 1;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const run = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'page error');
  return r.result.value;
};
/** Waits until the app has finished digitizing. */
const settled = async () => {
  for (let i = 0; i < 100; i++) {
    await sleep(150);
    if (await run(`document.getElementById('busy').hidden && !!document.querySelector('#stats dd')`)) { await sleep(300); return; }
  }
  throw new Error('the app did not finish digitizing');
};
const viewport = (width, height, mobile = false) =>
  send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile });
const theme = (value) => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
const shoot = async (name, clip) => {
  const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 }, captureBeyondViewport: true } : {}) });
  writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'));
  console.log('wrote docs/images/' + name);
};
/** An element's box in page coordinates (what screenshot clips use), not viewport coordinates. */
const rectOf = (selector) => run(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
  return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()`);

/** Loads the app with the sample and black satin outlines, the way the README describes it. */
async function openApp() {
  await send('Page.navigate', { url: APP });
  await sleep(500);
  await settled();
  await run(`(() => {
    const s = document.getElementById('outlineStyle'); s.value = 'satin'; s.dispatchEvent(new Event('change'));
    document.getElementById('outlineThread').click();
    [...document.querySelectorAll('#pickerGrid .sw-btn')].find((b) => b.title.endsWith('1005 · black')).click();
  })()`);
  await settled();
}

try {
  mkdirSync(OUT, { recursive: true });
  await send('Page.enable');

  // 1. The whole app, light and dark
  await viewport(1440, 900);
  for (const mode of ['light', 'dark']) {
    await theme(mode);
    await openApp();
    await shoot(`app-${mode}.png`);
  }

  // 2. Stitch detail: zoomed in on the cuff, loop and outline (dark theme, preview only)
  await run(`(() => { const z = document.getElementById('zoom'); z.value = '3'; z.dispatchEvent(new Event('change')); })()`);
  const drop = await rectOf('#drop');
  // Drag the view so the top of the stocking (loop and cuff) is in frame.
  const cx = drop.x + drop.width / 2, cy = drop.y + drop.height / 2;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 10; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx + 12 * i, y: cy + 70 * i, button: 'left', buttons: 1 });
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx + 120, y: cy + 700, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(300);
  await shoot('stitch-detail.png', drop);

  // 3. Mixing ranges: the thread picker open on Madeira Polyneon over the colour list (light theme)
  await theme('light');
  await openApp();
  await run(`(() => {
    // Put the colour list at the top of the settings panel, so the picker opens below its chip.
    const controls = document.querySelector('.controls');
    controls.scrollTop += document.getElementById('colours').getBoundingClientRect().top - controls.getBoundingClientRect().top - 40;
    const chip = [...document.querySelectorAll('#colours .chip')].find((c) => c.textContent.includes('red'));
    chip.click();
    const r = document.getElementById('pickerRange'); r.value = 'polyneon'; r.dispatchEvent(new Event('change'));
  })()`);
  await sleep(300);
  const list = await rectOf('#colours');
  const picker = await rectOf('#picker');
  const x0 = Math.min(list.x, picker.x) - 16, y0 = Math.min(list.y, picker.y) - 16;
  const x1 = Math.max(list.x + list.width, picker.x + picker.width) + 16, y1 = Math.max(list.y + list.height, picker.y + picker.height) + 16;
  await shoot('thread-picker.png', { x: Math.max(0, x0), y: Math.max(0, y0), width: x1 - Math.max(0, x0), height: y1 - Math.max(0, y0) });

  // 4. Thread changes with estimated amounts
  await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); document.querySelector('.sequence').scrollIntoView()`);
  await sleep(200);
  const seq = await rectOf('.sequence');
  await shoot('thread-changes.png', { x: seq.x - 8, y: seq.y - 8, width: seq.width + 16, height: seq.height + 16 });

  // 5. The printed thread list, as it comes out on A4 (print styles, printing itself stubbed out)
  await run(`window.print = () => {}; document.getElementById('printList').click()`);
  await sleep(500);
  await viewport(794, 1123); // A4 at 96 dpi
  await send('Emulation.setEmulatedMedia', { media: 'print', features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  // Screenshots don't apply @page margins, so stand in for them.
  await run(`document.getElementById('printSheet').style.padding = '14mm'`);
  await sleep(300);
  const sheet = await rectOf('#printSheet');
  await shoot('print-sheet.png', { x: 0, y: 0, width: 794, height: Math.ceil(sheet.y + sheet.height + 40) });
  await send('Emulation.setEmulatedMedia', { media: '', features: [] });

  // 6. On a phone (dark)
  await viewport(390, 844, true);
  await theme('dark');
  await openApp();
  await run('window.scrollTo(0, 0)');
  await shoot('phone-dark.png');
} finally {
  ws.close();
  chrome.kill();
  server.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
