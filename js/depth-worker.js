// Runs Depth Anything V2 in a Web Worker so the UI stays responsive.
// We call the model directly (no pipeline) so we can pick the input resolution:
// smaller inputs are much faster, which matters for live video.
import { AutoModelForDepthEstimation, Tensor, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;

const MODELS = {
  small: 'onnx-community/depth-anything-v2-small',
  base: 'onnx-community/depth-anything-v2-base',
};

// ImageNet normalisation used by Depth Anything.
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let model = null;
const canvas = new OffscreenCanvas(1, 1);
const ctx = canvas.getContext('2d', { willReadFrequently: true });

async function webgpuInfo() {
  try {
    const adapter = navigator.gpu && (await navigator.gpu.requestAdapter());
    return adapter ? { f16: adapter.features.has('shader-f16') } : null;
  } catch {
    return null;
  }
}

async function load(modelKey) {
  const id = MODELS[modelKey] || MODELS.small;
  const progress_callback = (p) => {
    if (p.status === 'progress') {
      self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
    }
  };
  const gpu = await webgpuInfo();
  const tries = [];
  if (gpu?.f16) tries.push({ device: 'webgpu', dtype: 'fp16' });
  if (gpu) tries.push({ device: 'webgpu', dtype: 'fp32' });
  tries.push({ device: 'wasm', dtype: 'q8' });

  let lastErr;
  for (const opts of tries) {
    try {
      model = await AutoModelForDepthEstimation.from_pretrained(id, { ...opts, progress_callback });
      return opts;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// Model input size: the long side is `size`, both sides multiples of 14 (the ViT patch size).
function inputSize(w, h, size) {
  const s = size / Math.max(w, h);
  const round = (v) => Math.max(14, Math.round((v * s) / 14) * 14);
  return [round(w), round(h)];
}

async function estimate(bitmap, size) {
  const [w, h] = inputSize(bitmap.width, bitmap.height, size);
  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const rgba = ctx.getImageData(0, 0, w, h).data;

  const n = w * h;
  const px = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    px[i] = (rgba[i * 4] / 255 - MEAN[0]) / STD[0];
    px[n + i] = (rgba[i * 4 + 1] / 255 - MEAN[1]) / STD[1];
    px[2 * n + i] = (rgba[i * 4 + 2] / 255 - MEAN[2]) / STD[2];
  }
  const { predicted_depth } = await model({ pixel_values: new Tensor('float32', px, [1, 3, h, w]) });
  const [oh, ow] = predicted_depth.dims.slice(-2);
  const raw = predicted_depth.data;

  let min = Infinity, max = -Infinity;
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  // Normalise to 0..1 where 1 = closest to the camera (the model outputs inverse depth).
  const range = max - min || 1;
  const depth = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) depth[i] = (raw[i] - min) / range;
  return { depth, width: ow, height: oh };
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      const opts = await load(msg.model);
      self.postMessage({ type: 'ready', device: `${opts.device} / ${opts.dtype}`, gpu: opts.device === 'webgpu' });
    } else if (msg.type === 'depth') {
      const t0 = performance.now();
      const r = await estimate(msg.bitmap, msg.size);
      self.postMessage({ type: 'depth', id: msg.id, ...r, ms: performance.now() - t0 }, [r.depth.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String(err?.message || err) });
  }
};
