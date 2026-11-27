import * as THREE from 'three';
import { PALETTE, SUN_DIRECTION } from '../palette.js';
import { createIceSheetMaterial } from '../shaders/iceSheetShader.js';
import { createWaterMaterial } from '../shaders/waterShader.js';
import { createWakeWaveMaterial } from '../shaders/wakeShader.js';
import { createGBufferMaterial } from '../shaders/celMaterials.js';
import { hullHalfBeamAt } from './icebreaker.js';

function seededRand(seed) {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

/**
 * Shared single-source-of-truth bow-pocket contour anchored to the farthest broken ice front
 * (`this.carvedHead`). Used identically by:
 * 1) Stencil open-water cutout & 3D vertical ice-shelf wall
 * 2) Exact ship bow / shoulder ice-contact collision probes
 * 3) Rigid-body shattered ice chunk bank-containment
 */
const POCKET_ANCHOR_Z = -2.2; // Longitudinal offset of last spine node behind carvedHead center
const POCKET_BASE_WL = 4.62;  // Port channel half-width where spine meets the fractured bow pocket
const POCKET_BASE_WR = 4.46;  // Starboard channel half-width where spine meets the fractured bow pocket
const POCKET_SLICES = [
  { z: -0.2, wL: 4.82, wR: 4.30 }, // Crisp asymmetric polygonal fracture facet beside midship
  { z:  2.2, wL: 4.24, wR: 4.72 }, // Opposing angular jagged ice-shelf tooth
  { z:  4.3, wL: 3.96, wR: 3.56 }, // Bold fractured bow-shoulder ledge
  { z:  6.1, wL: 3.16, wR: 3.42 }, // Outer cracked bow pocket facet
  { z:  7.5, wL: 2.52, wR: 2.24 }, // Immediate post-stem fracture split
  { z:  8.45, wL: 1.38, wR: 1.50 },
  { z:  8.92, wL: 0.38, wR: 0.38 }, // Tight crisp bow-stem bite into solid white ice
];
const POCKET_TIP_Z = POCKET_SLICES[POCKET_SLICES.length - 1].z;

function pocketHalfWidthsAt(lz) {
  if (lz < POCKET_ANCHOR_Z || lz > POCKET_TIP_Z) return null;
  if (lz <= POCKET_SLICES[0].z) {
    const t = (lz - POCKET_ANCHOR_Z) / Math.max(1e-4, POCKET_SLICES[0].z - POCKET_ANCHOR_Z);
    return {
      wL: POCKET_BASE_WL + (POCKET_SLICES[0].wL - POCKET_BASE_WL) * t,
      wR: POCKET_BASE_WR + (POCKET_SLICES[0].wR - POCKET_BASE_WR) * t,
    };
  }
  for (let i = 0; i < POCKET_SLICES.length - 1; i++) {
    const a = POCKET_SLICES[i];
    const b = POCKET_SLICES[i + 1];
    if (lz <= b.z) {
      const t = (lz - a.z) / Math.max(1e-4, b.z - a.z);
      return {
        wL: a.wL + (b.wL - a.wL) * t,
        wR: a.wR + (b.wR - a.wR) * t,
      };
    }
  }
  const last = POCKET_SLICES[POCKET_SLICES.length - 1];
  return { wL: last.wL, wR: last.wR };
}

/**
 * Andrew's monotone chain 2D convex hull returning CCW vertices [[x, z], ...].
 */
function convexHull2D(points) {
  const pts = points.slice().sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));
  if (pts.length <= 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/**
 * Four distinct, strictly convex, crisp angular Ligne Claire broken-ice slab templates
 * (wedges, cracked plates, architectural trapezoids, sharp splinters — zero round pebbles!).
 */
const FLOE_TEMPLATES = [
  // 0: Sharp elongated 5-sided fractured wedge slab
  [[-1.18, -0.30], [-0.32, -0.74], [1.04, -0.40], [1.14, 0.32], [-0.54, 0.68]],
  // 1: Broad angular 5-sided cracked ice plate
  [[-0.96, -0.56], [0.22, -0.86], [1.06, -0.22], [0.76, 0.74], [-0.74, 0.72]],
  // 2: Bold architectural 4-sided trapezoidal ice block
  [[-1.22, -0.42], [0.88, -0.62], [1.20, 0.36], [-0.76, 0.66]],
  // 3: Jagged 5-sided angular splinter shard
  [[-1.12, -0.16], [-0.16, -0.74], [1.16, -0.26], [0.64, 0.62], [-0.68, 0.56]],
];

/**
 * Custom beveled angular polygonal 3D ice slab geometry + exact inflated 2D XZ convex hull
 * (matches Three.js rendered vertices bit-for-bit for exact 2D SAT zero-clipping collision!).
 */
function createIceFloeGeometry(templateIdx) {
  const pts = FLOE_TEMPLATES[templateIdx % FLOE_TEMPLATES.length];
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    shape.lineTo(pts[i][0], pts[i][1]);
  }
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.16,
    bevelEnabled: true,
    bevelThickness: 0.025,
    bevelSize: 0.03,
    bevelSegments: 1,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -0.04, 0);
  geo.computeVertexNormals();

  // Extract exact 2D XZ convex hull of the final beveled mesh and inflate slightly for tilt safety
  const pAttr = geo.attributes.position;
  const raw2D = [];
  for (let v = 0; v < pAttr.count; v++) {
    raw2D.push([pAttr.getX(v), pAttr.getZ(v)]);
  }
  const hull = convexHull2D(raw2D);
  let cx = 0;
  let cz = 0;
  for (const h of hull) {
    cx += h[0];
    cz += h[1];
  }
  cx /= hull.length;
  cz /= hull.length;

  let maxR = 0;
  const inflatedHull = hull.map(([x, z]) => {
    const dx = x - cx;
    const dz = z - cz;
    const len = Math.hypot(dx, dz) || 1;
    const ix = x + (dx / len) * 0.025;
    const iz = z + (dz / len) * 0.025;
    const r = Math.hypot(ix, iz);
    if (r > maxR) maxR = r;
    return [ix, iz];
  });

  return { geo, hull: inflatedHull, maxR };
}

/**
 * Exact 2D Separating Axis Theorem (SAT) collision test between two convex ice-slab polygons.
 * Returns null if separated by >= gapMargin, or { ov, nx, nz } pushing B away from A.
 */
function satTestPolys(a, b, gapMargin) {
  const ax = a._wx;
  const az = a._wz;
  const an = a._vn;
  const bx = b._wx;
  const bz = b._wz;
  const bn = b._vn;

  let minOv = 1e9;
  let bestNx = 1;
  let bestNz = 0;

  // Test edge normals of polygon A then polygon B
  for (let pass = 0; pass < 2; pass++) {
    const px = pass === 0 ? ax : bx;
    const pz = pass === 0 ? az : bz;
    const pn = pass === 0 ? an : bn;

    for (let i = 0; i < pn; i++) {
      const next = (i + 1) % pn;
      const ex = px[next] - px[i];
      const ez = pz[next] - pz[i];
      const len = Math.hypot(ex, ez);
      if (len < 1e-6) continue;
      const nx = -ez / len;
      const nz = ex / len;

      let minA = 1e9;
      let maxA = -1e9;
      for (let k = 0; k < an; k++) {
        const p = ax[k] * nx + az[k] * nz;
        if (p < minA) minA = p;
        if (p > maxA) maxA = p;
      }

      let minB = 1e9;
      let maxB = -1e9;
      for (let k = 0; k < bn; k++) {
        const p = bx[k] * nx + bz[k] * nz;
        if (p < minB) minB = p;
        if (p > maxB) maxB = p;
      }

      const ov = Math.min(maxA, maxB) - Math.max(minA, minB) + gapMargin;
      if (ov <= 0) return null; // Strictly separated!
      if (ov < minOv) {
        minOv = ov;
        bestNx = nx;
        bestNz = nz;
      }
    }
  }

  // Orient normal consistently from A center toward B center
  const dcx = b.x - a.x;
  const dcz = b.z - a.z;
  if (dcx * bestNx + dcz * bestNz < 0) {
    bestNx = -bestNx;
    bestNz = -bestNz;
  }

  return { ov: minOv, nx: bestNx, nz: bestNz };
}

/**
 * Custom Instanced Cel Material specifically for 3D floating ice floes:
 * - Top flat face (N.y > 0.65) -> crisp snow white (#f3f5f6) / cobalt cast shadow (#6283ab)
 * - Side bevel wall (N.y <= 0.65) -> cool ice-edge thickness (#97aec4 lit / #6884a3 shadow)
 */
