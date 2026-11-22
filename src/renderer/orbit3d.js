import * as THREE from './vendor/three.module.min.js';
import { OrbitControls } from './vendor/addons/controls/OrbitControls.js';
import { GLTFLoader } from './vendor/addons/loaders/GLTFLoader.js';

const TAU = Math.PI * 2;
const INITIAL_CAMERA = new THREE.Vector3(0, 4.6, 11.8);
const CENTER = new THREE.Vector3(0, 0, 0);
let singleton = null;

const rand = (i, salt = 0) => {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

function lineRing(radius, color, opacity, segments = 192) {
  const points = new Float32Array(segments * 3);
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * TAU;
    points[i * 3] = Math.cos(a) * radius;
    points[i * 3 + 1] = Math.sin(a) * radius;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(points, 3));
  return new THREE.LineLoop(geometry, new THREE.LineBasicMaterial({
    color, transparent: true, opacity, depthWrite: false,
  }));
}

function orbitLine(radius, color, opacity) {
  const line = lineRing(radius, color, opacity, 160);
  line.rotation.x = -Math.PI / 2;
  return line;
}

function haloTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const g = canvas.getContext('2d');
  const gradient = g.createRadialGradient(128, 128, 8, 128, 128, 128);
  gradient.addColorStop(0, 'rgba(100, 202, 255, .42)');
  gradient.addColorStop(0.28, 'rgba(76, 155, 232, .2)');
  gradient.addColorStop(0.58, 'rgba(111, 103, 205, .07)');
  gradient.addColorStop(1, 'rgba(30, 65, 120, 0)');
  g.fillStyle = gradient;
  g.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function proceduralPlanetTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const g = canvas.getContext('2d');
  const base = g.createLinearGradient(0, 0, 0, 512);
  base.addColorStop(0, '#10283d');
  base.addColorStop(0.23, '#28546d');
  base.addColorStop(0.48, '#39718a');
  base.addColorStop(0.7, '#243f62');
  base.addColorStop(1, '#101c35');
  g.fillStyle = base;
  g.fillRect(0, 0, 1024, 512);
  for (let y = 0; y < 512; y += 3) {
    const wave = Math.sin(y * 0.083) * 0.5 + Math.sin(y * 0.027) * 0.5;
    const light = 25 + wave * 9 + rand(y, 42) * 5;
    g.fillStyle = `hsla(${199 + wave * 15}, ${32 + rand(y, 43) * 24}%, ${light}%, 0.32)`;
    g.fillRect(0, y, 1024, 3);
  }
  g.lineCap = 'round';
  for (let i = 0; i < 105; i++) {
    const y = rand(i, 45) * 512;
    const x = rand(i, 46) * 1024;
    const length = 80 + rand(i, 47) * 450;
    g.strokeStyle = `hsla(${185 + rand(i, 48) * 48}, 58%, ${55 + rand(i, 49) * 25}%, ${0.025 + rand(i, 50) * 0.07})`;
    g.lineWidth = 1 + rand(i, 51) * 5;
    g.beginPath();
    g.moveTo(x, y);
    g.bezierCurveTo(x + length * 0.3, y - 8, x + length * 0.72, y + 8, x + length, y + 1);
    g.stroke();
  }
  for (let i = 0; i < 3200; i++) {
    const x = rand(i, 52) * 1024;
    const y = rand(i, 53) * 512;
    const a = 0.025 + rand(i, 54) * 0.055;
    g.fillStyle = rand(i, 55) > 0.5 ? `rgba(194,231,242,${a})` : `rgba(4,19,43,${a})`;
    g.fillRect(x, y, 1 + rand(i, 56) * 3, 1 + rand(i, 57) * 2);
  }
  const storm = g.createRadialGradient(750, 318, 2, 750, 318, 70);
  storm.addColorStop(0, 'rgba(159,203,215,0.36)');
  storm.addColorStop(0.35, 'rgba(68,125,150,0.28)');
  storm.addColorStop(0.7, 'rgba(13,40,71,0.18)');
  storm.addColorStop(1, 'rgba(14,38,65,0)');
  g.save();
  g.translate(750, 318);
  g.scale(1, 0.36);
  g.translate(-750, -318);
  g.fillStyle = storm;
  g.fillRect(670, 228, 160, 180);
  g.restore();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function worldSurface(world, index) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const g = canvas.getContext('2d');
  const base = g.createLinearGradient(0, 0, 0, 128);
  base.addColorStop(0, world.accent);
  base.addColorStop(0.48, world.color);
  base.addColorStop(1, '#091323');
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 128);
  for (let y = 3; y < 128; y += 5) {
    const wave = Math.sin(y * 0.17 + index) * 0.5 + 0.5;
    g.fillStyle = `rgba(235,247,255,${0.018 + wave * 0.05})`;
    g.fillRect(0, y, 256, 1 + wave * 2);
  }
  for (let i = 0; i < 520; i++) {
    const a = 0.018 + rand(i, index + 81) * 0.065;
    g.fillStyle = rand(i, 86) > 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,8,25,${a})`;
    g.fillRect(rand(i, 87) * 256, rand(i, 88) * 128, 1 + rand(i, 89) * 3, 1 + rand(i, 90) * 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function worldIcon(world) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const g = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  let live = true;
  const image = new Image();
  image.onload = () => {
    if (!live) return;
    g.clearRect(0, 0, 256, 256);
    g.shadowColor = 'rgba(0,5,18,.8)';
    g.shadowBlur = 18;
    g.drawImage(image, 63, 63, 130, 130);
    texture.needsUpdate = true;
  };
  const paths = (ICONS[world.icon] || ICONS.note).replaceAll('currentColor', '#effaff');
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${paths}</svg>`)}`;
  return { texture, cancel() { live = false; image.onload = null; image.src = ''; } };
}

function worldLabel(world) {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 192;
  const g = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(2.25, 0.56, 1);
  sprite.renderOrder = 20;
  let key = '';
  const update = (selected, hovered) => {
    const next = `${selected}:${hovered}`;
    if (key === next) return;
    key = next;
    g.clearRect(0, 0, 768, 192);
    g.shadowColor = 'rgba(0,4,14,.95)';
    g.shadowBlur = 16;
    g.beginPath();
    g.arc(38, 62, selected || hovered ? 7 : 5, 0, TAU);
    g.fillStyle = world.color;
    g.fill();
    g.fillStyle = selected || hovered ? '#f4faff' : '#dbe9f7';
    g.font = '550 46px Inter, Segoe UI, sans-serif';
    g.textBaseline = 'middle';
    g.fillText(world.name, 62, 64, 660);
    g.fillStyle = '#9db4ca';
    g.font = '400 27px Inter, Segoe UI, sans-serif';
    g.fillText(world.short, 62, 124, 660);
    if (selected || hovered) {
      g.shadowBlur = 0;
      g.globalAlpha = selected ? 0.75 : 0.4;
      g.fillStyle = world.color;
      g.fillRect(62, 157, selected ? 154 : 72, 2);
      g.globalAlpha = 1;
    }
    texture.needsUpdate = true;
  };
  update(false, false);
  return { sprite, update };
}

function mainHint() {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 160;
  const g = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }));
  sprite.scale.set(2.35, 0.59, 1);
  sprite.position.set(0, -2.8, 0);
  sprite.renderOrder = 18;
  let key = '';
  const update = (active, hovered, playing) => {
    const next = `${active}:${hovered}:${playing}`;
    if (key === next) return;
    key = next;
    g.clearRect(0, 0, 640, 160);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.shadowColor = 'rgba(0,4,14,.95)';
    g.shadowBlur = 14;
    g.fillStyle = hovered ? '#ffffff' : '#d8efff';
    g.font = '600 29px Inter, Segoe UI, sans-serif';
    g.fillText(`▶  ${active && playing ? 'СВОБОДНЫЙ ПОТОК' : 'ЗАПУСТИТЬ СВОБОДНЫЙ ПОТОК'}`, 320, 48, 610);
    g.fillStyle = '#9cb9d2';
    g.font = '400 23px Inter, Segoe UI, sans-serif';
    g.fillText(active && playing ? 'рекомендации без фильтров' : active ? 'нажмите на планету, чтобы продолжить' : 'нажмите на центральную планету', 320, 108, 610);
    texture.needsUpdate = true;
  };
  update(false, false, false);
  return { sprite, update };
}

function createOrbit(host) {
  const portal = host.querySelector('.wv-portal');
  const seekEl = host.querySelector('#waveRingSeek');
  const timeBox = host.querySelector('.wv-orbit-time');
  const stage = document.createElement('div');
  stage.className = 'wv-3d-stage';
  stage.innerHTML = `<canvas class="wv-3d-canvas" tabindex="0" aria-label="Интерактивные музыкальные миры. Нажмите на планету для включения её настроения. Клавиши от 0 до 6 выбирают миры. Перетаскивайте свободное пространство для вращения, колесо меняет масштаб, двойной клик возвращает ракурс."></canvas>
    <div class="wv-3d-loader" aria-live="polite"><i></i><span>Собираем орбиту</span></div>
    <button class="wv-3d-reset" type="button" title="Вернуть исходный ракурс" aria-label="Вернуть исходный ракурс">Сбросить ракурс</button>
    <div class="wv-3d-index" aria-hidden="true"><i></i>ORBIT / 3D</div>`;
  // Сцена принадлежит всему hero, а не узкой правой колонке: иначе край canvas
  // проходит через левую панель и становится видимой вертикальной границей при зуме.
  host.prepend(stage);
  const canvas = stage.querySelector('canvas');
  const resetButton = stage.querySelector('.wv-3d-reset');

  host.dataset.renderQuality = 'full';
  const renderer = new THREE.WebGLRenderer({
    canvas, alpha: true, antialias: true, powerPreference: 'high-performance', stencil: false,
  });
  renderer.setClearColor(0x02060d, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = false;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 90);
  camera.position.copy(INITIAL_CAMERA);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.065;
  controls.rotateSpeed = 0.55;
  controls.zoomSpeed = 0.7;
  controls.enableZoom = false; // колесо обрабатываем локально, чтобы тачпад не терял событие
  controls.enablePan = false;
  controls.minDistance = 7.4;
  controls.maxDistance = 18;
  controls.minPolarAngle = 0.2;
  controls.maxPolarAngle = Math.PI - 0.28;
  controls.update();

  scene.add(new THREE.HemisphereLight(0xbcd9ff, 0x080b18, 1.25));
  const key = new THREE.DirectionalLight(0xc4edff, 2.7);
  key.position.set(4, 6, 6);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xb6a0ff, 1.8);
  rim.position.set(-5, 1.5, -4);
  scene.add(rim);
  const fill = new THREE.PointLight(0x48c9e8, 12, 13, 2);
  fill.position.set(-2.8, -1.2, 3.2);
  scene.add(fill);

  const system = new THREE.Group();
  system.rotation.z = -0.055;
  scene.add(system);

  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: haloTexture(), transparent: true, opacity: 0.56, depthWrite: false, depthTest: false,
    blending: THREE.AdditiveBlending,
  }));
  halo.scale.set(5.2, 5.2, 1);
  halo.renderOrder = -10;
  system.add(halo);

  const planetPivot = new THREE.Group();
  planetPivot.rotation.z = -0.13;
  system.add(planetPivot);
  const mainHit = new THREE.Mesh(
    new THREE.SphereGeometry(1.27, 32, 24),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }),
  );
  mainHit.userData.worldId = 'any';
  planetPivot.add(mainHit);
  let planet = new THREE.Mesh(
    new THREE.SphereGeometry(1.22, 64, 40),
    new THREE.MeshStandardMaterial({
      map: proceduralPlanetTexture(), color: 0xb8d4e4, roughness: 0.68, metalness: 0.16,
      emissive: 0x071827, emissiveIntensity: 0.28,
    }),
  );
  planetPivot.add(planet);
  host.dataset.orbitAsset = 'procedural';
  const centerHint = mainHint();
  system.add(centerHint.sprite);
  host.dataset.mainHint = 'ready';

  const rings = new THREE.Group();
  rings.rotation.set(-Math.PI / 2, 0, 0);
  system.add(rings);
  const band = new THREE.Mesh(
    new THREE.RingGeometry(1.46, 2.06, 192),
    new THREE.MeshBasicMaterial({ color: 0x81b7df, transparent: true, opacity: 0.075, side: THREE.DoubleSide, depthWrite: false }),
  );
  rings.add(band);
  [1.48, 1.57, 1.73, 1.89, 2.06].forEach((r, i) => rings.add(lineRing(r, i % 2 ? 0xa89bdc : 0x8bc8ee, 0.1 + i * 0.018)));
  rings.add(lineRing(2.13, 0x9ab8d7, 0.2));

  const timelineMaterial = new THREE.ShaderMaterial({
    transparent: true, side: THREE.DoubleSide, depthWrite: false,
    uniforms: {
      uProgress: { value: 0 },
      uEnergy: { value: 0 },
      uColorA: { value: new THREE.Color(0x79d7ff) },
      uColorB: { value: new THREE.Color(0xc2a5ff) },
    },
    vertexShader: `varying vec2 vPoint;
      void main() { vPoint = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec2 vPoint;
      uniform float uProgress; uniform float uEnergy; uniform vec3 uColorA; uniform vec3 uColorB;
      void main() {
        if (uProgress < 0.00001) discard;
        float angle = atan(vPoint.y, vPoint.x);
        float p = mod(1.57079632679 - angle + 6.28318530718, 6.28318530718) / 6.28318530718;
        if (p > uProgress) discard;
        gl_FragColor = vec4(mix(uColorA, uColorB, p), 0.78 + uEnergy * 0.18);
      }`,
  });
  const timeline = new THREE.Mesh(new THREE.RingGeometry(2.105, 2.155, 192), timelineMaterial);
  timeline.renderOrder = 3;
  rings.add(timeline);
  const timelineHead = new THREE.Mesh(
    new THREE.SphereGeometry(0.047, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0xe8f8ff, transparent: true, opacity: 0.95 }),
  );
  timelineHead.visible = false;
  rings.add(timelineHead);
  const timelineHit = new THREE.Mesh(
    new THREE.RingGeometry(1.98, 2.3, 128),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, colorWrite: false }),
  );
  rings.add(timelineHit);

  const moonGeometry = new THREE.SphereGeometry(1, 32, 24);
  const moons = [];
  const worldConfigs = OrbitWorlds.satellites;
  const worldSizes = [0.32, 0.36, 0.32, 0.34, 0.33, 0.31];
  const worldRadii = [3.0, 3.65, 4.15, 4.0, 3.55, 3.3];
  const worldAngles = [2.85, 3.9, 4.95, 6.0, 0.75, 1.8];
  const worldSpeeds = [0.018, 0.018, 0.018, 0.018, 0.018, 0.018];
  for (let i = 0; i < worldConfigs.length; i++) {
    const world = worldConfigs[i];
    const radius = worldRadii[i];
    const size = worldSizes[i];
    system.add(orbitLine(radius, world.color, 0.12 + i * 0.012));
    const body = new THREE.Mesh(moonGeometry, new THREE.MeshStandardMaterial({
      map: worldSurface(world, i), color: 0xffffff, roughness: 0.52, metalness: 0.22,
      emissive: new THREE.Color(world.color), emissiveIntensity: 0.08,
    }));
    body.userData.worldId = world.id;
    const mesh = new THREE.Group();
    mesh.scale.setScalar(size);
    mesh.add(body);
    const icon = worldIcon(world);
    const glyph = new THREE.Sprite(new THREE.SpriteMaterial({ map: icon.texture, transparent: true, depthTest: false, depthWrite: false }));
    glyph.scale.set(1.15, 1.15, 1);
    glyph.position.z = 0;
    glyph.renderOrder = 8;
    mesh.add(glyph);
    const smallRing = new THREE.Mesh(
      new THREE.RingGeometry(1.32, 1.37, 56),
      new THREE.MeshBasicMaterial({ color: world.color, transparent: true, opacity: 0.34, side: THREE.DoubleSide, depthWrite: false }),
    );
    smallRing.rotation.set(-0.65, 0.15, -0.2);
    mesh.add(smallRing);
    system.add(mesh);
    const angle = worldAngles[i];
    mesh.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
    const label = worldLabel(world);
    const labelDirection = Math.sin(angle) < 0 ? 1 : -1;
    label.sprite.position.copy(mesh.position);
    label.sprite.position.y += (size + 0.5) * labelDirection;
    system.add(label.sprite);
    moons.push({ world, mesh, body, icon, smallRing, label, labelDirection, radius, size, angle, speed: worldSpeeds[i] });
  }
  const worldHitMeshes = [mainHit, ...moons.map((moon) => moon.body)];
  host.dataset.world = App.settings.wave?.world || 'any';
  host.dataset.worldCount = String(moons.length);

  const belt = new THREE.Group();
  const beltMesh = new THREE.InstancedMesh(
    new THREE.DodecahedronGeometry(0.025, 0),
    new THREE.MeshStandardMaterial({ color: 0x7790aa, roughness: 0.88, metalness: 0.12 }),
    88,
  );
  const dummy = new THREE.Object3D();
  for (let i = 0; i < 88; i++) {
    const a = rand(i, 20) * TAU;
    const r = 3.63 + (rand(i, 21) - 0.5) * 0.28;
    dummy.position.set(Math.cos(a) * r, (rand(i, 22) - 0.5) * 0.13, Math.sin(a) * r);
    dummy.rotation.set(rand(i, 23) * TAU, rand(i, 24) * TAU, 0);
    dummy.scale.setScalar(0.55 + rand(i, 25) * 1.25);
    dummy.updateMatrix();
    beltMesh.setMatrixAt(i, dummy.matrix);
  }
  beltMesh.instanceMatrix.needsUpdate = true;
  belt.add(beltMesh);
  system.add(belt);

  const starCount = 420;
  const starPositions = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const a = rand(i, 31) * TAU;
    const u = rand(i, 32) * 2 - 1;
    const r = 16 + rand(i, 33) * 20;
    const q = Math.sqrt(1 - u * u);
    starPositions[i * 3] = Math.cos(a) * q * r;
    starPositions[i * 3 + 1] = u * r;
    starPositions[i * 3 + 2] = Math.sin(a) * q * r;
  }
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
  const stars = new THREE.Points(starGeometry, new THREE.PointsMaterial({
    color: 0xc4ddf5, size: 0.045, transparent: true, opacity: 0.55,
    depthWrite: false, sizeAttenuation: true,
  }));
  scene.add(stars);

  let destroyed = false;
  let active = false;
  let hidden = document.body.classList.contains('win-hidden');
  let raf = 0;
  let last = performance.now();
  let lastPalette = 0;
  let lastAria = 0;
  let lastSecond = -1;
  let lastDuration = -1;
  let energy = 0;
  let seeking = false;
  let seekPointer = null;
  let hoveringRing = false;
  let hoveringWorld = null;
  let worldPointer = null;
  let worldDownId = null;
  let worldStartX = 0;
  let worldStartY = 0;
  let worldMoved = false;
  let dragging = false;
  let cameraTween = null;
  let renderMs = 0;
  let frames = 0;
  const calmMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const hits = [];
  const localPoint = new THREE.Vector3();

  const disposeModel = (root) => {
    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    root.traverse((o) => {
      if (o.geometry) geometries.add(o.geometry);
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => materials.add(m));
    });
    materials.forEach((m) => Object.values(m).forEach((v) => v?.isTexture && textures.add(v)));
    textures.forEach((t) => t.dispose());
    materials.forEach((m) => m.dispose());
    geometries.forEach((g) => g.dispose());
  };

  const loader = new GLTFLoader();
  loader.load('assets/orbit/tripo-planet.glb', (gltf) => {
    if (destroyed) {
      disposeModel(gltf.scene);
      return;
    }
    const model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const max = Math.max(size.x, size.y, size.z) || 1;
    model.position.sub(center);
    model.scale.setScalar(2.44 / max);
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = o.receiveShadow = false;
      const materials = Array.isArray(o.material) ? o.material : [o.material];
      materials.forEach((m) => { if (m && 'envMapIntensity' in m) m.envMapIntensity = 0.7; });
    });
    planetPivot.remove(planet);
    disposeModel(planet);
    planet = model;
    planetPivot.add(model);
    host.dataset.orbitAsset = 'tripo';
    host.dataset.shader = 'pbr';
    stage.classList.add('loaded');
    stage.querySelector('.wv-3d-loader').classList.add('hidden');
  }, undefined, (error) => {
    if (destroyed) return;
    console.warn('Orbit 3D: Tripo GLB is unavailable, using the procedural core.', error);
    stage.classList.add('loaded');
    stage.querySelector('.wv-3d-loader').classList.add('hidden');
  });

  const resize = () => {
    if (destroyed) return;
    const w = Math.max(1, stage.clientWidth);
    const h = Math.max(1, stage.clientHeight);
    const hb = host.getBoundingClientRect();
    const pb = portal.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, Math.min(w, h) < 620 ? 1.25 : 1.5);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    host.dataset.pixelRatio = dpr.toFixed(2);
    host.dataset.renderQuality = 'full';
    camera.aspect = w / h;
    camera.fov = camera.aspect < 0.8 ? 50 : 42;
    // Центр системы остаётся на прежнем месте правой области при любом размере hero.
    // Отрицательный offset здесь означает сдвинутую проекцию, а не обрезание изображения.
    const centerX = pb.left - hb.left + pb.width * 0.35;
    camera.setViewOffset(w, h, Math.round(w / 2 - centerX), 0, w, h);
    camera.updateProjectionMatrix();
    // Вне фактического экрана и hero фрагменты не обрабатываются.
    const cb = canvas.getBoundingClientRect();
    const left = Math.max(0, cb.left, hb.left);
    const right = Math.min(innerWidth, cb.right, hb.right);
    const top = Math.max(0, cb.top, hb.top);
    const bottom = Math.min(innerHeight, cb.bottom, hb.bottom);
    renderer.setScissor(
      Math.floor((left - cb.left) * dpr), Math.floor((cb.bottom - bottom) * dpr),
      Math.max(0, Math.ceil((right - left) * dpr)), Math.max(0, Math.ceil((bottom - top) * dpr)),
    );
    renderer.setScissorTest(true);
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(stage);
  const onQuality = () => resize();
  window.addEventListener('zg:performance', onQuality);
  resize();

  const palette = (now) => {
    if (now - lastPalette < 500) return;
    lastPalette = now;
    const css = getComputedStyle(host);
    timelineMaterial.uniforms.uColorA.value.set(css.getPropertyValue('--mood-a').trim() || '#79d7ff');
    timelineMaterial.uniforms.uColorB.value.set(css.getPropertyValue('--mood-b').trim() || '#c2a5ff');
  };

  const timelineValue = () => {
    const audio = Player.audio;
    const duration = Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration : !audio.src && Player.current?.duration > 0 ? Player.current.duration : 0;
    const current = Math.max(0, Math.min(duration, Number.isFinite(audio.currentTime) ? audio.currentTime : 0));
    return { duration, current, progress: duration ? current / duration : 0 };
  };

  const syncTimeline = (now) => {
    const value = timelineValue();
    timelineMaterial.uniforms.uProgress.value = value.progress;
    timelineHead.visible = value.duration > 0;
    if (value.duration) {
      const a = Math.PI / 2 - value.progress * TAU;
      timelineHead.position.set(Math.cos(a) * 2.13, Math.sin(a) * 2.13, 0.025);
    }
    const enabled = value.duration > 0 && Boolean(Player.current);
    seekEl.tabIndex = enabled && active ? 0 : -1;
    seekEl.setAttribute('aria-disabled', String(!enabled));
    if (enabled && now - lastAria > 500) {
      lastAria = now;
      seekEl.setAttribute('aria-valuemax', String(Math.round(value.duration)));
      seekEl.setAttribute('aria-valuenow', String(Math.floor(value.current)));
      seekEl.setAttribute('aria-valuetext', `${fmtTime(value.current)} из ${fmtTime(value.duration)}`);
    }
    const seconds = Math.floor(value.current);
    const duration = Math.floor(value.duration);
    if (seconds !== lastSecond || duration !== lastDuration) {
      lastSecond = seconds;
      lastDuration = duration;
      timeBox.querySelector('[data-ring-current]').textContent = fmtTime(seconds);
      timeBox.querySelector('[data-ring-duration]').textContent = fmtTime(duration);
    }
    return value;
  };

  const setRay = (event) => {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    hits.length = 0;
  };
  const fractionAt = (event) => {
    if (!timelineValue().duration) return null;
    setRay(event);
    raycaster.intersectObject(timelineHit, false, hits);
    if (!hits.length) return null;
    localPoint.copy(hits[0].point);
    rings.worldToLocal(localPoint);
    const angle = Math.atan2(localPoint.y, localPoint.x);
    return ((Math.PI / 2 - angle) % TAU + TAU) % TAU / TAU;
  };
  const worldAt = (event) => {
    setRay(event);
    raycaster.intersectObjects(worldHitMeshes, false, hits);
    return hits[0]?.object.userData.worldId || null;
  };
  const selectWorld = (id) => {
    if (!active || !OrbitWorlds.all.some((world) => world.id === id)) return;
    host.dataset.world = id;
    host.dispatchEvent(new CustomEvent('orbit-world', { bubbles: true, detail: { id } }));
  };

  const updateCursor = () => {
    canvas.style.cursor = seeking ? 'ew-resize' : dragging ? 'grabbing' : hoveringRing ? 'ew-resize' : worldPointer != null || hoveringWorld ? 'pointer' : 'grab';
  };
  const pointerDown = (e) => {
    if (!active || e.button !== 0) return;
    canvas.focus({ preventScroll: true });
    const fraction = fractionAt(e);
    if (fraction != null) {
      e.preventDefault();
      e.stopImmediatePropagation();
      cameraTween = null;
      seeking = true;
      seekPointer = e.pointerId;
      controls.enabled = false;
      canvas.setPointerCapture(e.pointerId);
      Player.seek(fraction * timelineValue().duration);
      updateCursor();
      return;
    }
    const id = worldAt(e);
    if (!id) return;
    // Не блокируем OrbitControls: короткий клик выбирает мир, движение вращает сцену.
    cameraTween = null;
    worldPointer = e.pointerId;
    worldDownId = id;
    worldStartX = e.clientX;
    worldStartY = e.clientY;
    worldMoved = false;
    hoveringWorld = id;
    updateCursor();
  };
  const pointerMove = (e) => {
    if (!active) return;
    if (seeking && e.pointerId === seekPointer) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const fraction = fractionAt(e);
      if (fraction != null) Player.seek(fraction * timelineValue().duration);
      return;
    }
    if (worldPointer === e.pointerId) {
      if (Math.hypot(e.clientX - worldStartX, e.clientY - worldStartY) > 6) worldMoved = true;
      return;
    }
    const near = fractionAt(e) != null;
    const world = near ? null : worldAt(e);
    if (near !== hoveringRing || world !== hoveringWorld) {
      hoveringRing = near;
      hoveringWorld = world;
      updateCursor();
    }
  };
  const pointerEnd = (e) => {
    if (worldPointer === e.pointerId) {
      const id = worldDownId;
      const select = e.type !== 'pointercancel' && !worldMoved && worldAt(e) === id;
      worldPointer = null;
      worldDownId = null;
      worldMoved = false;
      updateCursor();
      // OrbitControls сначала завершит свой pointerup, затем безопасно меняем поток.
      if (select) queueMicrotask(() => selectWorld(id));
      return;
    }
    if (!seeking || e.pointerId !== seekPointer) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== 'pointercancel') {
      const fraction = fractionAt(e);
      if (fraction != null) Player.seek(fraction * timelineValue().duration);
    }
    seeking = false;
    seekPointer = null;
    controls.enabled = active;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    updateCursor();
  };
  canvas.addEventListener('pointerdown', pointerDown, { capture: true });
  canvas.addEventListener('pointermove', pointerMove, { capture: true });
  canvas.addEventListener('pointerup', pointerEnd, { capture: true });
  canvas.addEventListener('pointercancel', pointerEnd, { capture: true });
  canvas.addEventListener('wheel', (e) => {
    if (!active) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    cameraTween = null;
    const offset = camera.position.clone().sub(controls.target);
    const distance = offset.length();
    if (!Number.isFinite(distance) || distance <= 0) return;
    const next = Math.max(controls.minDistance, Math.min(controls.maxDistance, distance * Math.exp(e.deltaY * .001 * controls.zoomSpeed)));
    camera.position.copy(controls.target).add(offset.setLength(next));
    controls.update();
  }, { passive: false, capture: true });

  const onControlStart = () => { dragging = true; cameraTween = null; updateCursor(); };
  const onControlEnd = () => { dragging = false; updateCursor(); };
  controls.addEventListener('start', onControlStart);
  controls.addEventListener('end', onControlEnd);

  const resetView = () => {
    cameraTween = {
      elapsed: 0, from: camera.position.clone(), targetFrom: controls.target.clone(),
    };
  };
  resetButton.addEventListener('click', resetView);
  canvas.addEventListener('dblclick', resetView);

  const keyboard = (e) => {
    if (!active || seekEl.getAttribute('aria-disabled') === 'true') return;
    let seconds = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') seconds = Player.audio.currentTime - 5;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') seconds = Player.audio.currentTime + 5;
    else if (e.key === 'Home') seconds = 0;
    else if (e.key === 'End') seconds = Player.audio.duration - 0.25;
    if (seconds == null) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    Player.seek(seconds);
  };
  seekEl.addEventListener('keydown', keyboard, true);
  const worldKeyboard = (e) => {
    if (!active || e.repeat || e.ctrlKey || e.altKey || e.metaKey || !/^[0-6]$/.test(e.key)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    selectWorld(OrbitWorlds.all[Number(e.key)].id);
  };
  canvas.addEventListener('keydown', worldKeyboard);

  const frame = (now) => {
    raf = 0;
    if (!active || hidden || document.hidden || destroyed) return;
    const playing = Player.source?.kind === 'wave' && Player.playing;
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;
    const started = performance.now();
    const calm = Custom.s.reduceMotion || calmMedia.matches;
    const targetEnergy = playing ? Math.min(1, (Viz.bass || 0) * 0.75 + (Viz.level || 0) * 0.6) : 0;
    energy += (targetEnergy - energy) * (1 - Math.exp(-dt * 5.5));
    timelineMaterial.uniforms.uEnergy.value = energy;
    if (!calm) {
      planetPivot.rotation.y += dt * (playing ? 0.13 + energy * 0.055 : 0.035);
      stars.rotation.y += dt * 0.0018;
      belt.rotation.y += dt * (playing ? 0.025 : 0.009);
      halo.material.opacity = 0.5 + energy * 0.13;
      fill.intensity = 12 + energy * 5;
    }
    const selectedWorld = App.settings.wave?.world || 'any';
    host.dataset.world = selectedWorld;
    const freeActive = selectedWorld === 'any' && Player.source?.kind === 'wave' && Boolean(Player.current);
    centerHint.update(freeActive, hoveringWorld === 'any', playing);
    centerHint.sprite.material.opacity = hoveringWorld === 'any' ? 1 : freeActive ? 0.86 : 0.72;
    moons.forEach((moon) => {
      if (!calm) {
        moon.angle += dt * moon.speed * (playing ? 1 + energy * 0.18 : 0.12);
        moon.body.rotation.y += dt * 0.16;
        moon.smallRing.rotation.z += dt * 0.045;
      }
      moon.mesh.position.set(Math.cos(moon.angle) * moon.radius, 0, Math.sin(moon.angle) * moon.radius);
      const selected = selectedWorld === moon.world.id;
      const hovered = hoveringWorld === moon.world.id;
      const targetScale = moon.size * (hovered ? 1.13 : selected ? 1.06 : 1);
      const scale = moon.mesh.scale.x + (targetScale - moon.mesh.scale.x) * (1 - Math.exp(-dt * 10));
      moon.mesh.scale.setScalar(scale);
      moon.body.material.emissiveIntensity = 0.08 + energy * 0.06 + (selected || hovered ? 0.1 : 0);
      const ringOpacity = selected ? 0.75 : hovered ? 0.58 : 0.3;
      moon.smallRing.material.opacity += (ringOpacity - moon.smallRing.material.opacity) * (1 - Math.exp(-dt * 9));
      moon.label.sprite.position.copy(moon.mesh.position);
      moon.label.sprite.position.y += (scale + 0.48) * moon.labelDirection;
      moon.label.sprite.material.opacity = selected || hovered ? 1 : 0.84;
      moon.label.update(selected, hovered);
    });
    if (cameraTween) {
      cameraTween.elapsed += dt;
      const p = Math.min(1, cameraTween.elapsed / 0.72);
      const eased = 1 - Math.pow(1 - p, 3);
      camera.position.lerpVectors(cameraTween.from, INITIAL_CAMERA, eased);
      controls.target.lerpVectors(cameraTween.targetFrom, CENTER, eased);
      if (p >= 1) cameraTween = null;
    }
    controls.update();
    palette(now);
    syncTimeline(now);
    renderer.render(scene, camera);
    renderMs = renderMs * 0.94 + (performance.now() - started) * 0.06;
    frames++;
    host.dataset.orbitReady = 'true';
    raf = requestAnimationFrame(frame);
  };

  const start = () => {
    if (destroyed || active && raf) return;
    active = true;
    Viz.audioConsumers.add(host);
    controls.enabled = !seeking;
    seekEl.classList.remove('available', 'near-ring', 'drag');
    last = performance.now();
    resize();
    if (!hidden && !document.hidden && !raf) raf = requestAnimationFrame(frame);
  };
  const stop = () => {
    active = false;
    Viz.audioConsumers.delete(host);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (seekPointer != null && canvas.hasPointerCapture(seekPointer)) canvas.releasePointerCapture(seekPointer);
    if (worldPointer != null && canvas.hasPointerCapture(worldPointer)) canvas.releasePointerCapture(worldPointer);
    seeking = false;
    seekPointer = null;
    worldPointer = null;
    worldDownId = null;
    worldMoved = false;
    cameraTween = null;
    controls.enabled = false;
    seekEl.tabIndex = -1;
    seekEl.setAttribute('aria-disabled', 'true');
    hoveringRing = dragging = false;
    hoveringWorld = null;
    updateCursor();
  };
  const setHidden = (value) => {
    hidden = Boolean(value);
    if (hidden && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else if (!hidden && active && !raf) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  };
  const visibility = () => setHidden(document.hidden);
  document.addEventListener('visibilitychange', visibility);

  const handle = {
    host,
    start,
    stop,
    setHidden,
    resetView,
    getStats: () => ({
      asset: host.dataset.orbitAsset, frames, renderMs, destroyed,
      calls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
      camera: camera.position.toArray(), active, seeking, world: host.dataset.world,
      worldCount: moons.length, hoveringWorld,
      performanceMode: App.settings.performanceMode || 'auto', quality: host.dataset.renderQuality,
      pixelRatio: renderer.getPixelRatio(), pixels: canvas.width * canvas.height,
      scissor: renderer.getScissorTest(),
    }),
    getWorldTargets: () => {
      const rect = canvas.getBoundingClientRect();
      return [{ id: 'any', object: mainHit }, ...moons.map((moon) => ({ id: moon.world.id, object: moon.body }))].map(({ id, object }) => {
        const point = object.getWorldPosition(new THREE.Vector3()).project(camera);
        return { id, x: rect.left + (point.x + 1) * rect.width / 2, y: rect.top + (1 - point.y) * rect.height / 2, visible: point.z >= -1 && point.z <= 1 };
      });
    },
    getRingTarget: (fraction) => {
      const a = Math.PI / 2 - fraction * TAU;
      const point = new THREE.Vector3(Math.cos(a) * 2.13, Math.sin(a) * 2.13, 0);
      rings.localToWorld(point);
      camera.updateMatrixWorld();
      point.project(camera);
      const rect = canvas.getBoundingClientRect();
      return { x: rect.left + (point.x + 1) * rect.width / 2, y: rect.top + (1 - point.y) * rect.height / 2 };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener('zg:performance', onQuality);
      document.removeEventListener('visibilitychange', visibility);
      seekEl.removeEventListener('keydown', keyboard, true);
      canvas.removeEventListener('keydown', worldKeyboard);
      resetButton.removeEventListener('click', resetView);
      canvas.removeEventListener('dblclick', resetView);
      canvas.removeEventListener('pointerdown', pointerDown, { capture: true });
      canvas.removeEventListener('pointermove', pointerMove, { capture: true });
      canvas.removeEventListener('pointerup', pointerEnd, { capture: true });
      canvas.removeEventListener('pointercancel', pointerEnd, { capture: true });
      controls.removeEventListener('start', onControlStart);
      controls.removeEventListener('end', onControlEnd);
      controls.dispose();
      moons.forEach((moon) => moon.icon.cancel());
      disposeModel(scene);
      renderer.dispose();
      stage.remove();
      if (singleton === handle) singleton = null;
    },
  };
  const mutationObserver = new MutationObserver(() => {
    if (!host.isConnected) handle.destroy();
  });
  mutationObserver.observe(document.body, { childList: true, subtree: true });
  return handle;
}

export function mountOrbit(host) {
  if (singleton?.host === host) {
    singleton.start();
    return singleton;
  }
  singleton?.destroy();
  singleton = createOrbit(host);
  singleton.start();
  return singleton;
}
