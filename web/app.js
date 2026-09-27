import { contentBox } from './engine/analysis.js';
import { defaultSettings } from './engine/digitizer.js';
import { palettes, paletteList, nearestThread, findThread, brotherThread, isBrother, threadLabel, threadHex } from './engine/threads.js';
import { readPES, writePES } from './engine/pes.js';
import { STITCH, COLOR, bounds, stats, threadListText, threadUsage } from './engine/pattern.js';
import { makeZip } from './engine/zip.js';

const $ = (id) => document.getElementById(id);
const CELL_MM = 0.2;
const STORE_KEY = 'replicator.settings.v1';

// ---------------------------------------------------------------- state

const state = {
  source: null,          // canvas holding the (cropped) source image
  sourceName: 'stocking',
  pesMode: false,
  hoop: [130, 180],
  widthMM: 100, heightMM: 100,
  palette: 'guetermann',
  colorCount: 8,
  minRegionMM2: 1.5,
  settings: { ...defaultSettings, outlineThread: null }, // outlineThread holds a thread id here
  choices: [],           // [{ cluster, threadId, enabled }]
  pattern: null,
  view: 'stitches',
  fabric: '#F6F5F0',
  sewout: 1,
  zoom: null,            // preview zoom (1 = actual size); null = fit the hoop to the view
  pan: { x: 0, y: 0 },   // offset of the hoop's centre from the view's centre, in CSS px
};

