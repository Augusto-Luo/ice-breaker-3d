import * as THREE from 'three';
import { PALETTE, SUN_DIRECTION } from './palette.js';
import { I18N, SUPPORTED_LANGS, detectInitialLang } from './i18n.js';
import { ShipPhysics } from './controls/shipPhysics.js';
import { CameraRig, CAMERA_PRESETS } from './scene/cameraRig.js';
import { createIcebreaker } from './scene/icebreaker.js';
import { IceWorld } from './scene/iceWorld.js';
import { createPostCompositePass } from './shaders/postComposite.js';

const FAR_PLANE = 450.0;

// =========================================================================
// 1. RENDERER & MULTI-PASS LIGNE CLAIRE PIPELINE
// =========================================================================
const canvas = document.getElementById('scene-canvas');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false, // MSAA happens inside beautyRT for razor-crisp edges before ink composite
  powerPreference: 'high-performance',
  stencil: true,
  preserveDrawingBuffer: true,
});
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false; // Update 4096 shadow map ONCE per frame across reflection + beauty passes!
renderer.autoClear = false;
renderer.toneMapping = THREE.NoToneMapping;

const maxDpr = Math.min(window.devicePixelRatio || 1, 2);
renderer.setPixelRatio(maxDpr);
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
const snowBgColor = new THREE.Color(PALETTE.snowLit);
scene.background = snowBgColor;

// Camera Rig (5 curated fixed architectural & cinematic lenses)
const cameraRig = new CameraRig(window.innerWidth / window.innerHeight);
cameraRig.camera.far = FAR_PLANE;
cameraRig.camera.updateProjectionMatrix();

// Multi-pass Render Targets (Planar Reflection + MSAA Beauty + Full-Res Normal/Depth/ID G-Buffer)
const isWebGL2 = renderer.capabilities.isWebGL2;
const rtType = THREE.HalfFloatType;

