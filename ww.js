import * as THREE from 'three';
import { GLTFLoader } from './vendor/three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from './vendor/meshopt_decoder.module.js';
import { OrbitControls } from './vendor/three/addons/controls/OrbitControls.js';
import { MeshBVH, acceleratedRaycast } from './vendor/three-mesh-bvh.module.js';

const $ = (id) => document.getElementById(id);
const canvas = $('scene');
const scene = new THREE.Scene();
scene.background = new THREE.Color('#e9ece7');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const camera = new THREE.PerspectiveCamera(55, 1, .05, 2000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = .08;
controls.maxPolarAngle = Math.PI * .94;
scene.add(new THREE.HemisphereLight(0xffffff, 0x82947e, 1.7));
const sun = new THREE.DirectionalLight(0xfffaf0, 2.2);
sun.position.set(30, 55, 25);
scene.add(sun);
const fill = new THREE.DirectionalLight(0xe4f1ff, .65);
fill.position.set(-30, 10, -30);
scene.add(fill);
const clock = new THREE.Clock();
const raycaster = new THREE.Raycaster();
const down = new THREE.Vector3(0, -1, 0);
const up = new THREE.Vector3(0, 1, 0);
const keys = new Set();
const look = new THREE.Vector3();
const direction = new THREE.Vector3();
const right = new THREE.Vector3();
const step = new THREE.Vector3();
const origin = new THREE.Vector3();
const joystick = new THREE.Vector2();
const bounds = new THREE.Box3();
const center = new THREE.Vector3();
const size = new THREE.Vector3();
let model, collider, ready = false, mode = 'orbit', yaw = 0, pitch = 0;
let triangleCount = 0, spawns = [], overviewPosition;
let lookPointer = null, joyPointer = null, pointerStart = null;
const eyeHeight = 1.65, radius = .22;

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false);
}
function hint(message) { $('tip').textContent = message; }
function cast(from, dir, distance = Infinity) {
  if (!collider) return null;
  raycaster.set(from, dir);
  raycaster.near = .001;
  raycaster.far = distance;
  raycaster.firstHitOnly = true;
  return raycaster.intersectObject(collider, false)[0] || null;
}
function freeAt(point) {
  if (cast(point.clone().addScaledVector(up, .08), up, eyeHeight + .12)) return false;
  for (let i = 0; i < 8; i++) {
    const dir = new THREE.Vector3(Math.cos(i * Math.PI / 4), 0, Math.sin(i * Math.PI / 4));
    for (const height of [.3, 1., 1.5]) {
      if (cast(point.clone().addScaledVector(up, height), dir, radius + .08)) return false;
    }
  }
  return true;
}
function reset() {
  if (!ready) return;
  mode = 'orbit';
  clearMovement();
  camera.position.copy(overviewPosition);
  camera.up.set(0, 1, 0);
  controls.target.copy(center);
  controls.enabled = true;
  controls.enableDamping = false;
  controls.update();
  controls.enableDamping = true;
  updateUI();
  hint('单指旋转 · 双指缩放');
}
function updateUI() {
  document.body.classList.toggle('walking', mode === 'walk');
  $('overview').classList.toggle('active', mode === 'orbit');
  $('walk').classList.toggle('active', mode !== 'orbit');
  $('joystick').hidden = mode !== 'walk';
  $('walk-hint').hidden = mode !== 'walk';
  $('crosshair').hidden = mode !== 'walk';
  $('floor-panel').hidden = !ready || spawns.length === 0;
}
function updateLook() {
  look.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
  camera.lookAt(origin.copy(camera.position).add(look));
}
function enterAt(values) {
  if (!ready) return false;
  const point = new THREE.Vector3(...values);
  if (!freeAt(point)) { hint('这里空间不足，请选择地面空旷处'); return false; }
  mode = 'walk';
  controls.enabled = false;
  clearMovement();
  camera.position.copy(point).addScaledVector(up, eyeHeight);
  // Face toward the building center so entry starts with an informative view.
  direction.subVectors(center, camera.position);
  yaw = Math.atan2(direction.x, direction.z);
  pitch = -.06;
  updateLook();
  updateUI();
  hint('拖动画面看四周 · 左侧摇杆移动');
  return true;
}
function selectEntry() {
  if (!ready) return;
  reset();
  mode = 'pick';
  updateUI();
  hint('点击地面进入，或选择左侧楼层');
}
function clearMovement() {
  keys.clear();
  joystick.set(0, 0);
  joyPointer = null;
  lookPointer = null;
  $('stick').style.transform = '';
}
function tryStep(vector) {
  const distance = vector.length();
  if (distance < 1e-7) return;
  const dir = vector.clone().normalize();
  for (const height of [.25, .9, 1.5]) {
    origin.copy(camera.position);
    origin.y += height - eyeHeight;
    if (cast(origin, dir, distance + radius)) return;
  }
  const next = camera.position.clone().add(vector);
  origin.copy(next).addScaledVector(up, .36 - eyeHeight);
  const ground = cast(origin, down, 1.15);
  // A small step is allowed; a drop larger than 0.8 m stops movement.
  if (!ground || Math.abs(ground.face.normal.y) < .5) return;
  const groundHeight = ground.point.y;
  if (groundHeight - (camera.position.y - eyeHeight) > .32) return;
  next.y = groundHeight + eyeHeight;
  camera.position.copy(next);
}
function walkFrame(delta) {
  const x = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0) + joystick.x;
  const z = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0) - joystick.y;
  if (x || z) {
    direction.set(Math.sin(yaw), 0, Math.cos(yaw));
    right.set(-Math.cos(yaw), 0, Math.sin(yaw));
    step.copy(direction).multiplyScalar(z).addScaledVector(right, x);
    if (step.length() > 1) step.normalize();
    step.multiplyScalar((keys.has('ShiftLeft') ? 3 : 1.65) * delta);
    // Axis-separated movement allows sliding along a wall.
    tryStep(new THREE.Vector3(step.x, 0, 0));
    tryStep(new THREE.Vector3(0, 0, step.z));
  }
  updateLook();
}

