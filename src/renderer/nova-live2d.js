import * as THREE from './vendor/three.module.min.js';

/* Live2D-подобный риг утверждённого арта: текстурные сетки, а не Cubism-модель. */
const W = 1024;
const H = 1536;
const ROOT = 'assets/nova/rig/';
const TAU = Math.PI * 2;
const rigs = new Set();
let raf = 0;
let observer = null;
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const gauss = (x, y, cx, cy, rx, ry) => Math.exp(-(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2) * 2);
const rotate = (x, y, cx, cy, angle) => {
  const dx = x - cx, dy = y - cy, c = Math.cos(angle), s = Math.sin(angle);
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
};

const POSES = {
  idle: { head: 0, arm: .015, elbow: 0, smile: .16, brow: 0, talk: 0 },
  listening: { head: -.055, arm: .035, elbow: -.045, smile: .3, brow: .12, talk: .7 },
  delighted: { head: .07, arm: -.25, elbow: -.18, smile: 1, brow: .8, talk: .25 },
  help: { head: -.105, arm: -.5, elbow: -.28, smile: .12, brow: -.45, talk: .45 },
  pause: { head: .025, arm: .055, elbow: .08, smile: .04, brow: -.22, talk: 0 },
  wave: { head: -.065, arm: -1.2, elbow: -.64, smile: .7, brow: .5, talk: .25 },
};

function schedule() {
  if (!raf && [...rigs].some((rig) => rig.active && !rig.disposed)) raf = requestAnimationFrame(tick);
}

function tick(now) {
  raf = 0;
  for (const rig of rigs) {
    if (!rig.active || rig.disposed) continue;
    const interval = rig.small ? 1000 / 15 : 1000 / 30;
    if (now - rig.lastTick + .2 < interval) continue;
    rig.frame(now);
  }
  schedule();
}

