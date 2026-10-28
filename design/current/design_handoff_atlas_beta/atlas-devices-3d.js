import * as THREE from 'https://esm.sh/three@0.160.0';
import { RoomEnvironment } from 'https://esm.sh/three@0.160.0/examples/jsm/environments/RoomEnvironment.js';
import { OrbitControls } from 'https://esm.sh/three@0.160.0/examples/jsm/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'https://esm.sh/three@0.160.0/examples/jsm/geometries/RoundedBoxGeometry.js';

const M = {
  paper: () => new THREE.MeshPhysicalMaterial({ color: 0xf4efe8, roughness: 0.55, clearcoat: 0.3, clearcoatRoughness: 0.4 }),
  ink: () => new THREE.MeshPhysicalMaterial({ color: 0x1e1e24, roughness: 0.35, metalness: 0.1, clearcoat: 0.6, clearcoatRoughness: 0.25 }),
  brass: () => new THREE.MeshStandardMaterial({ color: 0xc9a46a, roughness: 0.28, metalness: 1 }),
  steel: () => new THREE.MeshStandardMaterial({ color: 0xbfc3c9, roughness: 0.22, metalness: 1 }),
  fabric: (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.95 }),
  glass: () => new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.04, transmission: 0.92, thickness: 0.2, ior: 1.45, transparent: true })
};
const lathe = (pts, seg = 96) => new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), seg);
const glowColor = (st) => new THREE.Color(st.color || '#ffd9a0');