function buildCollisionAndFloors() {
  const chunks = [];
  let total = 0;
  const v = new THREE.Vector3();
  model.updateMatrixWorld(true);
  model.traverse((object) => {
    if (!object.isMesh) return;
    const position = object.geometry.attributes.position;
    const indices = object.geometry.index;
    const count = indices ? indices.count : position.count;
    const chunk = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      v.fromBufferAttribute(position, indices ? indices.getX(i) : i).applyMatrix4(object.matrixWorld);
      v.toArray(chunk, i * 3);
    }
    chunks.push(chunk);
    total += chunk.length;
  });
  const positions = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) { positions.set(chunk, offset); offset += chunk.length; }
  triangleCount = total / 9;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.boundsTree = new MeshBVH(geometry, { maxLeafTris: 12 });
  collider = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  collider.raycast = acceleratedRaycast;
  collider.updateMatrixWorld(true);
  // One line draw call gives the original architectural white model legible edges.
  const edges = new THREE.EdgesGeometry(geometry, 32);
  const lines = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({
    color: 0x45594d, transparent: true, opacity: .34,
  }));
  scene.add(lines);
  const buckets = new Map();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), normal = new THREE.Vector3();
  for (let i = 0; i < positions.length; i += 9) {
    a.fromArray(positions, i); b.fromArray(positions, i + 3); c.fromArray(positions, i + 6);
    normal.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
    const area = normal.length() / 2;
    if (area < .18 || Math.abs(normal.y) / (area * 2) < .985) continue;
    const point = a.clone().add(b).add(c).multiplyScalar(1 / 3);
    const key = Math.round(point.y / .12);
    if (!buckets.has(key)) buckets.set(key, { y: point.y, area: 0, samples: [] });
    const bucket = buckets.get(key);
    bucket.area += area;
    bucket.samples.push({ point, area });
  }
  const selected = [];
  for (const bucket of [...buckets.values()].sort((a, b) => b.area - a.area)) {
    if (bucket.area < 10 || selected.some((level) => Math.abs(level.y - bucket.y) < 2.)) continue;
    const candidates = bucket.samples.sort((a, b) => b.area - a.area);
    const valid = candidates.find((sample) => freeAt(sample.point));
    if (valid) selected.push({ y: bucket.y, area: bucket.area, point: valid.point });
    if (selected.length >= 5) break;
  }
  selected.sort((a, b) => a.y - b.y);
  spawns = selected.map((level) => level.point.toArray());
  for (const [i, level] of selected.entries()) {
    const button = document.createElement('button');
    const names = ['首层', '二层', '三层', '屋面'];
    button.textContent = selected.length === 4 ? names[i] : `区域 ${i + 1}`;
    const elevation = document.createElement('small');
    elevation.textContent = `${level.y.toFixed(1)} m`;
    button.append(elevation);
    button.title = '进入此高度的可行走区域';
    button.addEventListener('click', () => enterAt(spawns[i]));
    $('floors').append(button);
  }
}