function createFloeCelMaterial() {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.lights,
    {
      uTopLit: { value: new THREE.Color(PALETTE.snowLit) },
      uTopShadow: { value: new THREE.Color(PALETTE.snowShadow) },
      uSideLit: { value: new THREE.Color(PALETTE.snowEdgeShade) },
      uSideShadow: { value: new THREE.Color(PALETTE.snowEdgeDark) },
      uSunDir: { value: SUN_DIRECTION.clone() },
    },
  ]);

  return new THREE.ShaderMaterial({
    uniforms,
    lights: true,
    vertexShader: /* glsl */ `
      #include <common>
      #include <shadowmap_pars_vertex>

      varying vec3 vWorldNormal;

      void main() {
        vec3 transformed = vec3(position);
        vec3 objectNormal = vec3(normal);

        #ifdef USE_INSTANCING
          mat4 instWorld = modelMatrix * instanceMatrix;
          vec4 worldPosition = instWorld * vec4(transformed, 1.0);
          vec3 transformedNormal = normalize(mat3(viewMatrix * instWorld) * objectNormal);
          vWorldNormal = normalize(mat3(instWorld) * objectNormal);
        #else
          vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
          vec3 transformedNormal = normalize(normalMatrix * objectNormal);
          vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
        #endif

        #include <shadowmap_vertex>

        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <packing>
      #include <lights_pars_begin>
      #include <shadowmap_pars_fragment>

      uniform vec3 uTopLit;
      uniform vec3 uTopShadow;
      uniform vec3 uSideLit;
      uniform vec3 uSideShadow;
      uniform vec3 uSunDir;

      varying vec3 vWorldNormal;

      void main() {
        vec3 N = normalize(vWorldNormal);
        vec3 L = normalize(uSunDir);
        float ndl = dot(N, L);

        float isTop = smoothstep(0.55, 0.75, N.y);
        float celLit = smoothstep(0.02, 0.09, ndl);

        float castShadow = 1.0;
        #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
          float raw = getShadow(
            directionalShadowMap[0],
            directionalLightShadows[0].shadowMapSize,
            directionalLightShadows[0].shadowIntensity,
            directionalLightShadows[0].shadowBias,
            directionalLightShadows[0].shadowRadius,
            vDirectionalShadowCoord[0]
          );
          castShadow = smoothstep(0.36, 0.62, raw);
        #endif

        float lit = min(celLit, castShadow);
        vec3 topCol = mix(uTopShadow, uTopLit, castShadow);
        vec3 sideCol = mix(uSideShadow, uSideLit, lit);
        vec3 col = mix(sideCol, topCol, isTop);

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

/**
 * Dynamic Polar Ice World:
 * - Infinite cold-press paper snow sheet with stipple clusters & cobalt cast shadows
 * - Vector-sharp stencil-punched dark Prussian navy open sea channel with persistent carved bow pocket
 * - 3D beveled ice shelf walls along jagged channel banks & bow pocket
 * - Sweeping curved & radial polygonal ink fracture crack network
 * - Unified non-overlapping 2D rigid-body 3D beveled shattered ice chunks & channel floes
 * - High-resolution 3D undulating Kelvin wake & restrained polar water reflections
 */
export class IceWorld {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'IceWorld';

    // Trail nodes storing the live carved channel spine
    this.maxNodes = 230;
    this.nodeSpacing = 2.25;
    this.nodes = [];
    this.nodeCounter = 0;

    // Persistent world-space pose of the farthest broken bow frontier (never re-freezes on reverse!)
    this.carvedHead = { x: 0, z: 0, heading: 0 };

    // 1. Stencil Cutout Mesh (invisible, writes stencil = 1 for open water channel)
    this.maxCutoutVerts = (this.maxNodes + 32) * 6;
    this.cutoutGeo = new THREE.BufferGeometry();
    this.cutoutPos = new Float32Array(this.maxCutoutVerts * 3);
    this.cutoutGeo.setAttribute('position', new THREE.BufferAttribute(this.cutoutPos, 3));
    this.cutoutGeo.setDrawRange(0, 0);

    this.cutoutMat = new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      stencilWrite: true,
      stencilFunc: THREE.AlwaysStencilFunc,
      stencilRef: 1,
      stencilZPass: THREE.ReplaceStencilOp,
      stencilFail: THREE.ReplaceStencilOp,
      stencilZFail: THREE.ReplaceStencilOp,
    });
    this.cutoutMesh = new THREE.Mesh(this.cutoutGeo, this.cutoutMat);
    this.cutoutMesh.frustumCulled = false;
    this.cutoutMesh.renderOrder = 1;
    this.cutoutMesh.userData.beautyMaterial = this.cutoutMat;
    this.cutoutMesh.userData.gbufMaterial = this.cutoutMat;
    this.cutoutMesh.userData.writeGBuffer = true;
    this.group.add(this.cutoutMesh);

    // 2. Open Arctic Sea Water Plane (y = 0.0, stencil == 1)
    const waterGeo = new THREE.PlaneGeometry(920, 920);
    waterGeo.rotateX(-Math.PI / 2);
    this.waterMat = createWaterMaterial();
    this.waterGbufMat = createGBufferMaterial({
      partId: 2,
      stencilWrite: true,
      stencilWriteMask: 0x00,
      stencilFunc: THREE.EqualStencilFunc,
      stencilRef: 1,
      stencilFail: THREE.KeepStencilOp,
      stencilZFail: THREE.KeepStencilOp,
      stencilZPass: THREE.KeepStencilOp,
    });
    this.waterMesh = new THREE.Mesh(waterGeo, this.waterMat);
    this.waterMesh.position.y = 0.0;
    this.waterMesh.renderOrder = 2;
    this.waterMesh.receiveShadow = true;
    this.waterMesh.userData.beautyMaterial = this.waterMat;
    this.waterMesh.userData.gbufMaterial = this.waterGbufMat;
    this.waterMesh.userData.writeGBuffer = true;
    this.group.add(this.waterMesh);

    // 3. Infinite Cold-Press Paper Snow Sheet (y = 0.14, stencil == 0)
    const iceGeo = new THREE.PlaneGeometry(920, 920);
    iceGeo.rotateX(-Math.PI / 2);
    this.iceMat = createIceSheetMaterial();
    this.iceGbufMat = createGBufferMaterial({
      partId: 1,
      stencilWrite: true,
      stencilWriteMask: 0x00,
      stencilFunc: THREE.EqualStencilFunc,
      stencilRef: 0,
      stencilFail: THREE.KeepStencilOp,
      stencilZFail: THREE.KeepStencilOp,
      stencilZPass: THREE.KeepStencilOp,
    });
    this.iceMesh = new THREE.Mesh(iceGeo, this.iceMat);
    this.iceMesh.position.y = 0.14;
    this.iceMesh.renderOrder = 3;
    this.iceMesh.receiveShadow = true;
    this.iceMesh.userData.beautyMaterial = this.iceMat;
    this.iceMesh.userData.gbufMaterial = this.iceGbufMat;
    this.iceMesh.userData.writeGBuffer = true;
    this.group.add(this.iceMesh);

    // 4. 3D Broken Ice Shelf Edge Skirt (vertical 0.14m slab wall along jagged banks & bow pocket)
    this.maxEdgeVerts = (this.maxNodes + 24) * 12;
    this.edgeGeo = new THREE.BufferGeometry();
    this.edgePos = new Float32Array(this.maxEdgeVerts * 3);
    this.edgeNorm = new Float32Array(this.maxEdgeVerts * 3);
    this.edgeGeo.setAttribute('position', new THREE.BufferAttribute(this.edgePos, 3));
    this.edgeGeo.setAttribute('normal', new THREE.BufferAttribute(this.edgeNorm, 3));
    this.edgeGeo.setDrawRange(0, 0);
    this.edgeMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(PALETTE.snowEdgeShade),
      side: THREE.DoubleSide,
    });
    this.edgeMesh = new THREE.Mesh(this.edgeGeo, this.edgeMat);
    this.edgeMesh.frustumCulled = false;
    this.edgeMesh.renderOrder = 4;
    this.edgeMesh.userData.beautyMaterial = this.edgeMat;
    this.edgeMesh.userData.writeGBuffer = false;
    this.group.add(this.edgeMesh);

    // 5. Sweeping Curved & Radial Polygonal Ink Fracture Cracks (crisp quad ribbons, stencil == 0)
    this.maxCrackQuads = 3200;
    this.crackGeo = new THREE.BufferGeometry();
    this.crackPos = new Float32Array(this.maxCrackQuads * 6 * 3);
    this.crackGeo.setAttribute('position', new THREE.BufferAttribute(this.crackPos, 3));
    this.crackGeo.setDrawRange(0, 0);
    this.crackMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(PALETTE.ink),
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
      stencilWrite: true,
      stencilWriteMask: 0x00,
      stencilFunc: THREE.EqualStencilFunc,
      stencilRef: 0,
      stencilFail: THREE.KeepStencilOp,
      stencilZFail: THREE.KeepStencilOp,
      stencilZPass: THREE.KeepStencilOp,
    });
    this.crackMesh = new THREE.Mesh(this.crackGeo, this.crackMat);
    this.crackMesh.frustumCulled = false;
    this.crackMesh.renderOrder = 5;
    this.crackMesh.userData.beautyMaterial = this.crackMat;
    this.crackMesh.userData.writeGBuffer = false;
    this.group.add(this.crackMesh);

    // 6. Floating 3D Beveled Angular Ice Slabs & Shattered Splinters (4 distinct convex InstancedMeshes!)
    this.floeMat = createFloeCelMaterial();
    this.floeGbufMat = createGBufferMaterial({ useInstanceId: true });
    this.floePools = [];
    this.shapeHulls = []; // Exact inflated 2D XZ convex hull vertices per shape for zero-clipping SAT!
    this.shapeRadii = []; // Broadphase outer circumradius per shape
    this.maxFloesPerShape = 220;
    for (let shapeIdx = 0; shapeIdx < FLOE_TEMPLATES.length; shapeIdx++) {
      const { geo, hull, maxR } = createIceFloeGeometry(shapeIdx);
      this.shapeHulls.push(hull);
      this.shapeRadii.push(maxR);

      const ids = new Float32Array(this.maxFloesPerShape);
      for (let i = 0; i < this.maxFloesPerShape; i++) {
        ids[i] = 30 + ((shapeIdx * 53 + i) % 205);
      }
      geo.setAttribute('aPartId', new THREE.InstancedBufferAttribute(ids, 1));
      const inst = new THREE.InstancedMesh(geo, this.floeMat, this.maxFloesPerShape);
      inst.count = 0;
      inst.frustumCulled = false;
      inst.receiveShadow = true;
      inst.castShadow = false;
      inst.renderOrder = 6;
      inst.userData.beautyMaterial = this.floeMat;
      inst.userData.gbufMaterial = this.floeGbufMat;
      inst.userData.writeGBuffer = true;
      this.group.add(inst);
      this.floePools.push(inst);
    }

    // Single unified array of non-overlapping rigid-body shattered ice chunks & channel floes
    this.floes = [];
    this._floeGrid = new Map();
    this._dummy = new THREE.Object3D();
    this._shardSeedCounter = 1;
    this._calveAccum = 0;
    this._calveSide = 1;
    this._prevCarvedPos = { x: 0, z: 0 };

    // 7. High-Resolution 3D Undulating Kelvin Wake Wave, Reflection & Propeller Foam Surface
    this.foamSegs = 116;
    this.foamAcross = 28;
    this.wakeBowStart = -16.5;
    this.wakeAftLength = 64.0;
    const foamVerts = (this.foamSegs + 1) * (this.foamAcross + 1);
    this.foamGeo = new THREE.BufferGeometry();
    this.foamPos = new Float32Array(foamVerts * 3);
    this.foamWakeCoord = new Float32Array(foamVerts * 4);
    this.foamFrame = new Float32Array(foamVerts * 4);
    const foamIndices = [];
    const cols = this.foamAcross + 1;
    for (let i = 0; i < this.foamSegs; i++) {
      for (let j = 0; j < this.foamAcross; j++) {
        const a = i * cols + j;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        foamIndices.push(a, c, b, b, c, d);
      }
    }
    this.foamGeo.setAttribute('position', new THREE.BufferAttribute(this.foamPos, 3));
    this.foamGeo.setAttribute('aWakeCoord', new THREE.BufferAttribute(this.foamWakeCoord, 4));
    this.foamGeo.setAttribute('aFrame', new THREE.BufferAttribute(this.foamFrame, 4));
    this.foamGeo.setIndex(foamIndices);
    this.foamMat = createWakeWaveMaterial();
    this.foamMat.uniforms.uWakeLength.value = this.wakeAftLength;
    this.foamMesh = new THREE.Mesh(this.foamGeo, this.foamMat);
    this.foamMesh.frustumCulled = false;
    this.foamMesh.receiveShadow = true;
    this.foamMesh.renderOrder = 7;
    this.foamMesh.userData.beautyMaterial = this.foamMat;
    this.foamMesh.userData.writeGBuffer = false;
    this.group.add(this.foamMesh);
    this._wakeSpineSamples = [];

    this.gbufEntries = [
      this.cutoutMesh,
      this.waterMesh,
      this.iceMesh,
      this.edgeMesh,
      this.crackMesh,
      ...this.floePools,
      this.foamMesh,
    ];

    this._time = 0;
    this.fractureLagNodes = 4;
    this.crackSegments = [];
    this.crackSideState = { 1: null, '-1': null };
    this.crackLastAnchor = { 1: null, '-1': null };
    this._lastCrackedNodeId = -1;
    this._cracksDirty = true;
    this._hasGrowingCracks = false;
    this.reset(0, 0, 0);
  }

  /**
   * Computes exact tapered effective left/right half-width of spine node `idx`
   * so channel mesh, contact queries, and floe containment use identical geometry.
   */
  _getNodeEffectiveWidths(idx) {
    const nCount = this.nodes.length;
    const nd = this.nodes[idx];
    const endT = Math.min(1, (nCount - 1 - idx) / 2.5);
    return {
      leftW: THREE.MathUtils.lerp(POCKET_BASE_WL, nd.leftW, endT),
      rightW: THREE.MathUtils.lerp(POCKET_BASE_WR, nd.rightW, endT),
    };
  }

  /**
   * Resets the ice sheet and pre-carves the iconic initial wake trail & fracture network
   * extending behind the ship toward -Z (upper-right in the Illustration Camera!).
   */
  reset(shipX = 0, shipZ = 0, heading = 0) {
    this.nodes = [];
    this.floes = [];
    this.nodeCounter = 0;
    this._shardSeedCounter = 1;
    this.crackSegments = [];
    this.crackSideState = { 1: null, '-1': null };
    this.crackLastAnchor = { 1: null, '-1': null };
    this._lastCrackedNodeId = -1;
    this._cracksDirty = true;
    this._hasGrowingCracks = false;

    this.carvedHead = { x: shipX, z: shipZ, heading };
    this._calveAccum = 0;
    this._calveSide = 1;
    this._prevCarvedPos = { x: shipX, z: shipZ };

    // Pre-populate ~175m of gently organic broken channel up to z = -2.0 (POCKET_ANCHOR_Z)
    const preCount = 76;
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const rx = Math.cos(heading);
    const rz = -Math.sin(heading);

    for (let i = preCount; i >= 0; i--) {
      const distBack = i * this.nodeSpacing - POCKET_ANCHOR_Z;
      const curveFactor = Math.max(0, (distBack - 16) / 140);
      const lateralSway = Math.sin(distBack * 0.028) * 3.8 * curveFactor - curveFactor * curveFactor * 6.5;

      const nx = shipX - fx * distBack + rx * lateralSway;
      const nz = shipZ - fz * distBack + rz * lateralSway;

      const nextDist = Math.max(-POCKET_ANCHOR_Z, (i - 1) * this.nodeSpacing - POCKET_ANCHOR_Z);
      const nextCurve = Math.max(0, (nextDist - 16) / 140);
      const nextSway = Math.sin(nextDist * 0.028) * 3.8 * nextCurve - nextCurve * nextCurve * 6.5;
      const nnx = shipX - fx * nextDist + rx * nextSway;
      const nnz = shipZ - fz * nextDist + rz * nextSway;
      const segHeading = i === 0 ? heading : Math.atan2(nnx - nx, nnz - nz);

      this._appendNode(nx, nz, segHeading, true, shipX, shipZ, heading);
    }

    // Seed crisp, strictly non-overlapping freshly broken brash chunks alongside midship & forward hull flanks
    this._seedInitialFlankShards(shipX, shipZ, heading);

    this._rebuildChannelMeshes();
    this._advanceCracks(true);
    this._uploadCrackGeometry();
    this._updateFoamRibbon(shipX, shipZ, heading);

    // Warm-up rigid PBD separation passes so Frame 0 has literally 0 overlaps anywhere!
    this._resolveFloeCollisions(0, shipX, shipZ, heading, 0, 0, 10);
    this._updateFloeInstances(0, shipX, shipZ, heading, 0.35, 0);

    // Sync initial water & wake shader ship uniforms
    this.waterMat.uniforms.uShipPos.value.set(shipX, 0, shipZ);
    this.waterMat.uniforms.uShipForward.value.set(fx, fz);
    this.waterMat.uniforms.uShipRight.value.set(rx, rz);
    this.waterMat.uniforms.uShipSpeed.value = 0.35;
    this.foamMat.uniforms.uThrottle.value = 0.44;
    this.foamMat.uniforms.uSpeed.value = 0.35;
    this.foamMat.uniforms.uRudder.value = 0.0;
    this.foamMat.uniforms.uImpactPulse.value = 0.0;
  }

  /**
   * Exact geometric point-in-carved-water test matching the rendered stencil polygon
   * (spine segments + bridge + persistent carvedHead bow pocket).
   */
  _isPointInCarvedWater(px, pz, margin = 0) {
    // 1. Check persistent bow pocket around carvedHead
    const head = this.carvedHead;
    const hfx = Math.sin(head.heading);
    const hfz = Math.cos(head.heading);
    const hrx = Math.cos(head.heading);
    const hrz = -Math.sin(head.heading);
    const hdx = px - head.x;
    const hdz = pz - head.z;
    const hlz = hdx * hfx + hdz * hfz;
    if (hlz >= POCKET_ANCHOR_Z - 0.35 && hlz <= POCKET_TIP_Z - margin) {
      const pw = pocketHalfWidthsAt(Math.max(POCKET_ANCHOR_Z, hlz));
      if (pw) {
        const hlx = hdx * hrx + hdz * hrz;
        if (hlx >= -(pw.wR - margin) && hlx <= pw.wL - margin) return true;
      }
    }

    // 2. Check all carved spine ribbon segments with exact linearly interpolated bank widths
    const nCount = this.nodes.length;
    for (let i = nCount - 2; i >= 0; i--) {
      const a = this.nodes[i];
      const b = this.nodes[i + 1];
      const mx = (a.x + b.x) * 0.5;
      const mz = (a.z + b.z) * 0.5;
      const qdx = px - mx;
      const qdz = pz - mz;
      if (qdx * qdx + qdz * qdz > 88) continue;

      const sx = b.x - a.x;
      const sz = b.z - a.z;
      const lenSq = sx * sx + sz * sz;
      if (lenSq < 1e-5) continue;
      const t = ((px - a.x) * sx + (pz - a.z) * sz) / lenSq;
      if (t < -0.10 || t > 1.10) continue;
      const tc = THREE.MathUtils.clamp(t, 0, 1);

      const cx = a.x + sx * tc;
      const cz = a.z + sz * tc;
      let npx = a.px + (b.px - a.px) * tc;
      let npz = a.pz + (b.pz - a.pz) * tc;
      const nLen = Math.hypot(npx, npz) || 1;
      npx /= nLen;
      npz /= nLen;

      const wa = this._getNodeEffectiveWidths(i);
      const wb = this._getNodeEffectiveWidths(i + 1);
      const leftW = wa.leftW + (wb.leftW - wa.leftW) * tc;
      const rightW = wa.rightW + (wb.rightW - wa.rightW) * tc;

      const lat = (px - cx) * npx + (pz - cz) * npz;
      if (lat >= -(rightW - margin) && lat <= leftW - margin) {
        return true;
      }
    }
    return false;
  }

  /**
   * Probes bow stem & port/starboard bow shoulders directly against the exact carved channel
   * polygon + persistent bow pocket. Reversing even 0.5m pulls the bow cleanly into open water!
   */
  sampleIceContact(shipX, shipZ, heading) {
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const rx = Math.cos(heading);
    const rz = -Math.sin(heading);

    // 3 longitudinal stem probes give crisp, smooth bow-edge touch detection right at z ~ +8.92
    const bowP1 = this._isPointInCarvedWater(shipX + fx * 8.78, shipZ + fz * 8.78, 0.02) ? 0.0 : 1.0;
    const bowP2 = this._isPointInCarvedWater(shipX + fx * 8.98, shipZ + fz * 8.98, 0.02) ? 0.0 : 1.0;
    const bowP3 = this._isPointInCarvedWater(shipX + fx * 9.16, shipZ + fz * 9.16, 0.02) ? 0.0 : 1.0;
    const bowInIce = (bowP1 + bowP2 + bowP3) / 3.0;

    // Port & starboard bow-shoulder probes aligned to fractured bow pocket (detect turning into ice banks!)
    const portShX = shipX + fx * 6.4 + rx * 2.95;
    const portShZ = shipZ + fz * 6.4 + rz * 2.95;
    const stbdShX = shipX + fx * 6.4 - rx * 2.95;
    const stbdShZ = shipZ + fz * 6.4 - rz * 2.95;

    const portShoulderInIce = this._isPointInCarvedWater(portShX, portShZ, 0.04) ? 0.0 : 1.0;
    const stbdShoulderInIce = this._isPointInCarvedWater(stbdShX, stbdShZ, 0.04) ? 0.0 : 1.0;
    const inOpenWater = bowInIce < 0.45;

    return { bowInIce, portShoulderInIce, stbdShoulderInIce, inOpenWater };
  }

  setReflection(texture, reflViewProjMatrix) {
    this.waterMat.uniforms.tReflection.value = texture;
    this.waterMat.uniforms.uHasReflection.value = texture ? 1.0 : 0.0;
    this.waterMat.uniforms.uReflMatrix.value.copy(reflViewProjMatrix);

    this.foamMat.uniforms.tReflection.value = texture;
    this.foamMat.uniforms.uHasReflection.value = texture ? 1.0 : 0.0;
    this.foamMat.uniforms.uReflMatrix.value.copy(reflViewProjMatrix);
  }

  setReflectionPassMode(enabled) {
    const showSurface = !enabled;
    this.cutoutMesh.visible = showSurface;
    this.waterMesh.visible = showSurface;
    this.iceMesh.visible = showSurface;
    this.crackMesh.visible = showSurface;
    this.foamMesh.visible = showSurface;
  }

  /**
   * Computes exact world-space 2D convex polygon vertices matching Three.js's Y-axis rotation
   * (x' = x*cos(rotY) + z*sin(rotY), z' = -x*sin(rotY) + z*cos(rotY)).
   */
  _updateFloeWorldPoly(f) {
    const hull = this.shapeHulls[f.shapeIdx];
    const n = hull.length;
    if (!f._wx || f._vn !== n) {
      f._wx = new Float32Array(n);
      f._wz = new Float32Array(n);
      f._vn = n;
    }
    const c = Math.cos(f.rotY);
    const s = Math.sin(f.rotY);
    const sx = f.scaleX;
    const sz = f.scaleZ;
    const fx = f.x;
    const fz = f.z;
    for (let i = 0; i < n; i++) {
      const lx = hull[i][0] * sx;
      const lz = hull[i][1] * sz;
      f._wx[i] = fx + lx * c + lz * s;
      f._wz[i] = fz - lx * s + lz * c;
    }
  }

  /**
   * Tests whether every vertex of polygon `f` sits strictly inside carved open water by `bankMargin`.
   */
  _isPolyInCarvedWater(f, bankMargin = 0.05) {
    for (let i = 0; i < f._vn; i++) {
      if (!this._isPointInCarvedWater(f._wx[i], f._wz[i], bankMargin)) return false;
    }
    return true;
  }

  /**
   * Exact polygon-level non-overlapping placement test against carved water banks,
   * the full 18.2m ship hull, and ALL active ice chunks (using exact 2D SAT!).
   */
  _canPlaceFloe(cand, shipX, shipZ, fx, fz, px, pz, gapMargin = 0.07) {
    this._updateFloeWorldPoly(cand);

    // 1. Every polygon corner strictly inside open dark water (zero snow-sheet clipping!)
    if (!this._isPolyInCarvedWater(cand, 0.07)) return false;

    // 2. Every polygon corner strictly outside the 18.2m ship hull envelope
    const hdx = cand.x - shipX;
    const hdz = cand.z - shipZ;
    if (hdx * hdx + hdz * hdz < 175) {
      const hullGap = 0.11;
      for (let i = 0; i < cand._vn; i++) {
        const vdx = cand._wx[i] - shipX;
        const vdz = cand._wz[i] - shipZ;
        const lz = vdx * fx + vdz * fz;
        if (lz > -8.98 - hullGap && lz < 9.12 + hullGap) {
          const lx = vdx * px + vdz * pz;
          const hb = hullHalfBeamAt(THREE.MathUtils.clamp(lz, -8.85, 8.98));
          if (Math.abs(lx) < hb + hullGap) return false;
        }
      }
    }

    // 3. Strictly non-overlapping against ALL active floes (circle broadphase + exact 2D SAT!)
    for (let m = this.floes.length - 1; m >= 0; m--) {
      const other = this.floes[m];
      if (other.submerging) continue;
      const maxD = cand.radius + other.radius + gapMargin;
      const dx = cand.x - other.x;
      const dz = cand.z - other.z;
      if (dx * dx + dz * dz >= maxD * maxD) continue;
      if (!other._wx) this._updateFloeWorldPoly(other);
      if (satTestPolys(cand, other, gapMargin)) return false;
    }

    return true;
  }

  /**
   * Seeds a dramatic, layered active icebreaking cascade from the bow stem (+7.8) down along
   * both hull flanks (-7.5): bold freshly broken angular ice slabs interspersed with smaller
   * jagged splinters fanning outward from the blue bow toward the jagged ice walls!
   */
  _seedInitialFlankShards(shipX, shipZ, heading) {
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const px = Math.cos(heading);
    const pz = -Math.sin(heading);

    // Tier 1: Prominent freshly cracked angular slabs along bow shoulders & flanks (big -> dramatic!)
    const slabSlots = [6.3, 4.4, 2.3, 0.1, -2.1, -4.4, -6.7];
    // Tier 2: Crisp smaller angular splinters & chips nestled around bow stem & between slabs!
    const chipSlots = [7.7, 6.8, 5.4, 3.4, 1.3, -0.9, -3.2, -5.5];

    const placeTier = (slots, isSlab) => {
      for (const side of [1, -1]) {
        for (let i = 0; i < slots.length; i++) {
          for (let attempt = 0; attempt < 6; attempt++) {
            const seed = (side > 0 ? 17.3 : 79.1) + (isSlab ? 0 : 313.7) + i * 29.7 + attempt * 11.3;
            const shapeIdx = Math.floor(seededRand(seed + 0.7) * FLOE_TEMPLATES.length) % FLOE_TEMPLATES.length;
            const lz = slots[i] + (side < 0 ? -0.42 : 0.0) + (attempt > 0 ? (seededRand(seed) - 0.5) * 0.85 : 0);
            const bowT = THREE.MathUtils.clamp((lz - 1.5) / 6.2, 0, 1);

            let scaleX;
            let scaleZ;
            if (isSlab) {
              const base = THREE.MathUtils.lerp(0.60, 0.40, bowT) + seededRand(seed + 1.1) * 0.22;
              scaleX = base * (0.90 + seededRand(seed + 1.7) * 0.34);
              scaleZ = base * (0.68 + seededRand(seed + 2.3) * 0.30);
            } else {
              const base = THREE.MathUtils.lerp(0.28, 0.20, bowT) + seededRand(seed + 1.1) * 0.14;
              scaleX = base * (0.88 + seededRand(seed + 1.7) * 0.36);
              scaleZ = base * (0.72 + seededRand(seed + 2.3) * 0.30);
            }
            const radius = this.shapeRadii[shapeIdx] * Math.max(scaleX, scaleZ);

            const hb = hullHalfBeamAt(THREE.MathUtils.clamp(lz, -8.85, 8.95));
            const pwObj = lz >= POCKET_ANCHOR_Z ? pocketHalfWidthsAt(lz) : { wL: 4.75, wR: 4.75 };
            const bankW = side > 0 ? (pwObj ? pwObj.wL : 4.75) : (pwObj ? pwObj.wR : 4.75);
            const minLat = hb + Math.min(scaleX, scaleZ) * 0.85 + 0.16;
            const maxLat = bankW - Math.min(scaleX, scaleZ) * 0.85 - 0.14;
            if (maxLat < minLat) continue;

            // Slabs fan outward from bow shoulder; chips hug closer to hull or fill outer fracture pockets!
            const spreadFrac = isSlab
              ? THREE.MathUtils.lerp(0.32 + seededRand(seed + 4.1) * 0.56, 0.20 + seededRand(seed + 4.1) * 0.45, bowT)
              : 0.12 + seededRand(seed + 4.1) * 0.78;
            const lat = side * THREE.MathUtils.lerp(minLat, maxLat, spreadFrac);
            const wx = shipX + fx * lz + px * lat;
            const wz = shipZ + fz * lz + pz * lat;

            // Align elongated newly cracked slabs loosely with the bow-wedge angle + organic jitter
            const wedgeAngle = heading + side * (0.35 + bowT * 0.45) + (seededRand(seed + 5.7) - 0.5) * 1.4;

            const cand = {
              kind: isSlab ? 'slab' : 'brash',
              shapeIdx,
              segIdx: Math.max(0, this.nodes.length - 2),
              side,
              x: wx,
              z: wz,
              vx: px * side * (0.24 + bowT * 0.42),
              vz: pz * side * (0.24 + bowT * 0.42),
              radius,
              mass: Math.max(0.08, scaleX * scaleZ * 0.9),
              scaleX,
              scaleZ,
              rotY: wedgeAngle,
              rotSpeed: -side * (0.18 + bowT * 0.42),
              phase: seededRand(seed + 8.3) * Math.PI * 2,
              tilt: (seededRand(seed + 9.1) - 0.5) * 0.08,
              calveAge: 1.0 - bowT * 0.62,
              calveDir: side,
              pushRock: bowT * 0.55,
              submerging: false,
              submergeProg: 0,
            };

            if (!this._canPlaceFloe(cand, shipX, shipZ, fx, fz, px, pz, 0.07)) continue;
            this.floes.push(cand);
            break;
          }
        }
      }
    };

    placeTier(slabSlots, true);
    placeTier(chipSlots, false);
  }

  /**
   * Calves a freshly shattered angular ice slab or chipped splinter right at the bow-shoulder
   * fracture zone, tipping dramatically as the spoon bow levers it off the ice edge & shoves it outward!
   */
  _calveBowChunk(shipX, shipZ, heading, speed, side, strength = 0.6, preferSlab = true) {
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const px = Math.cos(heading);
    const pz = -Math.sin(heading);

    const zones = preferSlab
      ? [
          { zMin: 4.4, zMax: 6.7, scMin: 0.36, scMax: 0.56, isSlab: true },
          { zMin: 2.2, zMax: 4.8, scMin: 0.42, scMax: 0.64, isSlab: true },
          { zMin: -0.4, zMax: 2.6, scMin: 0.44, scMax: 0.66, isSlab: true },
        ]
      : [
          { zMin: 6.2, zMax: 8.1, scMin: 0.17, scMax: 0.29, isSlab: false },
          { zMin: 4.2, zMax: 6.4, scMin: 0.20, scMax: 0.32, isSlab: false },
        ];

    for (let attempt = 0; attempt < 12; attempt++) {
      const zone = zones[Math.min(zones.length - 1, Math.floor(attempt / 4))];
      const seed = (this._shardSeedCounter++) * 37.3 + attempt * 13.7;
      const shapeIdx = Math.floor(seededRand(seed + 1.3) * FLOE_TEMPLATES.length) % FLOE_TEMPLATES.length;
      const base = zone.scMin + seededRand(seed + 2.1) * (zone.scMax - zone.scMin);
      const scaleX = base * (0.90 + seededRand(seed + 2.9) * 0.32);
      const scaleZ = base * (0.68 + seededRand(seed + 3.7) * 0.28);
      const radius = this.shapeRadii[shapeIdx] * Math.max(scaleX, scaleZ);

      const lz = zone.zMin + seededRand(seed + 4.9) * (zone.zMax - zone.zMin);
      const hb = hullHalfBeamAt(THREE.MathUtils.clamp(lz, -8.85, 8.95));
      const pwObj = pocketHalfWidthsAt(lz);
      if (!pwObj) continue;
      const bankW = side > 0 ? pwObj.wL : pwObj.wR;
      const minLat = hb + Math.min(scaleX, scaleZ) * 0.85 + 0.14;
      const maxLat = bankW - Math.min(scaleX, scaleZ) * 0.85 - 0.12;
      if (maxLat < minLat) continue;

      // Spawn near the bow wedge / fracture shoulder so you literally watch the steel hull shove & spin it outward!
      const frac = zone.isSlab
        ? 0.14 + seededRand(seed + 6.1) * 0.68
        : 0.08 + seededRand(seed + 6.1) * 0.56;
      const lat = side * THREE.MathUtils.lerp(minLat, maxLat, frac);
      const wx = shipX + fx * lz + px * lat;
      const wz = shipZ + fz * lz + pz * lat;
      // Align elongated newly cracked slabs along the bow-wedge angle so they fit cleanly & visibly rotate!
      const wedgeAngle = heading + side * (0.32 + seededRand(seed + 7.7) * 0.45);

      const pushSpeed = 0.78 + Math.abs(speed) * 0.44 + strength * 0.82;
      const cand = {
        kind: zone.isSlab ? 'slab' : 'brash',
        shapeIdx,
        segIdx: Math.max(0, this.nodes.length - 2),
        side,
        x: wx,
        z: wz,
        vx: (px * side * 0.88 - fx * 0.47) * pushSpeed,
        vz: (pz * side * 0.88 - fz * 0.47) * pushSpeed,
        radius,
        mass: Math.max(0.08, scaleX * scaleZ * 0.9),
        scaleX,
        scaleZ,
        rotY: wedgeAngle,
        rotSpeed: -side * (0.65 + seededRand(seed + 8.9) * 0.95),
        phase: seededRand(seed + 9.3) * Math.PI * 2,
        tilt: (seededRand(seed + 10.1) - 0.5) * 0.10,
        calveAge: 0.0,
        calveDir: side,
        pushRock: 0.95,
        submerging: false,
        submergeProg: 0,
      };

      if (!this._canPlaceFloe(cand, shipX, shipZ, fx, fz, px, pz, 0.07)) continue;
      this.floes.push(cand);
      this._trimFloeBudget();
      return true;
    }
    return false;
  }

  /**
   * Spawns freshly cracked angular slab + splinters at bow shoulders on ice-breaking / low-speed
   * bump events, and visibly shoves nearby bow ice cluster outward!
   */
  _spawnBowImpactShards(shipX, shipZ, heading, speed = 1.5, strength = 0.6, sideBias = 0) {
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const px = Math.cos(heading);
    const pz = -Math.sin(heading);

    if (sideBias !== 0) {
      const s = Math.sign(sideBias);
      this._calveBowChunk(shipX, shipZ, heading, speed, s, strength, true);
      this._calveBowChunk(shipX, shipZ, heading, speed, s, strength, false);
    } else {
      this._calveBowChunk(shipX, shipZ, heading, speed, 1, strength, true);
      this._calveBowChunk(shipX, shipZ, heading, speed, -1, strength, true);
      this._calveBowChunk(shipX, shipZ, heading, speed, this._calveSide, strength, false);
    }

    for (let i = 0; i < this.floes.length; i++) {
      const f = this.floes[i];
      if (f.submerging) continue;
      const dx = f.x - shipX;
      const dz = f.z - shipZ;
      const d2 = dx * dx + dz * dz;
      if (d2 > 170) continue;
      const lz = dx * fx + dz * fz;
      if (lz < -2.5) continue;
      const lx = dx * px + dz * pz;
      const s = lx >= 0 ? 1 : -1;
      const falloff = Math.max(0, 1 - Math.sqrt(d2) / 13.0);
      const kick = falloff * (0.55 + strength * 1.05);
      f.vx += (px * s * 0.86 - fx * 0.42) * kick;
      f.vz += (pz * s * 0.86 - fz * 0.42) * kick;
      f.rotSpeed = THREE.MathUtils.clamp(f.rotSpeed - s * kick * 0.52, -1.25, 1.25);
      f.pushRock = Math.min(1.0, (f.pushRock || 0) + falloff * strength * 0.85);
    }
  }

  _trimFloeBudget() {
    const maxTotalFloes = this.maxFloesPerShape * this.floePools.length - 16;
    while (this.floes.length > maxTotalFloes) {
      this.floes.shift();
    }
  }

  _appendNode(x, z, heading, initial = false, shipX = 0, shipZ = 0, shipHeading = 0) {
    const idx = this.nodeCounter++;
    const px = Math.cos(heading);
    const pz = -Math.sin(heading);

    // Jagged polygonal bank widths (generous dark-blue open lead matching reference, never pinching hull!)
    const rL1 = seededRand(idx * 13.7 + 1.1);
    const rL2 = seededRand(Math.floor(idx / 3) * 29.3 + 4.2);
    const rR1 = seededRand(idx * 17.9 + 2.7);
    const rR2 = seededRand(Math.floor(idx / 3) * 37.1 + 8.9);

    const notchL = rL1 > 0.78 ? 1.55 : rL1 < 0.16 ? -0.30 : 0;
    const notchR = rR1 > 0.78 ? 1.55 : rR1 < 0.16 ? -0.30 : 0;

    const leftW = 4.28 + rL2 * 1.72 + (rL1 - 0.5) * 1.05 + notchL;
    const rightW = 4.28 + rR2 * 1.72 + (rR1 - 0.5) * 1.05 + notchR;

    const prevNode = this.nodes.length > 0 ? this.nodes[this.nodes.length - 1] : null;
    const arcDist = prevNode ? prevNode.arcDist + Math.hypot(x - prevNode.x, z - prevNode.z) : 0;

    const node = {
      id: idx,
      x,
      z,
      arcDist,
      heading,
      px,
      pz,
      leftW,
      rightW,
      lx: x + px * leftW,
      lz: z + pz * leftW,
      rx: x - px * rightW,
      rz: z - pz * rightW,
      age: initial ? 10 : 0,
    };

    this.nodes.push(node);
    if (this.nodes.length > this.maxNodes) {
      this.nodes.shift();
      // Shift cached segIdx on floes so local segment tracking remains accurate
      for (let i = 0; i < this.floes.length; i++) {
        this.floes[i].segIdx = Math.max(0, this.floes[i].segIdx - 1);
      }
      const minKeepId = this.nodes[0].id;
      let dropCount = 0;
      while (dropCount < this.crackSegments.length && this.crackSegments[dropCount].nodeId < minKeepId) {
        dropCount++;
      }
      if (dropCount > 0) {
        this.crackSegments.splice(0, dropCount);
        this._cracksDirty = true;
      }
    }

    // On initial pre-carve, populate the full aft channel mosaic; during live breaking,
    // bow-calved chunks continuously stream down the hull into the wake, so only add occasional outer bank slabs!
    const spawnIdx = initial ? this.nodes.length - 1 : this.nodes.length - 4;
    if (spawnIdx >= 1) {
      this._spawnFloesForNode(this.nodes[spawnIdx], spawnIdx, shipX, shipZ, shipHeading, initial);
    }
  }

  _spawnFloesForNode(node, nodeIdx, shipX, shipZ, shipHeading, initial = true) {
    const id = node.id;
    const fx = Math.sin(node.heading);
    const fz = Math.cos(node.heading);
    const sfx = Math.sin(shipHeading);
    const sfz = Math.cos(shipHeading);
    const spx = Math.cos(shipHeading);
    const spz = -Math.sin(shipHeading);

    const eff = this._getNodeEffectiveWidths(nodeIdx);
    const targetCount = initial
      ? 2 + (seededRand(id * 31.1) > 0.38 ? 1 : 0)
      : (seededRand(id * 31.1) > 0.48 ? 1 : 0);

    for (let k = 0; k < targetCount; k++) {
      let placed = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        const sBase = id * 97.3 + k * 23.7 + attempt * 13.1;
        const side = ((k + attempt) % 2 === 0 ? 1 : -1);
        const bankW = side > 0 ? eff.leftW : eff.rightW;
        const rKind = seededRand(sBase + 2.3);
        const shapeIdx = Math.floor(seededRand(sBase + 8.3) * FLOE_TEMPLATES.length) % FLOE_TEMPLATES.length;

        let baseScale;
        if (rKind < 0.80) {
          baseScale = 0.36 + seededRand(sBase + 4.9) * 0.44;
        } else {
          baseScale = 0.24 + seededRand(sBase + 6.1) * 0.26;
        }
        const scaleX = baseScale * (0.86 + seededRand(sBase + 10.3) * 0.36);
        const scaleZ = baseScale * (0.68 + seededRand(sBase + 11.7) * 0.34);
        const radius = this.shapeRadii[shapeIdx] * Math.max(scaleX, scaleZ);

        // Keep entire beveled polygon strictly inside open water channel with clean margin!
        const maxOffset = bankW - Math.min(scaleX, scaleZ) * 0.9 - 0.24;
        if (maxOffset < 0.25) continue;

        let offsetFromCenter;
        if (rKind < 0.80) {
          const inward = seededRand(sBase + 3.7) * Math.min(1.25, Math.max(0.20, maxOffset - 2.2));
          offsetFromCenter = side * Math.max(Math.min(2.65, maxOffset), maxOffset - inward);
        } else {
          offsetFromCenter = (seededRand(sBase + 5.3) - 0.5) * 2.0 * Math.max(0.2, maxOffset * 0.62);
        }

        const alongJitter = (seededRand(sBase + 7.7) - 0.5) * this.nodeSpacing * 0.80;
        const wx = node.x + node.px * offsetFromCenter + fx * alongJitter;
        const wz = node.z + node.pz * offsetFromCenter + fz * alongJitter;

        const cand = {
          kind: 'floe',
          shapeIdx,
          segIdx: Math.max(0, nodeIdx - 1),
          side,
          x: wx,
          z: wz,
          vx: 0,
          vz: 0,
          radius,
          mass: Math.max(0.12, scaleX * scaleZ * 0.9),
          scaleX,
          scaleZ,
          rotY: seededRand(sBase + 12.9) * Math.PI * 2,
          rotSpeed: (seededRand(sBase + 13.7) - 0.5) * 0.05,
          phase: seededRand(sBase + 14.3) * Math.PI * 2,
          tilt: (seededRand(sBase + 15.1) - 0.5) * 0.05,
          calveAge: 1.0,
          calveDir: side,
          pushRock: 0,
          submerging: false,
          submergeProg: 0,
        };

        if (!this._canPlaceFloe(cand, shipX, shipZ, sfx, sfz, spx, spz, 0.14)) continue;
        placed = cand;
        break;
      }

      if (placed) {
        this.floes.push(placed);
      }
    }

    this._trimFloeBudget();
  }

  /**
   * Rebuilds the stencil cutout channel polygon (including persistent carvedHead bow pocket)
   * and the 3D vertical ice-shelf wall along both jagged banks AND around the bow pocket.
   */
  _rebuildChannelMeshes() {
    const nCount = this.nodes.length;
    if (nCount < 2) return;

    const pos = this.cutoutPos;
    let pIdx = 0;

    // 1. Main carved trail ribbon quads from oldest node to latest node
    for (let i = 0; i < nCount - 1; i++) {
      const a = this.nodes[i];
      const b = this.nodes[i + 1];
      const wa = this._getNodeEffectiveWidths(i);
      const wb = this._getNodeEffectiveWidths(i + 1);

      const aLx = a.x + a.px * wa.leftW;
      const aLz = a.z + a.pz * wa.leftW;
      const aRx = a.x - a.px * wa.rightW;
      const aRz = a.z - a.pz * wa.rightW;

      const bLx = b.x + b.px * wb.leftW;
      const bLz = b.z + b.pz * wb.leftW;
      const bRx = b.x - b.px * wb.rightW;
      const bRz = b.z - b.pz * wb.rightW;

      pos[pIdx++] = aLx; pos[pIdx++] = 0.05; pos[pIdx++] = aLz;
      pos[pIdx++] = bLx; pos[pIdx++] = 0.05; pos[pIdx++] = bLz;
      pos[pIdx++] = aRx; pos[pIdx++] = 0.05; pos[pIdx++] = aRz;

      pos[pIdx++] = bLx; pos[pIdx++] = 0.05; pos[pIdx++] = bLz;
      pos[pIdx++] = bRx; pos[pIdx++] = 0.05; pos[pIdx++] = bRz;
      pos[pIdx++] = aRx; pos[pIdx++] = 0.05; pos[pIdx++] = aRz;
    }

    // 2. Persistent Carved Bow Pocket Cap (anchored to this.carvedHead — stays open when ship reverses!)
    const head = this.carvedHead;
    const hfx = Math.sin(head.heading);
    const hfz = Math.cos(head.heading);
    const hpx = Math.cos(head.heading);
    const hpz = -Math.sin(head.heading);

    const lastNode = this.nodes[nCount - 1];
    const pocketPtsL = [];
    const pocketPtsR = [];

    let prevLx = lastNode.x + lastNode.px * POCKET_BASE_WL;
    let prevLz = lastNode.z + lastNode.pz * POCKET_BASE_WL;
    let prevRx = lastNode.x - lastNode.px * POCKET_BASE_WR;
    let prevRz = lastNode.z - lastNode.pz * POCKET_BASE_WR;
    pocketPtsL.push([prevLx, prevLz]);
    pocketPtsR.push([prevRx, prevRz]);

    for (let s = 0; s < POCKET_SLICES.length; s++) {
      const sl = POCKET_SLICES[s];
      const cx = head.x + hfx * sl.z;
      const cz = head.z + hfz * sl.z;
      const curLx = cx + hpx * sl.wL;
      const curLz = cz + hpz * sl.wL;
      const curRx = cx - hpx * sl.wR;
      const curRz = cz - hpz * sl.wR;

      pos[pIdx++] = prevLx; pos[pIdx++] = 0.05; pos[pIdx++] = prevLz;
      pos[pIdx++] = curLx;  pos[pIdx++] = 0.05; pos[pIdx++] = curLz;
      pos[pIdx++] = prevRx; pos[pIdx++] = 0.05; pos[pIdx++] = prevRz;

      pos[pIdx++] = curLx;  pos[pIdx++] = 0.05; pos[pIdx++] = curLz;
      pos[pIdx++] = curRx;  pos[pIdx++] = 0.05; pos[pIdx++] = curRz;
      pos[pIdx++] = prevRx; pos[pIdx++] = 0.05; pos[pIdx++] = prevRz;

      pocketPtsL.push([curLx, curLz]);
      pocketPtsR.push([curRx, curRz]);
      prevLx = curLx;
      prevLz = curLz;
      prevRx = curRx;
      prevRz = curRz;
    }

    this.cutoutGeo.attributes.position.needsUpdate = true;
    this.cutoutGeo.setDrawRange(0, pIdx / 3);

    // 3. 3D Ice Shelf Edge Wall (0.14m vertical rim along jagged banks + persistent bow pocket!)
    const ePos = this.edgePos;
    const eNorm = this.edgeNorm;
    let eIdx = 0;
    const yTop = 0.14;
    const yBot = -0.02;

    const pushWallQuad = (ax, az, bx, bz, nx, nz) => {
      if (eIdx + 18 > ePos.length) return;
      const verts = [
        [ax, yBot, az],
        [ax, yTop, az],
        [bx, yBot, bz],
        [bx, yBot, bz],
        [ax, yTop, az],
        [bx, yTop, bz],
      ];
      for (let v = 0; v < 6; v++) {
        ePos[eIdx] = verts[v][0];
        ePos[eIdx + 1] = verts[v][1];
        ePos[eIdx + 2] = verts[v][2];
        eNorm[eIdx] = nx;
        eNorm[eIdx + 1] = 0;
        eNorm[eIdx + 2] = nz;
        eIdx += 3;
      }
    };

    for (let i = 0; i < nCount - 1; i++) {
      const a = this.nodes[i];
      const b = this.nodes[i + 1];
      const wa = this._getNodeEffectiveWidths(i);
      const wb = this._getNodeEffectiveWidths(i + 1);

      for (const side of [1, -1]) {
        const wA = side > 0 ? wa.leftW : wa.rightW;
        const wB = side > 0 ? wb.leftW : wb.rightW;
        const ax = a.x + a.px * side * wA;
        const az = a.z + a.pz * side * wA;
        const bx = b.x + b.px * side * wB;
        const bz = b.z + b.pz * side * wB;
        pushWallQuad(ax, az, bx, bz, -a.px * side, -a.pz * side);
      }
    }

    // Add 3D vertical ice-shelf wall along both sides & nose of the carved bow pocket!
    for (let s = 0; s < pocketPtsL.length - 1; s++) {
      pushWallQuad(pocketPtsL[s][0], pocketPtsL[s][1], pocketPtsL[s + 1][0], pocketPtsL[s + 1][1], -hpx, -hpz);
      pushWallQuad(pocketPtsR[s][0], pocketPtsR[s][1], pocketPtsR[s + 1][0], pocketPtsR[s + 1][1], hpx, hpz);
    }
    const tipL = pocketPtsL[pocketPtsL.length - 1];
    const tipR = pocketPtsR[pocketPtsR.length - 1];
    pushWallQuad(tipL[0], tipL[1], tipR[0], tipR[1], -hfx, -hfz);

    this.edgeGeo.attributes.position.needsUpdate = true;
    this.edgeGeo.attributes.normal.needsUpdate = true;
    this.edgeGeo.setDrawRange(0, eIdx / 3);
  }

  /**
   * Creates a new persistent fracture plate state anchored seamlessly at the previous crack endpoint.
   */
  _createPlateState(side, node) {
    const seed = node.id * 41.7 + (side > 0 ? 11.3 : 73.9);
    const plannedSpan = 9 + Math.floor(seededRand(seed) * 10);
    const bulgeDist = 7.5 + seededRand(seed + 2.1) * 13.0;
    const isCurved = seededRand(seed + 3.7) > 0.44;

    const uA = 0.24 + seededRand(seed + 4.3) * 0.14;
    const uB = 0.62 + seededRand(seed + 5.1) * 0.14;
    const hA = 0.78 + seededRand(seed + 6.7) * 0.30;
    const hB = 0.78 + seededRand(seed + 7.9) * 0.30;

    const radialCount = isCurved ? 2 + Math.floor(seededRand(seed + 5.5) * 2) : 2;
    const radialSteps = [];
    for (let r = 1; r <= radialCount; r++) {
      const jitter = Math.round((seededRand(seed + r * 15.1) - 0.5) * 2);
      const step = Math.min(
        plannedSpan - 2,
        Math.max(2, Math.round((r / (radialCount + 1)) * plannedSpan) + jitter)
      );
      if (!radialSteps.includes(step)) {
        radialSteps.push(step);
      }
    }

    const bankW = side > 0 ? node.leftW : node.rightW;
    const anchor = this.crackLastAnchor[side];
    const startX = anchor ? anchor.x : node.x + node.px * side * bankW;
    const startZ = anchor ? anchor.z : node.z + node.pz * side * bankW;

    return {
      startNodeId: node.id,
      plannedSpan,
      bulgeDist,
      effectiveBulge: bulgeDist,
      isCurved,
      uA,
      uB,
      hA,
      hB,
      radialSteps,
      radialCount: 0,
      seed,
      prevX: startX,
      prevZ: startZ,
      prevHeading: node.heading,
    };
  }

  _pushPersistentCrack(nodeId, x1, z1, x2, z2, halfWidth, bornTime, growDur) {
    if (Math.hypot(x2 - x1, z2 - z1) < 0.05) return;
    this.crackSegments.push({
      nodeId,
      x1,
      z1,
      x2,
      z2,
      halfWidth,
      bornTime,
      growDur,
    });
    if (this.crackSegments.length > this.maxCrackQuads) {
      this.crackSegments.shift();
    }
    this._cracksDirty = true;
  }

  _advanceSideCrack(side, node, instant) {
    const lineW = 0.044;
    let state = this.crackSideState[side];
    if (!state) {
      state = this._createPlateState(side, node);
      this.crackSideState[side] = state;
      return;
    }

    const j = node.id - state.startNodeId;
    if (j <= 0) return;

    const u = Math.min(1, j / state.plannedSpan);
    let arch;
    if (state.isCurved) {
      arch = Math.pow(Math.sin(u * Math.PI), 0.78);
    } else if (u <= state.uA) {
      arch = (u / state.uA) * state.hA;
    } else if (u <= state.uB) {
      arch = state.hA + ((u - state.uA) / (state.uB - state.uA)) * (state.hB - state.hA);
    } else {
      arch = ((1 - u) / (1 - state.uB)) * state.hB;
    }

    const bankW = side > 0 ? node.leftW : node.rightW;
    const bankBlend = Math.sin(u * Math.PI);
    const smoothBankW = THREE.MathUtils.lerp(bankW, 5.15, Math.pow(bankBlend, 0.55));

    let dH = node.heading - state.prevHeading;
    while (dH > Math.PI) dH -= Math.PI * 2;
    while (dH < -Math.PI) dH += Math.PI * 2;
    state.prevHeading = node.heading;

    const inwardTurn = dH * side;
    if (inwardTurn > 0.01 && arch > 0.05) {
      const turnRadius = this.nodeSpacing / inwardTurn;
      const safeOutDist = Math.max(smoothBankW + 1.2, turnRadius * 0.52);
      const maxBulge = Math.max(1.2, (safeOutDist - smoothBankW) / Math.max(0.25, arch));
      state.effectiveBulge = Math.min(state.effectiveBulge, maxBulge);
    }

    const outDist = smoothBankW + arch * state.effectiveBulge;
    const nx = node.x + node.px * side * outDist;
    const nz = node.z + node.pz * side * outDist;

    const fx = Math.sin(node.heading);
    const fz = Math.cos(node.heading);
    const fwdStep = (nx - state.prevX) * fx + (nz - state.prevZ) * fz;
    if (fwdStep < 0.25 && j > 1 && j < state.plannedSpan) {
      return;
    }

    const baseBorn = instant ? -10.0 : this._time;

    this._pushPersistentCrack(node.id, state.prevX, state.prevZ, nx, nz, lineW, baseBorn, 0.30);

    if (state.radialSteps.includes(j)) {
      const r = ++state.radialCount;
      const bx = node.x + node.px * side * (bankW - 0.15);
      const bz = node.z + node.pz * side * (bankW - 0.15);
      const radialBorn = instant ? -10.0 : baseBorn + 0.05;
      this._pushPersistentCrack(node.id, bx, bz, nx, nz, lineW * 0.94, radialBorn, 0.28);

      if (seededRand(state.seed + r * 31.3) > 0.58) {
        const dx = nx - bx;
        const dz = nz - bz;
        const len = Math.hypot(dx, dz) || 1;
        const angleOff = (seededRand(state.seed + r * 37.9) - 0.5) * 0.55;
        const ca = Math.cos(angleOff);
        const sa = Math.sin(angleOff);
        const ex = (dx * ca - dz * sa) / len;
        const ez = (dx * sa + dz * ca) / len;
        const extLen = 4.0 + seededRand(state.seed + r * 43.1) * 8.5;
        const extBorn = instant ? -10.0 : radialBorn + 0.20;
        this._pushPersistentCrack(
          node.id,
          nx,
          nz,
          nx + ex * extLen,
          nz + ez * extLen,
          lineW * 0.78,
          extBorn,
          0.36
        );
      }
    }

    state.prevX = nx;
    state.prevZ = nz;

    if (j >= state.plannedSpan) {
      this.crackLastAnchor[side] = { x: nx, z: nz };
      this.crackSideState[side] = this._createPlateState(side, node);
    }
  }

  _advanceCracks(instant = false) {
    const nCount = this.nodes.length;
    const maxEligibleIdx = nCount - 1 - this.fractureLagNodes;
    if (maxEligibleIdx < 0) return;

    for (let i = 0; i <= maxEligibleIdx; i++) {
      const node = this.nodes[i];
      if (node.id <= this._lastCrackedNodeId) continue;
      this._advanceSideCrack(1, node, instant);
      this._advanceSideCrack(-1, node, instant);
      this._lastCrackedNodeId = node.id;
    }
  }

  _uploadCrackGeometry() {
    const pos = this.crackPos;
    const crackY = 0.148;
    const segs = this.crackSegments;
    let qCount = 0;
    let anyGrowing = false;

    for (let i = 0; i < segs.length && qCount < this.maxCrackQuads; i++) {
      const s = segs[i];
      let prog = 1.0;
      if (s.bornTime > -1.0 && s.growDur > 0.001) {
        const rawT = (this._time - s.bornTime) / s.growDur;
        if (rawT <= 0.0) {
          anyGrowing = true;
          continue;
        }
        if (rawT < 1.0) {
          anyGrowing = true;
          prog = 1.0 - Math.pow(1.0 - rawT, 2.4);
        }
      }

      const x1 = s.x1;
      const z1 = s.z1;
      const x2 = x1 + (s.x2 - x1) * prog;
      const z2 = z1 + (s.z2 - z1) * prog;

      const dx = x2 - x1;
      const dz = z2 - z1;
      const len = Math.hypot(dx, dz);
      if (len < 0.03) continue;

      const nx = (-dz / len) * s.halfWidth;
      const nz = (dx / len) * s.halfWidth;

      let o = qCount * 18;
      pos[o++] = x1 + nx; pos[o++] = crackY; pos[o++] = z1 + nz;
      pos[o++] = x1 - nx; pos[o++] = crackY; pos[o++] = z1 - nz;
      pos[o++] = x2 + nx; pos[o++] = crackY; pos[o++] = z2 + nz;

      pos[o++] = x2 + nx; pos[o++] = crackY; pos[o++] = z2 + nz;
      pos[o++] = x1 - nx; pos[o++] = crackY; pos[o++] = z1 - nz;
      pos[o++] = x2 - nx; pos[o++] = crackY; pos[o++] = z2 - nz;
      qCount++;
    }

    this.crackGeo.attributes.position.needsUpdate = true;
    this.crackGeo.setDrawRange(0, qCount * 6);
    this._cracksDirty = false;
    this._hasGrowingCracks = anyGrowing;
  }

  _catmullRom(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (
      (2 * p1) +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    );
  }

  _updateFoamRibbon(shipX, shipZ, heading) {
    const nCount = this.nodes.length;
    if (nCount < 3) return;

    const fx = Math.sin(heading);
    const fz = Math.cos(heading);

    const sternX = shipX - fx * 8.3;
    const sternZ = shipZ - fz * 8.3;

    const lastNode = this.nodes[nCount - 1];
    const anchorX = shipX + fx * POCKET_ANCHOR_Z;
    const anchorZ = shipZ + fz * POCKET_ANCHOR_Z;
    const anchorAhead = (anchorX - lastNode.x) * fx + (anchorZ - lastNode.z) * fz;
    const sternTrailArc = lastNode.arcDist + anchorAhead - 6.3;

    const rawPts = [{
      x: sternX,
      z: sternZ,
      s: 0,
      leftW: lastNode.leftW,
      rightW: lastNode.rightW,
    }];

    let accum = 0;
    let prevX = sternX;
    let prevZ = sternZ;

    for (let i = nCount - 1; i >= 0 && accum < this.wakeAftLength + 10; i--) {
      const nd = this.nodes[i];
      if (nd.arcDist > sternTrailArc - 0.55) continue;
      const d = Math.hypot(nd.x - prevX, nd.z - prevZ);
      if (d < 0.35) continue;
      accum += d;
      rawPts.push({
        x: nd.x,
        z: nd.z,
        s: accum,
        leftW: nd.leftW,
        rightW: nd.rightW,
      });
      prevX = nd.x;
      prevZ = nd.z;
    }

    if (rawPts.length < 2) {
      rawPts.push({
        x: sternX - fx * (this.wakeAftLength + 8),
        z: sternZ - fz * (this.wakeAftLength + 8),
        s: this.wakeAftLength + 8,
        leftW: 4.8,
        rightW: 4.8,
      });
    } else if (accum < this.wakeAftLength + 6) {
      const a = rawPts[rawPts.length - 2];
      const b = rawPts[rawPts.length - 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      const extra = (this.wakeAftLength + 8) - accum;
      rawPts.push({
        x: b.x + (dx / len) * extra,
        z: b.z + (dz / len) * extra,
        s: accum + extra,
        leftW: b.leftW,
        rightW: b.rightW,
      });
    }

    const sampleAftSpline = (sQuery) => {
      let seg = 0;
      const lastIdx = rawPts.length - 1;
      while (seg < lastIdx - 1 && rawPts[seg + 1].s < sQuery) {
        seg++;
      }
      const p1 = rawPts[seg];
      const p2 = rawPts[Math.min(lastIdx, seg + 1)];
      const p0 = rawPts[Math.max(0, seg - 1)];
      const p3 = rawPts[Math.min(lastIdx, seg + 2)];
      const span = Math.max(1e-4, p2.s - p1.s);
      const t = THREE.MathUtils.clamp((sQuery - p1.s) / span, 0, 1);

      const p0x = seg === 0 ? sternX + fx * 3.0 : p0.x;
      const p0z = seg === 0 ? sternZ + fz * 3.0 : p0.z;

      const x = this._catmullRom(p0x, p1.x, p2.x, p3.x, t);
      const z = this._catmullRom(p0z, p1.z, p2.z, p3.z, t);
      const leftW = p1.leftW + (p2.leftW - p1.leftW) * t;
      const rightW = p1.rightW + (p2.rightW - p1.rightW) * t;
      return { x, z, leftW, rightW };
    };

    const pos = this.foamPos;
    const wakeCoord = this.foamWakeCoord;
    const frameArr = this.foamFrame;
    const cols = this.foamAcross + 1;
    const totalSpan = this.wakeAftLength - this.wakeBowStart;

    const centers = new Array(this.foamSegs + 1);
    for (let i = 0; i <= this.foamSegs; i++) {
      const u = i / this.foamSegs;
      const sAft = this.wakeBowStart + u * totalSpan;
      if (sAft <= 0) {
        const hullZ = -8.3 - sAft;
        const bowBlend = THREE.MathUtils.clamp((sAft - this.wakeBowStart) / Math.abs(this.wakeBowStart), 0, 1);
        centers[i] = {
          sAft,
          x: shipX + fx * hullZ,
          z: shipZ + fz * hullZ,
          leftW: THREE.MathUtils.lerp(3.2, rawPts[0].leftW, bowBlend * bowBlend),
          rightW: THREE.MathUtils.lerp(3.2, rawPts[0].rightW, bowBlend * bowBlend),
        };
      } else {
        const sp = sampleAftSpline(sAft);
        centers[i] = {
          sAft,
          x: sp.x,
          z: sp.z,
          leftW: sp.leftW,
          rightW: sp.rightW,
        };
      }
    }

    this._wakeSpineSamples.length = 0;

    for (let i = 0; i <= this.foamSegs; i++) {
      const c = centers[i];
      const prev = centers[Math.max(0, i - 1)];
      const next = centers[Math.min(this.foamSegs, i + 1)];

      let ax = next.x - prev.x;
      let az = next.z - prev.z;
      const aLen = Math.hypot(ax, az) || 1;
      ax /= aLen;
      az /= aLen;
      const px = -az;
      const pz = ax;

      if (c.sAft >= -2.0 && c.sAft <= 48.0 && i % 4 === 0) {
        this._wakeSpineSamples.push({
          sAft: c.sAft,
          x: c.x,
          z: c.z,
          px,
          pz,
          leftW: c.leftW,
          rightW: c.rightW,
        });
      }

      const spanRight = c.rightW + 2.8;
      const spanLeft = c.leftW + 2.8;
      const worldS = sternTrailArc - c.sAft;

      for (let j = 0; j <= this.foamAcross; j++) {
        const v = j / this.foamAcross;
        const lat = -spanRight + v * (spanRight + spanLeft);
        const localBankW = lat >= 0 ? c.leftW : c.rightW;

        const vIdx = i * cols + j;
        const pBase = vIdx * 3;
        const qBase = vIdx * 4;

        pos[pBase] = c.x + px * lat;
        pos[pBase + 1] = 0.015;
        pos[pBase + 2] = c.z + pz * lat;

        wakeCoord[qBase] = c.sAft;
        wakeCoord[qBase + 1] = lat;
        wakeCoord[qBase + 2] = worldS;
        wakeCoord[qBase + 3] = localBankW;

        frameArr[qBase] = ax;
        frameArr[qBase + 1] = az;
        frameArr[qBase + 2] = px;
        frameArr[qBase + 3] = pz;
      }
    }

    this.foamGeo.attributes.position.needsUpdate = true;
    this.foamGeo.attributes.aWakeCoord.needsUpdate = true;
    this.foamGeo.attributes.aFrame.needsUpdate = true;
  }

  /**
   * Projects EVERY corner vertex of polygon `f` strictly inside the carved open water lead
   * (jagged asymmetric bow pocket + spine segments) — lets elongated angular slabs sit cleanly
   * parallel along jagged ice edges without clipping a single corner!
   */
  _constrainFloeToChannel(f, bankMargin = 0.08) {
    const nCount = this.nodes.length;
    if (nCount < 2) return 0;

    this._updateFloeWorldPoly(f);
    let bestClearance = -1e9;
    let bestFixX = 0;
    let bestFixZ = 0;
    let bestSegIdx = f.segIdx;

    // 1. Evaluate carvedHead jagged asymmetric bow pocket across ALL polygon vertices!
    const head = this.carvedHead;
    const hfx = Math.sin(head.heading);
    const hfz = Math.cos(head.heading);
    const hrx = Math.cos(head.heading);
    const hrz = -Math.sin(head.heading);
    const hdx = f.x - head.x;
    const hdz = f.z - head.z;
    const centerLz = hdx * hfx + hdz * hfz;

    if (centerLz >= POCKET_ANCHOR_Z - 1.5 && centerLz <= POCKET_TIP_Z + 3.0) {
      let minVertClr = 1e9;
      let maxExcessPos = 0;
      let maxExcessNeg = 0;
      let maxTipExcess = 0;
      let noseTooNarrow = false;

      for (let v = 0; v < f._vn; v++) {
        const vdx = f._wx[v] - head.x;
        const vdz = f._wz[v] - head.z;
        const vlz = vdx * hfx + vdz * hfz;
        const vlx = vdx * hrx + vdz * hrz;
        const clampedZ = THREE.MathUtils.clamp(vlz, POCKET_ANCHOR_Z, POCKET_TIP_Z);
        const pw = pocketHalfWidthsAt(clampedZ);
        if (!pw) continue;

        const limL = pw.wL - bankMargin;
        const limR = pw.wR - bankMargin;
        const tipLimit = POCKET_TIP_Z - bankMargin;

        if (limL + limR < 0.35 && vlz > 7.6) {
          noseTooNarrow = true;
        }
        const exPos = vlx - limL;
        const exNeg = -limR - vlx;
        const exTip = vlz - tipLimit;
        if (exPos > maxExcessPos) maxExcessPos = exPos;
        if (exNeg > maxExcessNeg) maxExcessNeg = exNeg;
        if (exTip > maxTipExcess) maxTipExcess = exTip;

        const vClr = Math.min(limL - vlx, limR + vlx, tipLimit - vlz);
        if (vClr < minVertClr) minVertClr = vClr;
      }

      if (noseTooNarrow || (maxExcessPos > 0 && maxExcessNeg > 0)) {
        const aftPush = Math.max(0.22, centerLz - 6.8);
        const clr = -aftPush - Math.abs(hdx * hrx + hdz * hrz);
        if (clr > bestClearance) {
          bestClearance = clr;
          bestFixX = -hfx * aftPush;
          bestFixZ = -hfz * aftPush;
          bestSegIdx = nCount - 2;
        }
      } else if (minVertClr > bestClearance) {
        bestClearance = minVertClr;
        let fixX = 0;
        let fixZ = 0;
        if (maxExcessPos > 0) {
          fixX -= hrx * maxExcessPos;
          fixZ -= hrz * maxExcessPos;
        } else if (maxExcessNeg > 0) {
          fixX += hrx * maxExcessNeg;
          fixZ += hrz * maxExcessNeg;
        }
        if (maxTipExcess > 0) {
          fixX -= hfx * maxTipExcess;
          fixZ -= hfz * maxTipExcess;
        }
        bestFixX = fixX;
        bestFixZ = fixZ;
        bestSegIdx = nCount - 2;
      }
    }

    // 2. Evaluate local spine segments around f.segIdx testing ALL polygon vertices!
    const startI = Math.max(0, (f.segIdx || 0) - 6);
    const endI = Math.min(nCount - 2, (f.segIdx || 0) + 8);
    let foundNearSeg = false;

    const testSegment = (i) => {
      const a = this.nodes[i];
      const b = this.nodes[i + 1];
      const sx = b.x - a.x;
      const sz = b.z - a.z;
      const lenSq = sx * sx + sz * sz;
      if (lenSq < 1e-5) return;

      const rawT = ((f.x - a.x) * sx + (f.z - a.z) * sz) / lenSq;
      if (rawT < -0.55 || rawT > 1.55) return;
      const t = THREE.MathUtils.clamp(rawT, 0, 1);

      const cx = a.x + sx * t;
      const cz = a.z + sz * t;
      let npx = a.px + (b.px - a.px) * t;
      let npz = a.pz + (b.pz - a.pz) * t;
      const nLen = Math.hypot(npx, npz) || 1;
      npx /= nLen;
      npz /= nLen;

      const wa = this._getNodeEffectiveWidths(i);
      const wb = this._getNodeEffectiveWidths(i + 1);
      const leftW = wa.leftW + (wb.leftW - wa.leftW) * t - bankMargin;
      const rightW = wa.rightW + (wb.rightW - wa.rightW) * t - bankMargin;

      let maxLat = -1e9;
      let minLat = 1e9;
      for (let v = 0; v < f._vn; v++) {
        const vLat = (f._wx[v] - cx) * npx + (f._wz[v] - cz) * npz;
        if (vLat > maxLat) maxLat = vLat;
        if (vLat < minLat) minLat = vLat;
      }

      const alongErr = Math.max(0, Math.abs(rawT - 0.5) - 0.5) * Math.sqrt(lenSq);
      const clearance = Math.min(leftW - maxLat, rightW + minLat) - alongErr;

      foundNearSeg = true;
      if (clearance > bestClearance) {
        bestClearance = clearance;
        bestSegIdx = i;
        if (maxLat > leftW) {
          const pull = maxLat - leftW;
          bestFixX = -npx * pull;
          bestFixZ = -npz * pull;
        } else if (minLat < -rightW) {
          const pull = -rightW - minLat;
          bestFixX = npx * pull;
          bestFixZ = npz * pull;
        } else {
          bestFixX = 0;
          bestFixZ = 0;
        }
      }
    };

    for (let i = startI; i <= endI; i++) testSegment(i);
    if (!foundNearSeg) {
      for (let i = 0; i <= nCount - 2; i++) testSegment(i);
    }

    f.segIdx = bestSegIdx;

    if (bestClearance < 0 && (bestFixX !== 0 || bestFixZ !== 0)) {
      f.x += bestFixX;
      f.z += bestFixZ;
      f.vx *= 0.68;
      f.vz *= 0.68;
      this._updateFloeWorldPoly(f);
      return -bestClearance;
    }
    return 0;
  }

  /**
   * Exact vertex-level hull exclusion for angular ice slabs:
   * Finds the deepest corner penetrating the 18.2m icebreaker hull footprint, pushes the slab
   * cleanly outward along the bow wedge/flank, AND applies lever-arm rotational torque so hitting
   * the corner of an elongated slab naturally rotates & wedges it cleanly along the blue bow!
   */
  _pushFloeOutsideHull(f, shipX, shipZ, fx, fz, px, pz, speed, impactPulse, applyVel = true) {
    const dx = f.x - shipX;
    const dz = f.z - shipZ;
    if (dx * dx + dz * dz > 205) return 0;

    this._updateFloeWorldPoly(f);
    const hullGap = 0.11;
    let worstPen = 0;
    let bestOutX = 0;
    let bestOutZ = 0;
    let hitVx = f.x;
    let hitVz = f.z;
    let hitSide = 1;

    for (let v = 0; v < f._vn; v++) {
      const vx = f._wx[v];
      const vz = f._wz[v];
      const vdx = vx - shipX;
      const vdz = vz - shipZ;
      const lz = vdx * fx + vdz * fz;
      if (lz < -8.98 - hullGap || lz > 9.15 + hullGap) continue;

      const lx = vdx * px + vdz * pz;
      const hb = hullHalfBeamAt(THREE.MathUtils.clamp(lz, -8.85, 8.98));
      const minLat = hb + hullGap;
      if (Math.abs(lx) >= minLat) continue;

      const distToStern = lz - (-8.98 - hullGap);
      const distToBow = (9.15 + hullGap) - lz;
      const distToSide = minLat - Math.abs(lx);
      const s = lx >= 0 ? 1 : -1;

      let pen;
      let outX;
      let outZ;
      if (lz < -7.6 && distToStern < distToSide * 0.95) {
        pen = distToStern + 0.02;
        outX = -fx;
        outZ = -fz;
      } else if (lz > 7.2 && distToBow < distToSide * 0.90) {
        outX = px * s * 0.90 - fx * 0.43;
        outZ = pz * s * 0.90 - fz * 0.43;
        pen = Math.min(distToBow, distToSide) + 0.02;
      } else if (lz > 2.6) {
        outX = px * s * 0.88 - fx * 0.47;
        outZ = pz * s * 0.88 - fz * 0.47;
        pen = distToSide / 0.88 + 0.02;
      } else {
        outX = px * s * 0.98 - fx * 0.18;
        outZ = pz * s * 0.98 - fz * 0.18;
        pen = distToSide + 0.02;
      }

      if (pen > worstPen) {
        worstPen = pen;
        bestOutX = outX;
        bestOutZ = outZ;
        hitVx = vx;
        hitVz = vz;
        hitSide = s;
      }
    }

    if (worstPen <= 0) return 0;

    f.x += bestOutX * worstPen;
    f.z += bestOutZ * worstPen;

    // Apply lever-arm rotational torque from exact corner contact (spins slabs parallel to bow flare!)
    const rx = hitVx - f.x;
    const rz = hitVz - f.z;
    const lever = rx * bestOutZ - rz * bestOutX;
    f.rotY += THREE.MathUtils.clamp(-lever * worstPen * 0.65, -0.18, 0.18);
    this._updateFloeWorldPoly(f);

    if (applyVel) {
      const impulse = 0.64 + Math.abs(speed) * 0.46 + impactPulse * 0.92;
      f.vx = f.vx * 0.40 + bestOutX * impulse;
      f.vz = f.vz * 0.40 + bestOutZ * impulse;
      f.rotSpeed = THREE.MathUtils.clamp(
        f.rotSpeed - hitSide * (0.20 + Math.abs(speed) * 0.10) - lever * 0.38,
        -1.35,
        1.35
      );
      f.pushRock = Math.min(1.0, (f.pushRock || 0) + 0.54 + Math.min(0.4, Math.abs(speed) * 0.14));
    }

    return worstPen;
  }

  /**
   * Builds spatial hash grid over all active (non-submerging) floes.
   */
  _rebuildFloeSpatialHash(invCell) {
    const grid = this._floeGrid;
    grid.clear();
    const floes = this.floes;
    for (let i = 0; i < floes.length; i++) {
      const f = floes[i];
      if (f.submerging) continue;
      this._updateFloeWorldPoly(f);
      const cx = Math.floor(f.x * invCell);
      const cz = Math.floor(f.z * invCell);
      const key = (cx + 32768) * 65536 + (cz + 32768);
      let bucket = grid.get(key);
      if (!bucket) {
        bucket = [];
        grid.set(key, bucket);
      }
      bucket.push(i);
    }
  }

  /**
   * Performs one spatial-hash pairwise mass-weighted exact 2D Convex-Polygon SAT separation pass!
   * Broadphase circle check rejects >99% of pairs; exact SAT lets elongated jagged slabs nestle
   * tightly edge-to-edge while mathematically guaranteeing ZERO polygon overlap!
   */
  _separateFloePairs(invCell, gapMargin, dt, exchangeVelocity) {
    const floes = this.floes;
    const count = floes.length;
    const grid = this._floeGrid;
    this._rebuildFloeSpatialHash(invCell);

    for (let i = 0; i < count; i++) {
      const a = floes[i];
      if (a.submerging) continue;
      const cx = Math.floor(a.x * invCell);
      const cz = Math.floor(a.z * invCell);

      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          const key = (cx + ox + 32768) * 65536 + (cz + oz + 32768);
          const bucket = grid.get(key);
          if (!bucket) continue;

          for (let bIdx = 0; bIdx < bucket.length; bIdx++) {
            const j = bucket[bIdx];
            if (j <= i) continue;
            const b = floes[j];
            if (b.submerging) continue;

            // Fast bounding-circle broadphase
            const dx = b.x - a.x;
            const dz = b.z - a.z;
            const maxDist = a.radius + b.radius + gapMargin;
            if (dx * dx + dz * dz >= maxDist * maxDist) continue;

            // Exact 2D Convex-Polygon SAT narrowphase
            const hit = satTestPolys(a, b, gapMargin);
            if (!hit) continue;

            const totalMass = a.mass + b.mass;
            const wA = b.mass / totalMass;
            const wB = a.mass / totalMass;

            a.x -= hit.nx * hit.ov * wA;
            a.z -= hit.nz * hit.ov * wA;
            b.x += hit.nx * hit.ov * wB;
            b.z += hit.nz * hit.ov * wB;
            this._updateFloeWorldPoly(a);
            this._updateFloeWorldPoly(b);

            if (exchangeVelocity && dt > 0) {
              const relVx = b.vx - a.vx;
              const relVz = b.vz - a.vz;
              const relVn = relVx * hit.nx + relVz * hit.nz;
              if (relVn < 0) {
                const jImp = -1.28 * relVn;
                a.vx -= hit.nx * jImp * wA;
                a.vz -= hit.nz * jImp * wA;
                b.vx += hit.nx * jImp * wB;
                b.vz += hit.nz * jImp * wB;
                const spinKick = (hit.nx * relVz - hit.nz * relVx) * 0.085;
                a.rotSpeed = THREE.MathUtils.clamp(a.rotSpeed + spinKick, -1.1, 1.1);
                b.rotSpeed = THREE.MathUtils.clamp(b.rotSpeed - spinKick, -1.1, 1.1);
                const clackRock = Math.min(0.45, Math.abs(relVn) * 0.35);
                a.pushRock = Math.min(1.0, (a.pushRock || 0) + clackRock * wA);
                b.pushRock = Math.min(1.0, (b.pushRock || 0) + clackRock * wB);
              }
            }
          }
        }
      }
    }
  }

  /**
   * Unified 2D Convex-Polygon Rigid-Body Ice Chunk Solver (Exact SAT + Vertex Bank/Hull Exclusion):
   * Guarantees ZERO polygon-polygon, polygon-hull, or polygon-bank interpenetration while allowing
   * jagged elongated broken ice slabs to cluster tightly around the bow & visibly push each other aside!
   */
  _resolveFloeCollisions(dt, shipX, shipZ, heading, speed, impactPulse = 0, iterations = 10) {
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const px = Math.cos(heading);
    const pz = -Math.sin(heading);
    const floes = this.floes;

    const velDrag = dt > 0 ? Math.exp(-dt * 2.15) : 1.0;
    const rotDrag = dt > 0 ? Math.exp(-dt * 0.88) : 1.0;
    const absSpeed = Math.abs(speed);

    for (let i = floes.length - 1; i >= 0; i--) {
      const f = floes[i];
      if (f.submerging) {
        f.submergeProg += dt > 0 ? dt * 4.5 : 1.0;
        if (f.submergeProg >= 1.0) {
          floes.splice(i, 1);
        }
        continue;
      }

      if (dt > 0) {
        // Gentle outward parting current right behind the twin propellers
        const sdx = f.x - shipX;
        const sdz = f.z - shipZ;
        if (sdx * sdx + sdz * sdz < 400 && absSpeed > 0.25) {
          const lz = sdx * fx + sdz * fz;
          if (lz < -8.2 && lz > -22.0) {
            const lx = sdx * px + sdz * pz;
            if (Math.abs(lx) < 2.2) {
              const s = lx >= 0 ? 1 : -1;
              const washStrength = (1 - Math.abs(lx) / 2.2) * (1 - (-8.2 - lz) / 14.0) * Math.min(1, absSpeed / 3.5);
              f.vx += (px * s * 0.78 - fx * 0.42) * washStrength * dt * 1.45;
              f.vz += (pz * s * 0.78 - fz * 0.42) * washStrength * dt * 1.45;
            }
          }
        }

        f.x += f.vx * dt;
        f.z += f.vz * dt;
        f.vx *= velDrag;
        f.vz *= velDrag;
        f.rotSpeed *= rotDrag;
      }
    }

    const cellSize = 3.2;
    const invCell = 1.0 / cellSize;
    const gapMargin = 0.065;
    const bankMargin = 0.07;

    // Multi-iteration Gauss-Seidel PBD: Bank Walls -> Hull Envelope -> Exact SAT Pairwise Separation!
    for (let iter = 0; iter < iterations; iter++) {
      const applyVel = iter === 0;
      for (let i = 0; i < floes.length; i++) {
        const f = floes[i];
        if (f.submerging) continue;
        this._constrainFloeToChannel(f, bankMargin);
        this._pushFloeOutsideHull(f, shipX, shipZ, fx, fz, px, pz, speed, applyVel ? impactPulse : 0, applyVel);
      }
      this._separateFloePairs(invCell, gapMargin, dt, iter === 0);
    }

    // Final strict non-overlap cleanup
    for (let i = 0; i < floes.length; i++) {
      const f = floes[i];
      if (f.submerging) continue;
      this._constrainFloeToChannel(f, bankMargin);
      this._pushFloeOutsideHull(f, shipX, shipZ, fx, fz, px, pz, speed, 0, false);
    }
    this._separateFloePairs(invCell, gapMargin * 0.75, 0, false);
    this._separateFloePairs(invCell, gapMargin * 0.50, 0, false);

    // Last-resort pinch submersion ONLY if a chunk is physically trapped with zero escape!
    this._rebuildFloeSpatialHash(invCell);
    const grid = this._floeGrid;
    for (let i = 0; i < floes.length; i++) {
      const a = floes[i];
      if (a.submerging) continue;

      if (!this._isPolyInCarvedWater(a, 0.01)) {
        a.submerging = true;
        continue;
      }

      // Check hull vertex pinch
      const hdx = a.x - shipX;
      const hdz = a.z - shipZ;
      if (hdx * hdx + hdz * hdz < 175) {
        let hullPinched = false;
        for (let v = 0; v < a._vn; v++) {
          const vdx = a._wx[v] - shipX;
          const vdz = a._wz[v] - shipZ;
          const lz = vdx * fx + vdz * fz;
          if (lz > -8.98 && lz < 9.12) {
            const lx = vdx * px + vdz * pz;
            const hb = hullHalfBeamAt(THREE.MathUtils.clamp(lz, -8.85, 8.98));
            if (Math.abs(lx) < hb + 0.01) {
              hullPinched = true;
              break;
            }
          }
        }
        if (hullPinched) {
          a.submerging = true;
          continue;
        }
      }

      // Check residual exact SAT polygon pinch
      const cx = Math.floor(a.x * invCell);
      const cz = Math.floor(a.z * invCell);
      for (let ox = -1; ox <= 1 && !a.submerging; ox++) {
        for (let oz = -1; oz <= 1 && !a.submerging; oz++) {
          const key = (cx + ox + 32768) * 65536 + (cz + oz + 32768);
          const bucket = grid.get(key);
          if (!bucket) continue;
          for (let bIdx = 0; bIdx < bucket.length; bIdx++) {
            const j = bucket[bIdx];
            if (j <= i) continue;
            const b = floes[j];
            if (b.submerging) continue;
            const maxD = a.radius + b.radius + 0.01;
            const dx = b.x - a.x;
            const dz = b.z - a.z;
            if (dx * dx + dz * dz >= maxD * maxD) continue;
            if (satTestPolys(a, b, 0.005)) {
              if (a.mass <= b.mass) {
                a.submerging = true;
                break;
              } else {
                b.submerging = true;
              }
            }
          }
        }
      }
    }
  }

  /**
   * Updates all instanced 3D beveled ice slabs & shattered splinters.
   */
  _updateFloeInstances(dt, shipX, shipZ, heading, speed, impactPulse = 0) {
    if (dt > 0) {
      this._resolveFloeCollisions(dt, shipX, shipZ, heading, speed, impactPulse, 10);
    }

    const poolCount = this.floePools.length;
    const counts = new Array(poolCount).fill(0);
    const dummy = this._dummy;
    const speedNorm = Math.min(1.2, Math.abs(speed) / 7.2);
    const waveRate = 3.0 + Math.max(0.2, speedNorm) * 3.6;
    const spine = this._wakeSpineSamples;

    for (let i = 0; i < this.floes.length; i++) {
      const f = this.floes[i];
      const si = f.shapeIdx;
      if (counts[si] >= this.maxFloesPerShape) continue;

      const dx = f.x - shipX;
      const dz = f.z - shipZ;
      const distSq = dx * dx + dz * dz;

      f.rotY += f.rotSpeed * dt;
      if (dt > 0) {
        if (f.calveAge !== undefined && f.calveAge < 1.0) {
          f.calveAge = Math.min(1.0, f.calveAge + dt * 1.40);
        }
        if (f.pushRock) {
          f.pushRock = Math.max(0, f.pushRock - dt * 1.50);
        }
      }

      let wakeBob = 0;
      let wakePitch = 0;
      let wakeRoll = 0;
      if (distSq < 3000 && spine.length > 0 && !f.submerging) {
        let bestD2 = 1e9;
        let bestS = null;
        for (let k = 0; k < spine.length; k++) {
          const sp = spine[k];
          const sx = f.x - sp.x;
          const sz = f.z - sp.z;
          const d2 = sx * sx + sz * sz;
          if (d2 < bestD2) {
            bestD2 = d2;
            bestS = sp;
          }
        }
        if (bestS && bestD2 < 72) {
          const sAft = Math.max(0, bestS.sAft);
          const lat = (f.x - bestS.x) * bestS.px + (f.z - bestS.z) * bestS.pz;
          const absLat = Math.abs(lat);
          const sideSign = lat >= 0 ? 1 : -1;
          const cuspLat = 1.48 + sAft * 0.31;
          const armEnv = Math.exp(-Math.pow((absLat - cuspLat) / (1.25 + sAft * 0.09), 2));
          const transEnv = Math.exp(-Math.pow(absLat / (cuspLat * 0.95 + 0.8), 2)) * Math.max(0, 1 - sAft / 42);
          const aftDecay = Math.max(0, 1 - sAft / 50);
          const amp = (0.35 + speedNorm * 0.85) * aftDecay;

          const pDiv = sAft * 0.88 - absLat * 1.18 - this._time * waveRate;
          const pTrans = sAft * 0.92 - this._time * (waveRate * 0.88);
          const waveVal = (Math.sin(pDiv) * armEnv * 0.72 + Math.sin(pTrans) * transEnv * 0.52) * amp;
          const slopeVal = (Math.cos(pDiv) * armEnv * 0.85 + Math.cos(pTrans) * transEnv * 0.55) * amp;

          wakeBob = Math.max(-0.012, waveVal * 0.108) + Math.max(0, armEnv + transEnv) * 0.020 * amp;
          wakePitch = slopeVal * 0.095;
          wakeRoll = -Math.cos(pDiv) * armEnv * sideSign * amp * 0.115;
        }
      }

      // Dramatic initial bow-wedge lever tip-over & buoyant rebound as slab splits off the white ice!
      const calveAge = f.calveAge !== undefined ? f.calveAge : 1.0;
      const calveEnv = Math.pow(1.0 - calveAge, 1.5);
      const calveDip = -Math.sin(calveAge * Math.PI) * 0.068 * calveEnv;
      const calveRoll = (f.calveDir || 1) * calveEnv * Math.cos(calveAge * 4.8) * 0.44;
      const calvePitch = calveEnv * 0.25;
      const calveScale = THREE.MathUtils.smoothstep(calveAge, 0.0, 0.14) * 0.24 + 0.76;

      // Tactile rocking & splash lift when actively wedged/shoved aside by the moving steel hull
      const rock = f.pushRock || 0;
      const pushRoll = (f.side || 1) * rock * Math.sin(this._time * 7.2 + f.phase) * 0.20;
      const pushBob = rock * 0.026;

      const subT = f.submerging ? Math.min(1, f.submergeProg) : 0;
      const scaleMod = (1.0 - subT * 0.65) * calveScale;
      const yBase = f.kind === 'brash' ? 0.022 : 0.028;
      const bobY = yBase + Math.sin(this._time * 1.3 + f.phase) * 0.016 + wakeBob + calveDip + pushBob - subT * 0.24;
      const yScale = (f.kind === 'brash' ? 0.78 : 0.88) * scaleMod;

      dummy.position.set(f.x, bobY, f.z);
      dummy.rotation.set(
        f.tilt + Math.sin(this._time * 1.1 + f.phase) * 0.024 + wakePitch + calvePitch + subT * 0.35,
        f.rotY,
        Math.cos(this._time * 0.9 + f.phase) * 0.024 + wakeRoll + calveRoll + pushRoll
      );
      dummy.scale.set(f.scaleX * scaleMod, yScale, f.scaleZ * scaleMod);
      dummy.updateMatrix();
      this.floePools[si].setMatrixAt(counts[si]++, dummy.matrix);
    }

    for (let s = 0; s < poolCount; s++) {
      this.floePools[s].count = counts[s];
      this.floePools[s].instanceMatrix.needsUpdate = true;
    }
  }

  update(dt, physics) {
    const clampedDt = Math.min(dt, 0.05);
    this._time += clampedDt;

    this.iceMesh.position.x = physics.x;
    this.iceMesh.position.z = physics.z;
    this.waterMesh.position.x = physics.x;
    this.waterMesh.position.z = physics.z;

    const fx = Math.sin(physics.heading);
    const fz = Math.cos(physics.heading);
    const rx = Math.cos(physics.heading);
    const rz = -Math.sin(physics.heading);
    const speedNorm = Math.min(1.2, Math.abs(physics.speed) / 6.2);
    const impactPulse = physics.iceImpactPulse || 0.0;

    this.iceMat.uniforms.uShipPos.value.set(physics.x, 0, physics.z);
    this.waterMat.uniforms.uTime.value = this._time;
    this.waterMat.uniforms.uShipPos.value.set(physics.x, 0, physics.z);
    this.waterMat.uniforms.uShipForward.value.set(fx, fz);
    this.waterMat.uniforms.uShipRight.value.set(rx, rz);
    this.waterMat.uniforms.uShipSpeed.value = speedNorm;

    this.foamMat.uniforms.uTime.value = this._time;
    this.foamMat.uniforms.uThrottle.value = Math.abs(physics.throttle);
    this.foamMat.uniforms.uSpeed.value = speedNorm;
    this.foamMat.uniforms.uRudder.value = physics.rudder || 0.0;
    this.foamMat.uniforms.uImpactPulse.value = impactPulse;

    // Handle bow/shoulder ice-impact events -> chip fresh shards & shove bow ice cluster outward!
    const impactEv = typeof physics.consumeImpactEvent === 'function' ? physics.consumeImpactEvent() : null;
    if (impactEv) {
      this._spawnBowImpactShards(physics.x, physics.z, physics.heading, physics.speed, impactEv.strength, impactEv.sideSign || 0);
    }

    // Advance the persistent carved bow pocket & spine ONLY when actually breaking ice forward
    // at the channel frontier (never folds backward if ramming a side wall far astern, and holds firm on low-speed bumps!)
    let channelChanged = false;
    const bowTipX = physics.x + fx * POCKET_TIP_Z;
    const bowTipZ = physics.z + fz * POCKET_TIP_Z;
    const bowOutsideCarved = !this._isPointInCarvedWater(bowTipX, bowTipZ, 0.02);
    const headFx = Math.sin(this.carvedHead.heading);
    const headFz = Math.cos(this.carvedHead.heading);
    const forwardPastHead = (physics.x - this.carvedHead.x) * headFx + (physics.z - this.carvedHead.z) * headFz;

    if (physics.isBreakingIce && physics.speed > 0.06 && bowOutsideCarved && forwardPastHead >= -1.8) {
      const stepDist = Math.hypot(physics.x - this._prevCarvedPos.x, physics.z - this._prevCarvedPos.z);
      this.carvedHead.x = physics.x;
      this.carvedHead.z = physics.z;
      this.carvedHead.heading = physics.heading;
      this._prevCarvedPos.x = physics.x;
      this._prevCarvedPos.z = physics.z;
      channelChanged = true;

      // Continuous bow-fracture calving: every ~0.62m of solid ice broken, split off a prominent angular
      // ice slab right at the bow shoulder plus occasional sharp bow-tip splinters on the opposite side!
      this._calveAccum += Math.min(stepDist, 1.5);
      while (this._calveAccum >= 0.62) {
        this._calveAccum -= 0.62;
        this._calveSide = -this._calveSide;
        const preferSlab = seededRand(this._shardSeedCounter * 13.3) > 0.28;
        this._calveBowChunk(physics.x, physics.z, physics.heading, physics.speed, this._calveSide, 0.48 + speedNorm * 0.50, preferSlab);
        if (seededRand(this._shardSeedCounter * 19.7) > 0.58) {
          this._calveBowChunk(physics.x, physics.z, physics.heading, physics.speed, -this._calveSide, 0.38 + speedNorm * 0.38, false);
        }
      }

      const last = this.nodes[this.nodes.length - 1];
      const anchorX = physics.x + fx * POCKET_ANCHOR_Z;
      const anchorZ = physics.z + fz * POCKET_ANCHOR_Z;
      const distFromLast = Math.hypot(anchorX - last.x, anchorZ - last.z);
      const forwardPastLast = (anchorX - last.x) * Math.sin(last.heading) + (anchorZ - last.z) * Math.cos(last.heading);

      if (distFromLast >= this.nodeSpacing && (forwardPastLast > 0.55 || physics.bowContact > 0.5)) {
        this._appendNode(anchorX, anchorZ, physics.heading, false, physics.x, physics.z, physics.heading);
        this._advanceCracks(false);
      }
    }

    if (this._cracksDirty || this._hasGrowingCracks) {
      this._uploadCrackGeometry();
    }

    if (channelChanged) {
      this._rebuildChannelMeshes();
    }
    this._updateFoamRibbon(physics.x, physics.z, physics.heading);
    this._updateFloeInstances(clampedDt, physics.x, physics.z, physics.heading, physics.speed, impactPulse);
  }
}