function build(kind, st) {
  const g = new THREE.Group(); g.name = kind;
  const on = st.on !== false, br = (st.br == null ? 70 : st.br) / 100;
  if (kind === 'lamp') {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.46, 0.06, 96), M.ink()); base.position.y = 0.03;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.9, 32), M.brass()); stem.position.y = 1.0;
    const shadeMat = M.fabric(0xefe6d8); shadeMat.side = THREE.DoubleSide;
    if (on) { shadeMat.emissive = glowColor(st); shadeMat.emissiveIntensity = 0.55 * br; }
    const shade = new THREE.Mesh(lathe([[0.52, 0], [0.5, 0.06], [0.34, 0.62], [0.32, 0.64]]), shadeMat); shade.position.y = 1.72;
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.11, 48, 32), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: on ? glowColor(st) : new THREE.Color(0x222222), emissiveIntensity: on ? 2.2 * br : 0 })); bulb.position.y = 1.92;
    g.add(base, stem, shade, bulb);
    if (on) { const L = new THREE.PointLight(glowColor(st), 6 * br, 6, 1.6); L.position.y = 1.9; L.castShadow = true; g.add(L); }
  } else if (kind === 'bulb') {
    const glass = new THREE.Mesh(lathe([[0, 0], [0.12, 0.02], [0.2, 0.12], [0.36, 0.42], [0.42, 0.62], [0.38, 0.86], [0.22, 1.0], [0, 1.04]]), M.glass()); glass.position.y = 0.52;
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.16, 48, 32), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: on ? glowColor(st) : new THREE.Color(0x111111), emissiveIntensity: on ? 3 * br : 0 })); core.position.y = 1.08;
    const screw = new THREE.Mesh(lathe([[0.2, 0], [0.21, 0.08], [0.19, 0.12], [0.21, 0.16], [0.19, 0.2], [0.21, 0.24], [0.19, 0.28], [0.2, 0.36], [0.22, 0.52], [0, 0.52]]), M.steel()); screw.position.y = 0.0;
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.08, 32, 16), M.brass()); tip.position.y = 0.0;
    g.add(glass, core, screw, tip);
    if (on) { const L = new THREE.PointLight(glowColor(st), 5 * br, 5, 1.6); L.position.y = 1.1; g.add(L); }
  } else if (kind === 'speaker') {
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.6, 24, 96), M.fabric(st.shade || 0x2b2b33)); body.scale.set(1, 1, 1); body.position.y = 0.84;
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.02, 96), M.ink()); top.position.y = 1.62;
    const ringMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: new THREE.Color(on ? '#8fa9ff' : '#333333'), emissiveIntensity: on ? 1.4 : 0.1 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.012, 16, 96), ringMat); ring.rotation.x = Math.PI / 2; ring.position.y = 1.635;
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.04, 96), M.ink()); foot.position.y = 0.02;
    g.add(body, top, ring, foot);
  } else if (kind === 'thermostat') {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.22, 128, 1, true), M.steel());
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.6, 128), new THREE.MeshPhysicalMaterial({ color: 0x0c0c10, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.05 })); face.position.y = 0.11; face.rotation.x = -Math.PI / 2;
    const hot = (st.target || 21) > 21.5, col = !on ? '#555555' : hot ? '#ff9a4d' : '#6fa0ff';
    const arc = new THREE.Mesh(new THREE.TorusGeometry(0.48, 0.018, 16, 128, Math.PI * 1.5 * Math.min(1, Math.max(0.1, ((st.target || 21) - 15) / 12))), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: new THREE.Color(col), emissiveIntensity: on ? 2.2 : 0.2 }));
    arc.rotation.x = -Math.PI / 2; arc.rotation.z = Math.PI * 1.25; arc.position.y = 0.115;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.05, 32, 16), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: new THREE.Color(col), emissiveIntensity: on ? 2 : 0.2 })); dot.position.set(0, 0.13, 0);
    const back = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.02, 128), M.paper()); back.position.y = -0.11;
    const holder = new THREE.Group(); holder.add(ring, face, arc, dot, back); holder.rotation.x = Math.PI / 2 - 0.15; holder.position.y = 0.9;
    g.add(holder);
  } else if (kind === 'lock') {
    const plate = new THREE.Mesh(new RoundedBoxGeometry(0.62, 1.2, 0.16, 6, 0.08), M.ink()); plate.position.y = 0.9;
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.18, 96), M.steel()); knob.rotation.x = Math.PI / 2; knob.position.set(0, 1.1, 0.16);
    const bar = new THREE.Mesh(new RoundedBoxGeometry(0.34, 0.07, 0.07, 4, 0.03), M.steel()); bar.position.set(0, 1.1, 0.27); bar.rotation.z = st.locked ? 0 : Math.PI / 2;
    const led = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.012, 16, 96), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: new THREE.Color(st.locked ? '#50dca0' : '#ffb36b'), emissiveIntensity: 2 })); led.position.set(0, 0.62, 0.085);
    g.add(plate, knob, bar, led);
  } else if (kind === 'camera') {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.38, 0.06, 96), M.paper()); base.position.y = 0.03;
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 32), M.paper()); neck.position.y = 0.3;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 96, 64), M.paper()); head.position.y = 0.86;
    const visor = new THREE.Mesh(new THREE.SphereGeometry(0.425, 96, 64, -0.9, 1.8, 0.9, 1.1), new THREE.MeshPhysicalMaterial({ color: 0x0b0b0f, roughness: 0.05, clearcoat: 1 })); visor.position.y = 0.86; visor.rotation.y = Math.PI / 2 - 0.9 + 0.9;
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.09, 64), new THREE.MeshPhysicalMaterial({ color: 0x1b2a66, roughness: 0.02, metalness: 0.6, clearcoat: 1 })); lens.position.set(0, 0.88, 0.43);
    const rec = new THREE.Mesh(new THREE.SphereGeometry(0.022, 16, 8), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: new THREE.Color(on ? '#ff4d4d' : '#333333'), emissiveIntensity: on ? 3 : 0.1 })); rec.position.set(0.16, 1.02, 0.37);
    g.add(base, neck, head, visor, lens, rec);
  } else if (kind === 'blinds') {
    const open = (st.open == null ? 60 : st.open) / 100;
    const rail = new THREE.Mesh(new RoundedBoxGeometry(1.6, 0.12, 0.14, 4, 0.04), M.paper()); rail.position.y = 1.9;
    g.add(rail);
    const n = 16, drop = 1.7 * (1 - open * 0.85);
    for (let i = 0; i < n; i++) { const s = new THREE.Mesh(new RoundedBoxGeometry(1.5, 0.018, 0.1, 2, 0.008), M.paper()); s.position.y = 1.82 - (i + 1) * (drop / n); s.rotation.x = open * 1.1; g.add(s); }
    const bottom = new THREE.Mesh(new RoundedBoxGeometry(1.52, 0.05, 0.12, 3, 0.02), M.steel()); bottom.position.y = 1.82 - drop - 0.03; g.add(bottom);
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

function makeScene(bg) {
  const scene = new THREE.Scene(); scene.background = new THREE.Color(bg);
  const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(0.8, 6, 1.6); key.castShadow = true; key.shadow.mapSize.set(1024, 1024); key.shadow.radius = 10; key.shadow.camera.near = 0.5; key.shadow.camera.far = 12;
  Object.assign(key.shadow.camera, { left: -2, right: 2, top: 3, bottom: -1 });
  scene.add(key, new THREE.HemisphereLight(0xffffff, 0xe8e2d8, 0.6));
  const floor = new THREE.Mesh(new THREE.CircleGeometry(1.6, 64), new THREE.ShadowMaterial({ opacity: 0.12 })); floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  return scene;
}
function setup(renderer, scene) {
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const pm = new THREE.PMREMGenerator(renderer); scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
}
function frame(cam, obj) {
  const box = new THREE.Box3().setFromObject(obj), c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3()), d = Math.max(sz.y, sz.x * 1.2) * 2.5;
  c.y -= sz.y * 0.08; cam.position.set(c.x + d * 0.55, c.y + d * 0.28, c.z + d * 0.85); cam.lookAt(c); return c;
}

