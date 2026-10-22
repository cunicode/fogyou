// WebGL2 frosted-glass renderer.
// Inputs: a colour source (image / video / bitmap) and a normalised depth map (1 = near).
// Pixels at or in front of the "glass" plane stay sharp; everything behind it is blurred,
// distorted by a frost texture and fades towards white the further back it sits.

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const BLUR_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;      // texel step * direction
out vec4 outColor;
void main() {
  // All textures keep the image's top row at v = 0, so no flipping between passes.
  vec2 uv = vUv;
  // 13-tap gaussian (sigma ~ 3 taps)
  float w[7] = float[](0.1596, 0.1494, 0.1225, 0.0880, 0.0554, 0.0306, 0.0148);
  vec4 c = texture(uTex, uv) * w[0];
  for (int i = 1; i < 7; i++) {
    vec2 o = uDir * float(i);
    c += texture(uTex, uv + o) * w[i];
    c += texture(uTex, uv - o) * w[i];
  }
  outColor = c / 0.9822;
}`;

// Frost texture, rendered once per size/scale instead of every frame:
// r = large blotches, g = fine crystals, ba = refraction warp.
const NOISE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec2 uRes;
uniform float uScale;
out vec4 outColor;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}

void main() {
  vec2 p = vec2(vUv.x, 1.0 - vUv.y) * uRes / (uScale * 40.0);
  outColor = vec4(fbm(p * 0.5 + 3.1), fbm(p * 6.0), fbm(p * 2.0 + 7.3), fbm(p * 2.0 - 1.7));
}`;

const COMPOSITE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uColor;
uniform sampler2D uBlur1;  // ~1/4 of the frost blur
uniform sampler2D uBlur2;  // ~1/2
uniform sampler2D uBlur3;  // full
uniform sampler2D uDepth;
uniform sampler2D uDepthPrev; // previous depth map, faded out over uDepthMix
uniform float uDepthMix;
uniform sampler2D uNoise;
uniform vec2 uRes;
uniform float uFocus;     // glass plane, 0..1 closeness
uniform float uFade;      // depth range over which the scene fades out
uniform float uWhite;     // max whiteness
uniform float uFrost;     // frost texture strength (distortion + grain)
uniform float uHaze;      // veil the glass puts over everything, even what touches it
uniform float uContact;   // softness of things touching the glass
uniform float uSat;       // overall saturation
uniform float uInvert;
uniform float uView;      // 0 effect, 1 depth, 2 original, 3 mask
uniform float uTime;
uniform vec3 uTint;
out vec4 outColor;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  // Live depth arrives a few times a second; easing from the previous map to the
  // newest one keeps the mask moving at the display frame rate.
  float d = mix(texture(uDepthPrev, uv).r, texture(uDepth, uv).r, uDepthMix);
  d = mix(d, 1.0 - d, uInvert);

  // How far behind the glass this pixel is, 0 = touching the glass, 1 = fully frosted.
  float behind = clamp((uFocus - d) / max(uFade, 1e-3), 0.0, 1.0);
  // Real frosted glass blurs almost immediately behind the surface, while the
  // wash-out to white only takes over further back.
  float blurAmt = mix(uContact, 1.0, pow(behind, 0.85));
  float frost = behind * behind;

  // Frost texture: large blotches + fine crystals, in pixel space so it doesn't stretch.
  vec4 nz = texture(uNoise, uv);
  float blotch = nz.r;
  float crystal = nz.g;
  vec2 warp = nz.ba - 0.5;

  vec2 off = warp * uFrost * blurAmt * 0.04;
  vec3 sharp = texture(uColor, uv).rgb;
  vec3 b1 = texture(uBlur1, uv + off * 0.3).rgb;
  vec3 b2 = texture(uBlur2, uv + off * 0.6).rgb;
  vec3 b3 = texture(uBlur3, uv + off).rgb;

  // Blur grows continuously with distance behind the glass.
  float t = blurAmt * 3.0;
  vec3 col = t < 1.0 ? mix(sharp, b1, t) : t < 2.0 ? mix(b1, b2, t - 1.0) : mix(b2, b3, t - 2.0);

  // Whiteness grows with distance behind the glass; patchy so it reads as condensation.
  float white = uWhite * frost * mix(1.0, 0.75 + 0.5 * blotch, uFrost);
  col = mix(col, uTint, clamp(white, 0.0, 1.0));
  // The glass itself scatters a little light over everything.
  col = mix(col, uTint, uHaze * (0.85 + 0.3 * blotch));
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(luma), col, uSat);
  // Ice grain: everywhere on the glass, stronger where it is frosted.
  float grainAmt = uFrost * (0.35 + 0.65 * blurAmt);
  col += (crystal - 0.5) * 0.10 * grainAmt;
  col += (hash(uv * uRes + uTime) - 0.5) * 0.04 * grainAmt;

  if (uView > 2.5) col = vec3(1.0 - frost);
  else if (uView > 1.5) col = sharp;
  else if (uView > 0.5) col = vec3(d);

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// Blur pyramid levels: resolution scale and the share of the frost blur each adds.
// Blurs accumulate down the chain (sqrt of summed squares), ending near the full radius.
const LEVELS = [
  { scale: 1 / 2, radius: 0.25 },
  { scale: 1 / 4, radius: 0.45 },
  { scale: 1 / 8, radius: 0.85 },
];

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

function program(gl, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
    uniforms[name] = gl.getUniformLocation(p, name);
  }
  return { p, u: uniforms };
}

function makeTexture(gl) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