function makeRenderTargets(w, h) {
  const reflW = Math.max(1, Math.floor(w * 0.55));
  const reflH = Math.max(1, Math.floor(h * 0.55));
  const reflection = new THREE.WebGLRenderTarget(reflW, reflH, {
    type: rtType,
    depthBuffer: true,
    stencilBuffer: false,
    samples: isWebGL2 ? 4 : 0,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  const beauty = new THREE.WebGLRenderTarget(w, h, {
    type: rtType,
    depthBuffer: true,
    stencilBuffer: true,
    samples: isWebGL2 ? 4 : 0,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  const gbuf = new THREE.WebGLRenderTarget(w, h, {
    type: rtType,
    depthBuffer: true,
    stencilBuffer: true,
    samples: 0,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  return { reflection, beauty, gbuf };
}

let rtWidth = Math.max(1, Math.floor(window.innerWidth * maxDpr));
let rtHeight = Math.max(1, Math.floor(window.innerHeight * maxDpr));
let { reflection: reflectionRT, beauty: beautyRT, gbuf: gbufRT } = makeRenderTargets(rtWidth, rtHeight);

// Real-Time Water Planar Reflection Camera (Mirrored across y=0 with Lengyel Oblique Near-Plane Clipping)
const reflectionCamera = new THREE.PerspectiveCamera(22, window.innerWidth / window.innerHeight, 0.8, FAR_PLANE);
const reflViewProjMatrix = new THREE.Matrix4();
const _reflPlaneNormal = new THREE.Vector3();
const _reflPlanePoint = new THREE.Vector3();
const _reflClipPlane = new THREE.Vector4();
const _reflQ = new THREE.Vector4();
const _reflLookTarget = new THREE.Vector3();
const _reflForward = new THREE.Vector3();

function updatePlanarReflectionCamera(mainCam) {
  mainCam.updateMatrixWorld();

  // Mirror camera position & look direction across the Arctic sea plane y = 0
  reflectionCamera.fov = mainCam.fov;
  reflectionCamera.aspect = mainCam.aspect;
  reflectionCamera.near = mainCam.near;
  reflectionCamera.far = mainCam.far;
  reflectionCamera.updateProjectionMatrix();

  reflectionCamera.position.set(mainCam.position.x, -mainCam.position.y, mainCam.position.z);
  mainCam.getWorldDirection(_reflForward);
  _reflLookTarget.set(
    mainCam.position.x + _reflForward.x * 40,
    -(mainCam.position.y + _reflForward.y * 40),
    mainCam.position.z + _reflForward.z * 40
  );
  reflectionCamera.up.set(0, 1, 0);
  reflectionCamera.lookAt(_reflLookTarget);
  reflectionCamera.updateMatrixWorld();

  // Apply Lengyel's Oblique Near-Plane Clipping at y = +0.012 so submerged hull keel & floe undersides
  // never occlude the above-water reflection (rows 0, 1, 3 stay bit-exact for mirror UV projection!)
  _reflPlaneNormal.set(0, 1, 0).transformDirection(reflectionCamera.matrixWorldInverse).normalize();
  _reflPlanePoint.set(0, 0.012, 0).applyMatrix4(reflectionCamera.matrixWorldInverse);
  _reflClipPlane.set(
    _reflPlaneNormal.x,
    _reflPlaneNormal.y,
    _reflPlaneNormal.z,
    -_reflPlaneNormal.dot(_reflPlanePoint)
  );

  const proj = reflectionCamera.projectionMatrix;
  const e = proj.elements;
  _reflQ.set(
    (Math.sign(_reflClipPlane.x) + e[8]) / e[0],
    (Math.sign(_reflClipPlane.y) + e[9]) / e[5],
    -1.0,
    (1.0 + e[10]) / e[14]
  );

  const dotCq = _reflClipPlane.dot(_reflQ);
  if (Math.abs(dotCq) > 1e-4) {
    const scale = 2.0 / dotCq;
    const cx = _reflClipPlane.x * scale;
    const cy = _reflClipPlane.y * scale;
    const cz = _reflClipPlane.z * scale;
    const cw = _reflClipPlane.w * scale;
    // Replace Row 2 (clip Z) so near plane coincides with water surface y = +0.012
    e[2] = cx;
    e[6] = cy;
    e[10] = cz + 1.0;
    e[14] = cw;
  }

  reflViewProjMatrix.multiplyMatrices(reflectionCamera.projectionMatrix, reflectionCamera.matrixWorldInverse);
}

const postPass = createPostCompositePass(FAR_PLANE);
postPass.setSize(rtWidth, rtHeight, maxDpr);

// =========================================================================
// 2. SUNLIGHT & HIGH-PRECISION TEXEL-SNAPPED SHADOW RIG
// =========================================================================
const sunLight = new THREE.DirectionalLight(0xffffff, 1.0);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(4096, 4096);
const SHADOW_EXTENT = 36;
sunLight.shadow.camera.left = -SHADOW_EXTENT;
sunLight.shadow.camera.right = SHADOW_EXTENT;
sunLight.shadow.camera.top = SHADOW_EXTENT;
sunLight.shadow.camera.bottom = -SHADOW_EXTENT;
sunLight.shadow.camera.near = 6;
sunLight.shadow.camera.far = 140;
sunLight.shadow.bias = -0.00028;
sunLight.shadow.normalBias = 0.032;
sunLight.shadow.radius = 1.65; // Mild PCF kernel that our shader thresholds into razor-crisp vector shadows!
scene.add(sunLight);
scene.add(sunLight.target);

// Precompute light-space basis for texel-snapped shadow camera tracking (zero shadow shimmer!)
const lightForward = SUN_DIRECTION.clone().negate().normalize();
const lightRight = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), lightForward).normalize();
const lightUp = new THREE.Vector3().crossVectors(lightForward, lightRight).normalize();
const shadowTexelWorld = (SHADOW_EXTENT * 2) / 4096;

function updateSunShadowRig(focusX, focusZ) {
  // Snap focus point in light-space XY to exact shadow texel increments
  const focus = new THREE.Vector3(focusX, 0, focusZ);
  const rx = Math.round(focus.dot(lightRight) / shadowTexelWorld) * shadowTexelWorld;
  const ry = Math.round(focus.dot(lightUp) / shadowTexelWorld) * shadowTexelWorld;
  const rz = focus.dot(lightForward);

  const snapped = new THREE.Vector3()
    .addScaledVector(lightRight, rx)
    .addScaledVector(lightUp, ry)
    .addScaledVector(lightForward, rz);

  sunLight.target.position.copy(snapped);
  sunLight.position.copy(snapped).addScaledVector(SUN_DIRECTION, 62);
  sunLight.target.updateMatrixWorld();
}

// =========================================================================
// 3. SCENE ENTITIES (POLAR ICEBREAKER + DYNAMIC ICE WORLD)
// =========================================================================
const physics = new ShipPhysics();
const icebreaker = createIcebreaker();
const iceWorld = new IceWorld();

scene.add(iceWorld.group);
scene.add(icebreaker.root);

// Sync G-buffer far plane across all meshes
const allRenderables = [...iceWorld.gbufEntries, ...icebreaker.gbufEntries];
for (const obj of allRenderables) {
  if (obj.userData.gbufMaterial && obj.userData.gbufMaterial.uniforms?.uFarPlane) {
    obj.userData.gbufMaterial.uniforms.uFarPlane.value = FAR_PLANE;
  }
}

// Initial snap so frame 0 opens directly on the iconic illustration plate
icebreaker.update(0, physics);
updateSunShadowRig(physics.x, physics.z);
cameraRig.snap(physics);

// =========================================================================
// 4. EDITORIAL HUD, I18N (ZH / EN / PT) & USER CONTROLS
// =========================================================================
const lensBarEl = document.getElementById('lens-bar');
const lensDescEl = document.getElementById('lens-desc');
const hudRootEl = document.getElementById('hud-root');
const vesselTitleEl = document.getElementById('vessel-title');
const labelSpeedEl = document.getElementById('label-speed');
const labelHeadingEl = document.getElementById('label-heading');
const labelEngineEl = document.getElementById('label-engine');
const speedValEl = document.getElementById('stat-speed');
const headingValEl = document.getElementById('stat-heading');
const throttleBarEl = document.getElementById('throttle-fill');
const throttleLabelEl = document.getElementById('stat-throttle');
const btnReset = document.getElementById('btn-reset');
const labelResetEl = document.getElementById('label-reset');
const btnHideHud = document.getElementById('btn-hide-hud');
const labelCleanViewEl = document.getElementById('label-clean-view');
const btnShowHud = document.getElementById('btn-show-hud');
const labelShowHudEl = document.getElementById('label-show-hud');
const hintThrottleEl = document.getElementById('hint-throttle');
const hintRudderEl = document.getElementById('hint-rudder');
const btnSpaceStopEl = document.getElementById('btn-space-stop');
const langSwitchEl = document.getElementById('lang-switch');
const langButtons = Array.from(document.querySelectorAll('#lang-switch [data-lang]'));

let currentLang = detectInitialLang();

const lensButtons = [];
CAMERA_PRESETS.forEach((preset, idx) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'lens-btn' + (idx === 0 ? ' active' : '');
  btn.innerHTML = `<span class="lens-key">${preset.key}</span><span class="lens-name"></span>`;
  btn.addEventListener('click', () => selectLens(idx));
  lensBarEl.appendChild(btn);
  lensButtons.push(btn);
});

function refreshLensCopy() {
  const dict = I18N[currentLang];
  CAMERA_PRESETS.forEach((preset, idx) => {
    const info = dict.lenses[preset.id];
    const btn = lensButtons[idx];
    const nameEl = btn.querySelector('.lens-name');
    if (nameEl) nameEl.textContent = info.name;
    btn.title = `${info.tag} — ${info.desc}`;
  });
  const activePreset = cameraRig.getActivePreset();
  const activeInfo = dict.lenses[activePreset.id];
  lensDescEl.textContent = `${activeInfo.tag} · ${activeInfo.desc}`;
}

function setLanguage(lang) {
  if (!SUPPORTED_LANGS.includes(lang)) return;
  currentLang = lang;
  try {
    window.localStorage.setItem('icebreaker_lang', lang);
  } catch {
    // Ignore storage errors
  }

  const dict = I18N[currentLang];
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang === 'pt' ? 'pt-BR' : 'en';
  document.title = dict.pageTitle;
  vesselTitleEl.textContent = dict.vesselTitle;
  labelSpeedEl.textContent = dict.statSpeed;
  labelHeadingEl.textContent = dict.statHeading;
  labelEngineEl.textContent = dict.statEngine;
  labelResetEl.textContent = dict.btnReset;
  btnReset.title = dict.btnResetTitle;
  labelCleanViewEl.textContent = dict.btnCleanView;
  btnHideHud.title = dict.btnCleanViewTitle;
  labelShowHudEl.textContent = dict.btnShowHud;
  btnShowHud.title = dict.btnShowHudTitle;
  if (langSwitchEl) langSwitchEl.setAttribute('aria-label', dict.langSwitchAria);
  hintThrottleEl.innerHTML = dict.hintThrottle;
  hintRudderEl.innerHTML = dict.hintRudder;
  btnSpaceStopEl.textContent = dict.btnStop;

  langButtons.forEach((b) => b.classList.toggle('active', b.dataset.lang === currentLang));
  refreshLensCopy();
  updateHud();
}

langButtons.forEach((btn) => {
  btn.addEventListener('click', () => setLanguage(btn.dataset.lang));
});

function selectLens(idx) {
  cameraRig.setPreset(idx);
  lensButtons.forEach((b, i) => b.classList.toggle('active', i === cameraRig.activeIndex));
  refreshLensCopy();
}

function resetVoyage() {
  physics.reset();
  iceWorld.reset(physics.x, physics.z, physics.heading);
  icebreaker.update(0, physics);
  updateSunShadowRig(physics.x, physics.z);
  cameraRig.snap(physics);
}

let hudHidden = false;
function toggleHud(forceState) {
  hudHidden = typeof forceState === 'boolean' ? forceState : !hudHidden;
  hudRootEl.classList.toggle('is-hidden', hudHidden);
  btnShowHud.classList.toggle('visible', hudHidden);
}

btnReset.addEventListener('click', resetVoyage);
btnHideHud.addEventListener('click', () => toggleHud(true));
btnShowHud.addEventListener('click', () => toggleHud(false));

// Keyboard shortcuts: 1-5 fixed lenses, C cycle, R reset, H hide HUD, L cycle language
window.addEventListener('keydown', (e) => {
  if (e.repeat && ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'KeyC', 'KeyR', 'KeyH', 'KeyL'].includes(e.code)) {
    return;
  }
  switch (e.code) {
    case 'Digit1': selectLens(0); break;
    case 'Digit2': selectLens(1); break;
    case 'Digit3': selectLens(2); break;
    case 'Digit4': selectLens(3); break;
    case 'Digit5': selectLens(4); break;
    case 'KeyC': selectLens(cameraRig.activeIndex + 1); break;
    case 'KeyR': resetVoyage(); break;
    case 'KeyH': toggleHud(); break;
    case 'KeyL': {
      const nextIdx = (SUPPORTED_LANGS.indexOf(currentLang) + 1) % SUPPORTED_LANGS.length;
      setLanguage(SUPPORTED_LANGS[nextIdx]);
      break;
    }
    default: break;
  }
});

// Interactive on-screen WASD keycaps (clickable/touchable + live keyboard feedback!)
const keycapMap = {
  KeyW: document.querySelector('[data-key="KeyW"]'),
  KeyA: document.querySelector('[data-key="KeyA"]'),
  KeyS: document.querySelector('[data-key="KeyS"]'),
  KeyD: document.querySelector('[data-key="KeyD"]'),
  Space: document.querySelector('[data-key="Space"]'),
};
Object.entries(keycapMap).forEach(([code, el]) => {
  if (!el) return;
  const press = (ev) => {
    ev.preventDefault();
    physics.keys.add(code);
  };
  const release = () => {
    physics.keys.delete(code);
  };
  el.addEventListener('pointerdown', press);
  el.addEventListener('pointerup', release);
  el.addEventListener('pointerleave', release);
  el.addEventListener('pointercancel', release);
});

function updateHud() {
  const dict = I18N[currentLang];
  const kts = physics.getSpeedKnots();
  const hdg = Math.round(physics.getHeadingDegrees()).toString().padStart(3, '0');
  speedValEl.textContent = `${kts >= 0 ? '' : '-'}${Math.abs(kts).toFixed(1)} ${dict.speedUnit}`;
  headingValEl.textContent = `${hdg}°`;

  // Display responsive engine-order telegraph label immediately while the bar shows actual spooling shaft output!
  const orderPct = Math.round(physics.targetThrottle * 100);
  if (orderPct > 3) {
    throttleLabelEl.textContent = dict.engineAhead(orderPct);
  } else if (orderPct < -3) {
    throttleLabelEl.textContent = dict.engineAstern(Math.abs(orderPct));
  } else {
    throttleLabelEl.textContent = dict.engineStop;
  }
  const normalized = (physics.throttle + 0.5) / 1.5; // 0..1 actual shaft output
  throttleBarEl.style.width = `${Math.max(0, Math.min(100, normalized * 100))}%`;

  // Highlight active WASD keys
  keycapMap.KeyW?.classList.toggle('pressed', physics.isPressed('KeyW') || physics.isPressed('ArrowUp'));
  keycapMap.KeyA?.classList.toggle('pressed', physics.isPressed('KeyA') || physics.isPressed('ArrowLeft'));
  keycapMap.KeyS?.classList.toggle('pressed', physics.isPressed('KeyS') || physics.isPressed('ArrowDown'));
  keycapMap.KeyD?.classList.toggle('pressed', physics.isPressed('KeyD') || physics.isPressed('ArrowRight'));
  keycapMap.Space?.classList.toggle('pressed', physics.isPressed('Space'));
}

selectLens(0);
setLanguage(currentLang);

// Handle crisp resizing
window.addEventListener('resize', () => {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr);
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  rtWidth = Math.max(1, Math.floor(window.innerWidth * dpr));
  rtHeight = Math.max(1, Math.floor(window.innerHeight * dpr));
  reflectionRT.dispose();
  beautyRT.dispose();
  gbufRT.dispose();
  ({ reflection: reflectionRT, beauty: beautyRT, gbuf: gbufRT } = makeRenderTargets(rtWidth, rtHeight));
  postPass.setSize(rtWidth, rtHeight, dpr);
  cameraRig.resize(window.innerWidth / window.innerHeight);
});

// =========================================================================
// 5. MULTI-PASS RENDER LOOP (Planar Reflection -> Beauty MSAA -> G-Buffer -> Ink)
// =========================================================================
const gbufClearColor = new THREE.Color(0.5, 0.5, 1.0); // Neutral normal + far depth
const reflClearColor = new THREE.Color(0x000000);
let lastTime = performance.now();

function renderFrame() {
  // Update 4096x4096 directional shadow map ONCE per frame (shared across reflection & beauty!)
  renderer.shadowMap.needsUpdate = true;

  // PASS 0: Real-Time Planar Reflection Pass (Icebreaker, Ice-Shelf Walls & Floating Floes)
  updatePlanarReflectionCamera(cameraRig.camera);
  scene.background = null;
  iceWorld.setReflectionPassMode(true);
  renderer.setRenderTarget(reflectionRT);
  renderer.setClearColor(reflClearColor, 0.0);
  renderer.clear(true, true, false);
  renderer.render(scene, reflectionCamera);
  iceWorld.setReflectionPassMode(false);
  iceWorld.setReflection(reflectionRT.texture, reflViewProjMatrix);

  // PASS 1: Beauty Cel-Shaded Scene with Stencil-Punched Ice Channel, 3D Kelvin Wake & Shadows
  scene.background = snowBgColor;
  renderer.setRenderTarget(beautyRT);
  renderer.setClearColor(snowBgColor, 1);
  renderer.state.buffers.stencil.setClear(0);
  renderer.clear(true, true, true);
  renderer.render(scene, cameraRig.camera);

  // PASS 2: G-Buffer Pass (Octahedral View Normal + Linear Depth + Part ID)
  scene.background = null;
  for (let i = 0; i < allRenderables.length; i++) {
    const obj = allRenderables[i];
    if (obj.userData.writeGBuffer) {
      obj.material = obj.userData.gbufMaterial;
    } else {
      obj.visible = false;
    }
  }

  renderer.setRenderTarget(gbufRT);
  // Use alpha = 1.0 so premultiplied clearColor writes exact (0.5, 0.5, 1.0, 1.0) -> sky depth = FAR_PLANE!
  renderer.setClearColor(gbufClearColor, 1.0);
  renderer.state.buffers.stencil.setClear(0);
  renderer.clear(true, true, true);
  renderer.render(scene, cameraRig.camera);

  // Restore Beauty materials & visibility
  for (let i = 0; i < allRenderables.length; i++) {
    const obj = allRenderables[i];
    if (obj.userData.writeGBuffer) {
      obj.material = obj.userData.beautyMaterial;
    } else {
      obj.visible = true;
    }
  }

  // PASS 3: Fullscreen Ligne Claire Ink Outlines + Cold-Press Paper Grain Composite
  postPass.material.uniforms.tBeauty.value = beautyRT.texture;
  postPass.material.uniforms.tGBuffer.value = gbufRT.texture;
  renderer.setRenderTarget(null);
  renderer.clear(true, true, false);
  renderer.render(postPass.scene, postPass.camera);
}

// Expose tiny debug hook for automated visual inspection across camera presets & languages
window.__ICEBREAKER_APP__ = {
  selectLens,
  setLanguage,
  resetVoyage,
  toggleHud,
  physics,
  cameraRig,
  iceWorld,
  stepSimulation(seconds = 1.0, steer = 0, throttle = null) {
    const steps = Math.max(1, Math.round(seconds * 60));
    const dt = seconds / steps;
    if (throttle !== null) physics.targetThrottle = throttle;
    for (let i = 0; i < steps; i++) {
      if (steer < 0) physics.keys.add('KeyA');
      else physics.keys.delete('KeyA');
      if (steer > 0) physics.keys.add('KeyD');
      else physics.keys.delete('KeyD');
      const contact = iceWorld.sampleIceContact(physics.x, physics.z, physics.heading);
      physics.update(dt, contact);
      icebreaker.update(dt, physics);
      iceWorld.update(dt, physics);
      updateSunShadowRig(physics.x, physics.z);
      cameraRig.update(dt, physics);
    }
    physics.keys.delete('KeyA');
    physics.keys.delete('KeyD');
    cameraRig.snap(physics);
    updateHud();
    renderFrame();
  },
};

function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  const contact = iceWorld.sampleIceContact(physics.x, physics.z, physics.heading);
  physics.update(dt, contact);
  icebreaker.update(dt, physics);
  iceWorld.update(dt, physics);
  updateSunShadowRig(physics.x, physics.z);
  cameraRig.update(dt, physics);
  updateHud();
  renderFrame();
}

updateHud();
renderFrame();
requestAnimationFrame(animate);