let thumbR = null, thumbScene = null; const cache = new Map();
function thumb(kind, st, bg, size) {
  const key = kind + JSON.stringify(st) + bg + size; if (cache.has(key)) return cache.get(key);
  if (!thumbR) { thumbR = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); thumbScene = makeScene(bg); setup(thumbR, thumbScene); }
  thumbR.setPixelRatio(2); thumbR.setSize(size, size, false); thumbScene.background = new THREE.Color(bg);
  const obj = build(kind, st); thumbScene.add(obj);
  const cam = new THREE.PerspectiveCamera(32, 1, 0.05, 50); frame(cam, obj);
  thumbR.render(thumbScene, cam); const url = thumbR.domElement.toDataURL('image/png');
  thumbScene.remove(obj); obj.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); cache.set(key, url); return url;
}

function mountStage(canvas, opts) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  const scene = makeScene(opts.bg || '#f1eeea'); setup(renderer, scene);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
  const ctl = new OrbitControls(cam, canvas); ctl.enableDamping = true; ctl.enablePan = false; ctl.enableZoom = false; ctl.autoRotate = true; ctl.autoRotateSpeed = 0.8; ctl.minPolarAngle = 0.6; ctl.maxPolarAngle = 1.45;
  let obj = null, raf = 0, alive = true, lastKind = '';
  const resize = () => { const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return; renderer.setPixelRatio(Math.min(2, window.devicePixelRatio)); renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); };
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize();
  const loop = () => { if (!alive) return; ctl.update(); renderer.render(scene, cam); raf = requestAnimationFrame(loop); }; loop();
  return {
    set(kind, st) {
      if (obj) { scene.remove(obj); obj.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); }
      obj = build(kind, st); scene.add(obj);
      if (kind !== lastKind) { ctl.target.copy(frame(cam, obj)); lastKind = kind; }
    },
    destroy() { alive = false; cancelAnimationFrame(raf); ro.disconnect(); ctl.dispose(); renderer.dispose(); }
  };
}

window.AtlasDevices3D = { mountStage, thumb };
window.dispatchEvent(new Event('atlas-devices-3d-ready'));