function batchMeshes() {
  const batches = new Map();
  model.updateMatrixWorld(true);
  model.traverse((object) => {
    if (!object.isMesh) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const source = object.geometry;
    const groups = source.groups.length ? source.groups : [{ start: 0,
      count: source.index ? source.index.count : source.attributes.position.count, materialIndex: 0 }];
    for (const group of groups) {
      const material = materials[group.materialIndex];
      if (!batches.has(material)) batches.set(material, []);
      const attributes = {};
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(object.matrixWorld);
      const vector = new THREE.Vector3();
      const mirrored = object.matrixWorld.determinant() < 0;
      for (const name of ['position', 'normal', 'uv']) {
        const attribute = source.getAttribute(name);
        if (!attribute) continue;
        const array = new Float32Array(group.count * attribute.itemSize);
        for (let i = 0; i < group.count; i++) {
          // A mirrored instance reverses winding after its transform is baked.
          const reordered = mirrored && i % 3 !== 0 ? i + (i % 3 === 1 ? 1 : -1) : i;
          const index = source.index ? source.index.getX(group.start + reordered) : group.start + reordered;
          if (name === 'uv') {
            array[i * 2] = attribute.getX(index);
            array[i * 2 + 1] = attribute.getY(index);
          } else {
            vector.fromBufferAttribute(attribute, index);
            if (name === 'position') vector.applyMatrix4(object.matrixWorld);
            else vector.applyMatrix3(normalMatrix).normalize();
            vector.toArray(array, i * 3);
          }
        }
        attributes[name] = array;
      }
      batches.get(material).push(attributes);
    }
  });
  const optimized = new THREE.Group();
  optimized.name = '康复疗养民宿';
  for (const [material, pieces] of batches) {
    const geometry = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'uv']) {
      const total = pieces.reduce((sum, part) => sum + (part[name]?.length || 0), 0);
      if (!total) continue;
      const array = new Float32Array(total);
      let offset = 0;
      for (const part of pieces) {
        if (!part[name]) continue;
        array.set(part[name], offset);
        offset += part[name].length;
      }
      geometry.setAttribute(name, new THREE.BufferAttribute(array, name === 'uv' ? 2 : 3));
    }
    optimized.add(new THREE.Mesh(geometry, material));
  }
  scene.remove(model);
  const oldGeometries = new Set();
  model.traverse((object) => { if (object.isMesh) oldGeometries.add(object.geometry); });
  for (const geometry of oldGeometries) geometry.dispose();
  model = optimized;
  scene.add(model);
}

