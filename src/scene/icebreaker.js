import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import {
  createCelMaterial,
  createFlatInkMaterial,
  createGBufferMaterial,
} from '../shaders/celMaterials.js';

function detRand(seed) {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

/**
 * Computes half-beam width of the polar icebreaker at longitudinal coordinate z.
 * Bow = +9.1 (spoon-flared polar bow), Stern = -8.9 (rounded cruiser/icebreaker transom), max half-beam = 2.34.
 */
export function hullHalfBeamAt(z) {
  if (z >= 9.1 || z <= -8.95) return 0;
  if (z > 2.4) {
    // Smooth spoon-flared icebreaker bow curve
    const t = (z - 2.4) / (9.1 - 2.4);
    return 2.34 * Math.pow(Math.max(0, 1 - Math.pow(t, 1.82)), 0.56);
  }
  if (z < -4.1) {
    // Broad rounded polar icebreaker stern transom
    const t = (-4.1 - z) / (8.95 - 4.1);
    if (t > 0.96) return 1.16 * Math.max(0, 1 - (t - 0.96) / 0.04);
    return 2.34 * (0.52 + 0.48 * Math.pow(Math.max(0, 1 - Math.pow(t / 0.96, 2.35)), 0.54));
  }
  return 2.34;
}

/**
 * Computes sheer deck height y at longitudinal coordinate z.
 */
function hullSheerY(z) {
  if (z > 2.0) {
    const t = (z - 2.0) / (9.1 - 2.0);
    return 1.48 + 0.36 * Math.pow(t, 1.58);
  }
  if (z < -4.5) {
    const t = (-4.5 - z) / (8.95 - 4.5);
    return 1.48 + 0.06 * t * t;
  }
  return 1.48;
}

/**
 * Continuous hull surface half-width function at any (z, y) so stacked hull bands
 * (blue lower hull, white sheer band, bulwark) join with 100% airtight bit-exact seams!
 */
function hullWidthAtZY(z, y, scaleX = 1.0) {
  const hb = hullHalfBeamAt(z);
  const yKeel = z > 5.2 ? -0.66 + ((z - 5.2) / 3.9) * 0.78 : -0.78;
  const yTop = hullSheerY(z) + 0.34;
  const v = THREE.MathUtils.clamp((y - yKeel) / Math.max(0.15, yTop - yKeel), 0, 1);
  const bowT = Math.max(0, (z - 2.8) / 6.3);
  const bottomFactor = 0.78 - 0.38 * bowT;
  const topFactor = 1.0 + 0.045 * bowT;
  const profile = bottomFactor + (topFactor - bottomFactor) * Math.pow(v, 0.74);
  return hb * profile * scaleX;
}

/**
 * Raked polar icebreaker bow stem offset so the sheer projects slightly forward of the ice-cutting keel.
 */
function bowStemZAt(z, y) {
  if (z < 6.0) return z;
  const t = Math.pow((z - 6.0) / 3.1, 1.6);
  const yNorm = THREE.MathUtils.clamp((y + 0.65) / 2.65, 0, 1);
  // Keel cuts back slightly under water while upper bow stem flares gracefully forward
  return z + t * (yNorm - 0.55) * 0.58;
}

/**
 * Builds a lofted side band of the hull between vertical profile yBottomFn(z) and yTopFn(z),
 * optionally capping the flat stern transom seamlessly to the exact hull cross-section.
 */
function buildHullBandGeometry({
  zStart,
  zEnd,
  zSteps,
  yBottomFn,
  yTopFn,
  scaleX = 1.0,
  capBottom = false,
  capTop = false,
  capStern = false,
}) {
  const positions = [];
  const uvs = [];
  const indices = [];

  const stations = [];
  for (let i = 0; i <= zSteps; i++) {
    const u = i / zSteps;
    const z = zStart + (zEnd - zStart) * u;
    const yb = yBottomFn(z);
    const yt = yTopFn(z);
    stations.push({
      u,
      z,
      zb: bowStemZAt(z, yb),
      zt: bowStemZAt(z, yt),
      xb: hullWidthAtZY(z, yb, scaleX),
      xt: hullWidthAtZY(z, yt, scaleX),
      yb,
      yt,
    });
  }

  // Port (+X) and Starboard (-X) sides with clean outward normals and readable left-to-right UVs
  function addSide(sign) {
    const base = positions.length / 3;
    for (let i = 0; i <= zSteps; i++) {
      const s = stations[i];
      const sideU = sign > 0 ? 1.0 - s.u : s.u;
      positions.push(sign * s.xb, s.yb, s.zb);
      uvs.push(sideU, 0);
      positions.push(sign * s.xt, s.yt, s.zt);
      uvs.push(sideU, 1);
    }
    for (let i = 0; i < zSteps; i++) {
      const i0 = base + i * 2;
      const i1 = i0 + 1;
      const i2 = i0 + 2;
      const i3 = i0 + 3;
      if (sign > 0) {
        indices.push(i0, i1, i2, i2, i1, i3);
      } else {
        indices.push(i0, i2, i1, i2, i3, i1);
      }
    }
  }

  addSide(1);
  addSide(-1);

  if (capStern && stations.length > 0) {
    const s = stations[0];
    const base = positions.length / 3;
    // Sample clean solid-hull UV region so side stencil lettering never repeats on transom
    positions.push(-s.xb, s.yb, s.zb); uvs.push(0.02, 0.5);
    positions.push( s.xb, s.yb, s.zb); uvs.push(0.02, 0.5);
    positions.push(-s.xt, s.yt, s.zt); uvs.push(0.02, 0.5);
    positions.push( s.xt, s.yt, s.zt); uvs.push(0.02, 0.5);
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }

  if (capTop) {
    const base = positions.length / 3;
    for (let i = 0; i <= zSteps; i++) {
      const s = stations[i];
      positions.push(-s.xt, s.yt, s.zt);
      uvs.push(0, s.u);
      positions.push(s.xt, s.yt, s.zt);
      uvs.push(1, s.u);
    }
    for (let i = 0; i < zSteps; i++) {
      const i0 = base + i * 2;
      const i1 = i0 + 1;
      const i2 = i0 + 2;
      const i3 = i0 + 3;
      indices.push(i0, i2, i1, i2, i3, i1);
    }
  }

  if (capBottom) {
    const base = positions.length / 3;
    for (let i = 0; i <= zSteps; i++) {
      const s = stations[i];
      positions.push(-s.xb, s.yb, s.zb);
      uvs.push(0, s.u);
      positions.push(s.xb, s.yb, s.zb);
      uvs.push(1, s.u);
    }
    for (let i = 0; i < zSteps; i++) {
      const i0 = base + i * 2;
      const i1 = i0 + 1;
      const i2 = i0 + 2;
      const i3 = i0 + 3;
      indices.push(i0, i1, i2, i2, i1, i3);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Creates a chamfered rectangular prism (vertical extrusion) for sleek architectural
 * modules like the polar funnel casing and octagonal-apron helideck platform.
 */
function createChamferedBoxGeometry(width, height, depth, chamfer) {
  const hw = width * 0.5;
  const hd = depth * 0.5;
  const c = Math.min(chamfer, hw * 0.45, hd * 0.45);
  const shape = new THREE.Shape();
  shape.moveTo(-hw + c, -hd);
  shape.lineTo(hw - c, -hd);
  shape.lineTo(hw, -hd + c);
  shape.lineTo(hw, hd - c);
  shape.lineTo(hw - c, hd);
  shape.lineTo(-hw + c, hd);
  shape.lineTo(-hw, hd - c);
  shape.lineTo(-hw, -hd + c);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: false,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -height * 0.5, 0);

  // Normalize top/bottom UVs cleanly into [0, 1] x [0, 1] so helideck markings map bit-accurately!
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const norm = geo.attributes.normal;
  geo.computeVertexNormals();
  for (let i = 0; i < pos.count; i++) {
    const ny = Math.abs(norm.getY(i));
    if (ny > 0.6) {
      const u = (pos.getX(i) + hw) / width;
      const v = (pos.getZ(i) + hd) / depth;
      uv.setXY(i, u, v);
    } else {
      const u = (pos.getX(i) + pos.getZ(i) + hw + hd) / (width + depth);
      const v = (pos.getY(i) + height * 0.5) / height;
      uv.setXY(i, u, v);
    }
  }
  uv.needsUpdate = true;
  return geo;
}

/**
 * Generates high-resolution (2048x256, ~8:1 true hull aspect!) Ligne Claire lower-hull texture:
 * - Proportionally accurate "C T S C" maritime stencil lettering
 * - Polar ice-belt waterline scrape scuffs (concentrated along bow ice-crushing shoulder)
 * - Graphic rust-umber vertical scupper & freeing-port drip streaks + welded strake seams
 * - Bow & stern draft mark ticks
 */
function createHullWeatheringTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Horizontal hull plating strake seams
  ctx.strokeStyle = 'rgba(15, 25, 38, 0.34)';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(0, 88);
  ctx.lineTo(2048, 88);
  ctx.moveTo(0, 174);
  ctx.lineTo(2048, 174);
  ctx.stroke();

  // Vertical hull weld plate seams & subtle subtle tonal panel variation
  for (let x = 80; x < 1980; x += 112) {
    if (detRand(x * 0.37) > 0.45) {
      ctx.fillStyle = detRand(x * 0.71) > 0.5
        ? 'rgba(14, 24, 36, 0.08)'
        : 'rgba(180, 210, 238, 0.06)';
      ctx.fillRect(x, 28, 112, 146);
    }
    ctx.strokeStyle = 'rgba(16, 28, 42, 0.24)';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(x, 28);
    ctx.lineTo(x, 236);
    ctx.stroke();
  }

  // Polar pack-ice waterline abrasion & pale ice-scrape streaks (stronger toward bow u ~ 0..0.35 on port, mirrored)
  for (let i = 0; i < 86; i++) {
    const sx = 32 + detRand(i * 7.3 + 1.1) * 1960;
    const sy = 158 + detRand(i * 11.7 + 2.4) * 74;
    const len = 24 + detRand(i * 5.9 + 3.8) * 96;
    const h = 2 + detRand(i * 13.1) * 3.8;
    const alpha = 0.14 + detRand(i * 17.3) * 0.20;
    ctx.fillStyle = `rgba(218, 234, 248, ${alpha})`;
    ctx.fillRect(sx, sy, len, h);
    // Occasional tiny dark scratch companion line
    if (detRand(i * 29.1) > 0.65) {
      ctx.fillStyle = 'rgba(16, 26, 38, 0.28)';
      ctx.fillRect(sx + 6, sy + h, len * 0.7, 1.5);
    }
  }

  // Graphic rust-umber & slate vertical scupper / hawsepipe weather-drip streaks
  const dripXs = [210, 340, 495, 650, 815, 1140, 1345, 1525, 1715, 1845];
  dripXs.forEach((dx, idx) => {
    const len = 42 + detRand(idx * 19.3 + 4.1) * 74;
    const w = 6 + detRand(idx * 7.1) * 6;
    const grad = ctx.createLinearGradient(dx, 24, dx, 24 + len);
    grad.addColorStop(0, 'rgba(98, 60, 36, 0.56)');
    grad.addColorStop(0.42, 'rgba(72, 48, 36, 0.32)');
    grad.addColorStop(1, 'rgba(54, 42, 36, 0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(dx - w * 0.5, 24, w, len);

    // Fine crisp center drip thread
    ctx.fillStyle = 'rgba(42, 30, 24, 0.36)';
    ctx.fillRect(dx - 1, 24, 2, len * 0.72);

    // Dark scupper port slot at upper sheer edge
    ctx.fillStyle = 'rgba(18, 27, 38, 0.80)';
    ctx.fillRect(dx - 7, 22, 14, 6);
  });

  // Subtle boot-topping / waterline grime band
  const wlGrad = ctx.createLinearGradient(0, 198, 0, 256);
  wlGrad.addColorStop(0, 'rgba(14, 25, 38, 0)');
  wlGrad.addColorStop(0.5, 'rgba(14, 25, 38, 0.22)');
  wlGrad.addColorStop(1, 'rgba(10, 20, 32, 0.36)');
  ctx.fillStyle = wlGrad;
  ctx.fillRect(0, 198, 2048, 58);

  // Crisp upper dark rub-strake ink line
  ctx.strokeStyle = '#141c24';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(0, 24);
  ctx.lineTo(2048, 24);
  ctx.stroke();

  // Properly proportioned stenciled "C T S C" lettering matching reference position & clarity!
  // On Port (+X, facing Illustration Camera): sideU = 1 - u, so mid-forward (z ~ +1.8 .. -1.6) maps to x ~ 820..1210
  ctx.save();
  ctx.fillStyle = '#111b27';
  ctx.font = '800 84px "SF Pro Display", "Helvetica Neue", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const letters = ['C', 'T', 'S', 'C'];
  const startX = 876;
  const spacing = 86;
  letters.forEach((ch, idx) => {
    ctx.fillText(ch, startX + idx * spacing, 120);
  });
  ctx.restore();

  // Crisp Plimsoll & draft marks near bow & stern
  ctx.fillStyle = 'rgba(218, 232, 246, 0.58)';
  for (let i = 0; i < 5; i++) {
    ctx.fillRect(280, 108 + i * 18, 24, 3);
    ctx.fillRect(1752, 108 + i * 18, 24, 3);
  }
  ctx.strokeStyle = 'rgba(20, 30, 42, 0.65)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(1005, 186, 12, 0, Math.PI * 2);
  ctx.moveTo(986, 186);
  ctx.lineTo(1024, 186);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * Generates crisp weathering texture (1024x192) for the white forward bow sheer band:
 * - Warm rust-umber anchor hawse drip trails
 * - Welded vertical plate joints, freeing port scuppers & subtle salt-spray patina
 */
function createWhiteBandWeatheringTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 192;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Subtle horizontal sheer strake seam
  ctx.strokeStyle = 'rgba(26, 36, 48, 0.24)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 96);
  ctx.lineTo(1024, 96);
  ctx.stroke();

  // Vertical weld plate seams
  for (let x = 76; x < 980; x += 108) {
    ctx.strokeStyle = 'rgba(26, 36, 48, 0.26)';
    ctx.beginPath();
    ctx.moveTo(x, 12);
    ctx.lineTo(x, 180);
    ctx.stroke();
  }

  // Prominent anchor-hawse rust-wash drip trail right under bow anchor pocket + subtle freeing-port drips
  const drips = [
    { x: 264, y: 58, w: 26, h: 130, a: 0.54 },
    { x: 274, y: 66, w: 9, h: 122, a: 0.44 },
    { x: 252, y: 74, w: 7, h: 108, a: 0.36 },
    { x: 468, y: 102, w: 13, h: 84, a: 0.30 },
    { x: 642, y: 106, w: 12, h: 76, a: 0.28 },
    { x: 816, y: 112, w: 11, h: 68, a: 0.26 },
  ];
  drips.forEach((d) => {
    const grad = ctx.createLinearGradient(d.x, d.y, d.x, d.y + d.h);
    grad.addColorStop(0, `rgba(128, 76, 42, ${d.a})`);
    grad.addColorStop(0.55, `rgba(108, 74, 52, ${d.a * 0.48})`);
    grad.addColorStop(1, 'rgba(108, 74, 52, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(d.x - d.w * 0.5, d.y, d.w, d.h);
  });

  // Crisp dark freeing-port slots along bulwark base
  ctx.fillStyle = 'rgba(20, 30, 42, 0.74)';
  [456, 630, 804].forEach((fx) => {
    ctx.fillRect(fx, 114, 28, 9);
  });

  // Subtle top gunwale shadow strip & lower blue-transition seam line
  ctx.fillStyle = 'rgba(28, 40, 54, 0.16)';
  ctx.fillRect(0, 0, 1024, 14);
  ctx.strokeStyle = 'rgba(21, 28, 36, 0.62)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(0, 189);
  ctx.lineTo(1024, 189);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * Generates crisp architectural cabin bulkhead texture with refined weathering:
 * - Architectural vertical & horizontal bulkhead panel seams
 * - Subtle weathered rain/rust-slate streaks descending from eaves & window levels
 * - Tasteful lower deck-splash patina right along bulkhead foot
 */
function createCabinWeatheringTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 512, 512);

  // Subtle architectural panel seams
  ctx.strokeStyle = 'rgba(34, 48, 64, 0.20)';
  ctx.lineWidth = 2;
  for (let x = 64; x < 512; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 512);
    ctx.stroke();
  }
  [164, 336].forEach((y) => {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(512, y);
    ctx.stroke();
  });

  // Delicate under-eave & under-window vertical weathered patina streaks
  for (let i = 0; i < 22; i++) {
    const dx = 22 + detRand(i * 13.7 + 2.1) * 468;
    const band = detRand(i * 7.9 + 1.3);
    const dy = band < 0.38 ? 0 : band < 0.72 ? 176 : 340;
    const h = 42 + detRand(i * 23.1) * 78;
    const isRusty = detRand(i * 31.7) > 0.68;
    const rgb = isRusty ? '114, 82, 58' : '64, 80, 96';
    const alpha = isRusty ? 0.22 : 0.20;
    const grad = ctx.createLinearGradient(dx, dy, dx, dy + h);
    grad.addColorStop(0, `rgba(${rgb}, ${alpha})`);
    grad.addColorStop(0.6, `rgba(${rgb}, ${alpha * 0.4})`);
    grad.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(dx - 4.5, dy, 9, h);
  }

  // Fine Ligne Claire ink-stipple micro-weathering ticks on painted steel
  ctx.fillStyle = 'rgba(36, 48, 62, 0.26)';
  for (let i = 0; i < 42; i++) {
    const sx = 16 + detRand(i * 19.3 + 4.4) * 480;
    const sy = 16 + detRand(i * 27.1 + 1.8) * 480;
    ctx.fillRect(sx, sy, 2.5, 2.5);
  }

  // Subtle bottom deck-splash grime band right along bulkhead base
  const baseGrad = ctx.createLinearGradient(0, 456, 0, 512);
  baseGrad.addColorStop(0, 'rgba(48, 62, 78, 0)');
  baseGrad.addColorStop(0.65, 'rgba(48, 62, 78, 0.16)');
  baseGrad.addColorStop(1, 'rgba(42, 54, 68, 0.28)');
  ctx.fillStyle = baseGrad;
  ctx.fillRect(0, 456, 512, 56);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * Generates subtle soot & heat-weathered casing texture for the polar smokestack.
 */
function createFunnelWeatheringTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 256, 256);

  // Crisp upper exhaust soot bleed running down from charcoal cap
  const sootGrad = ctx.createLinearGradient(0, 0, 0, 120);
  sootGrad.addColorStop(0, 'rgba(20, 26, 34, 0.52)');
  sootGrad.addColorStop(0.4, 'rgba(30, 38, 48, 0.22)');
  sootGrad.addColorStop(1, 'rgba(30, 38, 48, 0)');
  ctx.fillStyle = sootGrad;
  ctx.fillRect(0, 0, 256, 120);

  // Crisp graphic horizontal collar trim line + vertical panel seams
  ctx.strokeStyle = 'rgba(22, 30, 40, 0.42)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, 26);
  ctx.lineTo(256, 26);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(26, 36, 48, 0.24)';
  ctx.lineWidth = 2;
  [64, 128, 192].forEach((x) => {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 256);
    ctx.stroke();
  });

  // Subtle exhaust louver slits on funnel side
  ctx.fillStyle = 'rgba(20, 28, 38, 0.56)';
  for (let r = 0; r < 4; r++) {
    ctx.fillRect(92, 134 + r * 14, 72, 6);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Generates high-resolution (1024x1024) reference-faithful Helideck texture:
 * - Bold, crisp architectural dark-ink landing circle & inner guide ring (readable even at Illustration distance!)
 * - Restrained polar center crosshair, 8 tie-down padeyes, perimeter safety gutter seams
 * - Authentic non-skid tonal wear, helicopter skid-touchdown scuffs & subtle edge patina
 */
function createHelideckTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 1024, 1024);

  // Subtle weathered tonal deck-plate variation & non-skid traffic patina
  for (let i = 0; i < 36; i++) {
    const px = 48 + detRand(i * 11.3) * 840;
    const py = 48 + detRand(i * 17.9) * 840;
    const pw = 48 + detRand(i * 5.7) * 124;
    const ph = 34 + detRand(i * 9.1) * 96;
    ctx.fillStyle = detRand(i * 3.1) > 0.48
      ? 'rgba(56, 70, 84, 0.11)'
      : 'rgba(238, 242, 246, 0.14)';
    ctx.fillRect(px, py, pw, ph);
  }

  // Subtle radial rotor-wash tonal halo inside landing zone
  const washGrad = ctx.createRadialGradient(512, 512, 140, 512, 512, 410);
  washGrad.addColorStop(0, 'rgba(48, 60, 74, 0.08)');
  washGrad.addColorStop(0.75, 'rgba(48, 60, 74, 0.02)');
  washGrad.addColorStop(1, 'rgba(48, 60, 74, 0.16)');
  ctx.fillStyle = washGrad;
  ctx.fillRect(36, 36, 952, 952);

  // Fine architectural deck plating seams
  ctx.strokeStyle = 'rgba(24, 34, 46, 0.34)';
  ctx.lineWidth = 3.5;
  ctx.strokeRect(36, 36, 952, 952);
  [256, 512, 768].forEach((p) => {
    ctx.beginPath();
    ctx.moveTo(p, 36);
    ctx.lineTo(p, 988);
    ctx.moveTo(36, p);
    ctx.lineTo(988, p);
    ctx.stroke();
  });

  // Perimeter gutter border & subtle weathered corner wear
  ctx.strokeStyle = 'rgba(34, 46, 58, 0.24)';
  ctx.lineWidth = 22;
  ctx.strokeRect(48, 48, 928, 928);

  // Reference-faithful bold dark-ink outer helipad landing ring (clearly legible from telephoto view!)
  ctx.strokeStyle = 'rgba(20, 29, 40, 0.88)';
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.arc(512, 512, 376, 0, Math.PI * 2);
  ctx.stroke();

  // Crisp pale contrast highlight hairline right inside dark landing ring
  ctx.strokeStyle = 'rgba(240, 244, 248, 0.56)';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(512, 512, 358, 0, Math.PI * 2);
  ctx.stroke();

  // Secondary inner dashed touchdown guide ring
  ctx.strokeStyle = 'rgba(22, 32, 44, 0.48)';
  ctx.lineWidth = 6;
  ctx.setLineDash([28, 20]);
  ctx.beginPath();
  ctx.arc(512, 512, 286, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // Restrained architectural center aim-cross & subtle understated H-bar marks
  ctx.strokeStyle = 'rgba(22, 32, 44, 0.42)';
  ctx.lineWidth = 8;
  ctx.beginPath();
  // Subtle clean H / alignment mark (dark architectural ink, never garish yellow!)
  ctx.moveTo(438, 424);
  ctx.lineTo(438, 600);
  ctx.moveTo(586, 424);
  ctx.lineTo(586, 600);
  ctx.moveTo(438, 512);
  ctx.lineTo(586, 512);
  ctx.stroke();

  // Cardinal perimeter alignment ticks
  ctx.strokeStyle = 'rgba(20, 29, 40, 0.72)';
  ctx.lineWidth = 7;
  for (let k = 0; k < 4; k++) {
    const ang = (k * Math.PI) / 2;
    ctx.beginPath();
    ctx.moveTo(512 + Math.cos(ang) * 376, 512 + Math.sin(ang) * 376);
    ctx.lineTo(512 + Math.cos(ang) * 412, 512 + Math.sin(ang) * 412);
    ctx.stroke();
  }

  // 8 recessed tie-down deck padeyes
  ctx.fillStyle = 'rgba(20, 29, 40, 0.68)';
  for (let a = 0; a < 8; a++) {
    const ang = (a / 8) * Math.PI * 2 + Math.PI / 8;
    const tx = 512 + Math.cos(ang) * 332;
    const ty = 512 + Math.sin(ang) * 332;
    ctx.beginPath();
    ctx.arc(tx, ty, 7.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Helicopter skid-touchdown rubber/grime scuff marks + fine ink stipple wear
  ctx.strokeStyle = 'rgba(32, 42, 52, 0.30)';
  ctx.lineWidth = 9;
  ctx.beginPath();
  ctx.moveTo(404, 386);
  ctx.lineTo(418, 624);
  ctx.moveTo(604, 396);
  ctx.lineTo(618, 632);
  ctx.stroke();

  ctx.fillStyle = 'rgba(26, 36, 48, 0.34)';
  for (let i = 0; i < 65; i++) {
    const sx = 64 + detRand(i * 23.7 + 1.4) * 896;
    const sy = 64 + detRand(i * 31.3 + 2.8) * 896;
    ctx.fillRect(sx, sy, 4, 3);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * Generates longitudinally proportioned (512x1024) weathered weather-deck texture:
 * - Crisp non-stretched deck plating seams & centerline seam
 * - Boot-traffic wear paths, dark anchor-chain scuffing, rust ticks & fine ink stipple grain
 */
function createForedeckTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 512, 1024);

  // Subtle graphic paint wear & salt-worn non-skid patches
  for (let i = 0; i < 54; i++) {
    const x = detRand(i * 9.3 + 1.1) * 460;
    const y = detRand(i * 15.7 + 2.3) * 960;
    const w = 18 + detRand(i * 4.1) * 58;
    const h = 16 + detRand(i * 8.3) * 52;
    ctx.fillStyle = detRand(i * 12.1) > 0.45
      ? 'rgba(58, 72, 86, 0.13)'
      : 'rgba(234, 240, 245, 0.16)';
    ctx.fillRect(x, y, w, h);
  }

  // Subtle dark rust/chain scuff bands along foredeck centerline & stern working area
  ctx.fillStyle = 'rgba(92, 66, 48, 0.16)';
  ctx.fillRect(198, 760, 28, 170);
  ctx.fillRect(286, 760, 28, 170);
  ctx.fillStyle = 'rgba(48, 60, 74, 0.14)';
  ctx.fillRect(72, 88, 368, 160);

  // Crisp deck plating seams (true longitudinal proportion!)
  ctx.strokeStyle = 'rgba(24, 34, 46, 0.38)';
  ctx.lineWidth = 2.4;
  [128, 256, 384].forEach((x) => {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 1024);
    ctx.stroke();
  });
  for (let y = 64; y < 1024; y += 64) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(512, y);
    ctx.stroke();
  }

  // Fine Ligne Claire ink stipple aging & short scuff hatching ticks
  ctx.fillStyle = 'rgba(24, 34, 46, 0.40)';
  for (let i = 0; i < 92; i++) {
    const sx = 20 + detRand(i * 21.7) * 472;
    const sy = 20 + detRand(i * 33.1) * 984;
    ctx.fillRect(sx, sy, 3, 2);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * Builds the refined architectural Polar Icebreaker calibrated closely to the reference artwork:
 * - Raked spoon-bow hull with properly proportioned "CTSC" lettering & ice-belt weathering
 * - Cohesive compact two-tier superstructure with sleeker cantilevered bridge wings
 * - Slim chamfered polar smokestack & non-clipping aft lattice mast seated cleanly on funnel deckhouse
 * - Prominent chamfered aft helideck with crisp dark landing ring, anchored safety netting & hangar bay
 * - Stowed deck crane positioned cleanly on the lower stern working deck (zero helideck overlap!)
 */
export function createIcebreaker() {
  const root = new THREE.Group();
  root.name = 'IcebreakerRoot';

  const shipBody = new THREE.Group();
  root.add(shipBody);

  // Procedural crisp weathering & architectural marking textures
  const hullWeatherTex = createHullWeatheringTexture();
  const whiteBandTex = createWhiteBandWeatheringTexture();
  const cabinWeatherTex = createCabinWeatheringTexture();
  const funnelWeatherTex = createFunnelWeatheringTexture();
  const helideckTex = createHelideckTexture();
  const foredeckTex = createForedeckTexture();

  const matHullBlue = createCelMaterial({
    litColor: PALETTE.hullBlueLit,
    shadowColor: PALETTE.hullBlueShadow,
    deepShadowColor: '#163354',
    map: hullWeatherTex,
  });
  const matHullBluePlain = createCelMaterial({
    litColor: PALETTE.hullBlueLit,
    shadowColor: PALETTE.hullBlueShadow,
    deepShadowColor: '#163354',
  });
  const matHullWhite = createCelMaterial({
    litColor: PALETTE.hullWhiteLit,
    shadowColor: PALETTE.hullWhiteShadow,
    deepShadowColor: '#627c9b',
    map: whiteBandTex,
  });
  const matCabin = createCelMaterial({
    litColor: PALETTE.cabinLit,
    shadowColor: PALETTE.cabinShadow,
    deepShadowColor: PALETTE.cabinDeepShadow,
    map: cabinWeatherTex,
  });
  const matCabinClean = createCelMaterial({
    litColor: PALETTE.cabinLit,
    shadowColor: PALETTE.cabinShadow,
    deepShadowColor: PALETTE.cabinDeepShadow,
  });
  const matFunnelBody = createCelMaterial({
    litColor: PALETTE.cabinLit,
    shadowColor: PALETTE.cabinShadow,
    deepShadowColor: PALETTE.cabinDeepShadow,
    map: funnelWeatherTex,
  });
  const matDeck = createCelMaterial({
    litColor: PALETTE.deckLit,
    shadowColor: PALETTE.deckShadow,
    deepShadowColor: '#5f7488',
  });
  const matForedeck = createCelMaterial({
    litColor: PALETTE.deckLit,
    shadowColor: PALETTE.deckShadow,
    deepShadowColor: '#5f7488',
    map: foredeckTex,
  });
  const matHelideck = createCelMaterial({
    litColor: PALETTE.deckLit,
    shadowColor: PALETTE.deckShadow,
    deepShadowColor: '#5f7488',
    map: helideckTex,
  });
  const matFunnelDark = createCelMaterial({
    litColor: PALETTE.funnelDarkLit,
    shadowColor: PALETTE.funnelDarkShadow,
    deepShadowColor: '#0e141b',
  });
  const matLifeboat = createCelMaterial({
    litColor: PALETTE.lifeboatLit,
    shadowColor: PALETTE.lifeboatShadow,
    deepShadowColor: '#8d440b',
  });
  const matMetalDark = createCelMaterial({
    litColor: PALETTE.metalDarkLit,
    shadowColor: PALETTE.metalDarkShadow,
    deepShadowColor: '#171f29',
  });
  const matWindow = createFlatInkMaterial(PALETTE.windowDark);
  const matInkLine = createFlatInkMaterial(PALETTE.ink);

  // Cache G-buffer materials by partId so separate architectural blocks get crisp ink edges
  const gbufMatCache = new Map();
  function getGbufMat(partId, doubleSide = false) {
    const key = `${partId}_${doubleSide ? 1 : 0}`;
    if (!gbufMatCache.has(key)) {
      gbufMatCache.set(key, createGBufferMaterial({ partId, doubleSide }));
    }
    return gbufMatCache.get(key);
  }

  function addPart(geo, material, partId, {
    parent = shipBody,
    pos = [0, 0, 0],
    rot = [0, 0, 0],
    scale = [1, 1, 1],
    castShadow = true,
    writeGBuffer = true,
    doubleSide = false,
  } = {}) {
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(pos[0], pos[1], pos[2]);
    mesh.rotation.set(rot[0], rot[1], rot[2]);
    mesh.scale.set(scale[0], scale[1], scale[2]);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.userData.beautyMaterial = material;
    mesh.userData.writeGBuffer = writeGBuffer;
    if (writeGBuffer) {
      mesh.userData.gbufMaterial = getGbufMat(partId, doubleSide);
    }
    parent.add(mesh);
    return mesh;
  }

  // Beauty-only thin structural ink lines (railings, lattice braces, rigging, netting, shutter slats)
  const inkSegments = [];
  function pushLine(x1, y1, z1, x2, y2, z2) {
    inkSegments.push(x1, y1, z1, x2, y2, z2);
  }

  function addRailingLoop(points, height = 0.34, posts = true) {
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      pushLine(a[0], a[1] + height, a[2], b[0], b[1] + height, b[2]);
      pushLine(a[0], a[1] + height * 0.52, a[2], b[0], b[1] + height * 0.52, b[2]);
      if (posts) {
        const dist = Math.hypot(b[0] - a[0], b[2] - a[2]);
        const steps = Math.max(1, Math.round(dist / 0.85));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const px = a[0] + (b[0] - a[0]) * t;
          const py = a[1] + (b[1] - a[1]) * t;
          const pz = a[2] + (b[2] - a[2]) * t;
          pushLine(px, py, pz, px, py + height, pz);
        }
      }
    }
  }

  // =========================================================================
  // 1. LOFTED POLAR ICEBREAKER HULL (Airtight Two-Tone Hull + Weathering)
  // =========================================================================
  const whiteBandSplitY = (z) => {
    const topY = hullSheerY(z);
    if (z <= 0.75) return topY;
    const t = Math.min(1, (z - 0.75) / 5.7);
    const bandHeight = 0.14 + 0.60 * Math.pow(t, 0.78);
    return topY - bandHeight;
  };

  // Lower cobalt blue hull with properly proportioned C T S C stencil, ice-belt scuffs & scupper drips
  const lowerHullGeo = buildHullBandGeometry({
    zStart: -8.82,
    zEnd: 9.1,
    zSteps: 56,
    yBottomFn: (z) => (z > 5.2 ? -0.66 + ((z - 5.2) / 3.9) * 0.78 : -0.78),
    yTopFn: (z) => whiteBandSplitY(z),
    scaleX: 1.0,
    capBottom: true,
    capTop: false,
    capStern: true,
  });
  addPart(lowerHullGeo, matHullBlue, 5);

  // Upper forward white sheer band with anchor rust-wash patina & freeing ports
  const whiteBandGeo = buildHullBandGeometry({
    zStart: 0.75,
    zEnd: 9.1,
    zSteps: 36,
    yBottomFn: (z) => whiteBandSplitY(z),
    yTopFn: (z) => hullSheerY(z) + 0.34,
    scaleX: 1.0,
  });
  addPart(whiteBandGeo, matHullWhite, 5);

  // Solid Inner Bow Bulwark Wall (tucked safely inside outer hull curvature at raked stem)
  const innerBulwarkGeo = buildHullBandGeometry({
    zStart: 2.2,
    zEnd: 8.78,
    zSteps: 28,
    yBottomFn: (z) => hullSheerY(z) + 0.01,
    yTopFn: (z) => hullSheerY(z) + 0.32,
    scaleX: 0.91,
  });
  addPart(innerBulwarkGeo, matCabinClean, 6, { doubleSide: true, castShadow: false });

  // Aft & midship low deck bulwark / rub rail rim
  const aftBulwarkGeo = buildHullBandGeometry({
    zStart: -8.82,
    zEnd: 0.78,
    zSteps: 24,
    yBottomFn: (z) => hullSheerY(z),
    yTopFn: (z) => hullSheerY(z) + 0.28,
    scaleX: 1.0,
    capStern: true,
  });
  addPart(aftBulwarkGeo, matHullBluePlain, 5);

  // Main Continuous Weather Deck Plate (tucked safely inside outer hull curvature near stem tip)
  const mainDeckGeo = buildHullBandGeometry({
    zStart: -8.78,
    zEnd: 8.86,
    zSteps: 48,
    yBottomFn: (z) => hullSheerY(z) - 0.08,
    yTopFn: (z) => hullSheerY(z) + 0.02,
    scaleX: 0.955,
    capTop: true,
  });
  addPart(mainDeckGeo, matForedeck, 6);

  // Crisp Dark Gunwale Cap Rail along entire perimeter
  const gunwalePtsL = [];
  const gunwalePtsR = [];
  for (let i = 0; i <= 32; i++) {
    const z = -8.78 + (17.80 * i) / 32;
    const yRail = hullSheerY(z) + (z > 0.75 ? 0.34 : 0.28);
    const xOuter = hullWidthAtZY(z, yRail, 1.0);
    const zr = bowStemZAt(z, yRail);
    gunwalePtsL.push([xOuter, yRail, zr]);
    gunwalePtsR.push([-xOuter, yRail, zr]);
  }
  for (let i = 0; i < gunwalePtsL.length - 1; i++) {
    const a = gunwalePtsL[i];
    const b = gunwalePtsL[i + 1];
    pushLine(a[0], a[1], a[2], b[0], b[1], b[2]);
    const c = gunwalePtsR[i];
    const d = gunwalePtsR[i + 1];
    pushLine(c[0], c[1], c[2], d[0], d[1], d[2]);
  }

  // Sculpted Bow Hawsepipe Collar & Recessed Anchor Flukes on Bow Cheeks
  for (const s of [1, -1]) {
    const az = 6.95;
    const ay = 1.44;
    const ax = hullWidthAtZY(az, ay, 1.0);
    const azr = bowStemZAt(az, ay);
    addPart(new THREE.BoxGeometry(0.10, 0.26, 0.32), matWindow, 14, {
      pos: [s * (ax + 0.01), ay, azr],
      rot: [0, s * -0.45, 0],
      castShadow: false,
    });
    // Twin anchor flukes tucked neatly inside pocket
    addPart(new THREE.BoxGeometry(0.14, 0.30, 0.14), matMetalDark, 14, {
      pos: [s * (ax + 0.04), ay - 0.04, azr - 0.03],
      rot: [0.16, s * -0.45, s * 0.12],
    });
  }

  // =========================================================================
  // 2. FOREDECK DETAILS (Breakwater, Winches, Hatch, Anchor Chains, Bollards)
  // =========================================================================
  for (const s of [1, -1]) {
    addPart(new THREE.BoxGeometry(1.48, 0.38, 0.14), matCabinClean, 7, {
      pos: [s * 0.68, 1.69, 3.88],
      rot: [0, s * -0.24, 0],
    });
  }
  // Foredeck cargo hatch & raised coaming with crisp corner cleats
  addPart(new THREE.BoxGeometry(1.16, 0.20, 1.06), matDeck, 6, { pos: [0, 1.65, 5.14] });
  addPart(new THREE.BoxGeometry(1.24, 0.08, 1.14), matCabinClean, 6, { pos: [0, 1.78, 5.14] });
  pushLine(-0.56, 1.83, 5.14, 0.56, 1.83, 5.14);
  pushLine(0, 1.83, 4.62, 0, 1.83, 5.66);

  // Twin Anchor Windlasses, Capstan Drums & Dark Anchor Chains leading forward
  for (const s of [1, -1]) {
    addPart(new THREE.BoxGeometry(0.42, 0.34, 0.50), matMetalDark, 14, {
      pos: [s * 0.54, 1.77, 6.52],
    });
    addPart(new THREE.CylinderGeometry(0.18, 0.20, 0.34, 10), matMetalDark, 14, {
      pos: [s * 0.54, 1.81, 7.04],
    });
    // Anchor chain runs forward into hawsepipe deck tubes
    pushLine(s * 0.54, 1.72, 6.78, s * 0.38, 1.86, 8.26);
    pushLine(s * 0.58, 1.72, 6.78, s * 0.42, 1.86, 8.26);
    // Low deck vent mushroom beside windlass
    addPart(new THREE.CylinderGeometry(0.11, 0.09, 0.24, 8), matCabinClean, 14, {
      pos: [s * 1.14, 1.74, 5.65],
    });
  }
  [
    [1.64, 1.64, 4.42],
    [-1.64, 1.64, 4.42],
    [1.24, 1.76, 6.68],
    [-1.24, 1.76, 6.68],
    [0.62, 1.88, 7.98],
    [-0.62, 1.88, 7.98],
  ].forEach(([bx, by, bz]) => {
    addPart(new THREE.CylinderGeometry(0.08, 0.09, 0.22, 8), matMetalDark, 14, {
      pos: [bx, by, bz],
    });
  });
  // Slender bow jackstaff
  addPart(new THREE.CylinderGeometry(0.022, 0.032, 1.02, 6), matInkLine, 15, {
    pos: [0, 2.48, 9.08],
    writeGBuffer: false,
  });

  // =========================================================================
  // 3. COMPACT COHESIVE SUPERSTRUCTURE (Reference-Faithful Massing!)
  // =========================================================================
  // Main Sturdy Two-Deck Accommodation Block (z = -1.92 .. +3.22, y = 1.48 .. 3.82, width 3.60m)
  addPart(new THREE.BoxGeometry(3.60, 2.34, 5.14), matCabin, 7, {
    pos: [0, 2.65, 0.65],
  });
  // Crisp overhanging brow cornice deck (y = 3.82)
  addPart(new THREE.BoxGeometry(3.74, 0.11, 5.30), matDeck, 7, {
    pos: [0, 3.85, 0.65],
  });

  // Forward Bulkhead Windows (EXACT reference rhythm: lower row of 3, upper row of 5!)
  for (let i = 0; i < 3; i++) {
    const wx = -0.80 + i * 0.80;
    addPart(new THREE.BoxGeometry(0.28, 0.26, 0.06), matWindow, 7, {
      pos: [wx, 2.28, 3.23],
      castShadow: false,
      writeGBuffer: false,
    });
  }
  for (let i = 0; i < 5; i++) {
    const wx = -1.20 + i * 0.60;
    addPart(new THREE.BoxGeometry(0.25, 0.26, 0.06), matWindow, 7, {
      pos: [wx, 3.12, 3.23],
      castShadow: false,
      writeGBuffer: false,
    });
  }
  // Subtle forward bulkhead watertight door center-lower
  addPart(new THREE.BoxGeometry(0.36, 0.64, 0.05), matMetalDark, 7, {
    pos: [0, 1.82, 3.23],
    castShadow: false,
    writeGBuffer: false,
  });

  // Port & Starboard Accommodation Windows (2 neat rows of 5, cleanly aft of exterior ladder) + Tall Dark Intake Louvers Aft
  for (const s of [1, -1]) {
    for (let i = 0; i < 5; i++) {
      const wz = 2.48 - i * 0.51;
      addPart(new THREE.BoxGeometry(0.06, 0.23, 0.24), matWindow, 7, {
        pos: [s * 1.81, 2.36, wz],
        castShadow: false,
        writeGBuffer: false,
      });
      addPart(new THREE.BoxGeometry(0.06, 0.23, 0.24), matWindow, 7, {
        pos: [s * 1.81, 3.12, wz],
        castShadow: false,
        writeGBuffer: false,
      });
    }
    // Aft dark vertical ventilation louvers right behind the lifeboat
    for (let i = 0; i < 3; i++) {
      const vz = -0.52 - i * 0.46;
      addPart(new THREE.BoxGeometry(0.07, 0.96, 0.28), matWindow, 7, {
        pos: [s * 1.81, 2.74, vz],
        castShadow: false,
        writeGBuffer: false,
      });
    }
  }

  // Terrace walkway railings atop main accommodation deck (y = 3.91)
  addRailingLoop(
    [
      [1.82, 3.91, 3.26],
      [1.82, 3.91, -1.94],
    ],
    0.32
  );
  addRailingLoop(
    [
      [-1.82, 3.91, 3.26],
      [-1.82, 3.91, -1.94],
    ],
    0.32
  );
  addRailingLoop(
    [
      [-1.82, 3.91, 3.26],
      [1.82, 3.91, 3.26],
    ],
    0.32
  );

  // Exterior Inclined Companionway Ladders placed cleanly forward of windows & lifeboats (zero overlap!)
  for (const s of [1, -1]) {
    pushLine(s * 1.86, 1.56, 3.18, s * 1.86, 3.88, 2.68);
    pushLine(s * 2.02, 1.56, 3.18, s * 2.02, 3.88, 2.68);
    for (let step = 1; step <= 6; step++) {
      const t = step / 7;
      const y = 1.56 + (3.88 - 1.56) * t;
      const z = 3.18 + (2.68 - 3.18) * t;
      pushLine(s * 1.86, y, z, s * 2.02, y, z);
    }
  }

  // =========================================================================
  // 4. ICONIC AMBER-ORANGE LIFEBOATS IN DAVITS (Warm Color Focal Point!)
  // =========================================================================
  function buildLifeboatGeometry() {
    const shape = new THREE.Shape();
    shape.moveTo(0, -1.08);
    shape.quadraticCurveTo(0.37, -0.58, 0.35, 0);
    shape.quadraticCurveTo(0.37, 0.58, 0, 1.08);
    shape.quadraticCurveTo(-0.37, 0.58, -0.35, 0);
    shape.quadraticCurveTo(-0.37, -0.58, 0, -1.08);

    const extrude = new THREE.ExtrudeGeometry(shape, {
      depth: 0.36,
      bevelEnabled: true,
      bevelThickness: 0.11,
      bevelSize: 0.06,
      bevelSegments: 2,
    });
    extrude.rotateX(-Math.PI / 2);
    extrude.translate(0, -0.17, 0);
    extrude.computeVertexNormals();
    return extrude;
  }

  const lifeboatGeo = buildLifeboatGeometry();
  for (const s of [1, -1]) {
    addPart(lifeboatGeo, matLifeboat, 11, {
      pos: [s * 1.98, 2.16, 0.42],
    });
    // Dark canopy slit & rub-rail stripe
    addPart(new THREE.BoxGeometry(0.07, 0.08, 0.64), matWindow, 11, {
      pos: [s * 2.30, 2.34, 0.42],
      castShadow: false,
      writeGBuffer: false,
    });
    // Twin Gravity Davit Arms tucked snugly at ends of lifeboat
    for (const dz of [-0.68, 1.52]) {
      addPart(new THREE.BoxGeometry(0.46, 0.10, 0.13), matCabinClean, 12, {
        pos: [s * 1.94, 1.86, dz],
      });
      addPart(new THREE.BoxGeometry(0.11, 0.84, 0.13), matCabinClean, 12, {
        pos: [s * 2.16, 2.25, dz],
        rot: [0, 0, s * -0.12],
      });
    }
  }

  // =========================================================================
  // 5. COMPACT NAVIGATION BRIDGE & SLEEK REFERENCE-PROPORTIONED BRIDGE WINGS
  // =========================================================================
  // Compact Navigation Wheelhouse (z = -0.10 .. +2.42, y = 3.90 .. 5.06, width 3.16m)
  addPart(new THREE.BoxGeometry(3.16, 1.16, 2.52), matCabin, 9, {
    pos: [0, 4.48, 1.16],
  });

  // Streamlined Aft Funnel Deckhouse Collar behind wheelhouse (also seats aft lattice mast cleanly!)
  addPart(new THREE.BoxGeometry(2.74, 0.84, 1.92), matCabin, 8, {
    pos: [0, 4.32, -1.04],
  });
  addPart(new THREE.BoxGeometry(2.84, 0.09, 2.00), matDeck, 8, {
    pos: [0, 4.76, -1.04],
  });
  // Small radio-room side portholes on aft deckhouse
  for (const s of [1, -1]) {
    addPart(new THREE.BoxGeometry(0.05, 0.20, 0.24), matWindow, 8, {
      pos: [s * 1.38, 4.38, -0.78],
      castShadow: false,
      writeGBuffer: false,
    });
    addPart(new THREE.BoxGeometry(0.05, 0.20, 0.24), matWindow, 8, {
      pos: [s * 1.38, 4.38, -1.32],
      castShadow: false,
      writeGBuffer: false,
    });
  }

  // Sleek, Proportional Cantilevered Bridge Wings (flush with wheelhouse waist, NOT oversized tubs!)
  // Extends cleanly to x = ±2.56m with crisp shallow 0.44m parapet & rounded wingtips
  addPart(new THREE.BoxGeometry(4.46, 0.44, 1.06), matCabinClean, 9, {
    pos: [0, 4.24, 1.54],
  });
  for (const s of [1, -1]) {
    // Sleek rounded wingtip pod (r = 0.53, height = 0.44)
    addPart(new THREE.CylinderGeometry(0.53, 0.50, 0.44, 16), matCabinClean, 9, {
      pos: [s * 2.23, 4.24, 1.54],
    });
    addPart(new THREE.CylinderGeometry(0.49, 0.49, 0.07, 16), matDeck, 9, {
      pos: [s * 2.23, 4.48, 1.54],
    });
    // Compact bridge-wing pelorus / thruster control console & nav light hood
    addPart(new THREE.CylinderGeometry(0.08, 0.10, 0.26, 8), matMetalDark, 14, {
      pos: [s * 2.26, 4.64, 1.60],
    });
    // Slim diagonal cantilevered support knee underneath wing
    addPart(new THREE.BoxGeometry(0.70, 0.13, 0.24), matCabinClean, 9, {
      pos: [s * 1.88, 3.88, 1.54],
      rot: [0, 0, s * 0.44],
    });
    // Tightly fitted wing perimeter safety rail
    addRailingLoop(
      [
        [s * 1.58, 4.50, 2.04],
        [s * 2.26, 4.50, 2.04],
        [s * 2.72, 4.50, 1.54],
        [s * 2.26, 4.50, 1.04],
        [s * 1.58, 4.50, 1.04],
      ],
      0.24,
      true
    );
  }

  // Wrap-Around Panoramic Bridge Glazing with Crisp Vertical Mullions
  addPart(new THREE.BoxGeometry(2.94, 0.40, 0.07), matWindow, 9, {
    pos: [0, 4.66, 2.43],
    castShadow: false,
    writeGBuffer: false,
  });
  for (const s of [1, -1]) {
    addPart(new THREE.BoxGeometry(0.07, 0.40, 1.96), matWindow, 9, {
      pos: [s * 1.59, 4.66, 1.30],
      castShadow: false,
      writeGBuffer: false,
    });
  }
  for (let m = -3; m <= 3; m++) {
    addPart(new THREE.BoxGeometry(0.055, 0.42, 0.09), matCabinClean, 9, {
      pos: [m * 0.41, 4.66, 2.435],
      castShadow: false,
      writeGBuffer: false,
    });
  }

  // Crisp Overhanging Bridge Brow Visor & Compass Roof Deck (y = 5.10)
  addPart(new THREE.BoxGeometry(3.42, 0.12, 2.86), matCabinClean, 9, {
    pos: [0, 5.10, 1.24],
  });
  addPart(new THREE.BoxGeometry(3.22, 0.07, 2.64), matDeck, 9, {
    pos: [0, 5.18, 1.18],
  });
  addRailingLoop(
    [
      [-1.58, 5.21, 2.48],
      [1.58, 5.21, 2.48],
      [1.58, 5.21, -0.10],
      [-1.58, 5.21, -0.10],
      [-1.58, 5.21, 2.48],
    ],
    0.28,
    true
  );

  // =========================================================================
  // 6. SLEEK CHAMFERED FUNNEL, FORWARD RADAR MAST & NON-CLIPPING LATTICE MAST
  // =========================================================================
  const funnelGroup = new THREE.Group();
  funnelGroup.position.set(0, 4.62, -0.78);
  funnelGroup.rotation.x = -0.11;
  shipBody.add(funnelGroup);

  // Sleeker chamfered polar smokestack (white weathered lower trunk + crisp charcoal crown!)
  const funnelBaseGeo = createChamferedBoxGeometry(0.96, 1.48, 1.28, 0.22);
  addPart(funnelBaseGeo, matFunnelBody, 10, {
    parent: funnelGroup,
    pos: [0, 0.74, 0],
  });
  // Charcoal-navy upper funnel crown
  const funnelTopGeo = createChamferedBoxGeometry(0.90, 0.90, 1.20, 0.20);
  addPart(funnelTopGeo, matFunnelDark, 10, {
    parent: funnelGroup,
    pos: [0, 1.92, 0],
  });
  // Twin dark exhaust uptakes & small steam vent pipe
  for (const s of [1, -1]) {
    addPart(new THREE.CylinderGeometry(0.12, 0.14, 0.34, 10), matFunnelDark, 10, {
      parent: funnelGroup,
      pos: [s * 0.22, 2.50, -0.04],
    });
  }
  addPart(new THREE.CylinderGeometry(0.04, 0.04, 0.44, 6), matMetalDark, 10, {
    parent: funnelGroup,
    pos: [0, 2.48, 0.28],
  });

  // Forward Main Mast (mounted cleanly on bridge compass roof!)
  const mainMastZ = 1.26;
  addPart(new THREE.BoxGeometry(0.50, 0.32, 0.56), matCabinClean, 15, {
    pos: [0, 5.36, mainMastZ],
  });
  addPart(new THREE.CylinderGeometry(0.085, 0.19, 3.55, 10), matCabinClean, 15, {
    pos: [0, 7.26, mainMastZ - 0.12],
    rot: [-0.07, 0, 0],
  });
  // Compact radar platform
  addPart(new THREE.BoxGeometry(0.76, 0.08, 0.48), matDeck, 15, {
    pos: [0, 6.42, mainMastZ + 0.12],
  });

  // Rotating X-Band Radar Scanner
  const radarSpinner = new THREE.Group();
  radarSpinner.position.set(0, 6.56, mainMastZ + 0.16);
  shipBody.add(radarSpinner);
  addPart(new THREE.CylinderGeometry(0.07, 0.09, 0.18, 8), matMetalDark, 15, {
    parent: radarSpinner,
  });
  addPart(new THREE.BoxGeometry(1.24, 0.10, 0.13), matCabinClean, 15, {
    parent: radarSpinner,
    pos: [0, 0.12, 0],
  });

  // Iconic White SATCOM Radome Sphere perched on side bracket + secondary dome on bridge roof
  addPart(new THREE.BoxGeometry(0.42, 0.08, 0.11), matCabinClean, 15, {
    pos: [0.30, 7.06, mainMastZ + 0.14],
  });
  addPart(new THREE.SphereGeometry(0.28, 14, 12), matCabinClean, 15, {
    pos: [0.54, 7.30, mainMastZ + 0.14],
  });
  addPart(new THREE.SphereGeometry(0.20, 12, 10), matCabinClean, 15, {
    pos: [-0.94, 5.40, 0.72],
  });

  // Main Mast Horizontal Yardarms & Masthead Spire
  addPart(new THREE.CylinderGeometry(0.038, 0.038, 2.08, 8), matCabinClean, 15, {
    pos: [0, 7.66, mainMastZ - 0.14],
    rot: [0, 0, Math.PI / 2],
  });
  addPart(new THREE.CylinderGeometry(0.028, 0.028, 1.24, 8), matCabinClean, 15, {
    pos: [0, 8.48, mainMastZ - 0.20],
    rot: [0, 0, Math.PI / 2],
  });
  addPart(new THREE.CylinderGeometry(0.018, 0.036, 1.12, 6), matInkLine, 15, {
    pos: [0, 9.54, mainMastZ - 0.24],
    writeGBuffer: false,
  });

  // Taut signal halyards & forward stay
  pushLine(-1.00, 7.66, mainMastZ - 0.14, -1.48, 5.22, mainMastZ + 0.30);
  pushLine(1.00, 7.66, mainMastZ - 0.14, 1.48, 5.22, mainMastZ + 0.30);
  pushLine(0, 8.94, mainMastZ - 0.22, 0, 5.22, 2.38);

  // Aft Slender Steel Lattice / Truss Mast (seated CLEANLY atop aft funnel deckhouse roof — ZERO helideck clipping!)
  const latZ = -1.72;
  const latY0 = 4.78;
  const latY1 = 10.12;
  // Compact square mast foot pedestal on aft funnel deckhouse
  addPart(new THREE.BoxGeometry(0.84, 0.14, 0.66), matDeck, 8, {
    pos: [0, latY0, latZ],
  });
  const latCorners = [
    [-0.36, -0.26],
    [0.36, -0.26],
    [0.36, 0.26],
    [-0.36, 0.26],
  ];
  const latTopScale = 0.24;
  const latTiers = 6;

  for (let c = 0; c < 4; c++) {
    const [bx, bz] = latCorners[c];
    const tx = bx * latTopScale;
    const tz = bz * latTopScale;
    const p0 = new THREE.Vector3(bx, latY0 + 0.05, latZ + bz);
    const p1 = new THREE.Vector3(tx, latY1, latZ + tz);
    const dir = p1.clone().sub(p0);
    const len = dir.length();
    const mid = p0.clone().add(p1).multiplyScalar(0.5);
    const legGeo = new THREE.CylinderGeometry(0.026, 0.040, len, 6);
    const legMesh = new THREE.Mesh(legGeo, matInkLine);
    legMesh.position.copy(mid);
    legMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    legMesh.castShadow = true;
    legMesh.userData.beautyMaterial = matInkLine;
    legMesh.userData.writeGBuffer = false;
    shipBody.add(legMesh);
  }
  for (let t = 0; t < latTiers; t++) {
    const f0 = t / latTiers;
    const f1 = (t + 1) / latTiers;
    const y0 = latY0 + 0.05 + (latY1 - latY0 - 0.05) * f0;
    const y1 = latY0 + 0.05 + (latY1 - latY0 - 0.05) * f1;
    const s0 = 1 - (1 - latTopScale) * f0;
    const s1 = 1 - (1 - latTopScale) * f1;
    for (let c = 0; c < 4; c++) {
      const next = (c + 1) % 4;
      const a0 = [latCorners[c][0] * s0, y0, latZ + latCorners[c][1] * s0];
      const b0 = [latCorners[next][0] * s0, y0, latZ + latCorners[next][1] * s0];
      const a1 = [latCorners[c][0] * s1, y1, latZ + latCorners[c][1] * s1];
      const b1 = [latCorners[next][0] * s1, y1, latZ + latCorners[next][1] * s1];
      pushLine(a1[0], a1[1], a1[2], b1[0], b1[1], b1[2]);
      pushLine(a0[0], a0[1], a0[2], b1[0], b1[1], b1[2]);
      pushLine(b0[0], b0[1], b0[2], a1[0], a1[1], a1[2]);
    }
  }
  addPart(new THREE.CylinderGeometry(0.026, 0.026, 1.44, 6), matInkLine, 15, {
    pos: [0, 8.95, latZ],
    rot: [0, 0, Math.PI / 2],
    writeGBuffer: false,
  });
  addPart(new THREE.CylinderGeometry(0.018, 0.028, 1.05, 6), matInkLine, 15, {
    pos: [0, 10.60, latZ],
    writeGBuffer: false,
  });
  // Inter-mast aerial wire
  pushLine(0, 8.52, mainMastZ - 0.20, 0, 8.95, latZ);

  // =========================================================================
  // 7. PROMINENT CHAMFERED HELIDECK, HANGAR BAY & STEPPED STERN WORKING DECK
  // =========================================================================
  // Aft Hangar / Helideck Plinth (z = -5.74 .. -1.92, y = 1.48 .. 2.74)
  addPart(new THREE.BoxGeometry(3.84, 1.26, 3.82), matCabin, 13, {
    pos: [0, 2.11, -3.83],
  });

  // Chamfered Architectural Helideck Landing Platform (matches iconic chamfered-apron silhouette!)
  const helideckSlabGeo = createChamferedBoxGeometry(4.24, 0.14, 3.86, 0.42);
  addPart(helideckSlabGeo, matHelideck, 13, {
    pos: [0, 2.81, -3.86],
  });

  // Aft-Facing Helicopter Hangar Roll-Up Bay Door & Deck Floodlights (set into superstructure aft wall)
  addPart(new THREE.BoxGeometry(2.04, 1.02, 0.08), matMetalDark, 7, {
    pos: [0, 3.36, -1.94],
    castShadow: false,
    writeGBuffer: false,
  });
  // Horizontal hangar roller-shutter ribs
  for (let r = 0; r < 5; r++) {
    const ry = 2.96 + r * 0.18;
    pushLine(-0.98, ry, -1.99, 0.98, ry, -1.99);
  }
  // Twin compact helideck perimeter floodlights / fire-monitor housings
  for (const s of [1, -1]) {
    addPart(new THREE.BoxGeometry(0.18, 0.16, 0.18), matCabinClean, 14, {
      pos: [s * 1.44, 3.74, -2.02],
      castShadow: false,
    });
  }

  // Under-deck cantilevered support brackets along helideck overhang
  for (const s of [1, -1]) {
    for (const bz of [-2.42, -3.38, -4.34, -5.24]) {
      addPart(new THREE.BoxGeometry(0.20, 0.22, 0.10), matCabinClean, 13, {
        pos: [s * 2.02, 2.65, bz],
        rot: [0, 0, s * 0.48],
        castShadow: false,
      });
    }
  }

  // Properly Anchored Angled Perimeter Safety-Netting Frame around Helideck (ZERO floating lines!)
  const netRimPts = [
    [-2.12, 2.85, -2.02],
    [-2.12, 2.85, -5.36],
    [-1.70, 2.85, -5.78],
    [1.70, 2.85, -5.78],
    [2.12, 2.85, -5.36],
    [2.12, 2.85, -2.02],
  ];
  const netOutPts = [
    [-2.34, 2.75, -2.02],
    [-2.34, 2.75, -5.45],
    [-1.80, 2.75, -6.00],
    [1.80, 2.75, -6.00],
    [2.34, 2.75, -5.45],
    [2.34, 2.75, -2.02],
  ];
  for (let i = 0; i < netRimPts.length - 1; i++) {
    const a0 = netRimPts[i];
    const b0 = netRimPts[i + 1];
    const a1 = netOutPts[i];
    const b1 = netOutPts[i + 1];
    // Outer perimeter tube & mid-net longitudinal wire
    pushLine(a1[0], a1[1], a1[2], b1[0], b1[1], b1[2]);
    pushLine(
      (a0[0] + a1[0]) * 0.5, (a0[1] + a1[1]) * 0.5, (a0[2] + a1[2]) * 0.5,
      (b0[0] + b1[0]) * 0.5, (b0[1] + b1[1]) * 0.5, (b0[2] + b1[2]) * 0.5
    );
    // Anchored outrigger cross-struts connecting deck rim directly to outer safety frame
    const dist = Math.hypot(b0[0] - a0[0], b0[2] - a0[2]);
    const struts = Math.max(2, Math.round(dist / 0.72));
    for (let k = 0; k <= struts; k++) {
      const t = k / struts;
      pushLine(
        a0[0] + (b0[0] - a0[0]) * t,
        a0[1] + (b0[1] - a0[1]) * t,
        a0[2] + (b0[2] - a0[2]) * t,
        a1[0] + (b1[0] - a1[0]) * t,
        a1[1] + (b1[1] - a1[1]) * t,
        a1[2] + (b1[2] - a1[2]) * t
      );
    }
  }

  // Hangar side access doors & service portholes
  for (const s of [1, -1]) {
    addPart(new THREE.BoxGeometry(0.07, 0.76, 0.50), matMetalDark, 13, {
      pos: [s * 1.93, 1.96, -3.02],
      castShadow: false,
      writeGBuffer: false,
    });
    for (let p = 0; p < 2; p++) {
      addPart(new THREE.BoxGeometry(0.06, 0.22, 0.24), matWindow, 13, {
        pos: [s * 1.93, 2.30, -4.05 - p * 0.62],
        castShadow: false,
        writeGBuffer: false,
      });
    }
  }

  // Access companionway steps connecting helideck down to stern working deck (port aft corner)
  addPart(new THREE.BoxGeometry(0.56, 0.54, 0.44), matDeck, 13, {
    pos: [-1.36, 2.34, -5.96],
  });

  // Stepped Aft Stern Working Deck (z = -8.62 .. -5.74, graceful low icebreaker transom!)
  addPart(new THREE.BoxGeometry(3.48, 0.52, 2.46), matForedeck, 13, {
    pos: [0, 1.77, -7.02],
  });
  // Aft deck scientific container hatch & oceanographic winch drum
  addPart(new THREE.BoxGeometry(1.12, 0.34, 0.90), matCabin, 14, {
    pos: [-0.74, 2.19, -7.05],
  });
  addPart(new THREE.BoxGeometry(0.84, 0.38, 0.66), matMetalDark, 14, {
    pos: [0.58, 2.21, -7.42],
  });
  // Stern terrace railing
  addRailingLoop(
    [
      [-1.72, 2.04, -5.82],
      [-1.72, 2.04, -8.22],
      [1.72, 2.04, -8.22],
      [1.72, 2.04, -5.82],
    ],
    0.28,
    true
  );

  // Compact Stowed Hydraulic Deck Crane mounted cleanly on STERN WORKING DECK (ZERO helideck overlap!)
  addPart(new THREE.CylinderGeometry(0.16, 0.20, 0.66, 10), matCabinClean, 14, {
    pos: [1.32, 2.35, -6.58],
  });
  // Boom stowed cleanly aft along stern deck rail (pointing toward -Z stern, completely clear of helideck!)
  addPart(new THREE.BoxGeometry(0.20, 0.20, 1.24), matCabinClean, 14, {
    pos: [1.32, 2.66, -7.08],
    rot: [-0.08, 0, 0],
  });
  addPart(new THREE.BoxGeometry(0.14, 0.14, 0.86), matMetalDark, 14, {
    pos: [1.32, 2.60, -7.52],
    rot: [0.12, 0, 0],
  });

  // Stern mooring bollards & towing notch detail
  for (const s of [1, -1]) {
    addPart(new THREE.CylinderGeometry(0.085, 0.095, 0.23, 8), matMetalDark, 14, {
      pos: [s * 1.16, 1.67, -8.42],
    });
  }

  // Animated Rudder Blade below stern
  const rudderMesh = addPart(new THREE.BoxGeometry(0.14, 0.72, 0.95), matHullBluePlain, 5, {
    pos: [0, -0.35, -8.55],
    castShadow: false,
  });

  // Finalize all crisp Beauty-only architectural ink lines into a single draw call
  const inkLineGeo = new THREE.BufferGeometry();
  inkLineGeo.setAttribute('position', new THREE.Float32BufferAttribute(inkSegments, 3));
  const inkLineMat = new THREE.LineBasicMaterial({
    color: new THREE.Color(PALETTE.ink),
    transparent: true,
    opacity: 0.92,
  });
  const inkLines = new THREE.LineSegments(inkLineGeo, inkLineMat);
  inkLines.userData.beautyMaterial = inkLineMat;
  inkLines.userData.writeGBuffer = false;
  shipBody.add(inkLines);

  const gbufEntries = [];
  shipBody.traverse((obj) => {
    if (obj.isMesh || obj.isLineSegments) {
      gbufEntries.push(obj);
    }
  });

  return {
    root,
    shipBody,
    gbufEntries,
    update(dt, physics) {
      const h = physics.renderHeave ?? physics.heave;
      const r = physics.renderRoll ?? physics.roll;
      const p = physics.renderPitch ?? physics.pitch;
      root.position.set(physics.x, h, physics.z);
      root.rotation.y = physics.heading;
      shipBody.rotation.z = r;
      shipBody.rotation.x = p;
      radarSpinner.rotation.y += dt * 2.15;
      rudderMesh.rotation.y = -physics.rudder * 0.55;
    },
  };
}
