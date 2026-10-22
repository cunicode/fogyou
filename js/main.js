import { FrostRenderer } from './renderer.js';

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const statusEl = $('status');
const dropHint = $('drop-hint');

let statusHold = 0;
function setStatus(text, loading = false, hold = 0) {
  // Live fps updates must not hide a message the user still needs to read.
  if (!hold && performance.now() < statusHold) return;
  statusHold = hold ? performance.now() + hold : 0;
  statusEl.textContent = text;
  statusEl.classList.toggle('loading', loading);
}

let renderer;
try {
  renderer = new FrostRenderer(canvas);
} catch (err) {
  statusEl.textContent = err.message;
  throw err;
}

// ---------------------------------------------------------------- parameters

let dirty = true;
function requestRender() {
  dirty = true;
}

const params = {
  focus: 0.55,
  fade: 0.3,
  blur: 24,
  white: 0.85,
  frost: 0.5,
  scale: 1,
  haze: 0,
  contact: 0,
  saturation: 1,
  tint: [1, 1, 1],
  invert: false,
  animateGrain: false,
  view: 0,
  smoothing: 0.6,
  sync: false,
};

const sliders = ['focus', 'fade', 'blur', 'white', 'frost', 'scale', 'haze', 'contact', 'saturation', 'smoothing'];
for (const key of sliders) {
  const input = $(key);
  const out = $(`${key}-val`);
  const update = () => {
    params[key] = parseFloat(input.value);
    if (out) out.textContent = key === 'blur' ? `${input.value}px` : Number(input.value).toFixed(2);
    requestRender();
  };
  input.addEventListener('input', update);
  update();
}
function setTint(hex) {
  $('tint').value = hex;
  params.tint = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  requestRender();
}
$('tint').addEventListener('input', (e) => setTint(e.target.value));
for (const key of ['invert', 'animateGrain', 'sync']) {
  $(key).addEventListener('change', (e) => {
    params[key] = e.target.checked;
    requestRender();
  });
}
document.querySelectorAll('[data-view]').forEach((btn) =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b === btn));
    params.view = Number(btn.dataset.view);
    requestRender();
  }),
);

function setSlider(key, value) {
  const input = $(key);
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

const PRESETS = {
  // Hands and face pressed on a frosted shower door: only the contact is clear, the rest
  // dissolves into a cool, slightly grey haze with fine grain over everything.
  pressed: { fade: 0.45, blur: 90, white: 0.8, frost: 0.55, scale: 0.6, haze: 0.14, contact: 0.1, saturation: 0.75, tint: '#e8edf1' },
  classic: { fade: 0.3, blur: 24, white: 0.85, frost: 0.5, scale: 1, haze: 0, contact: 0, saturation: 1, tint: '#ffffff' },
  dense: { fade: 0.2, blur: 140, white: 0.95, frost: 0.7, scale: 1.2, haze: 0.22, contact: 0.2, saturation: 0.6, tint: '#f3f5f7' },
};

function applyPreset(name) {
  const { tint, ...values } = PRESETS[name];
  for (const [key, value] of Object.entries(values)) setSlider(key, value);
  setTint(tint);
  autoGlass();
}
$('preset').addEventListener('change', (e) => applyPreset(e.target.value));

// Put the glass just behind the nearest few percent of the scene, so only what
// actually touches it stays sharp.
function autoGlass() {
  if (!depth) return;
  const { data } = depth;
  const step = Math.max(1, Math.floor(data.length / 20000));
  const sample = [];
  for (let i = 0; i < data.length; i += step) sample.push(params.invert ? 1 - data[i] : data[i]);
  sample.sort((a, b) => a - b);
  setSlider('focus', sample[Math.floor(sample.length * 0.9)].toFixed(3));
}
$('auto-glass').addEventListener('click', autoGlass);

// ---------------------------------------------------------------- depth worker

const worker = new Worker(new URL('./depth-worker.js', import.meta.url), { type: 'module' });
let modelReady = false;
let onGPU = false;
let nextId = 1;
const pending = new Map();
const progress = new Map();

worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'progress') {
    progress.set(msg.file, [msg.loaded, msg.total]);
    let l = 0, t = 0;
    for (const [a, b] of progress.values()) { l += a; t += b; }
    setStatus(`Downloading depth model… ${t ? Math.round((l / t) * 100) : 0}%`, true);
  } else if (msg.type === 'ready') {
    modelReady = true;
    onGPU = msg.gpu;
    setStatus(
      onGPU
        ? `Depth model ready (${msg.device})`
        : 'Depth model running on the CPU (no WebGPU here), so video will be slow. Chrome or Edge on desktop use the GPU.',
      false,
      onGPU ? 0 : 8000,
    );
    $('model').disabled = false;
    if (source) refreshDepth();
  } else if (msg.type === 'depth') {
    pending.get(msg.id)?.resolve(msg);
    pending.delete(msg.id);
  } else if (msg.type === 'error') {
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id).reject(new Error(msg.message));
      pending.delete(msg.id);
    } else {
      setStatus(`Model error: ${msg.message}`, false, 8000);
    }
  }
};