canvas.addEventListener('pointerdown', (event) => {
  if (mode !== 'walk') {
    pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId };
    return;
  }
  if (lookPointer !== null) return;
  lookPointer = event.pointerId;
  pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', (event) => {
  if (mode !== 'walk' || event.pointerId !== lookPointer || !pointerStart) return;
  yaw -= (event.clientX - pointerStart.x) * .004;
  pitch = THREE.MathUtils.clamp(pitch - (event.clientY - pointerStart.y) * .003, -1.25, 1.25);
  pointerStart.x = event.clientX;
  pointerStart.y = event.clientY;
});
canvas.addEventListener('pointerup', (event) => {
  if (mode === 'pick' && pointerStart && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) < 8) {
    raycaster.setFromCamera(new THREE.Vector2(event.clientX / innerWidth * 2 - 1, 1 - event.clientY / innerHeight * 2), camera);
    raycaster.near = .01; raycaster.far = Infinity; raycaster.firstHitOnly = true;
    const hit = raycaster.intersectObject(collider, false)[0];
    if (hit && Math.abs(hit.face.normal.y) > .7) enterAt(hit.point.toArray());
    else hint('请选择水平地面，或使用左侧快捷到达');
  }
  if (event.pointerId === lookPointer) lookPointer = null;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  pointerStart = null;
});
canvas.addEventListener('pointercancel', () => { lookPointer = null; pointerStart = null; });
function updateJoystick(event) {
  const box = $('joystick').getBoundingClientRect();
  joystick.set((event.clientX - box.left - box.width / 2) / 35, (event.clientY - box.top - box.height / 2) / 35);
  if (joystick.length() > 1) joystick.normalize();
  $('stick').style.transform = `translate(${joystick.x * 30}px,${joystick.y * 30}px)`;
}
$('joystick').addEventListener('pointerdown', (event) => {
  event.preventDefault();
  if (joyPointer !== null) return;
  joyPointer = event.pointerId;
  $('joystick').setPointerCapture(event.pointerId);
  updateJoystick(event);
});
$('joystick').addEventListener('pointermove', (event) => { if (event.pointerId === joyPointer) updateJoystick(event); });
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  $('joystick').addEventListener(type, (event) => {
    if (event.pointerId !== joyPointer) return;
    joyPointer = null;
    joystick.set(0, 0);
    $('stick').style.transform = '';
  });
}
window.addEventListener('keydown', (event) => {
  if (mode === 'walk' && ['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(event.code)) event.preventDefault();
  keys.add(event.code);
  if (event.code === 'Escape') reset();
});
window.addEventListener('keyup', (event) => keys.delete(event.code));
window.addEventListener('blur', clearMovement);
document.addEventListener('visibilitychange', () => { if (document.hidden) clearMovement(); });
$('overview').addEventListener('click', reset);
$('reset').addEventListener('click', reset);
$('walk').addEventListener('click', selectEntry);
$('fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else hint('此浏览器不支持全屏，可横屏浏览');
  } catch { hint('当前浏览器无法全屏，可横屏浏览'); }
});
window.addEventListener('resize', resize);
for (const button of [$('overview'), $('walk'), $('reset')]) button.disabled = true;
resize();

new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).load('./models/ww.glb?v=20261113-pipelines', (gltf) => {
  try {
    model = gltf.scene;
    scene.add(model);
    // Ignore tiny isolated components only when fitting the camera, preserving all geometry.
    const root = model.children.length === 1 ? model.children[0] : model;
    const candidate = new THREE.Box3();
    const candidateSize = new THREE.Vector3();
    model.updateMatrixWorld(true);
    for (const child of root.children) {
      candidate.setFromObject(child);
      candidate.getSize(candidateSize);
      if (Math.max(...candidateSize.toArray()) >= 1) bounds.union(candidate);
    }
    if (bounds.isEmpty()) bounds.setFromObject(model);
    bounds.getCenter(center); bounds.getSize(size);
    const vertical = THREE.MathUtils.degToRad(camera.fov);
    const limitingAngle = Math.min(vertical, 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect));
    const distance = size.length() / (2 * Math.sin(limitingAngle / 2)) * .90;
    overviewPosition = center.clone().add(new THREE.Vector3(1, .85, -1.2).normalize().multiplyScalar(distance));
    controls.minDistance = .8;
    controls.maxDistance = Math.max(size.length() * 3, 150);
    $('progress').textContent = '准备行走区域…';
    // Yield once so the progress text can render before building the collision tree.
    setTimeout(() => {
      try {
        batchMeshes();
        buildCollisionAndFloors();
        ready = true;
        reset();
        $('loading').hidden = true;
        for (const button of [$('overview'), $('walk'), $('reset')]) button.disabled = false;
      } catch (error) { fail(error); }
    }, 30);
  } catch (error) { fail(error); }
}, (event) => {
  if (event.total) $('progress').textContent = `加载建筑模型 ${Math.round(event.loaded / event.total * 100)}%`;
}, fail);
function fail(error) {
  console.error(error);
  $('loading').hidden = true;
  $('error').hidden = false;
  $('error').textContent = '模型加载失败，请检查网络后刷新页面。' + (location.hostname === '127.0.0.1' ? ` ${error.message}` : '');
}
window.wwViewer = {
  enterAt,
  state: () => ({ ready, mode, position: camera.position.toArray(), spawns,
    bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() },
    triangles: triangleCount, calls: renderer.info.render.calls,
    geometries: renderer.info.memory.geometries, joystick: joystick.toArray() }),
};
renderer.setAnimationLoop(() => {
  const delta = Math.min(clock.getDelta(), .04);
  if (mode === 'walk') walkFrame(delta);
  else controls.update();
  renderer.render(scene, camera);
});