function observeRemoval() {
  if (observer || !document.body) return;
  observer = new MutationObserver(() => {
    for (const rig of [...rigs]) if (!rig.host.isConnected) rig.dispose();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function geometryFor(box, nx, ny, kind) {
  const [x0, y0, x1, y1] = box;
  const vertices = (nx + 1) * (ny + 1);
  const positions = new Float32Array(vertices * 3);
  const uv = new Float32Array(vertices * 2);
  const original = new Float32Array(vertices * 2);
  const weights = new Float32Array(vertices * 6);
  const indices = [];
  let p = 0;
  for (let iy = 0; iy <= ny; iy++) {
    const y = y0 + (y1 - y0) * iy / ny;
    for (let ix = 0; ix <= nx; ix++) {
      const x = x0 + (x1 - x0) * ix / nx;
      original[p * 2] = positions[p * 3] = x;
      original[p * 2 + 1] = positions[p * 3 + 1] = y;
      uv[p * 2] = (x - x0) / (x1 - x0);
      uv[p * 2 + 1] = 1 - (y - y0) / (y1 - y0);
      const w = p * 6;
      if (kind === 'head') {
        weights[w] = smooth(386, 316, y); // неподвижная точка шеи
        weights[w + 1] = Math.max(gauss(x, y, 456, 286, 31, 64), gauss(x, y, 613, 275, 26, 59));
        weights[w + 2] = gauss(x, y, 489, 236, 26, 13);
        weights[w + 3] = gauss(x, y, 562, 226, 25, 13);
        weights[w + 4] = gauss(x, y, 530, 275, 34, 21);
        weights[w + 5] = Math.max(gauss(x, y, 489, 213, 30, 13), gauss(x, y, 561, 204, 29, 13));
      } else if (kind === 'arm') {
        weights[w] = smooth(326, 405, y);
        weights[w + 1] = smooth(510, 585, y);
        weights[w + 2] = smooth(674, 720, y);
      } else {
        weights[w] = gauss(x, y, 495, 505, 87, 174);
        weights[w + 1] = gauss(x, y, 480, 565, 37, 34);
      }
      p++;
    }
  }
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const a = iy * (nx + 1) + ix, b = a + 1, c = a + nx + 1, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  return { geometry, original, weights };
}

class NovaRig {
  constructor(host, renderer, textures) {
    this.host = host;
    this.renderer = renderer;
    this.small = !host.closest('.nv-portrait');
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(0, W, H, 0, -20, 20);
    this.camera.position.z = 10;
    this.layers = [];
    this.pose = 'idle';
    this.target = POSES.idle;
    this.values = { ...POSES.idle };
    this.active = false;
    this.disposed = false;
    this.frames = 0;
    this.lastTick = 0;
    this.lastTime = performance.now();
    this.phase = Math.random() * TAU;
    this.look = { x: 0, y: 0, tx: 0, ty: 0 };
    this.beatValue = 0;
    this.blinkValue = 0;
    this.blinkStart = -1;
    this.nextBlink = performance.now() + 1400 + Math.random() * 1800;
    this.signature = 0;
    this.armAngle = 0;
    this.drawMs = 0;
    const specs = [
      ['base', [0, 0, W, H], 36, 54, 0],
      ['arm', [560, 290, 760, 840], 30, 72, 1],
      ['head', [394, 34, 654, 396], 42, 58, 2],
    ];
    for (const [kind, box, nx, ny, order] of specs) {
      const data = geometryFor(box, nx, ny, kind);
      const material = new THREE.MeshBasicMaterial({
        map: textures[kind], transparent: kind !== 'base', alphaTest: kind === 'base' ? 0 : .015,
        depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(data.geometry, material);
      mesh.renderOrder = order;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.layers.push({ kind, mesh, ...data });
    }
    host.append(renderer.domElement);
    renderer.domElement.className = 'nova-rig-canvas';
    renderer.domElement.setAttribute('aria-hidden', 'true');
    this.onPointer = (event) => {
      if (this.small) return;
      const rect = host.getBoundingClientRect();
      this.look.tx = clamp((event.clientX - rect.left) / rect.width * 2 - 1, -1, 1);
      this.look.ty = clamp((event.clientY - rect.top) / rect.height * 2 - 1, -1, 1);
    };
    this.onLeave = () => { this.look.tx = 0; this.look.ty = 0; };
    host.addEventListener('pointermove', this.onPointer);
    host.addEventListener('pointerleave', this.onLeave);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    rigs.add(this);
    observeRemoval();
  }

  resize() {
    if (this.disposed) return;
    const rect = this.host.getBoundingClientRect();
    const width = Math.max(2, Math.round(rect.width)), height = Math.max(2, Math.round(rect.height));
    const contain = Boolean(this.host.closest('.nova-context-avatar'));
    const scale = contain ? Math.min(width / W, height / H) : Math.max(width / W, height / H);
    const viewW = width / scale, viewH = height / scale;
    const left = (W - viewW) / 2;
    const top = contain ? (H - viewH) / 2 : 0;
    this.camera.left = left; this.camera.right = left + viewW;
    this.camera.top = top; this.camera.bottom = top + viewH;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.small ? 1 : 1.5));
    this.renderer.setSize(width, height, false);
    this.renderFrame(performance.now());
  }

  setPose(pose, playing = false) {
    if (!POSES[pose]) pose = 'idle';
    this.pose = pose;
    this.target = POSES[pose];
    this.playing = playing;
    this.host.dataset.pose = pose;
    schedule();
  }

  setActive(active) {
    if (this.disposed) return;
    this.active = Boolean(active);
    this.host.dataset.rigActive = String(this.active);
    if (this.active) {
      this.lastTime = performance.now();
      schedule();
    }
  }

  pulse() { this.beatValue = 1; schedule(); }
  testBlink() { this.blinkStart = performance.now(); schedule(); }

  deform(layer, time, dt) {
    const { kind, original, weights, mesh } = layer;
    const positions = mesh.geometry.attributes.position.array;
    const v = this.values;
    const breath = Math.sin(time * .00145 + this.phase);
    const nod = Math.sin(time * .0019 + this.phase) * 1.5 + this.beatValue * 2.2;
    const tilt = v.head + this.look.x * .033 + Math.sin(time * .0007 + this.phase) * .012;
    const wave = this.pose === 'wave' ? Math.sin(time * .0072) : 0;
    for (let i = 0; i < original.length / 2; i++) {
      let x = original[i * 2], y = original[i * 2 + 1];
      const w = i * 6;
      if (kind === 'base') {
        const body = weights[w], hand = weights[w + 1];
        x += (x - 495) * .0055 * breath * body;
        y += breath * 1.15 * body + Math.sin(time * .003) * 1.2 * hand;
      } else if (kind === 'arm') {
        const shoulderWeight = weights[w], elbowWeight = weights[w + 1], wristWeight = weights[w + 2];
        if (wristWeight) [x, y] = rotate(x, y, 682, 699, wave * .17 * wristWeight);
        const elbow = v.elbow + Math.sin(time * .0018 + this.phase) * .012 + this.beatValue * .018;
        if (elbowWeight) [x, y] = rotate(x, y, 646, 553, elbow * elbowWeight);
        const shoulder = v.arm + Math.sin(time * .00135 + this.phase) * .015;
        if (shoulderWeight) [x, y] = rotate(x, y, 621, 364, shoulder * shoulderWeight);
        this.armAngle = shoulder;
      } else {
        const joint = weights[w];
        const hair = weights[w + 1];
        if (hair) x += Math.sin(time * .0022 + y * .018 + this.phase) * 3.1 * hair * joint;
        const blink = this.blinkValue;
        for (let eye = 0; eye < 2; eye++) {
          const weight = weights[w + 2 + eye];
          if (!weight) continue;
          const cx = eye ? 562 : 489, cy = eye ? 226 : 236;
          y = cy + (y - cy) * (1 - blink * .91 * weight);
          x += this.look.x * 2.3 * weight;
          y += this.look.y * 1.35 * weight;
        }
        const mouth = weights[w + 4];
        if (mouth) {
          const mouthOpen = v.talk * (.5 + .5 * Math.sin(time * .0061 + this.phase)) * (this.playing ? 1 : .35);
          y += mouthOpen * 3.4 * mouth;
          x += Math.sign(x - 530) * v.smile * 1.5 * mouth;
          y -= v.smile * 1.6 * mouth;
        }
        y -= v.brow * 2.3 * weights[w + 5];
        if (joint) [x, y] = rotate(x, y, 529, 329, tilt * joint);
        x += this.look.x * 2.1 * joint;
        y += (nod + Math.sin(time * .0011 + this.phase) * 1.2) * joint;
      }
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
    }
    mesh.geometry.attributes.position.needsUpdate = true;
  }

  frame(now) {
    const dt = clamp((now - this.lastTime) / 1000, 0, .08);
    this.lastTime = now; this.lastTick = now;
    const blend = 1 - Math.exp(-dt * 7.5);
    for (const key of Object.keys(this.target)) this.values[key] += (this.target[key] - this.values[key]) * blend;
    this.look.x += (this.look.tx - this.look.x) * (1 - Math.exp(-dt * 9));
    this.look.y += (this.look.ty - this.look.y) * (1 - Math.exp(-dt * 9));
    this.beatValue *= Math.exp(-dt * 5.5);
    if (this.blinkStart < 0 && now >= this.nextBlink) this.blinkStart = now;
    if (this.blinkStart >= 0) {
      const progress = (now - this.blinkStart) / 185;
      this.blinkValue = progress < 1 ? Math.sin(progress * Math.PI) : 0;
      if (progress >= 1) {
        this.blinkStart = -1;
        this.nextBlink = now + 2300 + Math.random() * 3000;
      }
    }
    this.renderFrame(now, dt);
  }

  renderFrame(now, dt = 0) {
    if (this.disposed) return;
    const started = performance.now();
    for (const layer of this.layers) this.deform(layer, now, dt);
    let signature = 0;
    for (const layer of this.layers.slice(1)) {
      const data = layer.mesh.geometry.attributes.position.array;
      for (let i = 0; i < data.length; i += 3) signature += data[i] * .000017 + data[i + 1] * .000013;
    }
    this.signature = Math.round(signature * 10000) / 10000;
    this.renderer.render(this.scene, this.camera);
    this.frames++;
    this.drawMs = performance.now() - started;
  }

  getStats() {
    return {
      ready: true, active: this.active, pose: this.pose, frames: this.frames,
      signature: this.signature, blink: +this.blinkValue.toFixed(3), arm: +this.armAngle.toFixed(3),
      vertices: this.layers.reduce((n, layer) => n + layer.original.length / 2, 0),
      drawMs: +this.drawMs.toFixed(2), rigs: rigs.size,
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.active = false;
    rigs.delete(this);
    this.resizeObserver.disconnect();
    this.host.removeEventListener('pointermove', this.onPointer);
    this.host.removeEventListener('pointerleave', this.onLeave);
    for (const layer of this.layers) {
      layer.mesh.geometry.dispose();
      layer.mesh.material.map.dispose();
      layer.mesh.material.dispose();
    }
    this.renderer.dispose();
    this.renderer.domElement.remove();
    schedule();
  }
}

export async function createNovaRig(host) {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power', preserveDrawingBuffer: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x050b1c, 1);
  try {
    const loader = new THREE.TextureLoader();
    const [base, arm, head] = await Promise.all(['base', 'arm', 'head'].map(async (name) => {
      const texture = await loader.loadAsync(`${ROOT}${name}.webp`);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      return texture;
    }));
    const rig = new NovaRig(host, renderer, { base, arm, head });
    renderer.domElement.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      const wasHost = rig.host;
      rig.dispose();
      wasHost.dispatchEvent(new CustomEvent('nova:rig-fallback'));
    }, { once: true });
    return rig;
  } catch (error) {
    renderer.dispose();
    throw error;
  }
}
