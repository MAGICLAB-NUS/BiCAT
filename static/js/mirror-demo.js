/* Mirror canonicalization on Bimanual YAM.
 *
 * Two YAM arms (MuJoCo Menagerie model, MIT) stand side by side. The left arm follows a
 * smooth trajectory q^L. In "mirror" mode the right arm executes q^R = s ⊙ q^L with the
 * paper's sign vector s = (-1, 1, 1, 1, -1, -1, 1); this is the mirrored motion, and its
 * canonical coordinates s ⊙ q^R equal q^L. In "copy" mode the right arm simply copies q^L,
 * which is not a mirror image. The sign vector was checked offline with forward kinematics
 * (mirrored gripper orientation matches to 0.00°).
 */
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

const S = [-1, 1, 1, 1, -1, -1, 1];          // joints 1-6 + gripper (paper, YAM / RoboTwin)
const JOINT_LABELS = ['q₁', 'q₂', 'q₃', 'q₄', 'q₅', 'q₆', 'grip'];
const MODEL = './static/models/yam/';
const TEAL = 0x2B8597, ORANGE = 0xC96A2B;

export function initMirrorDemo(root) {
  const stage = root.querySelector('.md-stage');
  const canvas = root.querySelector('canvas');
  const tbody = root.querySelector('tbody');
  const modeBtns = root.querySelectorAll('[data-md-mode]');
  const playBtn = root.querySelector('[data-md-play]');
  const status = root.querySelector('.md-status');
  const labels = {
    left: root.querySelector('[data-md-label="left"]'),
    right: root.querySelector('[data-md-label="right"]'),
    plane: root.querySelector('[data-md-label="plane"]'),
  };
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- renderer / scene ----------
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch (e) {
    status.textContent = 'This demo needs WebGL, which is not available in this browser.';
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 4 / 3, 0.01, 20);
  // MuJoCo is z-up / x-forward; three.js is y-up. Everything robot-related lives in `world`.
  const world = new THREE.Group(); world.rotation.x = -Math.PI / 2; scene.add(world);

  scene.add(new THREE.HemisphereLight(0xffffff, 0xd8dde3, 1.25));
  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  key.position.set(-1.2, 2.2, 1.4); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -0.9, right: 0.9, top: 0.9, bottom: -0.9, near: 0.5, far: 5 });
  key.shadow.bias = -0.0004; key.shadow.radius = 4;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.6); fill.position.set(1.5, 1.0, -1.2); scene.add(fill);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.ShadowMaterial({ opacity: 0.13 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const table = new THREE.Mesh(new THREE.CircleGeometry(0.95, 64), new THREE.MeshStandardMaterial({ color: 0xf3f4f6, roughness: 1 }));
  table.rotation.x = -Math.PI / 2; table.position.y = -0.0005; table.receiveShadow = true; scene.add(table);

  // mirror plane (MuJoCo y = 0  ->  a vertical plane between the arms)
  const planeGeo = new THREE.PlaneGeometry(0.9, 0.62);
  const plane = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial({ color: 0x7fb6d6, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false }));
  plane.rotation.x = Math.PI / 2; plane.position.set(0.2, 0, 0.31); world.add(plane);
  const edge = new THREE.LineSegments(new THREE.EdgesGeometry(planeGeo), new THREE.LineDashedMaterial({ color: 0x5b9ec4, dashSize: 0.02, gapSize: 0.014, transparent: true, opacity: 0.8 }));
  edge.computeLineDistances(); plane.add(edge);

  camera.position.set(-1.5, 1.22, 0.0001);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0.16, 0.24, 0);
  controls.enableDamping = true; controls.enablePan = false;
  controls.minDistance = 1.0; controls.maxDistance = 3.2;
  controls.maxPolarAngle = Math.PI * 0.48;
  controls.update();

  // ---------- model ----------
  const mats = {
    black: new THREE.MeshStandardMaterial({ color: 0x323236, roughness: 0.55, metalness: 0.15 }),
    white: new THREE.MeshStandardMaterial({ color: 0xeeeeef, roughness: 0.42, metalness: 0.05 }),
  };

  function decodeMeshes(json, buf) {
    return json.meshes.map((m) => {
      const n = m.count;
      const qv = new Int16Array(buf, m.pos, n * 3);
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n * 3; i++) {
        const a = i % 3, lo = m.lo[a], span = m.hi[a] - m.lo[a];
        pos[i] = lo + ((qv[i] + 32767) / 65534) * span;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(new Int8Array(buf, m.nrm, n * 4), 4), 3, 0, true));
      const idx = m.idx32 ? new Uint32Array(buf, m.idx, m.tris * 3) : new Uint16Array(buf, m.idx, m.tris * 3);
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeBoundingSphere();
      return { body: m.body, material: m.material, geometry: g };
    });
  }

  function buildArm(json, geos, baseY, color) {
    const base = new THREE.Group(); base.position.set(0, baseY, 0); world.add(base);
    const joints = [];
    const groups = json.bodies.map((b) => {
      const g = new THREE.Group();
      g.position.set(b.pos[0], b.pos[1], b.pos[2]);
      g.quaternion.set(b.quat[1], b.quat[2], b.quat[3], b.quat[0]);
      const j = new THREE.Group(); g.add(j);
      g.userData.inner = j;
      if (b.joint) joints.push({ name: b.joint.name, type: b.joint.type, group: j });
      return g;
    });
    json.bodies.forEach((b, i) => { (b.parent < 0 ? base : groups[b.parent].userData.inner).add(groups[i]); });
    geos.forEach((m) => {
      const mesh = new THREE.Mesh(m.geometry, mats[m.material]);
      mesh.castShadow = true; mesh.receiveShadow = true;
      groups[m.body].userData.inner.add(mesh);
    });
    // coloured footprint so each arm is identifiable
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.075, 0.092, 64), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }));
    ring.position.z = 0.0008; base.add(ring);
    // rings on the joints whose sign flips (s = -1)
    const byName = Object.fromEntries(joints.map((j) => [j.name, j]));
    ['joint1', 'joint5', 'joint6'].forEach((name, k) => {
      const r = [0.062, 0.045, 0.045][k];
      const torus = new THREE.Mesh(new THREE.TorusGeometry(r, 0.0042, 12, 72), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92 }));
      if (name === 'joint1') torus.position.z = -0.03;
      byName[name].group.add(torus);
    });
    return { base, byName, labelAnchor: new THREE.Vector3() };
  }

  function setPose(arm, q, grip) {
    for (let k = 0; k < 6; k++) arm.byName['joint' + (k + 1)].group.rotation.z = q[k];
    const open = 0.004 + 0.032 * grip;           // slide joints: left finger +, right finger -
    arm.byName.left_finger.group.position.z = open;
    arm.byName.right_finger.group.position.z = -open;
  }

  // ---------- trajectory ----------
  const HOME = [0, 1.047, 1.047, 0, 0, 0];
  function leftTrajectory(t) {
    const w = 2 * Math.PI / 9.0;                  // ~9 s loop
    return {
      q: [
        HOME[0] + 0.55 * Math.sin(w * t),
        HOME[1] + 0.32 * Math.sin(w * 2 * t + 0.9),
        HOME[2] + 0.30 * Math.sin(w * 2 * t + 2.3),
        0.45 * Math.sin(w * t + 0.6),
        0.60 * Math.sin(w * t + 1.4),
        0.95 * Math.sin(w * 2 * t + 0.3),
      ],
      grip: 0.5 + 0.5 * Math.sin(w * 3 * t),
    };
  }

  // ---------- table ----------
  const rows = JOINT_LABELS.map((lab, k) => {
    const tr = document.createElement('tr');
    if (S[k] < 0) tr.className = 'flip';
    tr.innerHTML = `<th scope="row">${lab}</th><td class="ql"></td><td class="qr"></td><td class="s"><span class="sgn ${S[k] < 0 ? 'neg' : 'pos'}">${S[k] < 0 ? '−1' : '+1'}</span></td><td class="c"></td><td class="ok"></td>`;
    tbody.appendChild(tr);
    return { tr, ql: tr.querySelector('.ql'), qr: tr.querySelector('.qr'), c: tr.querySelector('.c'), ok: tr.querySelector('.ok') };
  });
  const fmt = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2);

  // ---------- state & loop ----------
  let mode = 'mirror', blend = 1, running = !reduceMotion, visible = false, t = 0, last = 0, lastTable = 0, arms = null;
  modeBtns.forEach((b) => b.addEventListener('click', () => {
    mode = b.dataset.mdMode;
    modeBtns.forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
    root.classList.toggle('is-copy', mode === 'copy');
    if (!running) frame(performance.now(), true);
  }));
  playBtn.addEventListener('click', () => {
    running = !running;
    playBtn.setAttribute('aria-pressed', running ? 'false' : 'true');
    playBtn.querySelector('span').textContent = running ? 'Pause' : 'Play';
    if (running) { last = performance.now(); requestAnimationFrame(frame); }
  });
  playBtn.querySelector('span').textContent = running ? 'Pause' : 'Play';

  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(stage);

  const tmp = new THREE.Vector3();
  function place(el, x, y, z) {               // MuJoCo coords -> screen
    tmp.set(x, y, z).applyMatrix4(world.matrixWorld).project(camera);
    const w = stage.clientWidth, h = stage.clientHeight;
    el.style.transform = `translate(${(tmp.x * 0.5 + 0.5) * w}px, ${(-tmp.y * 0.5 + 0.5) * h}px) translate(-50%, -50%)`;
  }

  function frame(now, once) {
    if (!arms) return;
    const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
    if (running && visible) t += dt;
    const target = mode === 'mirror' ? 1 : 0;
    blend += (target - blend) * Math.min(1, dt * 6 || (once ? 1 : 0));
    const L = leftTrajectory(t);
    const qR = L.q.map((v, k) => v * (blend * S[k] + (1 - blend)));   // mirror: s*q, copy: q
    setPose(arms.left, L.q, L.grip);
    setPose(arms.right, qR, L.grip);
    controls.update();
    renderer.render(scene, camera);
    place(labels.left, -0.13, 0.28, 0); place(labels.right, -0.13, -0.28, 0); place(labels.plane, 0.32, 0, 0.56);
    if (now - lastTable > 70 || once) {
      lastTable = now;
      const qRc = qR.concat([L.grip]), qLc = L.q.concat([L.grip]);
      rows.forEach((r, k) => {
        const c = S[k] * qRc[k], match = Math.abs(c - qLc[k]) < 0.02;
        r.ql.textContent = fmt(qLc[k]); r.qr.textContent = fmt(qRc[k]); r.c.textContent = fmt(c);
        r.tr.classList.toggle('mismatch', !match);
        r.ok.textContent = match ? '= qᴸ' : '≠ qᴸ';
      });
    }
    if (running && visible && !once) requestAnimationFrame(frame);
  }

  new IntersectionObserver((en) => {
    visible = en[0].isIntersecting;
    if (visible && arms) { last = performance.now(); requestAnimationFrame(frame); }
  }, { threshold: 0.05 }).observe(stage);

  // ---------- load ----------
  status.textContent = 'Loading YAM model…';
  Promise.all([fetch(MODEL + 'yam.json').then((r) => r.json()), fetch(MODEL + 'yam.bin').then((r) => r.arrayBuffer())])
    .then(([json, buf]) => {
      const geos = decodeMeshes(json, buf);
      arms = { left: buildArm(json, geos, 0.28, TEAL), right: buildArm(json, geos, -0.28, ORANGE) };
      status.textContent = '';
      root.classList.add('is-ready');
      resize();
      last = performance.now();
      frame(last, !running || !visible);
      if (running && visible) requestAnimationFrame(frame);
    })
    .catch(() => { status.textContent = 'Could not load the YAM model.'; });
}