// Preview zoom. 100% is actual size: CSS assumes 96 px per inch, which most screens roughly honour.
const PX_PER_MM = 96 / 25.4;
const ZOOM_MIN = 0.25, ZOOM_MAX = 4;
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!p) return;
    if (p.settings) Object.assign(state.settings, p.settings);
    for (const k of ['hoop', 'palette', 'colorCount', 'minRegionMM2', 'fabric']) if (p[k] !== undefined) state[k] = p[k];
    if (!palettes[state.palette]) state.palette = 'guetermann';
  } catch { /* storage unavailable: use defaults */ }
}
function savePrefs() {
  try {
    const { hoop, palette, colorCount, minRegionMM2, fabric, settings } = state;
    localStorage.setItem(STORE_KEY, JSON.stringify({ hoop, palette, colorCount, minRegionMM2, fabric, settings }));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- worker

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let seq = 0, analyzeSeq = 0, digitizeSeq = 0;
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress' && m.seq === digitizeSeq) setBusy('Digitizing', m.fraction);
  else if (m.type === 'analyzed' && m.seq === analyzeSeq) onAnalyzed(m);
  else if (m.type === 'digitized' && m.seq === digitizeSeq) onDigitized(m);
  else if (m.type === 'error') { setBusy(null); toast('Something went wrong while digitizing: ' + m.message); }
};
worker.onerror = (e) => { setBusy(null); toast('The digitizer could not start: ' + (e.message || 'unknown error')); };

let analyzeTimer = 0, digitizeTimer = 0;
function scheduleAnalyze(delay = 250) {
  if (!state.source || state.pesMode) return;
  clearTimeout(analyzeTimer); clearTimeout(digitizeTimer);
  setBusy('Finding colours');
  analyzeTimer = setTimeout(runAnalyze, delay);
}
function scheduleDigitize(delay = 150) {
  if (!state.source || state.pesMode || !state.choices.length) return;
  clearTimeout(digitizeTimer);
  setBusy('Digitizing', 0);
  digitizeTimer = setTimeout(runDigitize, delay);
}

/** Resamples the source to `w` x `h` pixels and returns un-premultiplied RGBA. */
function pixels(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(state.source, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: d.data };
}

function runAnalyze() {
  const src = state.source;
  const aspect = src.width / src.height;
  const [sw, sh] = aspect >= 1 ? [200, Math.max(8, Math.round(200 / aspect))] : [Math.max(8, Math.round(200 * aspect)), 200];
  const small = pixels(sw, sh);
  const grid = pixels(Math.max(1, Math.round(state.widthMM / CELL_MM)), Math.max(1, Math.round(state.heightMM / CELL_MM)));
  analyzeSeq = ++seq;
  worker.postMessage({ type: 'analyze', seq: analyzeSeq, small, grid,
    options: { colorCount: state.colorCount, minRegionMM2: state.minRegionMM2, cellMM: CELL_MM } },
  [small.data.buffer, grid.data.buffer]);
}

function onAnalyzed(m) {
  const previous = state.choices;
  state.choices = m.clusters
    .filter((c) => c.coverage > 0.0005)
    .map((c) => {
      // Keep the user's thread choice if the same colour is still present.
      const old = previous.find((o) => Math.abs(o.cluster.r - c.r) + Math.abs(o.cluster.g - c.g) + Math.abs(o.cluster.b - c.b) < 12);
      if (old) return { cluster: c, threadId: old.threadId, enabled: old.enabled };
      return { cluster: c, threadId: nearestThread(state.palette, c.r, c.g, c.b).id, enabled: !c.looksLikeBackground };
    })
    .sort((a, b) => b.cluster.coverage - a.cluster.coverage);
  renderColours();
  scheduleDigitize(0);
}

function runDigitize() {
  digitizeSeq = ++seq;
  const assignments = state.choices.filter((c) => c.enabled).map((c) => [c.cluster.id, c.threadId]);
  if (!assignments.length) {
    state.pattern = null;
    setBusy(null);
    renderAll();
    return;
  }
  worker.postMessage({ type: 'digitize', seq: digitizeSeq, assignments, settings: { ...state.settings } });
}

function onDigitized(m) {
  const stitches = new Array(m.stitches.length / 3);
  for (let i = 0; i < stitches.length; i++) stitches[i] = { x: m.stitches[i * 3], y: m.stitches[i * 3 + 1], k: m.stitches[i * 3 + 2] };
  setPattern({ stitches, threads: m.threads.map(findThread) });
  setBusy(null);
}

function setPattern(p) {
  state.pattern = p;
  state.sewout = 1;
  $('sewout').value = 1000;
  renderAll();
}

// ---------------------------------------------------------------- loading

async function openFile(file) {
  if (!file) return;
  if (/\.pes$/i.test(file.name)) {
    try {
      const { pattern } = readPES(await file.arrayBuffer());
      clearTimeout(analyzeTimer); clearTimeout(digitizeTimer); digitizeSeq = ++seq; setBusy(null);
      state.pesMode = true;
      state.source = null;
      state.choices = [];
      state.sourceName = file.name.replace(/\.pes$/i, '');
      state.zoom = null;
      state.pan = { x: 0, y: 0 };
      $('sourceName').textContent = file.name;
      setPattern(pattern);
      renderControls();
    } catch (err) {
      toast(err.message + ' Try a .pes file saved by PE-Design or this app.');
    }
    return;
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    toast(`${file.name} couldn't be read as an image. Try a PNG or JPEG.`);
    return;
  }
  useImage(bitmap, file.name.replace(/\.[^.]+$/, ''), file.name);
}

function useImage(bitmap, name, title) {
  // Cap the working copy, then crop away a plain border so the size refers to the design itself.
  const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
  const W = Math.round(bitmap.width * scale), H = Math.round(bitmap.height * scale);
  const probeScale = Math.min(1, 600 / Math.max(W, H));
  const pw = Math.max(1, Math.round(W * probeScale)), ph = Math.max(1, Math.round(H * probeScale));
  const probe = document.createElement('canvas');
  probe.width = pw; probe.height = ph;
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  pctx.drawImage(bitmap, 0, 0, pw, ph);
  const box = contentBox({ width: pw, height: ph, data: pctx.getImageData(0, 0, pw, ph).data });
  const crop = box
    ? { x: box.x / probeScale / scale, y: box.y / probeScale / scale, w: box.width / probeScale / scale, h: box.height / probeScale / scale }
    : { x: 0, y: 0, w: bitmap.width, h: bitmap.height };
  const src = document.createElement('canvas');
  src.width = Math.max(1, Math.round(crop.w * scale));
  src.height = Math.max(1, Math.round(crop.h * scale));
  const sctx = src.getContext('2d');
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(bitmap, crop.x, crop.y, crop.w, crop.h, 0, 0, src.width, src.height);

  state.source = src;
  state.pesMode = false;
  state.sourceName = name;
  state.pattern = null;
  state.choices = [];
  state.zoom = null;
  state.pan = { x: 0, y: 0 };
  $('sourceName').textContent = title;
  fitToHoop();
  renderControls();
  renderAll();
}

function fitToHoop() {
  if (!state.source) return;
  const aspect = state.source.width / state.source.height;
  const maxW = state.hoop[0] - 10, maxH = state.hoop[1] - 10;
  let w = maxW, h = maxW / aspect;
  if (h > maxH) { h = maxH; w = maxH * aspect; }
  state.widthMM = Math.round(w * 10) / 10;
  state.heightMM = Math.round(h * 10) / 10;
  $('width').value = state.widthMM;
  $('height').value = state.heightMM;
  scheduleAnalyze();
}

// ---------------------------------------------------------------- controls

const SLIDERS = ['rowSpacingMM', 'stitchLengthMM', 'fillAngle', 'pullCompensationMM', 'satinMaxWidthMM', 'satinSpacingMM', 'outlineWidthMM'];
const CHECKS = ['underlay', 'satinForThinAreas'];

function bindControls() {
  $('file').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
  const drop = $('drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); openFile(e.dataTransfer.files[0]); });
  document.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) openFile(new File([item.getAsFile()], 'pasted-image.png', { type: item.type }));
  });

  $('hoop').addEventListener('change', (e) => { state.hoop = e.target.value.split('x').map(Number); savePrefs(); fitToHoop(); renderAll(); });
  $('fit').addEventListener('click', fitToHoop);
  $('width').addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    if (!(v >= 5) || !state.source) return;
    state.widthMM = v;
    state.heightMM = Math.round((v / (state.source.width / state.source.height)) * 10) / 10;
    $('height').value = state.heightMM;
    scheduleAnalyze(); renderAll();
  });
  $('height').addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    if (!(v >= 5) || !state.source) return;
    state.heightMM = v;
    state.widthMM = Math.round(v * (state.source.width / state.source.height) * 10) / 10;
    $('width').value = state.widthMM;
    scheduleAnalyze(); renderAll();
  });

  fillRangeSelect($('palette'), false);
  $('palette').addEventListener('change', (e) => {
    const p = e.target.value, old = state.palette;
    if (!palettes[p] || p === old) return;
    state.palette = p;
    // Re-match colours that came from the old range; keep ones deliberately taken from another range.
    for (const c of state.choices) {
      if (findThread(c.threadId)?.palette === old) c.threadId = nearestThread(p, c.cluster.r, c.cluster.g, c.cluster.b).id;
    }
    // Re-match the outline from the colour originally chosen, so repeated switches don't drift.
    const ot = state.settings.outlineThread && findThread(state.settings.outlineThread);
    if (ot && ot.palette === old) {
      const [r, g, b] = state.settings.outlineRGB || [ot.r, ot.g, ot.b];
      state.settings.outlineThread = nearestThread(p, r, g, b).id;
    }
    savePrefs(); renderControls(); renderColours(); scheduleDigitize();
  });
  $('colorCount').addEventListener('change', (e) => {
    state.colorCount = Math.max(1, Math.min(16, parseInt(e.target.value, 10) || 8));
    e.target.value = state.colorCount;
    savePrefs(); scheduleAnalyze();
  });
  $('minRegion').addEventListener('change', (e) => {
    state.minRegionMM2 = Math.max(0, parseFloat(e.target.value) || 0);
    savePrefs(); scheduleAnalyze();
  });

  for (const id of SLIDERS) {
    $(id).addEventListener('input', (e) => { state.settings[id] = parseFloat(e.target.value); renderOutputs(); savePrefs(); scheduleDigitize(); });
  }
  for (const id of CHECKS) {
    $(id).addEventListener('change', (e) => { state.settings[id] = e.target.checked; renderControls(); savePrefs(); scheduleDigitize(); });
  }
  $('outlineStyle').addEventListener('change', (e) => { state.settings.outlineStyle = e.target.value; renderControls(); savePrefs(); scheduleDigitize(); });
  $('outlineThread').addEventListener('click', (e) => openPicker(e.currentTarget, state.settings.outlineThread, true, (id) => {
    state.settings.outlineThread = id;
    const t = id && findThread(id);
    state.settings.outlineRGB = t ? [t.r, t.g, t.b] : null;
    renderControls(); savePrefs(); scheduleDigitize();
  }));
  for (const r of document.querySelectorAll('input[name="order"]')) {
    r.addEventListener('change', (e) => { state.settings.sewingOrder = e.target.value; savePrefs(); scheduleDigitize(); });
  }

  document.querySelector('.seg[aria-label="Show"]').addEventListener('click', (e) => {
    const v = e.target.dataset.view;
    if (!v) return;
    state.view = v;
    for (const b of e.currentTarget.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.view === v));
    draw();
  });
  document.querySelector('.fabric').addEventListener('click', (e) => {
    const f = e.target.dataset.fabric;
    if (!f) return;
    state.fabric = f;
    savePrefs(); renderFabric(); draw();
  });
  $('sewout').addEventListener('input', (e) => { state.sewout = e.target.value / 1000; renderSewout(); draw(); });
  $('export').addEventListener('click', exportPES);
  $('threadlist').addEventListener('click', exportThreadList);
  $('printList').addEventListener('click', printThreadList);
  new ResizeObserver(() => { renderZoom(); draw(); }).observe($('drop'));
  bindZoom();
}

