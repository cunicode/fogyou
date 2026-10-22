// Runs Depth Anything V2 in a Web Worker so the UI stays responsive.
import { pipeline, RawImage, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;

const MODELS = {
  small: 'onnx-community/depth-anything-v2-small',
  base: 'onnx-community/depth-anything-v2-base',
};

let estimator = null;
let device = null;

async function hasWebGPU() {
  try {
    return !!(navigator.gpu && (await navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

async function load(modelKey) {
  const model = MODELS[modelKey] || MODELS.small;
  const progress_callback = (p) => {
    if (p.status === 'progress') {
      self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
    }
  };
  const tries = (await hasWebGPU())
    ? [{ device: 'webgpu', dtype: 'fp16' }, { device: 'webgpu', dtype: 'fp32' }, { device: 'wasm', dtype: 'q8' }]
    : [{ device: 'wasm', dtype: 'q8' }];

  let lastErr;
  for (const opts of tries) {
    try {
      estimator = await pipeline('depth-estimation', model, { ...opts, progress_callback });
      device = `${opts.device} / ${opts.dtype}`;
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      await load(msg.model);
      self.postMessage({ type: 'ready', device });
    } else if (msg.type === 'depth') {
      const t0 = performance.now();
      const image = new RawImage(new Uint8ClampedArray(msg.pixels), msg.width, msg.height, 4);
      const { predicted_depth } = await estimator(image);
      const [h, w] = predicted_depth.dims.slice(-2);
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
      self.postMessage(
        { type: 'depth', id: msg.id, depth, width: w, height: h, ms: performance.now() - t0 },
        [depth.buffer],
      );
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String(err?.message || err) });
  }
};