export class FrostRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false });
    if (!gl) throw new Error('WebGL2 is not supported in this browser.');
    this.gl = gl;

    this.blurProg = program(gl, BLUR_FRAG);
    this.compProg = program(gl, COMPOSITE_FRAG);
    this.noiseProg = program(gl, NOISE_FRAG);
    this.noise = this._fbo();
    this.noiseKey = '';

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.colorTex = makeTexture(gl);
    this.depthTex = makeTexture(gl);
    this.depthPrev = makeTexture(gl);
    this.levels = LEVELS.map(() => [this._fbo(), this._fbo()]);
    this.hasDepth = false;

    // Start with a flat "everything is near" depth so the image shows before the model is ready.
    this.setDepth(new Float32Array([1]), 1, 1);
    this.setDepth(new Float32Array([1]), 1, 1);
    this.hasDepth = false;
    this.colorW = 0;
    this.colorH = 0;
    this.blurKey = '';
  }

  _fbo() {
    const gl = this.gl;
    const tex = makeTexture(gl);
    const fb = gl.createFramebuffer();
    return { tex, fb, w: 0, h: 0 };
  }

  _resizeFbo(f, w, h) {
    if (f.w === w && f.h === h) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, f.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, f.tex, 0);
    f.w = w;
    f.h = h;
  }

  setSize(w, h) {
    this.canvas.width = w;
    this.canvas.height = h;
  }

  setColor(source) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.blurKey = '';
    // Reuse the texture storage when the size is unchanged instead of reallocating every frame.
    const w = source.videoWidth || source.width, h = source.videoHeight || source.height;
    if (w === this.colorW && h === this.colorH) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
      this.colorW = w;
      this.colorH = h;
    }
  }

  // The previous map is kept so render() can blend towards the new one.
  setDepth(data, w, h) {
    const gl = this.gl;
    [this.depthPrev, this.depthTex] = [this.depthTex, this.depthPrev];
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, w, h, 0, gl.RED, gl.FLOAT, data);
    this.hasDepth = true;
  }

  render(params) {
    const gl = this.gl;
    const W = this.canvas.width, H = this.canvas.height;

    const key = `${W}x${H}@${params.scale}`;
    if (key !== this.noiseKey) {
      this.noiseKey = key;
      this._resizeFbo(this.noise, W, H);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.noise.fb);
      gl.viewport(0, 0, W, H);
      gl.useProgram(this.noiseProg.p);
      gl.uniform2f(this.noiseProg.u.uRes, W, H);
      gl.uniform1f(this.noiseProg.u.uScale, params.scale);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // Blur pyramid: each level blurs the previous one at a lower resolution, giving
    // roughly 1/4, 1/2 and the full frost blur radius. It only depends on the colour
    // frame and blur radius, so frames that just blend depth or animate grain skip it.
    const blurKey = `${W}x${H}@${params.blur}`;
    if (blurKey !== this.blurKey) {
      this.blurKey = blurKey;
      gl.useProgram(this.blurProg.p);
      gl.uniform1i(this.blurProg.u.uTex, 0);
      gl.activeTexture(gl.TEXTURE0);
      let src = this.colorTex;
      for (let i = 0; i < LEVELS.length; i++) {
        const { scale, radius } = LEVELS[i];
        const [A, B] = this.levels[i];
        const bw = Math.max(1, Math.round(W * scale)), bh = Math.max(1, Math.round(H * scale));
        this._resizeFbo(A, bw, bh);
        this._resizeFbo(B, bw, bh);
        const step = (params.blur * radius * scale) / 6;
        gl.viewport(0, 0, bw, bh);

        gl.bindFramebuffer(gl.FRAMEBUFFER, A.fb);
        gl.bindTexture(gl.TEXTURE_2D, src);
        gl.uniform2f(this.blurProg.u.uDir, step / bw, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        gl.bindFramebuffer(gl.FRAMEBUFFER, B.fb);
        gl.bindTexture(gl.TEXTURE_2D, A.tex);
        gl.uniform2f(this.blurProg.u.uDir, 0, step / bh);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        src = B.tex;
      }
    }

    // Composite to screen.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    const c = this.compProg;
    gl.useProgram(c.p);
    const textures = [
      ['uColor', this.colorTex],
      ['uBlur1', this.levels[0][1].tex],
      ['uBlur2', this.levels[1][1].tex],
      ['uBlur3', this.levels[2][1].tex],
      ['uDepth', this.depthTex],
      ['uDepthPrev', this.depthPrev],
      ['uNoise', this.noise.tex],
    ];
    textures.forEach(([name, tex], unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(c.u[name], unit);
    });
    gl.activeTexture(gl.TEXTURE0);

    gl.uniform2f(c.u.uRes, W, H);
    gl.uniform1f(c.u.uDepthMix, params.depthMix ?? 1);
    gl.uniform1f(c.u.uFocus, params.focus);
    gl.uniform1f(c.u.uFade, params.fade);
    gl.uniform1f(c.u.uWhite, params.white);
    gl.uniform1f(c.u.uFrost, params.frost);
    gl.uniform1f(c.u.uHaze, params.haze);
    gl.uniform1f(c.u.uContact, params.contact);
    gl.uniform1f(c.u.uSat, params.saturation);
    gl.uniform1f(c.u.uInvert, params.invert ? 1 : 0);
    gl.uniform1f(c.u.uView, params.view);
    gl.uniform1f(c.u.uTime, params.animateGrain ? (performance.now() % 1000) / 1000 : 0);
    gl.uniform3fv(c.u.uTint, params.tint);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