function renderOutputs() {
  for (const o of document.querySelectorAll('output[data-for]')) {
    const v = state.settings[o.dataset.for];
    const unit = o.dataset.unit;
    o.textContent = unit === '°' ? `${Math.round(v)}°` : `${v.toFixed(o.dataset.for === 'satinMaxWidthMM' || o.dataset.for === 'outlineWidthMM' ? 1 : 2)} ${unit}`;
  }
}

function renderControls() {
  const s = state.settings;
  $('hoop').value = state.hoop.join('x');
  $('colorCount').value = state.colorCount;
  $('minRegion').value = state.minRegionMM2;
  $('palette').value = state.palette;
  for (const id of SLIDERS) $(id).value = s[id];
  for (const id of CHECKS) $(id).checked = s[id];
  $('outlineStyle').value = s.outlineStyle;
  $('satinWidthRow').hidden = !s.satinForThinAreas;
  $('outlineWidthRow').hidden = s.outlineStyle !== 'satin';
  $('outlineColourRow').hidden = s.outlineStyle === 'none';
  $('orderFewest').checked = s.sewingOrder !== 'layered';
  $('orderLayered').checked = s.sewingOrder === 'layered';
  const ot = s.outlineThread ? findThread(s.outlineThread) : null;
  $('outlineThread').replaceChildren(...chipContent(ot, 'Same as each area'));
  renderOutputs();
  renderFabric();

  $('pesNote').hidden = !state.pesMode;
  for (const id of ['sizeGroup', 'colourGroup', 'fillGroup', 'satinGroup', 'outlineGroup', 'orderGroup']) $(id).hidden = state.pesMode;
}

function renderFabric() {
  for (const b of document.querySelectorAll('.fabric button')) b.setAttribute('aria-pressed', String(b.dataset.fabric === state.fabric));
}

function chipContent(thread, emptyLabel) {
  const sw = document.createElement('span');
  sw.className = 'sw';
  const lbl = document.createElement('span');
  lbl.className = 'lbl';
  if (thread) {
    sw.style.background = threadHex(thread);
    const code = document.createElement('span');
    code.className = 'code';
    code.textContent = isBrother(thread) ? thread.code + '.' : thread.code;
    lbl.append(code, ' ' + thread.name);
    // Say so when a thread comes from a different range than the one being matched to.
    if (thread.palette !== state.palette) {
      const from = document.createElement('span');
      from.className = 'from';
      from.textContent = ' · ' + rangeName(thread.palette);
      lbl.append(from);
    }
  } else {
    sw.style.background = 'conic-gradient(#d33, #eb3, #3a5, #38c, #93c, #d33)';
    lbl.textContent = emptyLabel;
  }
  return [sw, lbl];
}