function loadModel() {
  modelReady = false;
  progress.clear();
  $('model').disabled = true;
  setStatus('Loading depth model…', true);
  worker.postMessage({ type: 'load', model: $('model').value });
}
$('model').addEventListener('change', loadModel);
loadModel();

// Model input size (long side). Smaller is much faster; stills always get full detail.
const IMAGE_DETAIL = 700;
function liveDetail() {
  return Number($('detail').value);
}

// Copies a frame (image, bitmap or video) into an ImageBitmap of the given size.
// Drawing through a canvas works for every source; createImageBitmap(video) does not
// in all browsers.
const grab = new OffscreenCanvas(1, 1);
const grabCtx = grab.getContext('2d');
function snapshot(frame, w, h) {
  grab.width = w;
  grab.height = h;
  grabCtx.drawImage(frame, 0, 0, w, h);
  return grab.transferToImageBitmap();
}

// The frame goes to the worker as a small ImageBitmap, so the main thread never
// waits on a GPU readback.
function estimateDepth(frame, w, h, size) {
  const s = Math.min(1, size / Math.max(w, h));
  const bitmap = snapshot(frame, Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ type: 'depth', id, bitmap, size }, [bitmap]);
  });
}

// Last depth map on the CPU: used for temporal smoothing and click-to-focus.
let depth = null; // { data, width, height }

function applyDepth(result, smoothing) {
  const { width, height } = result;
  let data = result.depth;
  if (smoothing > 0 && depth && depth.width === width && depth.height === height) {
    const prev = depth.data;
    for (let i = 0; i < data.length; i++) data[i] = prev[i] * smoothing + data[i] * (1 - smoothing);
  }
  const first = !depth;
  depth = { data, width, height };
  renderer.setDepth(data, width, height);
  if (first) autoGlass();
}

// ---------------------------------------------------------------- sources

let source = null; // { kind: 'image'|'video'|'webcam', el, width, height }
let stream = null;
let busy = false;
const depthTimes = [];
let exporting = false;

function sizeFor(w, h, max) {
  // Even dimensions (required by H.264) and capped for performance.
  const s = Math.min(1, max / Math.max(w, h));
  return [Math.max(2, Math.round((w * s) / 2) * 2), Math.max(2, Math.round((h * s) / 2) * 2)];
}

function stopSource() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  if (source?.kind !== 'image' && source?.el) {
    source.el.pause();
    if (source.url) URL.revokeObjectURL(source.url);
  }
  source = null;
  depth = null;
  renderer.hasDepth = false;
}

async function openImage(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  stopSource();
  source = { kind: 'image', el: bitmap, width: bitmap.width, height: bitmap.height };
  startSource();
}

async function openVideo(srcObject, url) {
  const video = document.createElement('video');
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  if (srcObject) video.srcObject = srcObject;
  else video.src = url;
  await new Promise((res, rej) => {
    video.onloadeddata = res;
    video.onerror = () => rej(new Error('Could not load this video.'));
  });
  await video.play();
  return video;
}

async function openVideoFile(file) {
  stopSource();
  const url = URL.createObjectURL(file);
  const video = await openVideo(null, url);
  source = { kind: 'video', el: video, url, width: video.videoWidth, height: video.videoHeight };
  startSource();
}

async function openWebcam() {
  stopSource();
  stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
  const video = await openVideo(stream);
  source = { kind: 'webcam', el: video, width: video.videoWidth, height: video.videoHeight };
  startSource();
}

