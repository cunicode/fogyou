# fogyou

Depth-aware frosted glass for images, videos and your webcam, running entirely in the browser.

A depth model ([Depth Anything V2](https://huggingface.co/onnx-community/depth-anything-v2-small), via
[Transformers.js](https://github.com/huggingface/transformers.js)) estimates how far every pixel is from the
camera. A WebGL shader then places a sheet of frosted glass in the scene: whatever touches the glass stays sharp,
and everything behind it gets blurred, textured with frost and fades to white the further back it is.

## Run it

It's a static site with no build step. Serve the folder with any static server and open it:

```sh
cd fogyou
python3 -m http.server 8000
# open http://localhost:8000
```

(Opening `index.html` straight from disk won't work, because module workers need http(s).)

The model (~50 MB for Small, ~200 MB for Base) downloads from Hugging Face the first time and is cached by the
browser after that. It runs on WebGPU when available (Chrome / Edge), otherwise on WebAssembly, which is slower.
Your images never leave the device. The status line shows the depth frame rate; if it says the model runs on the CPU, video will be slow, so switch to Chrome or Edge on desktop.

## Controls

| Control | What it does |
| --- | --- |
| **Look** | Presets. *Pressed on glass* (default) imitates hands and a face pressed on a frosted shower door; also *Classic frost* and *Dense fog*. |
| **Glass distance** | Where the glass sits in depth (1 = closest to camera). It's placed automatically just behind the nearest parts of the scene; click the picture or use *Auto-place glass* to move it. |
| **Fade depth** | How far behind the glass it takes to go fully white. Small = hard cut-out, large = gentle fog. |
| **Frost blur** | Maximum blur radius. Blur grows continuously with distance behind the glass. |
| **Whiteness** | How white the fully-frosted areas get. |
| **Frost texture / scale** | Patchy condensation, refraction warp and ice grain. |
| **Glass haze** | A light veil over everything, including what touches the glass. |
| **Contact softness** | How soft the parts touching the glass are. |
| **Saturation** | Overall colour saturation (frosted glass mutes colour). |
| **Fog colour** | Colour things fade to (white by default). |
| **Invert depth** | Flip near/far, for when you want the background sharp. |
| **Depth detail** | (Video) model input size. *Fast* is the smoothest; *High* gives finer edges. Photos always use full detail. |
| **Temporal smoothing** | (Video) blends depth between frames to stop flicker. |
| **Lock colour to depth** | (Video) shows each frame together with its own depth map: no lag, but plays at the model's speed. |
| **View** | Effect, the raw depth map, the sharp/frost mask, or the original. |

## Export

- **Save PNG**: the current frame at full resolution (up to 1920 px).
- **Record live**: records the canvas in real time (webcam or playback) with MediaRecorder.
- **Export video (MP4)**: steps through a video file frame by frame, runs depth on every frame and encodes with
  WebCodecs (H.264, or VP9 where H.264 isn't available). It's slower than real time but frame-accurate.

## Files

- `index.html`, `style.css`: UI
- `js/main.js`: sources, render loop, interaction, export
- `js/depth-worker.js`: Transformers.js depth estimation in a Web Worker
- `js/renderer.js`: WebGL2 blur pyramid + frosted-glass compositing shader