function renderColours() {
  const list = $('colours');
  list.replaceChildren();
  state.choices.forEach((choice) => {
    const row = document.createElement('div');
    row.className = 'colour' + (choice.enabled ? '' : ' off');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = choice.enabled;
    cb.id = 'use-' + choice.cluster.id;
    cb.setAttribute('aria-label', 'Sew this colour');
    cb.addEventListener('change', () => { choice.enabled = cb.checked; renderColours(); scheduleDigitize(); });
    const src = document.createElement('span');
    src.className = 'src';
    const { r, g, b } = choice.cluster;
    src.style.background = `rgb(${r | 0} ${g | 0} ${b | 0})`;
    src.title = 'Colour in the image' + (choice.cluster.looksLikeBackground ? ' (looks like the background)' : '');
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '→';
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.disabled = !choice.enabled;
    chip.append(...chipContent(findThread(choice.threadId)));
    chip.addEventListener('click', () => openPicker(chip, choice.threadId, false, (id) => {
      choice.threadId = id; renderColours(); scheduleDigitize();
    }));
    const pct = document.createElement('span');
    pct.className = 'pct';
    pct.textContent = choice.cluster.coverage < 0.01 ? '<1%' : Math.round(choice.cluster.coverage * 100) + '%';
    row.append(cb, src, arrow, chip, pct);
    list.append(row);
  });
}

// ---------------------------------------------------------------- shade card picker

let pickerDone = null;
function openPicker(anchor, currentId, allowSame, done) {
  pickerDone = done;
  const picker = $('picker');
  $('pickerSame').hidden = !allowSame;
  $('pickerSearch').value = '';
  // Open on the range of the current thread, so swapping within a range is quick.
  $('pickerRange').value = (currentId && findThread(currentId)?.palette) || state.palette;
  fillPicker(currentId);
  picker.hidden = false;
  const r = anchor.getBoundingClientRect();
  const pw = picker.offsetWidth, ph = picker.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - pw - 16);
  let top = r.bottom + 6;
  if (top + ph > window.innerHeight - 16) top = Math.max(16, r.top - ph - 6);
  picker.style.left = Math.max(16, left) + 'px';
  picker.style.top = top + 'px';
  $('pickerSearch').focus();
}
function fillPicker(currentId) {
  const q = $('pickerSearch').value.trim().toLowerCase();
  const grid = $('pickerGrid');
  grid.replaceChildren();
  const range = $('pickerRange').value;
  const shown = range === 'all' ? paletteList : [palettes[range]];
  for (const p of shown) {
    const matches = p.threads.filter((t) => !q || t.code.includes(q) || t.name.toLowerCase().includes(q));
    if (!matches.length) continue;
    if (shown.length > 1) {
      const h = document.createElement('div');
      h.className = 'range-head';
      h.textContent = `${p.maker} ${p.name}`;
      grid.append(h);
    }
    for (const t of matches) grid.append(swatchButton(t, currentId));
  }
  grid.dataset.current = currentId || '';
}
function swatchButton(t, currentId) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sw-btn' + (t.id === currentId ? ' current' : '');
    b.title = `${t.brand} ${threadLabel(t)}`;
    const i = document.createElement('i');
    i.style.background = threadHex(t);
    b.append(i, isBrother(t) ? t.code + '. ' + t.name.split(' ')[0] : t.code);
    b.addEventListener('click', () => closePicker(t.id));
    return b;
}
function closePicker(id) {
  $('picker').hidden = true;
  if (id !== undefined && pickerDone) pickerDone(id);
  pickerDone = null;
}
$('pickerSearch').addEventListener('input', () => fillPicker($('pickerGrid').dataset.current));
$('pickerRange').addEventListener('change', () => fillPicker($('pickerGrid').dataset.current));

/** Fills a <select> with the thread ranges, grouped by maker. */
function fillRangeSelect(select, includeAll) {
  select.replaceChildren();
  if (includeAll) select.append(new Option('All ranges', 'all'));
  const groups = new Map();
  for (const p of paletteList) {
    if (!groups.has(p.maker)) {
      const g = document.createElement('optgroup');
      g.label = p.maker;
      groups.set(p.maker, g);
      select.append(g);
    }
    groups.get(p.maker).append(new Option(p.id === 'brother' ? 'Brother (PEC colours)' : `${p.maker} ${p.name}`, p.id));
  }
}
function rangeName(id) {
  const p = palettes[id];
  return p ? (p.maker === palettes[state.palette]?.maker ? p.name : `${p.maker} ${p.name}`) : '';
}
fillRangeSelect($('pickerRange'), true);
$('pickerSame').addEventListener('click', () => closePicker(null));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('picker').hidden) closePicker(); });
document.addEventListener('pointerdown', (e) => {
  if ($('picker').hidden || $('picker').contains(e.target) || e.target.closest('.chip')) return;
  closePicker();
});

// ---------------------------------------------------------------- preview