function startSource() {
  // Live sources render smaller to keep the frame rate up.
  const [w, h] = sizeFor(source.width, source.height, source.kind === 'image' ? 1920 : 1280);
  renderer.setSize(w, h);
  renderer.setColor(source.el);
  if (source.kind !== 'image') watchFrames(source.el);
  dropHint.hidden = true;
  document.body.classList.add('has-source');
  document.body.classList.toggle('is-video', source.kind !== 'image');
  $('export-video').disabled = source.kind !== 'video';
  $('play').textContent = 'Pause';
  requestRender();
  refreshDepth();
}

async function refreshDepth() {
  if (!source || !modelReady) return;
  if (source.kind === 'image') {
    setStatus('Estimating depth…', true);
    try {
      const r = await estimateDepth(source.el, source.width, source.height, IMAGE_DETAIL);
      applyDepth(r, 0);
      setStatus(`Depth ready in ${Math.round(r.ms)} ms — click the image to place the glass`);
      requestRender();
    } catch (err) {
      setStatus(`Depth failed: ${err.message}`);
    }
  }
  // Video sources are handled by the frame loop.
}

// Video: estimate depth on the newest frame whenever the model is free.
async function pumpVideo() {
  if (busy || exporting || !modelReady || !source || source.kind === 'image') return;
  const video = source.el;
  if (video.readyState < 2) return;
  busy = true;
  try {
    // In sync mode we keep a snapshot so colour and depth always match.
    const still = params.sync ? snapshot(video, source.width, source.height) : null;
    const r = await estimateDepth(still || video, source.width, source.height, liveDetail());
    if (!source || source.el !== video) return;
    applyDepth(r, params.smoothing);
    requestRender();
    if (still) {
      renderer.setColor(still);
      still.close();
    }
    depthTimes.push(performance.now());
    while (depthTimes.length > 10) depthTimes.shift();
    const fps = depthTimes.length > 1 ? ((depthTimes.length - 1) * 1000) / (depthTimes.at(-1) - depthTimes[0]) : 0;
    setStatus(`Depth ${fps.toFixed(1)} fps (${Math.round(r.ms)} ms per frame${onGPU ? '' : ', CPU'})`);
  } catch (err) {
    setStatus(`Depth failed: ${err.message}`, false, 5000);
  } finally {
    busy = false;
  }
}

// ---------------------------------------------------------------- render loop

// Video frames only need uploading when the video actually shows a new one.
let newVideoFrame = false;
function watchFrames(video) {
  if (!('requestVideoFrameCallback' in video)) return;
  const onFrame = () => {
    newVideoFrame = true;
    if (source?.el === video) video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
}

function frame() {
  if (source && !exporting) {
    const live = source.kind !== 'image';
    if (live) {
      const fresh = 'requestVideoFrameCallback' in source.el ? newVideoFrame : !source.el.paused;
      if (fresh && !params.sync) {
        renderer.setColor(source.el);
        dirty = true;
      }
      newVideoFrame = false;
      pumpVideo();
    }
    if (dirty || params.animateGrain) {
      renderer.render(currentParams());
      dirty = false;
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function currentParams() {
  // Until a depth map exists, show the original instead of a fully frosted frame.
  return renderer.hasDepth ? params : { ...params, view: 2 };
}

// ---------------------------------------------------------------- interaction

canvas.addEventListener('click', (e) => {
  if (!depth) return;
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor(((e.clientX - rect.left) / rect.width) * depth.width);
  const y = Math.floor(((e.clientY - rect.top) / rect.height) * depth.height);
  let d = depth.data[Math.min(depth.height - 1, y) * depth.width + Math.min(depth.width - 1, x)];
  if (params.invert) d = 1 - d;
  setSlider('focus', Math.max(0, d - 0.02).toFixed(3));
});

$('file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) openFile(f);
  e.target.value = '';
});

function openFile(f) {
  const p = f.type.startsWith('video/') ? openVideoFile(f) : openImage(f);
  p.catch((err) => setStatus(err.message));
}

$('webcam').addEventListener('click', () => openWebcam().catch((err) => setStatus(`Webcam: ${err.message}`)));

$('play').addEventListener('click', () => {
  if (!source || source.kind === 'image') return;
  const v = source.el;
  if (v.paused) { v.play(); $('play').textContent = 'Pause'; }
  else { v.pause(); $('play').textContent = 'Play'; }
});

const stageWrap = $('stage-wrap');
['dragenter', 'dragover'].forEach((t) =>
  stageWrap.addEventListener(t, (e) => { e.preventDefault(); stageWrap.classList.add('drag'); }),
);
['dragleave', 'drop'].forEach((t) =>
  stageWrap.addEventListener(t, (e) => { e.preventDefault(); stageWrap.classList.remove('drag'); }),
);
stageWrap.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files[0];
  if (f) openFile(f);
});

// ---------------------------------------------------------------- export

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

$('save-png').addEventListener('click', () => {
  if (!source) return;
  renderer.render(currentParams());
  canvas.toBlob((b) => download(b, 'fogyou.png'), 'image/png');
});

// Live recording (works for webcam and playback) via MediaRecorder.
let recorder = null;
$('record').addEventListener('click', () => {
  if (recorder) {
    recorder.stop();
    return;
  }
  if (!source) return;
  const mime = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  const chunks = [];
  recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: mime, videoBitsPerSecond: 8e6 });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    download(new Blob(chunks, { type: mime }), `fogyou-live.${mime.startsWith('video/mp4') ? 'mp4' : 'webm'}`);
    recorder = null;
    $('record').textContent = 'Record live';
    $('record').classList.remove('recording');
  };
  recorder.start();
  $('record').textContent = 'Stop recording';
  $('record').classList.add('recording');
});