function draw() {
  const canvas = $('view');
  const wrap = $('drop');
  const dpr = window.devicePixelRatio || 1;
  const cw = wrap.clientWidth, ch = wrap.clientHeight;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  const css = getComputedStyle(document.documentElement);

  const p = state.pattern;
  const b = p ? bounds(p) : null;
  // Design size in mm, and the hoop around it.
  const dW = state.pesMode && b ? b.width / 10 : state.widthMM, dH = state.pesMode && b ? b.height / 10 : state.heightMM;
  const hoopW = state.pesMode ? Math.max(dW + 20, 100) : Math.max(state.hoop[0], dW);
  const hoopH = state.pesMode ? Math.max(dH + 20, 100) : Math.max(state.hoop[1], dH);
  const { scale, cx: hcx, cy: hcy } = viewGeometry(cw, ch, hoopW, hoopH);
  if (!(scale > 0)) return;
  const hx = hcx - (hoopW * scale) / 2, hy = hcy - (hoopH * scale) / 2;
  const radius = Math.min(18, hoopW * scale * 0.08);

  // Hoop frame and fabric
  ctx.save();
  roundRect(ctx, hx - 9, hy - 9, hoopW * scale + 18, hoopH * scale + 18, radius + 9);
  ctx.fillStyle = css.getPropertyValue('--hoop');
  ctx.fill();
  roundRect(ctx, hx, hy, hoopW * scale, hoopH * scale, radius);
  ctx.fillStyle = state.fabric;
  ctx.fill();
  ctx.clip();
  // Template sheet grid: 10 mm squares from the centre, as on Brother's embroidery sheets.
  const dark = luminance(state.fabric) < 0.4;
  ctx.strokeStyle = dark ? 'rgb(255 255 255 / 0.10)' : 'rgb(40 60 90 / 0.10)';
  ctx.lineWidth = 1;
  const cx = hcx, cy = hcy;
  ctx.beginPath();
  for (let mm = -Math.ceil(hoopW / 20) * 10; mm <= hoopW / 2; mm += 10) { const x = Math.round(cx + mm * scale) + 0.5; ctx.moveTo(x, hy); ctx.lineTo(x, hy + hoopH * scale); }
  for (let mm = -Math.ceil(hoopH / 20) * 10; mm <= hoopH / 2; mm += 10) { const y = Math.round(cy + mm * scale) + 0.5; ctx.moveTo(hx, y); ctx.lineTo(hx + hoopW * scale, y); }
  ctx.stroke();
  ctx.strokeStyle = dark ? 'rgb(255 255 255 / 0.22)' : 'rgb(40 60 90 / 0.22)';
  ctx.beginPath();
  ctx.moveTo(cx, hy); ctx.lineTo(cx, hy + hoopH * scale);
  ctx.moveTo(hx, cy); ctx.lineTo(hx + hoopW * scale, cy);
  ctx.stroke();

  // Design, centred in the hoop
  const ox = cx - (dW * scale) / 2, oy = cy - (dH * scale) / 2;
  if (state.source && !state.pesMode && state.view !== 'stitches') {
    ctx.globalAlpha = state.view === 'both' ? 0.35 : 1;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(state.source, ox, oy, dW * scale, dH * scale);
    ctx.globalAlpha = 1;
  }
  if (p && b && state.view !== 'image') {
    // Stitches are in 0.1 mm; place the pattern's bounding box on the design rectangle.
    const s = scale / 10;
    const offX = cx - (b.width * s) / 2 - b.minX * s, offY = cy - (b.height * s) / 2 - b.minY * s;
    const limit = Math.round(p.stitches.length * state.sewout);
    const threadW = Math.max(0.6, 0.38 * scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    let block = 0, run = [];
    const flush = () => {
      if (run.length < 2) { run = []; return; }
      const t = p.threads[Math.min(block, p.threads.length - 1)];
      ctx.beginPath();
      ctx.moveTo(offX + run[0].x * s, offY + run[0].y * s);
      for (let i = 1; i < run.length; i++) ctx.lineTo(offX + run[i].x * s, offY + run[i].y * s);
      if (threadW > 1.2) {
        ctx.strokeStyle = 'rgb(0 0 0 / 0.28)';
        ctx.lineWidth = threadW + 0.8;
        ctx.stroke();
      }
      ctx.strokeStyle = threadHex(t);
      ctx.lineWidth = threadW;
      ctx.stroke();
      run = [];
    };
    for (let i = 0; i < limit; i++) {
      const st = p.stitches[i];
      if (st.k === STITCH) run.push(st);
      else { flush(); if (st.k === COLOR) block++; run = [st]; }
    }
    flush();
    // Needle position during a partial sew-out
    if (limit < p.stitches.length && limit > 0) {
      const st = p.stitches[limit - 1];
      ctx.beginPath();
      ctx.arc(offX + st.x * s, offY + st.y * s, 5, 0, Math.PI * 2);
      ctx.strokeStyle = css.getPropertyValue('--accent');
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
  ctx.restore();

  // Hoop label
  ctx.fillStyle = css.getPropertyValue('--muted');
  ctx.font = '500 11px ' + css.getPropertyValue('--font-mono');
  ctx.textBaseline = 'bottom';
  if (!state.pesMode) ctx.fillText(`${state.hoop[0]} × ${state.hoop[1]} mm hoop`, hx, hy - 12);
}

/** The hoop's size in mm for the current design (a margin around it when previewing a PES file). */
function hoopSize() {
  const b = state.pattern ? bounds(state.pattern) : null;
  const dW = state.pesMode && b ? b.width / 10 : state.widthMM, dH = state.pesMode && b ? b.height / 10 : state.heightMM;
  return state.pesMode
    ? [Math.max(dW + 20, 100), Math.max(dH + 20, 100)]
    : [Math.max(state.hoop[0], dW), Math.max(state.hoop[1], dH)];
}

/** Pixels per mm that fit the whole hoop in the view. */
function fitScale(cw, ch, hoopW, hoopH) {
  const pad = 28;
  return Math.max(0.01, Math.min((cw - pad * 2) / hoopW, (ch - pad * 2) / hoopH));
}

/** Scale (px per mm) and hoop centre for the current zoom and pan, with the pan kept in range. */
function viewGeometry(cw, ch, hoopW, hoopH) {
  const scale = state.zoom ? state.zoom * PX_PER_MM : fitScale(cw, ch, hoopW, hoopH);
  // Pan only as far as keeps the hoop's edge (plus a margin) at the view's edge; a hoop that fits stays centred.
  const limX = Math.max(0, (hoopW * scale - cw) / 2 + 40), limY = Math.max(0, (hoopH * scale - ch) / 2 + 40);
  state.pan.x = Math.max(-limX, Math.min(limX, state.pan.x));
  state.pan.y = Math.max(-limY, Math.min(limY, state.pan.y));
  return { scale, cx: cw / 2 + state.pan.x, cy: ch / 2 + state.pan.y };
}

/** The effective zoom (1 = actual size), whether fitted or set. */
function currentZoom() {
  if (state.zoom) return state.zoom;
  const [hw, hh] = hoopSize();
  return fitScale($('drop').clientWidth, $('drop').clientHeight, hw, hh) / PX_PER_MM;
}

/** Sets the zoom, keeping the point under (px, py) in the view still. zoom null = fit. */
function setZoom(zoom, px, py) {
  const wrap = $('drop');
  const cw = wrap.clientWidth, ch = wrap.clientHeight;
  const [hw, hh] = hoopSize();
  if (zoom === null) {
    state.zoom = null;
    state.pan = { x: 0, y: 0 };
  } else {
    const before = viewGeometry(cw, ch, hw, hh);
    const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
    const ax = px ?? cw / 2, ay = py ?? ch / 2;
    const mmX = (ax - before.cx) / before.scale, mmY = (ay - before.cy) / before.scale;
    state.zoom = z;
    const s = z * PX_PER_MM;
    state.pan = { x: ax - mmX * s - cw / 2, y: ay - mmY * s - ch / 2 };
  }
  renderZoom();
  requestDraw();
}

function stepZoom(dir) {
  const z = currentZoom();
  const next = dir > 0 ? ZOOM_STEPS.find((s) => s > z + 0.001) : [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001);
  setZoom(next ?? (dir > 0 ? ZOOM_MAX : ZOOM_MIN));
}

function renderZoom() {
  const sel = $('zoom');
  const pct = Math.round(currentZoom() * 100);
  sel.querySelector('[value="fit"]').textContent = `Fit (${pct}%)`;
  const custom = sel.querySelector('[value="custom"]');
  const isStep = state.zoom && ZOOM_STEPS.some((s) => Math.abs(s - state.zoom) < 0.001);
  custom.hidden = !state.zoom || isStep;
  custom.textContent = `${pct}%`;
  sel.value = !state.zoom ? 'fit' : isStep ? String(ZOOM_STEPS.find((s) => Math.abs(s - state.zoom) < 0.001)) : 'custom';
  $('zoomOut').disabled = currentZoom() <= ZOOM_MIN + 0.001;
  $('zoomIn').disabled = currentZoom() >= ZOOM_MAX - 0.001;
  $('zoomFit').disabled = !state.zoom;
  $('drop').classList.toggle('pannable', !!state.zoom);
}

let drawQueued = false;
function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; draw(); });
}

/** Zoom and pan gestures on the preview: ⌘/Ctrl-scroll or trackpad pinch, touch pinch, drag, double-click. */
function bindZoom() {
  const wrap = $('drop');
  const local = (e) => { const r = wrap.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  $('zoomIn').addEventListener('click', () => stepZoom(1));
  $('zoomOut').addEventListener('click', () => stepZoom(-1));
  $('zoomFit').addEventListener('click', () => setZoom(null));
  $('zoom').addEventListener('change', (e) => {
    const v = e.target.value;
    if (v === 'fit') setZoom(null); else if (v !== 'custom') setZoom(parseFloat(v));
  });
  wrap.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return; // plain scrolling still scrolls the page
    e.preventDefault();
    const [x, y] = local(e);
    setZoom(currentZoom() * Math.exp(-e.deltaY * 0.01), x, y);
  }, { passive: false });
  wrap.addEventListener('dblclick', (e) => {
    const [x, y] = local(e);
    setZoom(state.zoom && Math.abs(state.zoom - 1) < 0.001 ? null : 1, x, y);
  });
  // Drag to pan (when zoomed), two fingers to pinch.
  const pointers = new Map();
  let pinch = null;
  wrap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.busy, .banner')) return;
    pointers.set(e.pointerId, local(e));
    wrap.setPointerCapture(e.pointerId);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: currentZoom() };
    }
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId), cur = local(e);
    pointers.set(e.pointerId, cur);
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
      setZoom(pinch.zoom * (dist / pinch.dist), (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    } else if (pointers.size === 1 && state.zoom) {
      state.pan.x += cur[0] - prev[0];
      state.pan.y += cur[1] - prev[1];
      wrap.classList.add('panning');
      requestDraw();
    }
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) wrap.classList.remove('panning');
  };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', end);
  // Keyboard: + and − zoom, 0 fits, when not typing in a field.
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '+' || e.key === '=') stepZoom(1);
    else if (e.key === '-') stepZoom(-1);
    else if (e.key === '0') setZoom(null);
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