// Frame-accurate export: step through the video, run depth on every frame, encode with WebCodecs.
let cancelExport = false;
$('export-video').addEventListener('click', async () => {
  if (exporting) {
    cancelExport = true;
    return;
  }
  if (!source || source.kind !== 'video' || !modelReady) return;
  if (!('VideoEncoder' in window)) {
    setStatus('This browser has no WebCodecs — use "Record live" instead.', false, 5000);
    return;
  }
  const { Muxer, ArrayBufferTarget } = await import('https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/+esm');
  const video = source.el;
  const fps = Number($('fps').value);
  const W = canvas.width, H = canvas.height;

  // Prefer H.264 for compatibility; fall back to VP9 (also valid in MP4) where H.264 is unavailable.
  const codecs = [
    ['avc1.640034', 'avc'], ['avc1.640028', 'avc'], ['avc1.4d0028', 'avc'], ['avc1.42001f', 'avc'],
    ['vp09.00.40.08', 'vp9'], ['vp09.00.10.08', 'vp9'],
  ];
  let config = null, muxCodec = null;
  for (const [codec, mux] of codecs) {
    const c = { codec, width: W, height: H, bitrate: 10e6, framerate: fps };
    if ((await VideoEncoder.isConfigSupported(c)).supported) { config = c; muxCodec = mux; break; }
  }
  if (!config) {
    setStatus('No supported video encoder here — use "Record live" instead.', false, 5000);
    return;
  }

  // Wait for any in-flight live depth request to finish before taking over the worker.
  while (busy) await new Promise((r) => setTimeout(r, 20));
  exporting = true;
  cancelExport = false;
  const btn = $('export-video');
  btn.textContent = 'Cancel export';
  video.pause();
  const wasLoop = video.loop;
  video.loop = false;
  depth = null;

  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: muxCodec, width: W, height: H }, fastStart: 'in-memory' });
  let encodeError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encodeError = e; },
  });
  encoder.configure(config);

  const total = Math.max(1, Math.floor(video.duration * fps));
  try {
    for (let i = 0; i < total && !cancelExport && !encodeError; i++) {
      video.currentTime = i / fps;
      await new Promise((r) => video.addEventListener('seeked', r, { once: true }));
      const r = await estimateDepth(video, source.width, source.height, Math.max(liveDetail(), 518));
      applyDepth(r, params.smoothing);
      renderer.setColor(video);
      renderer.render(params);
      const vf = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(vf, { keyFrame: i % (fps * 2) === 0 });
      vf.close();
      if (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
      setStatus(`Exporting frame ${i + 1} / ${total}…`, true, 1000);
    }
    if (encodeError) throw encodeError;
    await encoder.flush();
    if (!cancelExport) {
      muxer.finalize();
      download(new Blob([muxer.target.buffer], { type: 'video/mp4' }), 'fogyou.mp4');
      setStatus('Export finished.', false, 4000);
    } else {
      setStatus('Export cancelled.', false, 4000);
    }
  } catch (err) {
    setStatus(`Export failed: ${err.message || err}`, false, 8000);
  } finally {
    encoder.state !== 'closed' && encoder.close();
    exporting = false;
    btn.textContent = 'Export video (MP4)';
    video.loop = wasLoop;
    video.play();
    $('play').textContent = 'Pause';
  }
});

// Start with the look from the reference photo.
applyPreset('pressed');