function renderSewout() {
  const p = state.pattern;
  const out = $('sewoutOut');
  if (!p) { out.textContent = '—'; return; }
  const n = Math.round(p.stitches.length * state.sewout);
  out.textContent = state.sewout >= 1 ? 'all stitches' : `${n.toLocaleString()} of ${p.stitches.length.toLocaleString()}`;
}

function renderStats() {
  const p = state.pattern;
  const el = $('stats');
  el.replaceChildren();
  if (!p) return;
  const st = stats(p), b = bounds(p), usage = threadUsage(p);
  const unique = new Set(p.threads.map((t) => t.id)).size;
  const changes = Math.max(0, p.threads.length - 1);
  // The 750E sews at up to 850 stitches/min; allow for colour changes and trims.
  const minutes = Math.ceil(st.stitches / 700 + changes * 0.5 + st.trims * 0.1);
  const tooBig = !state.pesMode && (b.width / 10 > state.hoop[0] || b.height / 10 > state.hoop[1]);
  const items = [
    ['Size', `${(b.width / 10).toFixed(1)} × ${(b.height / 10).toFixed(1)} mm`, tooBig],
    ['Stitches', st.stitches.toLocaleString()],
    ['Threads', String(unique)],
    ['Colour changes', String(changes)],
    ['Trims', String(st.trims)],
    ['Sewing time', `≈ ${minutes} min`],
    ['Thread', `≈ ${Math.ceil(usage.top)} m + ${Math.ceil(usage.bobbin)} m bobbin`],
  ];
  for (const [k, v, warn] of items) {
    const d = document.createElement('div');
    if (warn) d.className = 'warn';
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    d.append(dt, dd);
    el.append(d);
  }
  const banner = $('banner');
  banner.hidden = !tooBig;
  banner.textContent = tooBig ? `This design is larger than the ${state.hoop[0]} × ${state.hoop[1]} mm hoop. Choose Fit to hoop or a bigger hoop.` : '';
}

/** Thread length for display: to the next half metre below 10 m, whole metres above. */
function metres(m) {
  return m < 10 ? `≈ ${(Math.ceil(m * 2) / 2).toFixed(1)} m` : `≈ ${Math.ceil(m)} m`;
}

function renderSequence() {
  const p = state.pattern;
  const list = $('sequence');
  list.replaceChildren();
  $('sequenceTitle').textContent = p ? `Thread changes (${Math.max(0, p.threads.length - 1)})` : 'Thread changes';
  if (!p) return;
  const usage = threadUsage(p);
  p.threads.forEach((t, i) => {
    const li = document.createElement('li');
    li.className = 'spool';
    const sw = document.createElement('span');
    sw.className = 'sw';
    sw.style.background = threadHex(t);
    const top = document.createElement('span');
    const n = document.createElement('span'); n.className = 'n'; n.textContent = String(i + 1);
    const code = document.createElement('b'); code.textContent = isBrother(t) ? t.code + '.' : t.code;
    top.className = 'spool-top';
    const amount = document.createElement('span');
    amount.className = 'amount';
    amount.textContent = metres(usage.blocks[i]);
    amount.title = 'Estimated top thread for this colour';
    const name = document.createElement('span');
    name.append(n, code, ' ' + t.name);
    top.append(name, amount);
    const sub = document.createElement('small');
    sub.textContent = isBrother(t) ? 'Brother' : `${t.brand} · machine shows ${brotherThread(t.pecIndex).name}`;
    li.append(sw, top, sub);
    list.append(li);
  });
}

function renderAll() {
  renderStats();
  renderSequence();
  renderSewout();
  $('export').disabled = !state.pattern || state.pesMode;
  $('threadlist').hidden = !state.pattern || state.pesMode || !!downloads;
  // Pages hosted on claude.ai can't open the print dialog, so the button only shows elsewhere.
  $('printList').hidden = !state.pattern || !!window.claude?.use;
  renderZoom();
  draw();
}

function setBusy(text, fraction) {
  const el = $('busy');
  if (!text) { el.hidden = true; return; }
  el.hidden = false;
  $('busyText').textContent = text;
  $('busyFill').style.width = fraction === undefined ? '15%' : Math.round(fraction * 100) + '%';
}

let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

// ---------------------------------------------------------------- export

// On claude.ai, pages save files through the downloads capability, which doesn't accept .pes, so the
// design is saved as a .zip holding the .pes and its thread list. Elsewhere, plain downloads are used.
let downloads = null;
if (window.claude?.use) {
  window.claude.use('downloads').then((d) => {
    downloads = d;
    if (d) $('export').textContent = 'Download PES (.zip)';
    renderAll();
  }).catch(() => {});
}

const safeName = () => (state.sourceName || 'design').replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'design';

async function exportPES() {
  const p = state.pattern;
  if (!p) return;
  const name = safeName();
  const pes = writePES(p, name);
  const list = threadListText(p, name);
  if (downloads) {
    try {
      const zip = makeZip([{ name: name + '.pes', data: pes }, { name: name + '.threads.txt', data: list }]);
      await downloads.save({ filename: name + '.zip', data: zip });
      toast(`Saved ${name}.zip with the PES file and its thread list.`);
    } catch (err) {
      if (err?.code === 'declined') return;
      toast(err?.code === 'rate_limited' ? 'A save is already waiting for your answer.' : 'The file could not be saved here.');
    }
    return;
  }
  saveBlob(name + '.pes', new Blob([pes], { type: 'application/octet-stream' }));
}

/** Draws the design's stitches (no hoop) onto a white canvas at most `max` px on its longer side. */
function designImage(p, max) {
  const b = bounds(p);
  const pad = 0.04 * Math.max(b.width, b.height);
  const s = max / (Math.max(b.width, b.height) + pad * 2);
  const c = document.createElement('canvas');
  c.width = Math.round((b.width + pad * 2) * s);
  c.height = Math.round((b.height + pad * 2) * s);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fafaf7';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, 3.8 * s);
  const ox = (pad - b.minX) * s, oy = (pad - b.minY) * s;
  let block = 0, run = [];
  const flush = () => {
    if (run.length > 1) {
      ctx.strokeStyle = threadHex(p.threads[Math.min(block, p.threads.length - 1)]);
      ctx.beginPath();
      ctx.moveTo(ox + run[0].x * s, oy + run[0].y * s);
      for (const q of run.slice(1)) ctx.lineTo(ox + q.x * s, oy + q.y * s);
      ctx.stroke();
    }
    run = [];
  };
  for (const st of p.stitches) {
    if (st.k === STITCH) run.push(st);
    else { flush(); if (st.k === COLOR) block++; run = [st]; }
  }
  flush();
  return c.toDataURL('image/png');
}

/** Builds a one-page thread list (design picture, facts, a table to tick off) and opens the print dialog. */
async function printThreadList() {
  const p = state.pattern;
  if (!p) return;
  const st = stats(p), b = bounds(p), usage = threadUsage(p);
  const changes = Math.max(0, p.threads.length - 1);
  const minutes = Math.ceil(st.stitches / 700 + changes * 0.5 + st.trims * 0.1);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

  const sheet = $('printSheet');
  sheet.replaceChildren();
  const head = el('header', 'ps-head');
  const when = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  const sub = el('p');
  sub.append('Thread list · Brother PES', document.createElement('br'), when);
  head.append(el('h1', '', state.sourceName || 'Design'), sub);

  const top = el('div', 'ps-top');
  const img = new Image();
  img.src = designImage(p, 900);
  img.alt = '';
  const facts = el('dl', 'ps-facts');
  const fact = (k, v) => facts.append(el('dt', '', k), el('dd', '', v));
  fact('Size', `${(b.width / 10).toFixed(1)} × ${(b.height / 10).toFixed(1)} mm`);
  if (!state.pesMode) fact('Hoop', `${state.hoop[0]} × ${state.hoop[1]} mm`);
  fact('Stitches', st.stitches.toLocaleString());
  fact('Colour changes', String(changes));
  fact('Trims', String(st.trims));
  fact('Sewing time', `about ${minutes} min`);
  fact('Top thread', `about ${Math.ceil(usage.top)} m`);
  fact('Bobbin thread', `about ${Math.ceil(usage.bobbin)} m`);
  top.append(img, facts);

  const table = el('table', 'ps-table');
  const hr = el('tr');
  for (const h of ['#', '', 'Thread', 'Colour', 'Machine shows', 'Estimate', 'Done']) hr.append(el('th', '', h));
  const thead = el('thead');
  thead.append(hr);
  const tbody = el('tbody');
  p.threads.forEach((t, i) => {
    const tr = el('tr');
    const sw = el('span', 'ps-sw');
    sw.style.background = threadHex(t);
    const swCell = el('td');
    swCell.append(sw);
    const name = el('td');
    name.append(el('strong', 'num', isBrother(t) ? t.code + '.' : t.code), ' ', el('span', '', t.brand));
    const tick = el('td');
    tick.append(el('span', 'ps-tick'));
    tr.append(el('td', 'num', String(i + 1)), swCell, name, el('td', '', t.name),
      el('td', '', isBrother(t) ? '—' : brotherThread(t.pecIndex).name), el('td', 'amt', metres(usage.blocks[i])), tick);
    tbody.append(tr);
  });
  table.append(thead, tbody);

  const note = el('p', 'ps-note', 'Load the threads in this order; the machine asks for each change but names Brother colours. ' +
    'Thread amounts are estimates (about ±25%), so allow some spare. Colours on screen and in print are approximate.');
  sheet.append(head, top, table, note);
  try { await img.decode(); } catch { /* print anyway */ }
  window.print();
}

function exportThreadList() {
  if (!state.pattern) return;
  const name = safeName();
  saveBlob(name + '.threads.txt', new Blob([threadListText(state.pattern, name)], { type: 'text/plain' }));
}

function saveBlob(filename, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- start

loadPrefs();
bindControls();
renderControls();
renderAll();
// Open with the sample so the first view shows what the tool does.
fetch(new URL('./sample-stocking.png', import.meta.url))
  .then((r) => r.blob())
  .then((b) => createImageBitmap(b))
  .then((bm) => { if (!state.source && !state.pesMode) useImage(bm, 'stocking', 'Sample: Christmas stocking'); })
  .catch(() => { $('sourceName').textContent = 'Open an image to begin'; });
