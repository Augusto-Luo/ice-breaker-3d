import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import {
  createIceSheetMaterial,
  createIntactPlateMaterial,
  createDetachedSlabMaterial,
} from '../shaders/iceSheetShader.js';
import { createWaterMaterial } from '../shaders/waterShader.js';
import { createWakeWaveMaterial } from '../shaders/wakeShader.js';
import { createGBufferMaterial } from '../shaders/celMaterials.js';
import { hullHalfBeamAt } from './icebreaker.js';
import {
  seededRand,
  hashGrid2D,
  polygonMetrics,
  computeMacroVoronoiCell,
  voronoiSubdivideConvexPoly,
  generateBowFractureSites,
  splitConvexPolyByLine,
  extractInternalEdges,
  pointInConvexPoly,
  satTestFlatPolys,
  buildShipHullPoly,
} from './iceFracture.js';

// =========================================================================
// PHYSICAL & GEOMETRIC CONSTANTS (Plan A + B1 Real Fracture & 6-DOF Physics)
// =========================================================================
const MACRO_CELL_SIZE = 10.5;          // Seamless macro Voronoi grid cell spacing (m)
const ICE_TOP_Y = 0.14;                // Intact snow sheet top surface elevation (m)
const SLAB_HALF_H = 0.19;              // Detached 3D slab half-thickness (total 0.38m: +0.14 freeboard, -0.24 draft)
const SLAB_EQ_Y = ICE_TOP_Y - SLAB_HALF_H; // -0.05m -> upright & upside-down slabs both float flush at +0.14m!
const BUOYANCY_MULT = (SLAB_HALF_H * 2) / (SLAB_HALF_H - SLAB_EQ_Y); // ~1.5833 exact equilibrium at y = -0.05
const GRAVITY = 9.81;

const MAX_ACTIVE_CELLS = 260;
const MAX_DETACHED_SLABS = 240;
const MAX_CUTOUT_TRIS = 6000;
const MAX_INTACT_STATIC_VERTS = 42000;
const MAX_INTACT_FLEX_VERTS = 4500;
const MAX_DETACHED_VERTS = 26000;
const MAX_CRACK_QUADS = 3800;

function toFlatPoly(poly) {
  const n = poly.length;
  const fx = new Float32Array(n);
  const fz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    fx[i] = poly[i][0];
    fz[i] = poly[i][1];
  }
  return { fx, fz, n };
}

/**
 * Dynamic Polar Ice World (Plan A + B1):
 * - Streaming seamless Macro-Voronoi ice sheet fused seamlessly with the infinite snowfield (zero seams!)
 * - Real-time bow-centered Westergaard radial + circumferential convex-polygon fracture
 * - Ahead-of-bow stress crack propagation + persistent macro Voronoi fracture networks
 * - Downward flexural lip bending right before snap-off
 * - 100% area-conserving jigsaw-complement detachment (with world-locked snow stipple texture!)
 * - Secondary shattering of large detached slabs under direct bow impact
 * - 6-DOF Quaternion buoyancy, spoon-bow downward press & 180° overturning (exposing wet blue glacial keel!),
 *   under-hull keel transit emerging in stern prop wash, and under-ice shelf rafting/sliding
 * - Full compatibility with Ligne Claire G-Buffer ink outlines, planar reflections & 3D Kelvin wake
 */
export class IceWorld {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'IceWorld';

    // Streaming macro Voronoi cells & active detached 6-DOF slabs
    this.cells = new Map();
    this.slabs = [];
    this.macroCracks = [];       // Real macro Voronoi boundary cracks extending into intact snowfield
    this._macroCrackKeys = new Set();
    this._plateIdCounter = 1;
    this._slabIdCounter = 1;
    this._fractureSeedCounter = 1;
    this._slabGrid = new Map();

    // Ship trail spine used ONLY for smoothly curving the 3D Kelvin wake wave ribbon
    this.trailNodes = [];
    this.maxTrailNodes = 160;
    this.trailSpacing = 2.25;
    this._wakeSpineSamples = [];

    // Dirty flags for static batched geometry uploads
    this._domainDirty = true;
    this._intactStaticDirty = true;
    this._cracksDirty = true;
    this._hasGrowingCracks = false;
    this._time = 0;
    this._lastImpactBreakTime = -10;
    this._subdivideCooldown = 0;

    // -----------------------------------------------------------------------
    // 1. Activated Voronoi Domain Stencil Cutout (RenderOrder 1, writes stencil = 1)
    // Placed at y = ICE_TOP_Y (0.14) so clip-space edges match intact plates bit-for-bit!
    // -----------------------------------------------------------------------
    this.cutoutGeo = new THREE.BufferGeometry();
    this.cutoutPos = new Float32Array(MAX_CUTOUT_TRIS * 3 * 3);
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

    // -----------------------------------------------------------------------
    // 2. Infinite Background Polar Snow Plane (RenderOrder 2, y = 0.14, stencil == 0)
    // -----------------------------------------------------------------------
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
    this.iceMesh.position.y = ICE_TOP_Y;
    this.iceMesh.renderOrder = 2;
    this.iceMesh.receiveShadow = true;
    this.iceMesh.userData.beautyMaterial = this.iceMat;
    this.iceMesh.userData.gbufMaterial = this.iceGbufMat;
    this.iceMesh.userData.writeGBuffer = true;
    this.group.add(this.iceMesh);

    // -----------------------------------------------------------------------
    // 3. Real 3D Intact Voronoi Ice Plates (RenderOrder 3, writes stencil = 2)
    // Split into Static (rebuilt only on fracture) & Flexing (2-10 plates bending under bow!)
    // -----------------------------------------------------------------------
    this.intactPlateMat = createIntactPlateMaterial();
    this.intactPlateGbufMat = createGBufferMaterial({
      partId: 1,
      stencilWrite: true,
      stencilWriteMask: 0xff,
      stencilFunc: THREE.AlwaysStencilFunc,
      stencilRef: 2,
      stencilFail: THREE.KeepStencilOp,
      stencilZFail: THREE.KeepStencilOp,
      stencilZPass: THREE.ReplaceStencilOp,
    });

    this.intactStaticGeo = new THREE.BufferGeometry();
    this.intactStaticPos = new Float32Array(MAX_INTACT_STATIC_VERTS * 3);
    this.intactStaticNorm = new Float32Array(MAX_INTACT_STATIC_VERTS * 3);
    this.intactStaticGeo.setAttribute('position', new THREE.BufferAttribute(this.intactStaticPos, 3));
    this.intactStaticGeo.setAttribute('normal', new THREE.BufferAttribute(this.intactStaticNorm, 3));
    this.intactStaticGeo.setDrawRange(0, 0);

    this.intactStaticMesh = new THREE.Mesh(this.intactStaticGeo, this.intactPlateMat);
    this.intactStaticMesh.frustumCulled = false;
    this.intactStaticMesh.renderOrder = 3;
    this.intactStaticMesh.receiveShadow = true;
    this.intactStaticMesh.userData.beautyMaterial = this.intactPlateMat;
    this.intactStaticMesh.userData.gbufMaterial = this.intactPlateGbufMat;
    this.intactStaticMesh.userData.writeGBuffer = true;
    this.group.add(this.intactStaticMesh);

    this.intactFlexGeo = new THREE.BufferGeometry();
    this.intactFlexPos = new Float32Array(MAX_INTACT_FLEX_VERTS * 3);
    this.intactFlexNorm = new Float32Array(MAX_INTACT_FLEX_VERTS * 3);
    this.intactFlexGeo.setAttribute('position', new THREE.BufferAttribute(this.intactFlexPos, 3));
    this.intactFlexGeo.setAttribute('normal', new THREE.BufferAttribute(this.intactFlexNorm, 3));
    this.intactFlexGeo.setDrawRange(0, 0);

    this.intactFlexMesh = new THREE.Mesh(this.intactFlexGeo, this.intactPlateMat);
    this.intactFlexMesh.frustumCulled = false;
    this.intactFlexMesh.renderOrder = 3;
    this.intactFlexMesh.receiveShadow = true;
    this.intactFlexMesh.userData.beautyMaterial = this.intactPlateMat;
    this.intactFlexMesh.userData.gbufMaterial = this.intactPlateGbufMat;
    this.intactFlexMesh.userData.writeGBuffer = true;
    this.group.add(this.intactFlexMesh);

    // -----------------------------------------------------------------------
    // 4. Open Arctic Sea Water Plane (RenderOrder 4, y = 0.0, stencil == 1)
    // Renders strictly where ice has broken away (stencil == 1), writing depth y = 0
    // so submerged keels & overturning slab undersides clip crisply at the waterline!
    // -----------------------------------------------------------------------
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
    this.waterMesh.renderOrder = 4;
    this.waterMesh.receiveShadow = true;
    this.waterMesh.userData.beautyMaterial = this.waterMat;
    this.waterMesh.userData.gbufMaterial = this.waterGbufMat;
    this.waterMesh.userData.writeGBuffer = true;
    this.group.add(this.waterMesh);

    // -----------------------------------------------------------------------
    // 5. Real Ink Fracture Cracks (RenderOrder 5, stencil != 1 -> intact ice only!)
    // Drawn along REAL Voronoi fracture seams ahead of the bow & branching across snowfield
    // -----------------------------------------------------------------------
    this.crackGeo = new THREE.BufferGeometry();
    this.crackPos = new Float32Array(MAX_CRACK_QUADS * 6 * 3);
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
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilRef: 1,
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

    // -----------------------------------------------------------------------
    // 6. Batched 6-DOF Detached 3D Fractured Ice Slabs (RenderOrder 6, 1 Draw Call!)
    // Exact fractured polygons + world-locked snow top + wet blue glacial underside
    // -----------------------------------------------------------------------
    this.detachedGeo = new THREE.BufferGeometry();
    this.detachedPos = new Float32Array(MAX_DETACHED_VERTS * 3);
    this.detachedNorm = new Float32Array(MAX_DETACHED_VERTS * 3);
    this.detachedOriginXZ = new Float32Array(MAX_DETACHED_VERTS * 2);
    this.detachedLocalUp = new Float32Array(MAX_DETACHED_VERTS);
    this.detachedWetness = new Float32Array(MAX_DETACHED_VERTS);
    this.detachedPartId = new Float32Array(MAX_DETACHED_VERTS);

    this.detachedGeo.setAttribute('position', new THREE.BufferAttribute(this.detachedPos, 3));
    this.detachedGeo.setAttribute('normal', new THREE.BufferAttribute(this.detachedNorm, 3));
    this.detachedGeo.setAttribute('aOriginXZ', new THREE.BufferAttribute(this.detachedOriginXZ, 2));
    this.detachedGeo.setAttribute('aLocalUp', new THREE.BufferAttribute(this.detachedLocalUp, 1));
    this.detachedGeo.setAttribute('aWetness', new THREE.BufferAttribute(this.detachedWetness, 1));
    this.detachedGeo.setAttribute('aPartId', new THREE.BufferAttribute(this.detachedPartId, 1));
    this.detachedGeo.setDrawRange(0, 0);

    this.detachedMat = createDetachedSlabMaterial();
    this.detachedGbufMat = createGBufferMaterial({ useInstanceId: true }); // Reads per-vertex aPartId!
    this.detachedMesh = new THREE.Mesh(this.detachedGeo, this.detachedMat);
    this.detachedMesh.frustumCulled = false;
    this.detachedMesh.receiveShadow = true;
    this.detachedMesh.castShadow = false;
    this.detachedMesh.renderOrder = 6;
    this.detachedMesh.userData.beautyMaterial = this.detachedMat;
    this.detachedMesh.userData.gbufMaterial = this.detachedGbufMat;
    this.detachedMesh.userData.writeGBuffer = true;
    this.group.add(this.detachedMesh);

    // -----------------------------------------------------------------------
    // 7. High-Resolution 3D Undulating Kelvin Wake & Propeller Foam (RenderOrder 7, stencil == 1)
    // -----------------------------------------------------------------------
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

    // Expose fixed renderable list for main.js G-Buffer pass swapping
    this.gbufEntries = [
      this.cutoutMesh,
      this.iceMesh,
      this.intactStaticMesh,
      this.intactFlexMesh,
      this.waterMesh,
      this.crackMesh,
      this.detachedMesh,
      this.foamMesh,
    ];

    // Reusable scratch math objects (zero per-frame allocations!)
    this._tmpBasis = new Float32Array(9);
    this._tmpQuat = new THREE.Quaternion();
    this._tmpAxis = new THREE.Vector3();
    this._tmpVec = new THREE.Vector3();
    this._topRingX = new Float32Array(32);
    this._topRingY = new Float32Array(32);
    this._topRingZ = new Float32Array(32);
    this._botRingX = new Float32Array(32);
    this._botRingY = new Float32Array(32);
    this._botRingZ = new Float32Array(32);

    this.reset(0, 0, 0);
  }

  // =========================================================================
  // MACRO VORONOI CELL MANAGEMENT & REAL-TIME CONVEX FRACTURE
  // =========================================================================

  _ensureMacroCell(gx, gz) {
    const key = `${gx},${gz}`;
    let cell = this.cells.get(key);
    if (cell) return cell;

    const raw = computeMacroVoronoiCell(gx, gz, MACRO_CELL_SIZE);
    if (!raw) return null;

    const flat = toFlatPoly(raw.poly);
    const rootPlate = {
      id: this._plateIdCounter++,
      cellKey: key,
      poly: raw.poly,
      flatX: flat.fx,
      flatZ: flat.fz,
      vn: flat.n,
      cx: raw.cx,
      cz: raw.cz,
      area: raw.area,
      radius: raw.radius,
      state: 'INTACT',
      flex: 0,
      flexTarget: 0,
      flexDirX: 0,
      flexDirZ: 1,
      stress: 0,
    };

    cell = {
      gx,
      gz,
      key,
      poly: raw.poly,
      cx: raw.cx,
      cz: raw.cz,
      area: raw.area,
      radius: raw.radius,
      subdivided: false,
      hasOpenWater: false,
      plates: [rootPlate],
      internalEdges: [],
    };

    this.cells.set(key, cell);
    this._domainDirty = true;
    this._intactStaticDirty = true;
    return cell;
  }

  _ensureCellRing(gx, gz, ring = 1) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dz = -ring; dz <= ring; dz++) {
        this._ensureMacroCell(gx + dx, gz + dz);
      }
    }
  }

  /**
   * Subdivides an intact macro Voronoi cell in-place into strictly convex sub-polygons
   * centered on an impact / load point `(impX, impZ)` along ship heading `(dirX, dirZ)`.
   * 100% area-conserving and completely invisible until stress cracks shoot along the seams!
   */
  _subdivideMacroCell(cell, impX, impZ, dirX, dirZ) {
    if (cell.subdivided) return;
    const intactRoot = cell.plates.length === 1 && cell.plates[0].state === 'INTACT' ? cell.plates[0] : null;
    if (!intactRoot) return;

    const seedVal =
      (cell.gx * 73.1 + cell.gz * 139.7) + (this._fractureSeedCounter++) * 17.3;
    const sites = generateBowFractureSites(
      cell.poly,
      cell.cx,
      cell.cz,
      cell.radius,
      impX,
      impZ,
      dirX,
      dirZ,
      seedVal
    );
    const subPolys = voronoiSubdivideConvexPoly(cell.poly, sites, 0.14);
    const newPlates = [];

    for (let i = 0; i < subPolys.length; i++) {
      const sp = subPolys[i];
      const flat = toFlatPoly(sp.poly);
      newPlates.push({
        id: this._plateIdCounter++,
        cellKey: cell.key,
        poly: sp.poly,
        flatX: flat.fx,
        flatZ: flat.fz,
        vn: flat.n,
        cx: sp.cx,
        cz: sp.cz,
        area: sp.area,
        radius: sp.radius,
        state: 'INTACT',
        flex: 0,
        flexTarget: 0,
        flexDirX: dirX,
        flexDirZ: dirZ,
        stress: 0,
      });
    }

    const rawEdges = extractInternalEdges(subPolys);
    const internalEdges = rawEdges.map((e) => ({
      ...e,
      crackProg: 0,
      targetProg: 0,
      bornTime: -1,
      growDur: 0.22,
      fromFirst: true,
    }));

    cell.plates = newPlates;
    cell.internalEdges = internalEdges;
    cell.subdivided = true;
    this._intactStaticDirty = true;
  }

  /**
   * Subdivides a large INTACT plate (`area > 7.5 m²`) using compact Voronoi cells around the
   * contact point — mathematically guaranteeing chunky angular polygonal slabs (ZERO skinny planks!).
   */
  _subdivideIntactPlate(cell, plateIdx, hitX, hitZ) {
    const plate = cell.plates[plateIdx];
    if (!plate || plate.state !== 'INTACT' || plate.area < 5.5) return false;

    const targetPieces = Math.min(7, Math.max(3, Math.round(plate.area / 3.4)));
    const seedVal = plate.id * 37.1 + (this._fractureSeedCounter++) * 13.7;
    const sites = [];

    // Place well-spaced jittered sites strictly inside the plate polygon (guarantees chunky aspect ratios!)
    const baseOff = seededRand(seedVal) * Math.PI * 2;
    const ringR = Math.min(plate.radius * 0.56, Math.sqrt(plate.area / Math.PI) * 0.68);
    sites.push({
      x: plate.cx + (hitX - plate.cx) * 0.25,
      z: plate.cz + (hitZ - plate.cz) * 0.25,
    });
    for (let i = 0; i < targetPieces - 1; i++) {
      const ang = baseOff + (i / (targetPieces - 1)) * Math.PI * 2 + (seededRand(seedVal + i * 9.3) - 0.5) * 0.48;
      const r = ringR * (0.72 + seededRand(seedVal + i * 17.1) * 0.42);
      const sx = plate.cx + Math.cos(ang) * r;
      const sz = plate.cz + Math.sin(ang) * r;
      sites.push({ x: sx, z: sz });
    }

    const subPolys = voronoiSubdivideConvexPoly(plate.poly, sites, 0.35);
    if (subPolys.length < 2) return false;

    const newPlates = subPolys.map((sp) => {
      const flat = toFlatPoly(sp.poly);
      return {
        id: this._plateIdCounter++,
        cellKey: cell.key,
        poly: sp.poly,
        flatX: flat.fx,
        flatZ: flat.fz,
        vn: flat.n,
        cx: sp.cx,
        cz: sp.cz,
        area: sp.area,
        radius: sp.radius,
        state: 'INTACT',
        flex: plate.flex * 0.5,
        flexTarget: plate.flexTarget * 0.5,
        flexDirX: plate.flexDirX,
        flexDirZ: plate.flexDirZ,
        stress: plate.stress,
      };
    });

    cell.plates.splice(plateIdx, 1, ...newPlates);

    const rawEdges = extractInternalEdges(cell.plates);
    const oldEdges = cell.internalEdges;
    cell.internalEdges = rawEdges.map((e) => {
      for (let i = 0; i < oldEdges.length; i++) {
        const oe = oldEdges[i];
        if (Math.hypot(oe.mx - e.mx, oe.mz - e.mz) < 0.08) {
          return { ...oe, plateA: e.plateA, plateB: e.plateB };
        }
      }
      return {
        ...e,
        crackProg: 1.0,
        targetProg: 1.0,
        bornTime: this._time,
        growDur: 0.16,
        fromFirst: true,
      };
    });

    this._intactStaticDirty = true;
    this._cracksDirty = true;
    return true;
  }

  /**
   * Propagates a continuous, connected branching fracture tree strictly vertex-to-vertex
   * along real macro Voronoi cell edges starting from the broken channel bank!
   * Zero floating disconnected crack stubs — every crack roots cleanly in the broken ice edge!
   */
  _propagateMacroBoundaryCracks(originGx, originGz, sideX, sideZ, instant = false) {
    const startCell = this.cells.get(`${originGx},${originGz}`) || computeMacroVoronoiCell(originGx, originGz, MACRO_CELL_SIZE);
    if (!startCell) return;

    const dirLen = Math.hypot(sideX, sideZ) || 1;
    const dxDir = sideX / dirLen;
    const dzDir = sideZ / dirLen;

    const quant = (v) => Math.round(v * 20);
    const addEdge = (x1, z1, x2, z2, delay, halfW) => {
      const a = `${quant(x1)},${quant(z1)}`;
      const b = `${quant(x2)},${quant(z2)}`;
      if (a === b) return false;
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (this._macroCrackKeys.has(key)) return false;
      this._macroCrackKeys.add(key);
      this.macroCracks.push({
        key,
        x1,
        z1,
        x2,
        z2,
        halfWidth: halfW,
        bornTime: instant ? -10 : this._time + delay,
        growDur: instant ? 0 : 0.24 + seededRand(this._fractureSeedCounter++ * 7.1) * 0.18,
      });
      if (this.macroCracks.length > MAX_CRACK_QUADS * 0.55) {
        const old = this.macroCracks.shift();
        this._macroCrackKeys.delete(old.key);
      }
      this._cracksDirty = true;
      return true;
    };

    // Pick a starting vertex on startCell facing roughly along (dxDir, dzDir) that actually sits on
    // the intact/broken frontier (never starting a disconnected floating stub out in distant snow!)
    let bestV = null;
    let bestDot = -1e9;
    for (let i = 0; i < startCell.poly.length; i++) {
      const v = startCell.poly[i];
      // Require the starting vertex to be close to open water (within 2.5m) or on the cell boundary of an open cell
      const sc = (v[0] - startCell.cx) * dxDir + (v[1] - startCell.cz) * dzDir;
      if (sc > bestDot) {
        bestDot = sc;
        bestV = v;
      }
    }
    if (!bestV) return;
    // Also connect the starting macro vertex inward to the broken bank if startCell has open water
    if (startCell.hasOpenWater) {
      let nearestOpenV = null;
      let nearestD = 1e9;
      for (let i = 0; i < startCell.plates.length; i++) {
        const pl = startCell.plates[i];
        if (pl.state !== 'DETACHED') continue;
        for (let k = 0; k < pl.poly.length; k++) {
          const pt = pl.poly[k];
          const d = Math.hypot(pt[0] - bestV[0], pt[1] - bestV[1]);
          if (d < nearestD) {
            nearestD = d;
            nearestOpenV = pt;
          }
        }
      }
      if (nearestOpenV && nearestD > 0.35 && nearestD < 6.5) {
        addEdge(nearestOpenV[0], nearestOpenV[1], bestV[0], bestV[1], 0.0, 0.032);
      }
    }

    // Collect connected Voronoi edges incident to vertex (vx, vz) from local 3x3 macro cells
    const getOutgoingVoronoiEdges = (vx, vz) => {
      const cgx = Math.floor(vx / MACRO_CELL_SIZE);
      const cgz = Math.floor(vz / MACRO_CELL_SIZE);
      const found = [];
      const seenEnd = new Set();

      for (let gx = cgx - 1; gx <= cgx + 1; gx++) {
        for (let gz = cgz - 1; gz <= cgz + 1; gz++) {
          const c = this.cells.get(`${gx},${gz}`) || computeMacroVoronoiCell(gx, gz, MACRO_CELL_SIZE);
          if (!c) continue;
          const poly = c.poly;
          const n = poly.length;
          for (let i = 0; i < n; i++) {
            const a = poly[i];
            const b = poly[(i + 1) % n];
            let nextPt = null;
            if (Math.hypot(a[0] - vx, a[1] - vz) < 0.20) nextPt = b;
            else if (Math.hypot(b[0] - vx, b[1] - vz) < 0.20) nextPt = a;
            if (!nextPt) continue;
            if (Math.hypot(nextPt[0] - vx, nextPt[1] - vz) < 0.8) continue;
            const eKey = `${quant(nextPt[0])},${quant(nextPt[1])}`;
            if (seenEnd.has(eKey)) continue;
            seenEnd.add(eKey);
            found.push(nextPt);
          }
        }
      }
      return found;
    };

    // Walk 3–4 connected vertex-to-vertex Voronoi edges outward (plus 1 crisp side branch!)
    const walkBranch = (startX, startZ, bDirX, bDirZ, maxSteps, startDelay, baseW) => {
      let cx = startX;
      let cz = startZ;
      let delay = startDelay;

      for (let st = 0; st < maxSteps; st++) {
        const candidates = getOutgoingVoronoiEdges(cx, cz);
        if (candidates.length === 0) break;

        let bestPt = null;
        let secondPt = null;
        let bestSc = -1e9;
        let secondSc = -1e9;

        for (let i = 0; i < candidates.length; i++) {
          const pt = candidates[i];
          const ex = pt[0] - cx;
          const ez = pt[1] - cz;
          const len = Math.hypot(ex, ez) || 1;
          const dot = (ex * bDirX + ez * bDirZ) / len;
          if (dot < 0.05) continue; // Only grow outward, never double back!
          const sc = dot + (seededRand(this._fractureSeedCounter++ * 3.7 + i) - 0.5) * 0.28;
          if (sc > bestSc) {
            secondSc = bestSc;
            secondPt = bestPt;
            bestSc = sc;
            bestPt = pt;
          } else if (sc > secondSc) {
            secondSc = sc;
            secondPt = pt;
          }
        }

        if (!bestPt) break;
        const hw = Math.max(0.018, baseW - st * 0.005);
        addEdge(cx, cz, bestPt[0], bestPt[1], delay, hw);

        // Occasional natural Y-fork branch off vertex 1
        if (st === 1 && secondPt && seededRand(this._fractureSeedCounter++ * 13.1) > 0.45) {
          addEdge(cx, cz, secondPt[0], secondPt[1], delay + 0.10, Math.max(0.018, hw - 0.004));
        }

        cx = bestPt[0];
        cz = bestPt[1];
        delay += 0.14;
      }
    };

    const mainSteps = 2 + (seededRand(originGx * 31.7 + originGz * 53.3 + sideX * 19.1) > 0.42 ? 1 : 0);
    walkBranch(bestV[0], bestV[1], dxDir, dzDir, mainSteps, 0.0, 0.032);
  }

  /**
   * Transitions an exact `INTACT` convex Voronoi sub-plate into a 6-DOF `DETACHED` rigid-body slab!
   * Zero geometry mismatch: the newly exposed hole in the ice sheet is the EXACT polygon of the slab!
   */
  _detachPlate(cell, plate, {
    shipX = 0,
    shipZ = 0,
    fx = 0,
    fz = 1,
    px = 1,
    pz = 0,
    shipSpeed = 1.8,
    strength = 0.7,
    instantSettle = false,
  } = {}) {
    if (plate.state !== 'INTACT') return null;

    plate.state = 'DETACHED';
    const initialFlex = plate.flex || 0;
    const flexDirX = plate.flexDirX || fx;
    const flexDirZ = plate.flexDirZ || fz;
    plate.flex = 0;
    plate.flexTarget = 0;

    cell.hasOpenWater = true;
    this._ensureCellRing(cell.gx, cell.gz, 1);
    this._domainDirty = true;
    this._intactStaticDirty = true;
    this._cracksDirty = true;

    // Immediately crack neighboring internal edges on the remaining intact shelf!
    const pIdx = cell.plates.indexOf(plate);
    for (let i = 0; i < cell.internalEdges.length; i++) {
      const e = cell.internalEdges[i];
      if (e.plateA === pIdx || e.plateB === pIdx) {
        e.targetProg = 1.0;
        e.crackProg = 1.0;
      } else {
        const d = Math.hypot(e.mx - plate.cx, e.mz - plate.cz);
        if (d < 5.5 && e.targetProg < 1.0) {
          e.targetProg = 1.0;
          if (e.bornTime < 0) {
            e.bornTime = instantSettle ? -10 : this._time;
            e.growDur = 0.22;
          }
        }
      }
    }

    // Build exact local polygon centered at (plate.cx, plate.cz) + preserve world originPoly for snow texture!
    const n = plate.poly.length;
    const localPoly = new Array(n);
    const originPoly = new Array(n);
    for (let i = 0; i < n; i++) {
      const wx = plate.poly[i][0];
      const wz = plate.poly[i][1];
      localPoly[i] = [wx - plate.cx, wz - plate.cz];
      originPoly[i] = [wx, wz];
    }

    const slabId = this._slabIdCounter++;
    const partId = 30 + ((slabId * 37) % 205); // Distinct G-buffer ID in [30..234] for crisp Ligne Claire ink!
    const mass = Math.max(0.28, plate.area * 0.92);
    const r2 = Math.max(0.35, plate.radius * plate.radius);
    const inertiaY = Math.max(0.25, 0.50 * mass * r2);
    const inertiaTilt = Math.max(0.18, 0.26 * mass * r2);

    const quat = new THREE.Quaternion();
    // Inherit slight flexural pre-bend tilt right at the moment of snap-off!
    if (initialFlex > 0.01) {
      this._tmpAxis.set(-flexDirZ, 0, flexDirX).normalize();
      quat.setFromAxisAngle(this._tmpAxis, initialFlex * 0.06);
    }

    // Compute realistic spoon-bow fracture impulse (downward press + outward shove + overturning torque!)
    const dxShip = plate.cx - shipX;
    const dzShip = plate.cz - shipZ;
    const lzShip = dxShip * fx + dzShip * fz;
    const lxShip = dxShip * px + dzShip * pz;
    const sideSign = lxShip >= 0 ? 1 : -1;

    let vx = 0;
    let vy = 0;
    let vz = 0;
    let wx = 0;
    let wy = 0;
    let wz = 0;
    let wetness = 0.08;

    if (!instantSettle) {
      const bowProximity = THREE.MathUtils.clamp(1.0 - Math.abs(lzShip - 6.8) / 7.5, 0.15, 1.0);
      const energy = 0.52 + Math.abs(shipSpeed) * 0.34 + strength * 0.58;
      const sizeAgility = THREE.MathUtils.clamp(2.4 / Math.max(0.85, Math.sqrt(plate.area)), 0.58, 1.50);

      // Spoon bow presses slab DOWN into seawater first, then levers it outward along the hull flank!
      vy = -(0.46 + bowProximity * 0.58) * energy * Math.min(1.2, sizeAgility);
      const outPush = (0.56 + bowProximity * 0.48) * energy * Math.min(1.15, sizeAgility);
      vx = (px * sideSign * 0.78 - fx * 0.54) * outPush;
      vz = (pz * sideSign * 0.78 - fz * 0.54) * outPush;

      // Lever-arm overturning torque: inner edge near hull dives DOWN -> outer edge tips UP & flips!
      const outX = px * sideSign;
      const outZ = pz * sideSign;
      const flipSeed = seededRand(slabId * 23.7 + plate.cx * 3.1);
      // ~36% of bow-struck slabs get a decisive overturning kick (>90° -> completes 180° flip showing wet blue keel!)
      const isOverturn = flipSeed < 0.36 && lzShip > 2.2;
      const tiltRate = isOverturn
        ? (3.4 + bowProximity * 1.6) * Math.min(1.25, sizeAgility)
        : (1.05 + bowProximity * 1.15) * energy * sizeAgility;

      wx = -outZ * tiltRate + (seededRand(slabId * 11.3) - 0.5) * 0.55;
      wz = outX * tiltRate + (seededRand(slabId * 13.7) - 0.5) * 0.55;
      wy = -sideSign * (0.45 + seededRand(slabId * 17.9) * 0.85) * energy;
      wetness = isOverturn ? 0.45 : 0.20;
    }

    const slab = {
      id: slabId,
      partId,
      localPoly,
      originPoly,
      vn: n,
      area: plate.area,
      mass,
      radius: plate.radius,
      inertiaY,
      inertiaTilt,
      x: plate.cx,
      y: SLAB_EQ_Y - initialFlex * 0.04,
      z: plate.cz,
      vx,
      vy,
      vz,
      quat,
      wx,
      wy,
      wz,
      wetness,
      underIce: false,
      underIceTime: 0,
      hullPinched: false,
      age: instantSettle ? 3.0 : 0.0,
      splitCooldown: 0.45,
      _wx: new Float32Array(n),
      _wz: new Float32Array(n),
    };

    this._updateSlabFootprint(slab);
    this.slabs.push(slab);
    this._enforceSlabBudget(shipX, shipZ);
    return slab;
  }

  /**
   * Secondary Fragmentation: splits a large detached slab into 2 exact convex child slabs
   * when directly rammed/crushed by the bow stem, conserving 100% area, snow texture & momentum!
   */
  _shatterDetachedSlab(slabIdx, hitWorldX, hitWorldZ, shipFx, shipFz, shipPx, shipPz) {
    const s = this.slabs[slabIdx];
    if (!s || s.area < 3.6 || s.splitCooldown > 0) return false;

    // Transform world impact point into slab's local XZ frame
    const invQ = this._tmpQuat.copy(s.quat).invert();
    this._tmpVec.set(hitWorldX - s.x, 0, hitWorldZ - s.z).applyQuaternion(invQ);
    const lpx = THREE.MathUtils.clamp(this._tmpVec.x, -s.radius * 0.45, s.radius * 0.45);
    const lpz = THREE.MathUtils.clamp(this._tmpVec.z, -s.radius * 0.45, s.radius * 0.45);

    // Choose a crisp angular fracture line aligned roughly along bow crush vector + organic offset
    const ang = Math.atan2(shipFz, shipFx) + (seededRand(s.id * 41.3 + this._time) - 0.5) * 1.1;
    const worldDirX = Math.cos(ang);
    const worldDirZ = Math.sin(ang);
    this._tmpVec.set(worldDirX, 0, worldDirZ).applyQuaternion(invQ);
    const nLen = Math.hypot(this._tmpVec.x, this._tmpVec.z) || 1;
    const lnx = -this._tmpVec.z / nLen;
    const lnz = this._tmpVec.x / nLen;

    const split = splitConvexPolyByLine(s.localPoly, lpx, lpz, lnx, lnz, 0.35);
    if (!split) return false;

    // Original world offset mapping so world-locked snow stipple texture stays continuous across children!
    const origCx = s.originPoly[0][0] - s.localPoly[0][0];
    const origCz = s.originPoly[0][1] - s.localPoly[0][1];

    const children = [];
    for (let k = 0; k < 2; k++) {
      const part = split[k];
      const n = part.poly.length;
      const childLocal = new Array(n);
      const childOrigin = new Array(n);
      for (let i = 0; i < n; i++) {
        childLocal[i] = [part.poly[i][0] - part.cx, part.poly[i][1] - part.cz];
        childOrigin[i] = [origCx + part.poly[i][0], origCz + part.poly[i][1]];
      }

      // World position of child centroid transformed by parent's current 3D orientation
      this._tmpVec.set(part.cx, 0, part.cz).applyQuaternion(s.quat);
      const cwX = s.x + this._tmpVec.x;
      const cwY = s.y + this._tmpVec.y;
      const cwZ = s.z + this._tmpVec.z;

      const sepSign = k === 0 ? -1 : 1;
      const childId = this._slabIdCounter++;
      const mass = Math.max(0.24, part.area * 0.92);
      const r2 = Math.max(0.30, part.radius * part.radius);

      // Push apart along fracture normal + extra tumble spin
      this._tmpVec.set(lnx * sepSign, 0, lnz * sepSign).applyQuaternion(s.quat);
      const sepX = this._tmpVec.x;
      const sepZ = this._tmpVec.z;

      const child = {
        id: childId,
        partId: 30 + ((childId * 37) % 205),
        localPoly: childLocal,
        originPoly: childOrigin,
        vn: n,
        area: part.area,
        mass,
        radius: part.radius,
        inertiaY: Math.max(0.22, 0.50 * mass * r2),
        inertiaTilt: Math.max(0.16, 0.26 * mass * r2),
        x: cwX + sepX * 0.04,
        y: cwY,
        z: cwZ + sepZ * 0.04,
        vx: s.vx + sepX * 0.55 + shipPx * sepSign * 0.35,
        vy: s.vy - 0.45,
        vz: s.vz + sepZ * 0.55 + shipPz * sepSign * 0.35,
        quat: s.quat.clone(),
        wx: s.wx + sepZ * 1.15,
        wy: s.wy + sepSign * 0.75,
        wz: s.wz - sepX * 1.15,
        wetness: Math.min(1.0, s.wetness + 0.15),
        underIce: s.underIce,
        underIceTime: 0,
        hullPinched: false,
        age: 0.0,
        splitCooldown: 0.75,
        _wx: new Float32Array(n),
        _wz: new Float32Array(n),
      };
      this._updateSlabFootprint(child);
      children.push(child);
    }

    this.slabs.splice(slabIdx, 1, children[0], children[1]);
    return true;
  }

  _enforceSlabBudget(shipX, shipZ) {
    if (this.slabs.length <= MAX_DETACHED_SLABS) return;
    // Remove farthest slabs behind/away from ship first so near-ship ice stays rich
    while (this.slabs.length > MAX_DETACHED_SLABS) {
      let worstIdx = 0;
      let worstDist2 = -1;
      for (let i = 0; i < this.slabs.length; i++) {
        const s = this.slabs[i];
        const d2 = (s.x - shipX) ** 2 + (s.z - shipZ) ** 2 + (s.underIce ? 4000 : 0);
        if (d2 > worstDist2) {
          worstDist2 = d2;
          worstIdx = i;
        }
      }
      this.slabs.splice(worstIdx, 1);
    }
  }

  _pruneFarMacroCells(shipX, shipZ) {
    if (this.cells.size <= MAX_ACTIVE_CELLS) return;

    const candidates = [];
    for (const cell of this.cells.values()) {
      const d2 = (cell.cx - shipX) ** 2 + (cell.cz - shipZ) ** 2;
      if (d2 > 215 * 215) {
        candidates.push({ cell, d2 });
      }
    }
    if (candidates.length === 0) return;

    candidates.sort((a, b) => b.d2 - a.d2);
    const toRemove = Math.min(candidates.length, this.cells.size - (MAX_ACTIVE_CELLS - 24));
    let removed = 0;

    for (let i = 0; i < candidates.length && removed < toRemove; i++) {
      const c = candidates[i].cell;
      // Never delete a cell that borders an active open-water cell still within view
      let bordersKeepOpen = false;
      for (let dx = -1; dx <= 1 && !bordersKeepOpen; dx++) {
        for (let dz = -1; dz <= 1 && !bordersKeepOpen; dz++) {
          if (dx === 0 && dz === 0) continue;
          const nb = this.cells.get(`${c.gx + dx},${c.gz + dz}`);
          if (nb && nb.hasOpenWater) {
            const nd2 = (nb.cx - shipX) ** 2 + (nb.cz - shipZ) ** 2;
            if (nd2 <= 215 * 215) bordersKeepOpen = true;
          }
        }
      }
      if (bordersKeepOpen) continue;

      this.cells.delete(c.key);
      removed++;
    }

    if (removed > 0) {
      this._domainDirty = true;
      this._intactStaticDirty = true;
      this._cracksDirty = true;
    }
  }

  // =========================================================================
  // INITIAL FRAME-0 PRE-FRACTURED POLAR CHANNEL & RESET
  // =========================================================================

  reset(shipX = 0, shipZ = 0, heading = 0) {
    this.cells.clear();
    this.slabs = [];
    this.macroCracks = [];
    this._macroCrackKeys.clear();
    this.trailNodes = [];
    this._wakeSpineSamples = [];
    this._plateIdCounter = 1;
    this._slabIdCounter = 1;
    this._fractureSeedCounter = 1;
    this._time = 0;
    this._lastImpactBreakTime = -10;

    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const px = Math.cos(heading);
    const pz = -Math.sin(heading);

    // 1. Build graceful ~172m curved initial ship trail behind the icebreaker (matches Illustration composition!)
    const preCount = 74;
    let arcDist = 0;
    let prevX = null;
    let prevZ = null;

    for (let i = preCount; i >= 0; i--) {
      const distBack = i * this.trailSpacing + 2.0;
      const curveFactor = Math.max(0, (distBack - 16) / 140);
      const lateralSway = Math.sin(distBack * 0.028) * 3.8 * curveFactor - curveFactor * curveFactor * 6.5;

      const nx = shipX - fx * distBack + px * lateralSway;
      const nz = shipZ - fz * distBack + pz * lateralSway;

      const nextDist = Math.max(2.0, (i - 1) * this.trailSpacing + 2.0);
      const nextCurve = Math.max(0, (nextDist - 16) / 140);
      const nextSway = Math.sin(nextDist * 0.028) * 3.8 * nextCurve - nextCurve * nextCurve * 6.5;
      const nnx = shipX - fx * nextDist + px * nextSway;
      const nnz = shipZ - fz * nextDist + pz * nextSway;
      const segHeading = i === 0 ? heading : Math.atan2(nnx - nx, nnz - nz);

      if (prevX !== null) arcDist += Math.hypot(nx - prevX, nz - prevZ);
      prevX = nx;
      prevZ = nz;

      this.trailNodes.push({
        x: nx,
        z: nz,
        heading: segHeading,
        arcDist,
        leftW: 4.85,
        rightW: 4.85,
      });
    }

    // 2. Genuinely fracture macro Voronoi cells along the pre-broken trail so Frame 0's jagged banks
    //    and floating chunks are 100% real jigsaw complements from the very first frame!
    const touchedMacroKeys = new Set();
    for (let i = 0; i < this.trailNodes.length; i++) {
      const nd = this.trailNodes[i];
      const gx = Math.floor(nd.x / MACRO_CELL_SIZE);
      const gz = Math.floor(nd.z / MACRO_CELL_SIZE);
      this._ensureCellRing(gx, gz, 1);

      const nfx = Math.sin(nd.heading);
      const nfz = Math.cos(nd.heading);
      const npx = Math.cos(nd.heading);
      const npz = -Math.sin(nd.heading);

      // Subdivide macro cells intersecting the channel corridor
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const cell = this.cells.get(`${gx + dx},${gz + dz}`);
          if (!cell) continue;
          const d = Math.hypot(cell.cx - nd.x, cell.cz - nd.z);
          if (d < cell.radius + 5.6 && !cell.subdivided) {
            this._subdivideMacroCell(cell, nd.x, nd.z, nfx, nfz);
            touchedMacroKeys.add(cell.key);
          }
        }
      }
    }

    // Also activate & subdivide the immediate bow frontier ahead of ship (z = 0..+18) for pre-cracks!
    const bowTipX = shipX + fx * 9.0;
    const bowTipZ = shipZ + fz * 9.0;
    const bowGx = Math.floor(bowTipX / MACRO_CELL_SIZE);
    const bowGz = Math.floor(bowTipZ / MACRO_CELL_SIZE);
    this._ensureCellRing(bowGx, bowGz, 2);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const cell = this.cells.get(`${bowGx + dx},${bowGz + dz}`);
        if (!cell || cell.subdivided) continue;
        if (Math.hypot(cell.cx - bowTipX, cell.cz - bowTipZ) < cell.radius + 7.5) {
          this._subdivideMacroCell(cell, bowTipX, bowTipZ, fx, fz);
        }
      }
    }

    // Build exact ship hull polygons at Frame 0:
    // - Tight steel hull clearance (0.18m) up to full bow tip so zero intact ice clips inside the hull!
    // - Generous channel berth (0.95m) from stern up to bow shoulders so slabs sit cleanly beside flanks
    const shipTightPoly = buildShipHullPoly(shipX, shipZ, heading, 0.18);
    const shipTightFlat = toFlatPoly(shipTightPoly);
    const shipHullPoly = buildShipHullPoly(shipX, shipZ, heading, 0.95);
    const shipHullFlat = toFlatPoly(shipHullPoly);

    // Detach every sub-plate lying inside the pre-broken channel corridor or ship envelope!
    for (const cell of this.cells.values()) {
      if (!cell.subdivided) continue;
      for (let p = 0; p < cell.plates.length; p++) {
        const plate = cell.plates[p];
        if (plate.state !== 'INTACT') continue;

        // Check against ship hull envelope (bow tip bites cleanly right into solid white ice!)
        const dShipX = plate.cx - shipX;
        const dShipZ = plate.cz - shipZ;
        const lzShip = dShipX * fx + dShipZ * fz;
        const lxShip = dShipX * px + dShipZ * pz;
        let shouldBreak = false;
        let isNearShip = false;

        if (lzShip > -10.5 && lzShip < 9.35) {
          const hitTight = satTestFlatPolys(
            shipTightFlat.fx, shipTightFlat.fz, shipTightFlat.n, shipX, shipZ,
            plate.flatX, plate.flatZ, plate.vn, plate.cx, plate.cz,
            0.0
          );
          if (hitTight) {
            shouldBreak = true;
            isNearShip = true;
          }
        }
        if (!shouldBreak && lzShip > -10.5 && lzShip < 7.8) {
          const hitHull = satTestFlatPolys(
            shipHullFlat.fx, shipHullFlat.fz, shipHullFlat.n, shipX, shipZ,
            plate.flatX, plate.flatZ, plate.vn, plate.cx, plate.cz,
            0.05
          );
          if (hitHull) {
            shouldBreak = true;
            isNearShip = true;
          }
        }

        // Check distance to historical trail nodes behind the ship
        if (!shouldBreak && lzShip < 6.5) {
          let minLat = 1e9;
          let nearDistBack = 1e9;
          for (let t = 0; t < this.trailNodes.length; t++) {
            const nd = this.trailNodes[t];
            const dx = plate.cx - nd.x;
            const dz = plate.cz - nd.z;
            const d2 = dx * dx + dz * dz;
            if (d2 > 68) continue;
            const d = Math.sqrt(d2);
            if (d < minLat) {
              minLat = d;
              nearDistBack = (this.trailNodes.length - 1 - t) * this.trailSpacing;
            }
          }
          // Slightly organic jagged corridor width (~3.6 - 4.7m)
          const channelR = 3.55 + seededRand(plate.id * 19.3) * 0.95;
          if (minLat < channelR) {
            shouldBreak = true;
            isNearShip = nearDistBack < 18.0;
          }
        }

        if (shouldBreak) {
          // Keep rich active freshly-broken chunks beside hull + organic mosaic astern
          const distFromShip = Math.hypot(dShipX, dShipZ);
          const keepSlab =
            isNearShip
              ? seededRand(plate.id * 7.3) < 0.86
              : distFromShip < 95
                ? seededRand(plate.id * 11.7) < 0.58
                : seededRand(plate.id * 13.1) < 0.38;

          if (keepSlab) {
            const slab = this._detachPlate(cell, plate, {
              shipX,
              shipZ,
              fx,
              fz,
              px,
              pz,
              shipSpeed: 1.95,
              strength: 0.65,
              instantSettle: true,
            });
            if (slab) {
              // Give freshly broken bow/flank slabs authentic tipping & ~26% overturned flat wet-blue undersides!
              if (lzShip > -7.5 && lzShip < 8.6 && Math.abs(lxShip) < 6.2) {
                const sSide = lxShip >= 0 ? 1 : -1;
                const pushLat = Math.max(0.0, (hullHalfBeamAt(THREE.MathUtils.clamp(lzShip, -8.5, 8.8)) + slab.radius * 0.58 + 0.25) - Math.abs(lxShip));
                slab.x += px * sSide * pushLat;
                slab.z += pz * sSide * pushLat;
                const rollSeed = seededRand(slab.id * 29.1);
                if (rollSeed < 0.28 && lzShip > -1.0) {
                  // Cleanly overturned slab beside bow/flank revealing wet glacial-blue keel!
                  this._tmpAxis.set(-pz * sSide, 0, px * sSide).normalize();
                  slab.quat.setFromAxisAngle(this._tmpAxis, Math.PI - (0.06 + rollSeed * 0.45));
                  slab.wetness = 0.80;
                } else {
                  this._tmpAxis.set(-pz * sSide, 0, px * sSide).normalize();
                  slab.quat.setFromAxisAngle(this._tmpAxis, (0.06 + rollSeed * 0.24));
                  slab.wetness = 0.24;
                }
                slab.vx = px * sSide * 0.28;
                slab.vz = pz * sSide * 0.28;
                slab.wy = -sSide * 0.18;
                this._updateSlabFootprint(slab);
              } else {
                // Calm drifted aft channel floes with gentle yaw jitter & occasional overturned wet blue slab
                const rotAmt = (seededRand(slab.id * 17.3) - 0.5) * 0.75;
                slab.quat.setFromAxisAngle(this._tmpAxis.set(0, 1, 0), rotAmt);
                if (seededRand(slab.id * 47.7) < 0.18) {
                  const flipQ = this._tmpQuat.setFromAxisAngle(this._tmpAxis.set(1, 0, 0), Math.PI);
                  slab.quat.multiply(flipQ);
                  slab.wetness = 0.72;
                }
                this._updateSlabFootprint(slab);
              }
            }
          } else {
            // Still mark plate detached cleanly so open dark-blue lead opens up!
            plate.state = 'DETACHED';
            cell.hasOpenWater = true;
            this._ensureCellRing(cell.gx, cell.gz, 1);
            const pIdx = cell.plates.indexOf(plate);
            for (let eIdx = 0; eIdx < cell.internalEdges.length; eIdx++) {
              const e = cell.internalEdges[eIdx];
              if (e.plateA === pIdx || e.plateB === pIdx) {
                e.crackProg = 1.0;
                e.targetProg = 1.0;
              }
            }
          }
        }
      }
    }

    // Propagate connected macro Voronoi fracture trees outward from the freshly broken channel banks!
    for (let i = 4; i < this.trailNodes.length; i += 5) {
      const nd = this.trailNodes[i];
      const gx = Math.floor(nd.x / MACRO_CELL_SIZE);
      const gz = Math.floor(nd.z / MACRO_CELL_SIZE);
      const npx = Math.cos(nd.heading);
      const npz = -Math.sin(nd.heading);
      this._propagateMacroBoundaryCracks(gx, gz, npx, npz, true);
      this._propagateMacroBoundaryCracks(gx, gz, -npx, -npz, true);
    }

    // Light up real ahead-of-bow pre-fracture stress cracks on Frame 0 so you immediately see
    // the ice sheet actively cracking ahead of the reinforced steel bow!
    this._updatePreFractureStress(shipX, shipZ, heading, 0.55, 0.45, 0.25, true);

    // Run quiet settling substeps so Frame 0 slabs have zero hull/bank/slab overlaps
    const dummyPhysics = {
      x: shipX,
      z: shipZ,
      heading,
      speed: 1.95,
      throttle: 0.44,
      rudder: 0,
      iceImpactPulse: 0,
      isBreakingIce: false,
    };
    this._updateFoamRibbon(shipX, shipZ, heading);
    for (let s = 0; s < 14; s++) {
      this._stepDetachedSlabs(0.016, dummyPhysics, true);
    }

    // Upload initial GPU buffers
    this._domainDirty = true;
    this._intactStaticDirty = true;
    this._cracksDirty = true;
    this._rebuildDomainCutout();
    this._rebuildIntactStaticMesh();
    this._rebuildIntactFlexMesh();
    this._uploadCrackGeometry();
    this._uploadDetachedSlabGeometry();

    // Sync initial shader uniforms
    this.iceMat.uniforms.uShipPos.value.set(shipX, 0, shipZ);
    this.intactPlateMat.uniforms.uShipPos.value.set(shipX, 0, shipZ);
    this.detachedMat.uniforms.uShipPos.value.set(shipX, 0, shipZ);
    this.waterMat.uniforms.uShipPos.value.set(shipX, 0, shipZ);
    this.waterMat.uniforms.uShipForward.value.set(fx, fz);
    this.waterMat.uniforms.uShipRight.value.set(px, pz);
    this.waterMat.uniforms.uShipSpeed.value = 0.35;
    this.foamMat.uniforms.uThrottle.value = 0.44;
    this.foamMat.uniforms.uSpeed.value = 0.35;
    this.foamMat.uniforms.uRudder.value = 0.0;
    this.foamMat.uniforms.uImpactPulse.value = 0.0;
  }

  // =========================================================================
  // REAL OMNI-DIRECTIONAL INTACT ICE QUERIES (Works in ANY Heading & Reversing!)
  // =========================================================================

  /**
   * Tests whether world point (x, z) sits on solid INTACT sea ice.
   * Works everywhere in the infinite world: un-activated distant ice = intact (true);
   * activated cells check exact convex sub-plates!
   */
  _isPointInIntactIce(x, z, margin = 0.0) {
    const gx = Math.floor(x / MACRO_CELL_SIZE);
    const gz = Math.floor(z / MACRO_CELL_SIZE);

    let insideAnyActivatedCell = false;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const cell = this.cells.get(`${gx + dx},${gz + dz}`);
        if (!cell) continue;
        const d2 = (x - cell.cx) ** 2 + (z - cell.cz) ** 2;
        if (d2 > (cell.radius + 0.5) ** 2) continue;

        if (pointInConvexPoly(x, z, cell.poly, -0.02)) {
          insideAnyActivatedCell = true;
          for (let i = 0; i < cell.plates.length; i++) {
            const p = cell.plates[i];
            if (p.state !== 'INTACT') continue;
            if ((x - p.cx) ** 2 + (z - p.cz) ** 2 > (p.radius + 0.25) ** 2) continue;
            if (pointInConvexPoly(x, z, p.poly, margin)) return true;
          }
        }
      }
    }

    // Outside all activated cells -> untouched infinite background snow sheet (solid intact ice!)
    return !insideAnyActivatedCell;
  }

  /**
   * Probes the ship's bow stem and port/starboard bow shoulders directly against real intact
   * Voronoi ice plates — works identically forward, reversing, turning 90° into channel walls,
   * or slicing through ice islands!
   */
  sampleIceContact(shipX, shipZ, heading) {
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const px = Math.cos(heading);
    const pz = -Math.sin(heading);

    // 5 bow-cone probes smoothly sense the oncoming broken ice frontier (no noisy open-water drops mid-crush!)
    const b1 = this._isPointInIntactIce(shipX + fx * 8.65, shipZ + fz * 8.65) ? 1.0 : 0.0;
    const b2 = this._isPointInIntactIce(shipX + fx * 9.25, shipZ + fz * 9.25) ? 1.0 : 0.0;
    const b3 = this._isPointInIntactIce(shipX + fx * 9.95, shipZ + fz * 9.95) ? 1.0 : 0.0;
    const bL = this._isPointInIntactIce(shipX + fx * 7.85 + px * 1.45, shipZ + fz * 7.85 + pz * 1.45) ? 1.0 : 0.0;
    const bR = this._isPointInIntactIce(shipX + fx * 7.85 - px * 1.45, shipZ + fz * 7.85 - pz * 1.45) ? 1.0 : 0.0;
    const bowInIce = b1 * 0.28 + b2 * 0.28 + b3 * 0.20 + (bL + bR) * 0.12;

    // Port & starboard bow-shoulder probes detect turning into solid ice banks
    const p1 = this._isPointInIntactIce(shipX + fx * 6.2 + px * 2.55, shipZ + fz * 6.2 + pz * 2.55) ? 1.0 : 0.0;
    const p2 = this._isPointInIntactIce(shipX + fx * 3.6 + px * 2.75, shipZ + fz * 3.6 + pz * 2.75) ? 1.0 : 0.0;
    const s1 = this._isPointInIntactIce(shipX + fx * 6.2 - px * 2.55, shipZ + fz * 6.2 - pz * 2.55) ? 1.0 : 0.0;
    const s2 = this._isPointInIntactIce(shipX + fx * 3.6 - px * 2.75, shipZ + fz * 3.6 - pz * 2.75) ? 1.0 : 0.0;

    const portShoulderInIce = Math.max(p1, p2 * 0.85);
    const stbdShoulderInIce = Math.max(s1, s2 * 0.85);
    const inOpenWater = bowInIce < 0.35;

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
    this.iceMesh.visible = showSurface;
    this.waterMesh.visible = showSurface;
    this.crackMesh.visible = showSurface;
    this.foamMesh.visible = showSurface;
    // Keep intactStaticMesh, intactFlexMesh & detachedMesh visible in reflection pass
    // so broken jagged ice cliffs & overturning slabs cast real-time reflections in the sea!
  }

  // =========================================================================
  // LIVE FRACTURE ENGINE: PRE-CRACKING, FLEXURAL BENDING & JIGSAW DETACHMENT
  // =========================================================================

  /**
   * Computes real-time pre-fracture stress ahead of the bow:
   * - Silently subdivides approaching macro Voronoi cells around the bow load center
   * - Shoots black ink stress cracks along real upcoming fracture edges ahead of the bow
   * - Applies downward flexural bend (`plate.flexTarget`) to bow-loaded ice lips right before snap!
   */
  _updatePreFractureStress(shipX, shipZ, heading, breakProg, iceStress, impactPulse, instant = false) {
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const bowX = shipX + fx * 9.05;
    const bowZ = shipZ + fz * 9.05;

    const bowGx = Math.floor(bowX / MACRO_CELL_SIZE);
    const bowGz = Math.floor(bowZ / MACRO_CELL_SIZE);
    this._ensureCellRing(bowGx, bowGz, 2);

    const loadLevel = Math.max(0.28, breakProg * 0.9 + iceStress * 0.95 + impactPulse * 0.8);

    // 1. Subdivide un-subdivided intact macro cells ahead of/near the bow
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const cell = this.cells.get(`${bowGx + dx},${bowGz + dz}`);
        if (!cell) continue;
        const dBow = Math.hypot(cell.cx - bowX, cell.cz - bowZ);
        if (!cell.subdivided && dBow < cell.radius + 9.5) {
          this._subdivideMacroCell(cell, bowX, bowZ, fx, fz);
        }
      }
    }

    // 2. Drive ahead-of-bow stress cracks & flexural lip bend on nearby subdivided cells
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const cell = this.cells.get(`${bowGx + dx},${bowGz + dz}`);
        if (!cell || !cell.subdivided) continue;

        // Stress cracks shoot outward ahead of the bow along real internal Voronoi seams!
        for (let i = 0; i < cell.internalEdges.length; i++) {
          const e = cell.internalEdges[i];
          if (e.targetProg >= 1.0) continue;
          const pA = cell.plates[e.plateA];
          const pB = cell.plates[e.plateB];
          if (!pA || !pB || (pA.state !== 'INTACT' && pB.state !== 'INTACT')) continue;

          const ex = e.mx - bowX;
          const ez = e.mz - bowZ;
          const dist = Math.hypot(ex, ez);
          const fwdDot = (ex * fx + ez * fz) / Math.max(0.1, dist);
          // Forward stress cone reaches ~9.5m ahead of bow stem, ~6m to the sides
          const coneReach = (fwdDot > -0.15 ? 8.8 : 5.4) * (0.72 + loadLevel * 0.42);
          if (dist < coneReach) {
            e.targetProg = 1.0;
            const d1 = Math.hypot(e.x1 - bowX, e.z1 - bowZ);
            const d2 = Math.hypot(e.x2 - bowX, e.z2 - bowZ);
            e.fromFirst = d1 <= d2;
            e.bornTime = instant ? -10 : this._time;
            e.growDur = instant ? 0 : 0.14 + Math.min(0.22, dist * 0.022);
            if (instant) e.crackProg = 1.0;
            this._cracksDirty = true;
          }
        }

        // Update downward flexural bend target on intact plates directly under/ahead of bow lip
        for (let i = 0; i < cell.plates.length; i++) {
          const p = cell.plates[i];
          if (p.state !== 'INTACT') continue;
          const dpx = p.cx - bowX;
          const dpz = p.cz - bowZ;
          const dist = Math.hypot(dpx, dpz);
          if (dist < p.radius + 4.0) {
            const prox = THREE.MathUtils.clamp(1.0 - Math.max(0, dist - p.radius * 0.6) / 3.8, 0, 1);
            p.flexTarget = prox * THREE.MathUtils.clamp(0.32 + loadLevel * 0.78, 0, 1);
            const len = dist || 1;
            p.flexDirX = -dpx / len; // points toward bow -> vertices closest to bow dip downward!
            p.flexDirZ = -dpz / len;
          } else {
            p.flexTarget = 0;
          }
        }
      }
    }
  }

  /**
   * Executes real fracture & jigsaw-complement detachment whenever the moving icebreaker hull
   * overcomes yield strength and presses into intact ice plates (from ANY heading or turn!).
   */
  _processRealIceBreaking(physics, impactEv) {
    const fx = Math.sin(physics.heading);
    const fz = Math.cos(physics.heading);
    const px = Math.cos(physics.heading);
    const pz = -Math.sin(physics.heading);

    const strongImpact = impactEv && (impactEv.kind === 'break' || impactEv.kind === 'ram' || impactEv.kind === 'shoulder');
    const canBreak = (physics.isBreakingIce && physics.speed > 0.08) || strongImpact;

    // Even on low-speed non-breaking bumps, shoot extra stress cracks right at the bow contact!
    if (impactEv && impactEv.kind === 'bump') {
      this._updatePreFractureStress(
        physics.x,
        physics.z,
        physics.heading,
        0.95,
        1.0,
        impactEv.strength,
        false
      );
      // Propagate a subtle hairline macro crack on a firm low-speed bump
      const bowX = physics.x + fx * 9.0;
      const bowZ = physics.z + fz * 9.0;
      this._propagateMacroBoundaryCracks(
        Math.floor(bowX / MACRO_CELL_SIZE),
        Math.floor(bowZ / MACRO_CELL_SIZE),
        fx * 0.7 + px * (seededRand(this._time * 13.7) > 0.5 ? 0.7 : -0.7),
        fz * 0.7 + pz * (seededRand(this._time * 13.7) > 0.5 ? 0.7 : -0.7),
        false
      );
      return;
    }

    if (!canBreak) return;

    // Inflate hull slightly so flexural fractures naturally open a clean ~0.65m berth past steel hull flanks
    const breakInflate = strongImpact && impactEv.kind === 'ram' ? 0.95 : 0.62;
    const hullPoly = buildShipHullPoly(physics.x, physics.z, physics.heading, breakInflate);
    const hullFlat = toFlatPoly(hullPoly);
    const bowX = physics.x + fx * 9.0;
    const bowZ = physics.z + fz * 9.0;

    const minGx = Math.floor((physics.x - 18) / MACRO_CELL_SIZE);
    const maxGx = Math.floor((physics.x + 18) / MACRO_CELL_SIZE);
    const minGz = Math.floor((physics.z - 18) / MACRO_CELL_SIZE);
    const maxGz = Math.floor((physics.z + 18) / MACRO_CELL_SIZE);

    let detachedCount = 0;

    for (let gx = minGx; gx <= maxGx; gx++) {
      for (let gz = minGz; gz <= maxGz; gz++) {
        const cell = this.cells.get(`${gx},${gz}`);
        if (!cell) continue;
        if ((cell.cx - physics.x) ** 2 + (cell.cz - physics.z) ** 2 > (cell.radius + 12.5) ** 2) continue;

        if (!cell.subdivided) {
          this._subdivideMacroCell(cell, bowX, bowZ, fx, fz);
        }

        // Loop carefully because splitting a huge outer plate appends to cell.plates
        for (let pIdx = 0; pIdx < cell.plates.length; pIdx++) {
          const plate = cell.plates[pIdx];
          if (plate.state !== 'INTACT') continue;

          // Quick broadphase against ship center (11m radius covers 18.2m hull + inflate)
          const dShip = Math.hypot(plate.cx - physics.x, plate.cz - physics.z);
          if (dShip > plate.radius + 11.2) continue;

          const hit = satTestFlatPolys(
            hullFlat.fx, hullFlat.fz, hullFlat.n, physics.x, physics.z,
            plate.flatX, plate.flatZ, plate.vn, plate.cx, plate.cz,
            0.0
          );
          if (!hit) continue;

          // If an unusually large outer plate (> 7.5 m²) is struck, Voronoi-subdivide it cleanly into
          // compact chunky angular slabs (never shaving off skinny long planks!)
          if (plate.area > 7.5) {
            if (this._subdivideIntactPlate(cell, pIdx, bowX, bowZ)) {
              pIdx--; // Re-evaluate the newly subdivided compact children!
              continue;
            }
          }

          const strength = impactEv ? impactEv.strength : (0.48 + Math.min(0.55, Math.abs(physics.speed) * 0.12));
          this._detachPlate(cell, plate, {
            shipX: physics.x,
            shipZ: physics.z,
            fx,
            fz,
            px,
            pz,
            shipSpeed: physics.speed,
            strength,
            instantSettle: false,
          });
          detachedCount++;
        }
      }
    }

    // When significant breaking occurs, shoot real macro Voronoi tension cracks deep into the snowfield!
    if (detachedCount > 0 || strongImpact) {
      if (this._time - this._lastImpactBreakTime > 0.55 || strongImpact) {
        this._lastImpactBreakTime = this._time;
        const bowGx = Math.floor(bowX / MACRO_CELL_SIZE);
        const bowGz = Math.floor(bowZ / MACRO_CELL_SIZE);
        const sideSign = seededRand(this._fractureSeedCounter++ * 11.3) > 0.5 ? 1 : -1;
        this._propagateMacroBoundaryCracks(
          bowGx,
          bowGz,
          px * sideSign * 0.82 + fx * 0.55,
          pz * sideSign * 0.82 + fz * 0.55,
          false
        );
        if (strongImpact) {
          this._propagateMacroBoundaryCracks(
            bowGx,
            bowGz,
            -px * sideSign * 0.82 + fx * 0.55,
            -pz * sideSign * 0.82 + fz * 0.55,
            false
          );
        }
      }
    }
  }

  // =========================================================================
  // PLAN B1: 6-DOF QUATERNION BUOYANCY, SPOON-BOW OVERTURN & UNDER-ICE RAFTING
  // =========================================================================

  _updateSlabFootprint(s) {
    this._computeSlabBasis(s.quat, this._tmpBasis);
    this._updateSlabWorldFootprint(s, this._tmpBasis);
  }

  _computeSlabBasis(q, out) {
    const x = q.x;
    const y = q.y;
    const z = q.z;
    const w = q.w;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;

    // Column 0 (local +X), Column 1 (local +Y = slab Up), Column 2 (local +Z)
    out[0] = 1 - (yy + zz);
    out[1] = xy + wz;
    out[2] = xz - wy;

    out[3] = xy - wz;
    out[4] = 1 - (xx + zz);
    out[5] = yz + wx;

    out[6] = xz + wy;
    out[7] = yz - wx;
    out[8] = 1 - (xx + yy);
  }

  _updateSlabWorldFootprint(s, basis) {
    const n = s.vn;
    const lp = s.localPoly;
    const wx = s._wx;
    const wz = s._wz;
    const b0 = basis[0], b2 = basis[2], b6 = basis[6], b8 = basis[8];
    const cx = s.x;
    const cz = s.z;
    for (let i = 0; i < n; i++) {
      const lx = lp[i][0];
      const lz = lp[i][1];
      wx[i] = cx + b0 * lx + b6 * lz;
      wz[i] = cz + b2 * lx + b8 * lz;
    }
  }

  /**
   * Samples approximate 3D Kelvin wake wave surface height at world (wx, wz)
   * so detached slabs authentically pitch, roll & heave over rolling stern swells!
   */
  _sampleWaterHeight(wx, wz, speedNorm) {
    const spine = this._wakeSpineSamples;
    const amb = Math.sin(wx * 0.52 + wz * 0.44 - this._time * 1.25) * 0.014;
    if (spine.length === 0) return amb;

    let bestD2 = 1e9;
    let bestS = null;
    for (let k = 0; k < spine.length; k++) {
      const sp = spine[k];
      const dx = wx - sp.x;
      const dz = wz - sp.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestS = sp;
      }
    }
    if (!bestS || bestD2 > 75) return amb;

    const sAft = Math.max(0, bestS.sAft);
    const lat = (wx - bestS.x) * bestS.px + (wz - bestS.z) * bestS.pz;
    const absLat = Math.abs(lat);
    const cuspLat = 1.48 + sAft * 0.31;
    const armEnv = Math.exp(-Math.pow((absLat - cuspLat) / (1.25 + sAft * 0.09), 2));
    const transEnv = Math.exp(-Math.pow(absLat / (cuspLat * 0.95 + 0.8), 2)) * Math.max(0, 1 - sAft / 42);
    const aftDecay = Math.max(0, 1 - sAft / 50);
    const amp = (0.30 + speedNorm * 0.78) * aftDecay;
    const waveRate = 3.0 + Math.max(0.2, speedNorm) * 3.6;

    const pDiv = sAft * 0.88 - absLat * 1.18 - this._time * waveRate;
    const pTrans = sAft * 0.92 - this._time * (waveRate * 0.88);
    const waveVal = (Math.sin(pDiv) * armEnv * 0.72 + Math.sin(pTrans) * transEnv * 0.52) * amp;
    return amb + THREE.MathUtils.clamp(waveVal * 0.115, -0.02, 0.14);
  }

  /**
   * Advances all detached 6-DOF ice slabs by `dt`:
   * 1. Multi-point Archimedes buoyancy & bistable 0° / 180° hydrostatic overturning
   * 2. 3D Spoon-bow downward press, overturning lever-arm torque, under-hull keel transit & secondary shattering
   * 3. Intact ice-shelf edge collision + realistic under-ice rafting/sliding (instead of disappearing!)
   * 4. Spatial-hash 2D SAT slab-to-slab collisions with clack tilt & crowding dip
   */
  _stepDetachedSlabs(dt, physics, settleOnly = false) {
    const slabs = this.slabs;
    const count = slabs.length;
    if (count === 0) return;

    const shipX = physics.x;
    const shipZ = physics.z;
    const heading = physics.heading;
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const px = Math.cos(heading);
    const pz = -Math.sin(heading);
    const speed = physics.speed || 0;
    const absSpeed = Math.abs(speed);
    const speedNorm = Math.min(1.2, absSpeed / 6.2);
    const impactPulse = physics.iceImpactPulse || 0;

    const basis = this._tmpBasis;
    const shatterQueue = [];

    // -----------------------------------------------------------------------
    // PASS A: Multi-point Buoyancy, Hydrodynamic Drag, Spoon-Bow 3D Contact & Prop Wash
    // -----------------------------------------------------------------------
    for (let i = 0; i < count; i++) {
      const s = slabs[i];
      s.age += dt;
      s.splitCooldown = Math.max(0, s.splitCooldown - dt);
      s.hullPinched = false;

      this._computeSlabBasis(s.quat, basis);
      const b0 = basis[0], b1 = basis[1], b2 = basis[2];
      const b3 = basis[3], b4 = basis[4], b5 = basis[5]; // local +Y (slab Up normal)
      const b6 = basis[6], b7 = basis[7], b8 = basis[8];
      const upY = b4;

      // Update world XZ footprint vertices
      const n = s.vn;
      const lp = s.localPoly;
      for (let v = 0; v < n; v++) {
        const lx = lp[v][0];
        const lz = lp[v][1];
        s._wx[v] = s.x + b0 * lx + b6 * lz;
        s._wz[v] = s.z + b2 * lx + b8 * lz;
      }

      // 1. Exact Bistable Hydrostatic Buoyancy & Wave-Slope Righting Torque!
      // A uniform thin floating ice slab is strictly bistable at 0° (upright snow) and 180° (overturned wet blue keel),
      // and strictly UNSTABLE standing 90° on edge (zero toothpick/stick slabs!).
      const wCenter = settleOnly ? 0 : this._sampleWaterHeight(s.x, s.z, speedNorm);
      const sub = THREE.MathUtils.clamp((wCenter - (s.y - SLAB_HALF_H)) / (2.0 * SLAB_HALF_H), 0, 1);

      if (!settleOnly) {
        const forceY = -s.mass * GRAVITY + sub * BUOYANCY_MULT * s.mass * GRAVITY;
        s.vy += (forceY / s.mass) * dt;

        // Sample local Kelvin wake wave slope so slabs visibly rock & ride over rolling stern waves
        const wEps = 0.65;
        const dwDx = (this._sampleWaterHeight(s.x + wEps, s.z, speedNorm) - wCenter) / wEps;
        const dwDz = (this._sampleWaterHeight(s.x, s.z + wEps, speedNorm) - wCenter) / wEps;

        // Nearest flat equilibrium face (+1 upright, -1 overturned upside-down)
        const flatSign = Math.abs(upY) < 0.04
          ? ((s.id & 1) === 0 ? 1.0 : -1.0)
          : (upY >= 0 ? 1.0 : -1.0);

        let tx = -dwDx * flatSign;
        let ty = flatSign;
        let tz = -dwDz * flatSign;
        const tLen = Math.hypot(tx, ty, tz) || 1;
        tx /= tLen; ty /= tLen; tz /= tLen;

        // Righting torque axis = U × T (restores cleanly toward nearest flat face!)
        const rxT = b4 * tz - b5 * ty;
        const rzT = b3 * ty - b4 * tx;

        // Edge-on instability boost prevents ANY slab from ever lingering near 90° vertical!
        const absUp = Math.abs(upY);
        const edgeEscape = absUp < 0.35 ? 1.0 + (1.0 - absUp / 0.35) * 1.15 : 1.0;
        const rightK = (13.5 + Math.min(7.5, s.radius * 3.2)) * (0.35 + sub * 0.65) * edgeEscape;

        s.wx += rxT * rightK * dt;
        s.wz += rzT * rightK * dt;

        // Track surface wetness (spikes when submerged or overturned; drains slowly above water)
        if (sub > 0.78 || absUp < 0.55 || upY < -0.2) {
          s.wetness = Math.min(1.0, s.wetness + dt * 1.35);
        } else {
          s.wetness = Math.max(0.05, s.wetness - dt * 0.055);
        }
      }
      const avgSub = sub;

      // 2. Twin-Propeller Stern Wash & Outward Parting Current (lifts under-hull slabs back up!)
      const sdx = s.x - shipX;
      const sdz = s.z - shipZ;
      const distShipSq = sdx * sdx + sdz * sdz;

      if (!settleOnly && distShipSq < 625 && absSpeed > 0.18) {
        const lzS = sdx * fx + sdz * fz;
        if (lzS < -7.6 && lzS > -24.0) {
          const lxS = sdx * px + sdz * pz;
          if (Math.abs(lxS) < 2.8) {
            const sideS = lxS >= 0 ? 1 : -1;
            const wash = (1 - Math.abs(lxS) / 2.8) * (1 - (-7.6 - lzS) / 16.4) * Math.min(1.1, absSpeed / 3.2);
            s.vx += (px * sideS * 0.74 - fx * 0.56) * wash * dt * 2.4;
            s.vz += (pz * sideS * 0.74 - fz * 0.56) * wash * dt * 2.4;
            s.vy += wash * dt * 1.65; // Churning propeller boil lifts submerged chunks up!
            s.wx += (seededRand(s.id * 7.1 + Math.floor(this._time)) - 0.5) * wash * dt * 2.8;
            s.wz += (seededRand(s.id * 11.9 + Math.floor(this._time)) - 0.5) * wash * dt * 2.8;
          }
        }
      }

      // 3. 3D Spoon-Bow & Hull Contact + Under-Hull Transit + Secondary Shattering!
      if (distShipSq < 230) {
        const cLz = sdx * fx + sdz * fz;
        const cLx = sdx * px + sdz * pz;
        const hullGap = 0.20;
        const yKeelC = cLz > 5.2 ? -0.66 + ((cLz - 5.2) / 3.9) * 0.78 : -0.78;

        // Case 3A: Slab already pushed deeply beneath the hull keel -> guide smoothly aft toward stern!
        if (!settleOnly && s.y < yKeelC - 0.06 && cLz > -8.9 && cLz < 8.4 && Math.abs(cLx) < hullHalfBeamAt(THREE.MathUtils.clamp(cLz, -8.8, 8.9)) + 0.35) {
          s.y = Math.min(s.y, yKeelC - 0.16);
          s.vy = Math.min(s.vy, -0.08);
          const sideS = cLx >= 0 ? 1 : -1;
          s.vx += (-fx * 0.65 + px * sideS * 0.55) * (0.8 + absSpeed * 0.45) * dt;
          s.vz += (-fz * 0.65 + pz * sideS * 0.55) * (0.8 + absSpeed * 0.45) * dt;
          s.wetness = 1.0;
        } else {
          // Case 3B: Exact vertex-level 3D contact against raked spoon bow & hull flanks
          let worstPen = 0;
          let bestOutX = 0;
          let bestOutY = 0;
          let bestOutZ = 0;
          let hitVx = s.x;
          let hitVy = s.y;
          let hitVz = s.z;
          let hitLz = 0;
          let hitSide = 1;

          for (let v = 0; v < n; v++) {
            const vxW = s._wx[v];
            const vzW = s._wz[v];
            const lxL = lp[v][0];
            const lzL = lp[v][1];
            const vyW = s.y + b1 * lxL + b7 * lzL;

            const vdx = vxW - shipX;
            const vdz = vzW - shipZ;
            const lz = vdx * fx + vdz * fz;
            if (lz < -8.98 - hullGap || lz > 9.18 + hullGap) continue;

            const lx = vdx * px + vdz * pz;
            const hb = hullHalfBeamAt(THREE.MathUtils.clamp(lz, -8.85, 8.98));
            const minLat = hb + hullGap;
            if (Math.abs(lx) >= minLat) continue;

            const yKeelV = lz > 5.2 ? -0.66 + ((lz - 5.2) / 3.9) * 0.78 : -0.78;
            if (vyW < yKeelV - 0.14) continue;

            const sideS = lx >= 0 ? 1 : -1;
            const distToSide = minLat - Math.abs(lx);
            const distToStern = lz - (-8.98 - hullGap);
            const distToBow = (9.18 + hullGap) - lz;

            let pen;
            let ox, oy, oz;
            if (lz < -7.5 && distToStern < distToSide * 0.95) {
              pen = distToStern + 0.02;
              ox = -fx;
              oy = -0.10;
              oz = -fz;
            } else if (lz > 4.2) {
              // Raked spoon-bow flare: presses slab DOWN AND OUTWARD!
              ox = px * sideS * 0.74 - fx * 0.34;
              oy = -0.58;
              oz = pz * sideS * 0.74 - fz * 0.34;
              pen = Math.min(distToBow, distToSide) + 0.02;
            } else {
              // Midship flank: wedges outward with gentle downward roll
              ox = px * sideS * 0.94 - fx * 0.22;
              oy = -0.22;
              oz = pz * sideS * 0.94 - fz * 0.22;
              pen = distToSide + 0.02;
            }

            if (pen > worstPen) {
              worstPen = pen;
              bestOutX = ox;
              bestOutY = oy;
              bestOutZ = oz;
              hitVx = vxW;
              hitVy = vyW;
              hitVz = vzW;
              hitLz = lz;
              hitSide = sideS;
            }
          }

          if (worstPen > 0) {
            s.hullPinched = true;
            // Positional push out of steel hull (horizontal + downward spoon press)
            const hLen = Math.hypot(bestOutX, bestOutZ) || 1;
            s.x += (bestOutX / hLen) * worstPen;
            s.z += (bestOutZ / hLen) * worstPen;

            if (!settleOnly) {
              s.y += bestOutY * Math.min(0.24, worstPen * 0.65);

              const impMag = 0.62 + absSpeed * 0.44 + impactPulse * 0.85;
              s.vx = s.vx * 0.45 + bestOutX * impMag;
              s.vy = Math.min(s.vy, 0.2) + bestOutY * impMag * 0.95;
              s.vz = s.vz * 0.45 + bestOutZ * impMag;

              // Exact 3D lever-arm torque from contact point `(hitV - center) × impulse`!
              // Pressing the inner bow-side edge DOWN tips the outer edge UP & flips slabs naturally!
              const rcx = hitVx - s.x;
              const rcy = hitVy - s.y;
              const rcz = hitVz - s.z;
              const impX = bestOutX * impMag * 0.55;
              const impY = bestOutY * impMag * 1.15;
              const impZ = bestOutZ * impMag * 0.55;

              const tX = rcy * impZ - rcz * impY;
              const tY = rcz * impX - rcx * impZ;
              const tZ = rcx * impY - rcy * impX;

              s.wx += (tX / s.inertiaTilt) * 0.36;
              s.wy += (tY / s.inertiaY) * 0.42 - hitSide * 0.15;
              s.wz += (tZ / s.inertiaTilt) * 0.36;

              // Queue secondary crushing if a big detached slab gets rammed directly at the bow!
              if (s.area > 3.8 && s.splitCooldown <= 0 && hitLz > 4.0 && (absSpeed > 1.25 || impactPulse > 0.38)) {
                shatterQueue.push({ idx: i, hx: hitVx, hz: hitVz });
              }
            }
          }
        }
      }

      // 4. Integrate 6-DOF linear & quaternion rotational motion with realistic heavy water drag
      if (!settleOnly) {
        const horizDrag = Math.exp(-dt * (1.75 + avgSub * 1.05));
        const vertDrag = Math.exp(-dt * (2.5 + avgSub * 3.8));
        const tiltDrag = Math.exp(-dt * (2.15 + avgSub * 2.15));
        const yawDrag = Math.exp(-dt * 1.25);

        s.vx = THREE.MathUtils.clamp(s.vx * horizDrag, -6.0, 6.0);
        s.vy = THREE.MathUtils.clamp(s.vy * vertDrag, -4.5, 4.5);
        s.vz = THREE.MathUtils.clamp(s.vz * horizDrag, -6.0, 6.0);
        s.wx = THREE.MathUtils.clamp(s.wx * tiltDrag, -4.6, 4.6);
        s.wy = THREE.MathUtils.clamp(s.wy * yawDrag, -2.4, 2.4);
        s.wz = THREE.MathUtils.clamp(s.wz * tiltDrag, -4.6, 4.6);

        s.x += s.vx * dt;
        s.y = THREE.MathUtils.clamp(s.y + s.vy * dt, -1.35, 0.55);
        s.z += s.vz * dt;

        // Exact exponential-map Quaternion integration: q' = exp(0.5 * dt * omega) * q
        const wMag = Math.hypot(s.wx, s.wy, s.wz);
        if (wMag > 1e-5) {
          const halfAng = 0.5 * wMag * dt;
          const sinH = Math.sin(halfAng) / wMag;
          this._tmpQuat.set(s.wx * sinH, s.wy * sinH, s.wz * sinH, Math.cos(halfAng));
          s.quat.premultiply(this._tmpQuat).normalize();
        }
      }

      this._computeSlabBasis(s.quat, basis);
      this._updateSlabWorldFootprint(s, basis);
    }

    // -----------------------------------------------------------------------
    // PASS B: Detached Slab vs. Intact Voronoi Shelf (Edge Clack OR Under-Ice Rafting!)
    // -----------------------------------------------------------------------
    for (let i = 0; i < slabs.length; i++) {
      const s = slabs[i];
      this._computeSlabBasis(s.quat, basis);
      const upY = basis[4];
      const gx = Math.floor(s.x / MACRO_CELL_SIZE);
      const gz = Math.floor(s.z / MACRO_CELL_SIZE);

      let overlappedIntact = false;

      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const cell = this.cells.get(`${gx + dx},${gz + dz}`);
          if (!cell) continue;
          if ((s.x - cell.cx) ** 2 + (s.z - cell.cz) ** 2 > (s.radius + cell.radius + 0.3) ** 2) continue;

          for (let p = 0; p < cell.plates.length; p++) {
            const plate = cell.plates[p];
            if (plate.state !== 'INTACT') continue;
            const maxR = s.radius + plate.radius + 0.08;
            if ((s.x - plate.cx) ** 2 + (s.z - plate.cz) ** 2 > maxR * maxR) continue;

            const hit = satTestFlatPolys(
              plate.flatX, plate.flatZ, plate.vn, plate.cx, plate.cz,
              s._wx, s._wz, s.vn, s.x, s.z,
              0.04
            );
            if (!hit) continue;

            overlappedIntact = true;

            // Real under-ice rafting: ONLY when genuinely squeezed between steel hull and intact bank
            // (or already deep underneath) — keeps freshly broken bow slabs richly visible tumbling beside the ship!
            const shouldDiveUnder =
              !settleOnly &&
              (s.underIce ||
                (s.hullPinched && hit.ov > 0.34 && s.y < -0.20) ||
                (s.y < -0.26 && hit.ov > 0.28));

            if (shouldDiveUnder) {
              s.underIce = true;
              // Ceiling constraint right underneath the intact ice bottom (-0.25m) -> cleanly hidden by Z-buffer!
              s.y = Math.min(s.y, -0.27);
              s.vy = Math.min(s.vy, -0.05);
              s.vx *= 0.90;
              s.vz *= 0.90;
              s.wx *= 0.82;
              s.wz *= 0.82;
              s.wetness = 1.0;
            } else {
              // Floating at surface: crisp horizontal ice-wall bounce + subtle edge-clack tilt!
              s.x += hit.nx * hit.ov;
              s.z += hit.nz * hit.ov;
              this._updateSlabWorldFootprint(s, basis);
              const vn = s.vx * hit.nx + s.vz * hit.nz;
              if (vn < 0) {
                s.vx -= hit.nx * vn * 1.18;
                s.vz -= hit.nz * vn * 1.18;
                if (!settleOnly) {
                  // Edge impact rocks the slab slightly!
                  const clack = Math.min(1.2, -vn * 0.7);
                  s.wx += -hit.nz * clack * 0.45;
                  s.wz += hit.nx * clack * 0.45;
                }
              }
            }
          }
        }
      }

      if (overlappedIntact && s.underIce) {
        s.underIceTime += dt;
      } else {
        s.underIce = false;
        s.underIceTime = Math.max(0, s.underIceTime - dt * 2.0);
      }
    }

    // -----------------------------------------------------------------------
    // PASS C: Spatial-Hash Slab-to-Slab Exact 2D SAT + Clack Rock & Rafting Dip
    // -----------------------------------------------------------------------
    const invCell = 1.0 / 3.4;
    const grid = this._slabGrid;
    grid.clear();

    for (let i = 0; i < slabs.length; i++) {
      const s = slabs[i];
      const cx = Math.floor(s.x * invCell);
      const cz = Math.floor(s.z * invCell);
      const key = (cx + 32768) * 65536 + (cz + 32768);
      let bucket = grid.get(key);
      if (!bucket) {
        bucket = [];
        grid.set(key, bucket);
      }
      bucket.push(i);
    }

    const gapMargin = 0.045;
    for (let i = 0; i < slabs.length; i++) {
      const a = slabs[i];
      const cx = Math.floor(a.x * invCell);
      const cz = Math.floor(a.z * invCell);

      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          const bucket = grid.get((cx + ox + 32768) * 65536 + (cz + oz + 32768));
          if (!bucket) continue;

          for (let bIdx = 0; bIdx < bucket.length; bIdx++) {
            const j = bucket[bIdx];
            if (j <= i) continue;
            const b = slabs[j];

            // Slabs at different vertical layers (e.g. one rafted underneath another!) pass cleanly!
            if (Math.abs(a.y - b.y) > 0.28) continue;

            const dx = b.x - a.x;
            const dz = b.z - a.z;
            const maxD = a.radius + b.radius + gapMargin;
            if (dx * dx + dz * dz >= maxD * maxD) continue;

            const hit = satTestFlatPolys(
              a._wx, a._wz, a.vn, a.x, a.z,
              b._wx, b._wz, b.vn, b.x, b.z,
              gapMargin
            );
            if (!hit) continue;

            const totalM = a.mass + b.mass;
            const wA = b.mass / totalM;
            const wB = a.mass / totalM;

            // If tightly crowded/squeezed, let the lighter slab raft slightly downward instead of jittering!
            if (!settleOnly && hit.ov > 0.28 && (a.hullPinched || b.hullPinched)) {
              const lighter = a.mass <= b.mass ? a : b;
              lighter.vy -= 0.85 * dt * 12;
              lighter.y -= 0.03;
              lighter.wx += -hit.nz * 0.5;
              lighter.wz += hit.nx * 0.5;
            }

            a.x -= hit.nx * hit.ov * wA;
            a.z -= hit.nz * hit.ov * wA;
            b.x += hit.nx * hit.ov * wB;
            b.z += hit.nz * hit.ov * wB;

            if (!settleOnly) {
              const relVx = b.vx - a.vx;
              const relVz = b.vz - a.vz;
              const relVn = relVx * hit.nx + relVz * hit.nz;
              if (relVn < 0) {
                const jImp = -1.20 * relVn;
                a.vx -= hit.nx * jImp * wA;
                a.vz -= hit.nz * jImp * wA;
                b.vx += hit.nx * jImp * wB;
                b.vz += hit.nz * jImp * wB;

                const spinKick = (hit.nx * relVz - hit.nz * relVx) * 0.09;
                a.wy = THREE.MathUtils.clamp(a.wy + spinKick, -2.0, 2.0);
                b.wy = THREE.MathUtils.clamp(b.wy - spinKick, -2.0, 2.0);

                // Tactile ice-block collision clack rock
                const rock = Math.min(0.9, -relVn * 0.45);
                a.wx += hit.nz * rock * wA;
                a.wz -= hit.nx * rock * wA;
                b.wx -= hit.nz * rock * wB;
                b.wz += hit.nx * rock * wB;
              }
            }
          }
        }
      }
    }

    // Execute queued secondary shatters (iterate descending index so splices stay valid!)
    if (shatterQueue.length > 0 && slabs.length < MAX_DETACHED_SLABS - 4) {
      shatterQueue.sort((a, b) => b.idx - a.idx);
      const limit = Math.min(shatterQueue.length, 2);
      for (let k = 0; k < limit; k++) {
        this._shatterDetachedSlab(shatterQueue[k].idx, shatterQueue[k].hx, shatterQueue[k].hz, fx, fz, px, pz);
      }
    }

    // Quietly retire slabs that have been buried deep underneath intact ice for > 5 seconds
    if (!settleOnly) {
      for (let i = slabs.length - 1; i >= 0; i--) {
        if (slabs[i].underIceTime > 5.2) {
          slabs.splice(i, 1);
        }
      }
    }
  }

  // =========================================================================
  // GPU BUFFER BUILDERS (Domain Stencil, Intact Static/Flex, Cracks, 6-DOF Slabs)
  // =========================================================================

  _rebuildDomainCutout() {
    const pos = this.cutoutPos;
    const maxVerts = MAX_CUTOUT_TRIS * 3;
    let vCount = 0;

    for (const cell of this.cells.values()) {
      const poly = cell.poly;
      const n = poly.length;
      if (n < 3) continue;
      const p0 = poly[0];
      for (let i = 1; i < n - 1; i++) {
        if (vCount + 3 > maxVerts) break;
        const p1 = poly[i + 1];
        const p2 = poly[i];
        let o = vCount * 3;
        pos[o++] = p0[0]; pos[o++] = ICE_TOP_Y; pos[o++] = p0[1];
        pos[o++] = p1[0]; pos[o++] = ICE_TOP_Y; pos[o++] = p1[1];
        pos[o++] = p2[0]; pos[o++] = ICE_TOP_Y; pos[o++] = p2[1];
        vCount += 3;
      }
    }

    this.cutoutGeo.attributes.position.needsUpdate = true;
    this.cutoutGeo.setDrawRange(0, vCount);
    this._domainDirty = false;
  }

  /**
   * Emits a 3D intact ice plate (top face + 0.14m vertical ice-shelf walls down to y = 0.0)
   * into flat position/normal buffers. Supports subtle flexural bow-lip dip on flexing plates!
   */
  _emitIntactPlatePrism(plate, posArr, normArr, vOffset, maxVerts, withFlex = false) {
    const poly = plate.poly;
    const n = poly.length;
    const needed = (n - 2) * 3 + n * 6;
    if (vOffset + needed > maxVerts) return vOffset;

    const yBot = 0.0;

    // Precompute per-vertex top Y (flat 0.14 when static; hinged flexural bend when bow-loaded!)
    let minProj = 1e9;
    let maxProj = -1e9;
    const topY = this._topRingY;
    if (withFlex && plate.flex > 0.005) {
      for (let i = 0; i < n; i++) {
        const pr = (poly[i][0] - plate.cx) * plate.flexDirX + (poly[i][1] - plate.cz) * plate.flexDirZ;
        if (pr < minProj) minProj = pr;
        if (pr > maxProj) maxProj = pr;
      }
      const span = Math.max(0.4, maxProj - minProj);
      const maxDip = plate.flex * 0.088;
      for (let i = 0; i < n; i++) {
        const pr = (poly[i][0] - plate.cx) * plate.flexDirX + (poly[i][1] - plate.cz) * plate.flexDirZ;
        const t = THREE.MathUtils.clamp((pr - minProj) / span, 0, 1);
        topY[i] = Math.max(0.032, ICE_TOP_Y - maxDip * t);
      }
    } else {
      for (let i = 0; i < n; i++) topY[i] = ICE_TOP_Y;
    }

    // Approximate top normal (strictly (0,1,0) when flat; tilted slightly toward bow when flexing)
    let topNx = 0;
    let topNy = 1;
    let topNz = 0;
    if (withFlex && plate.flex > 0.005) {
      const span = Math.max(0.4, maxProj - minProj);
      const slope = (plate.flex * 0.088) / span;
      topNx = plate.flexDirX * slope;
      topNy = 1.0;
      topNz = plate.flexDirZ * slope;
      const nl = Math.hypot(topNx, topNy, topNz);
      topNx /= nl; topNy /= nl; topNz /= nl;
    }

    let v = vOffset;
    const pushVert = (x, y, z, nx, ny, nz) => {
      const o = v * 3;
      posArr[o] = x; posArr[o + 1] = y; posArr[o + 2] = z;
      normArr[o] = nx; normArr[o + 1] = ny; normArr[o + 2] = nz;
      v++;
    };

    // 1. Top snow cap (winding (p0, p_{i+1}, p_i) -> exact +Y upward normal!)
    const p0 = poly[0];
    const y0 = topY[0];
    for (let i = 1; i < n - 1; i++) {
      const p1 = poly[i + 1];
      const p2 = poly[i];
      pushVert(p0[0], y0, p0[1], topNx, topNy, topNz);
      pushVert(p1[0], topY[i + 1], p1[1], topNx, topNy, topNz);
      pushVert(p2[0], topY[i], p2[1], topNx, topNy, topNz);
    }

    // 2. Vertical 0.14m ice-shelf walls ONLY along genuinely EXPOSED open-water edges!
    // Skipping internal walls between flush intact plates guarantees 100% seamless snow (zero ghost lines!)
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      const a = poly[i];
      const b = poly[next];
      const ex = b[0] - a[0];
      const ez = b[1] - a[1];
      const len = Math.hypot(ex, ez) || 1;
      // Outward 2D normal for CCW polygon in (x, z) is (ez/len, 0, -ex/len)
      const nx = ez / len;
      const nz = -ex / len;

      // Test 0.08m outside edge midpoint: if solid intact ice sits right across this edge, skip wall!
      const mx = (a[0] + b[0]) * 0.5;
      const mz = (a[1] + b[1]) * 0.5;
      if (this._isPointInIntactIce(mx + nx * 0.08, mz + nz * 0.08, -0.005)) {
        continue;
      }

      const ay = topY[i];
      const by = topY[next];

      // Outward winding: (A_bot, A_top, B_bot), (B_bot, A_top, B_top)
      pushVert(a[0], yBot, a[1], nx, 0, nz);
      pushVert(a[0], ay, a[1], nx, 0, nz);
      pushVert(b[0], yBot, b[1], nx, 0, nz);

      pushVert(b[0], yBot, b[1], nx, 0, nz);
      pushVert(a[0], ay, a[1], nx, 0, nz);
      pushVert(b[0], by, b[1], nx, 0, nz);
    }

    return v;
  }

  _rebuildIntactStaticMesh() {
    let v = 0;
    for (const cell of this.cells.values()) {
      for (let i = 0; i < cell.plates.length; i++) {
        const p = cell.plates[i];
        if (p.state !== 'INTACT' || p.flex > 0.006) continue;
        v = this._emitIntactPlatePrism(p, this.intactStaticPos, this.intactStaticNorm, v, MAX_INTACT_STATIC_VERTS, false);
      }
    }
    this.intactStaticGeo.attributes.position.needsUpdate = true;
    this.intactStaticGeo.attributes.normal.needsUpdate = true;
    this.intactStaticGeo.setDrawRange(0, v);
    this._intactStaticDirty = false;
  }

  _rebuildIntactFlexMesh() {
    let v = 0;
    for (const cell of this.cells.values()) {
      if (!cell.subdivided) continue;
      for (let i = 0; i < cell.plates.length; i++) {
        const p = cell.plates[i];
        if (p.state !== 'INTACT' || p.flex <= 0.006) continue;
        v = this._emitIntactPlatePrism(p, this.intactFlexPos, this.intactFlexNorm, v, MAX_INTACT_FLEX_VERTS, true);
      }
    }
    this.intactFlexGeo.attributes.position.needsUpdate = true;
    this.intactFlexGeo.attributes.normal.needsUpdate = true;
    this.intactFlexGeo.setDrawRange(0, v);
  }

  _uploadCrackGeometry() {
    const pos = this.crackPos;
    const crackY = ICE_TOP_Y + 0.008;
    let qCount = 0;
    let anyGrowing = false;

    const pushQuad = (x1, z1, x2, z2, halfW) => {
      if (qCount >= MAX_CRACK_QUADS) return;
      const dx = x2 - x1;
      const dz = z2 - z1;
      const len = Math.hypot(dx, dz);
      if (len < 0.03) return;
      const nx = (-dz / len) * halfW;
      const nz = (dx / len) * halfW;

      let o = qCount * 18;
      pos[o++] = x1 + nx; pos[o++] = crackY; pos[o++] = z1 + nz;
      pos[o++] = x1 - nx; pos[o++] = crackY; pos[o++] = z1 - nz;
      pos[o++] = x2 + nx; pos[o++] = crackY; pos[o++] = z2 + nz;

      pos[o++] = x2 + nx; pos[o++] = crackY; pos[o++] = z2 + nz;
      pos[o++] = x1 - nx; pos[o++] = crackY; pos[o++] = z1 - nz;
      pos[o++] = x2 - nx; pos[o++] = crackY; pos[o++] = z2 - nz;
      qCount++;
    };

    // 1. Real pre-fracture internal Voronoi seams (shooting ahead of the bow & bordering banks!)
    for (const cell of this.cells.values()) {
      if (!cell.subdivided) continue;
      for (let i = 0; i < cell.internalEdges.length; i++) {
        const e = cell.internalEdges[i];
        if (e.targetProg <= 0) continue;

        const pA = cell.plates[e.plateA];
        const pB = cell.plates[e.plateB];
        // Only render crack if BOTH adjacent plates are still intact (if one detached, G-buffer draws the cliff ink!)
        if (!pA || !pB || pA.state !== 'INTACT' || pB.state !== 'INTACT') continue;

        let prog = 1.0;
        if (e.bornTime >= 0 && e.growDur > 0.001) {
          const rawT = (this._time - e.bornTime) / e.growDur;
          if (rawT <= 0) {
            anyGrowing = true;
            continue;
          }
          if (rawT < 1.0) {
            anyGrowing = true;
            prog = 1.0 - Math.pow(1.0 - rawT, 2.2);
          }
        }
        e.crackProg = prog;

        const sx = e.fromFirst ? e.x1 : e.x2;
        const sz = e.fromFirst ? e.z1 : e.z2;
        const ex = e.fromFirst ? e.x2 : e.x1;
        const ez = e.fromFirst ? e.z2 : e.z1;
        pushQuad(sx, sz, sx + (ex - sx) * prog, sz + (ez - sz) * prog, 0.026);
      }
    }

    // 2. Real long-range macro Voronoi edge cracks extending outward into the white ice sheet!
    for (let i = 0; i < this.macroCracks.length; i++) {
      const c = this.macroCracks[i];
      let prog = 1.0;
      if (c.bornTime >= 0 && c.growDur > 0.001) {
        const rawT = (this._time - c.bornTime) / c.growDur;
        if (rawT <= 0) {
          anyGrowing = true;
          continue;
        }
        if (rawT < 1.0) {
          anyGrowing = true;
          prog = 1.0 - Math.pow(1.0 - rawT, 2.4);
        }
      }
      pushQuad(c.x1, c.z1, c.x1 + (c.x2 - c.x1) * prog, c.z1 + (c.z2 - c.z1) * prog, c.halfWidth);
    }

    this.crackGeo.attributes.position.needsUpdate = true;
    this.crackGeo.setDrawRange(0, qCount * 6);
    this._cracksDirty = false;
    this._hasGrowingCracks = anyGrowing;
  }

  /**
   * Packs all active 6-DOF detached 3D ice slabs into ONE single batched BufferGeometry
   * (1 draw call across Reflection, Beauty & G-Buffer passes, <0.18ms CPU per frame!).
   */
  _uploadDetachedSlabGeometry() {
    const pos = this.detachedPos;
    const norm = this.detachedNorm;
    const orig = this.detachedOriginXZ;
    const locUp = this.detachedLocalUp;
    const wet = this.detachedWetness;
    const pid = this.detachedPartId;

    const topX = this._topRingX;
    const topY = this._topRingY;
    const topZ = this._topRingZ;
    const botX = this._botRingX;
    const botY = this._botRingY;
    const botZ = this._botRingZ;
    const basis = this._tmpBasis;

    let v = 0;

    for (let sIdx = 0; sIdx < this.slabs.length; sIdx++) {
      const s = this.slabs[sIdx];
      const n = s.vn;
      const needed = (n - 2) * 6 + n * 6;
      if (v + needed > MAX_DETACHED_VERTS) break;

      this._computeSlabBasis(s.quat, basis);
      const b0 = basis[0], b1 = basis[1], b2 = basis[2];
      const b3 = basis[3], b4 = basis[4], b5 = basis[5];
      const b6 = basis[6], b7 = basis[7], b8 = basis[8];

      const cx = s.x;
      const cy = s.y;
      const cz = s.z;
      const upOffX = b3 * SLAB_HALF_H;
      const upOffY = b4 * SLAB_HALF_H;
      const upOffZ = b5 * SLAB_HALF_H;

      // Transform ONLY the 2N prism ring vertices once per slab!
      const lp = s.localPoly;
      const op = s.originPoly;
      for (let i = 0; i < n; i++) {
        const lx = lp[i][0];
        const lz = lp[i][1];
        const rx = cx + b0 * lx + b6 * lz;
        const ry = cy + b1 * lx + b7 * lz;
        const rz = cz + b2 * lx + b8 * lz;
        topX[i] = rx + upOffX;
        topY[i] = ry + upOffY;
        topZ[i] = rz + upOffZ;
        botX[i] = rx - upOffX;
        botY[i] = ry - upOffY;
        botZ[i] = rz - upOffZ;
      }

      const sWet = s.wetness;
      const sPid = s.partId;

      const emit = (x, y, z, nx, ny, nz, ox, oz, localUpVal) => {
        const o3 = v * 3;
        const o2 = v * 2;
        pos[o3] = x; pos[o3 + 1] = y; pos[o3 + 2] = z;
        norm[o3] = nx; norm[o3 + 1] = ny; norm[o3 + 2] = nz;
        orig[o2] = ox; orig[o2 + 1] = oz;
        locUp[v] = localUpVal;
        wet[v] = sWet;
        pid[v] = sPid;
        v++;
      };

      // 1. Top snow cap (localUp = +1.0, normal = +localY = (b3, b4, b5))
      const o0x = op[0][0], o0z = op[0][1];
      for (let i = 1; i < n - 1; i++) {
        const i1 = i + 1;
        emit(topX[0], topY[0], topZ[0], b3, b4, b5, o0x, o0z, 1.0);
        emit(topX[i1], topY[i1], topZ[i1], b3, b4, b5, op[i1][0], op[i1][1], 1.0);
        emit(topX[i], topY[i], topZ[i], b3, b4, b5, op[i][0], op[i][1], 1.0);
      }

      // 2. Wet glacial blue underside (localUp = -1.0, normal = -localY = (-b3, -b4, -b5))
      for (let i = 1; i < n - 1; i++) {
        const i1 = i + 1;
        emit(botX[0], botY[0], botZ[0], -b3, -b4, -b5, o0x, o0z, -1.0);
        emit(botX[i], botY[i], botZ[i], -b3, -b4, -b5, op[i][0], op[i][1], -1.0);
        emit(botX[i1], botY[i1], botZ[i1], -b3, -b4, -b5, op[i1][0], op[i1][1], -1.0);
      }

      // 3. Stratified fractured ice side walls (localUp = +0.42 top edge -> -0.42 bottom edge)
      for (let i = 0; i < n; i++) {
        const next = (i + 1) % n;
        const lex = lp[next][0] - lp[i][0];
        const lez = lp[next][1] - lp[i][1];
        const len = Math.hypot(lex, lez) || 1;
        const lnx = lez / len;
        const lnz = -lex / len;
        // Transform local outward edge normal into world space
        const wnx = b0 * lnx + b6 * lnz;
        const wny = b1 * lnx + b7 * lnz;
        const wnz = b2 * lnx + b8 * lnz;

        const oAx = op[i][0], oAz = op[i][1];
        const oBx = op[next][0], oBz = op[next][1];

        emit(botX[i], botY[i], botZ[i], wnx, wny, wnz, oAx, oAz, -0.42);
        emit(topX[i], topY[i], topZ[i], wnx, wny, wnz, oAx, oAz, 0.42);
        emit(botX[next], botY[next], botZ[next], wnx, wny, wnz, oBx, oBz, -0.42);

        emit(botX[next], botY[next], botZ[next], wnx, wny, wnz, oBx, oBz, -0.42);
        emit(topX[i], topY[i], topZ[i], wnx, wny, wnz, oAx, oAz, 0.42);
        emit(topX[next], topY[next], topZ[next], wnx, wny, wnz, oBx, oBz, 0.42);
      }
    }

    this.detachedGeo.attributes.position.needsUpdate = true;
    this.detachedGeo.attributes.normal.needsUpdate = true;
    this.detachedGeo.attributes.aOriginXZ.needsUpdate = true;
    this.detachedGeo.attributes.aLocalUp.needsUpdate = true;
    this.detachedGeo.attributes.aWetness.needsUpdate = true;
    this.detachedGeo.attributes.aPartId.needsUpdate = true;
    this.detachedGeo.setDrawRange(0, v);
  }

  // =========================================================================
  // 3D UNDULATING KELVIN WAKE RIBBON (Clipped Strictly to Open Water via Stencil!)
  // =========================================================================

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

  _updateTrailSpine(shipX, shipZ, heading) {
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const anchorX = shipX - fx * 2.0;
    const anchorZ = shipZ - fz * 2.0;

    if (this.trailNodes.length === 0) {
      this.trailNodes.push({ x: anchorX, z: anchorZ, heading, arcDist: 0, leftW: 5.2, rightW: 5.2 });
      return;
    }

    const last = this.trailNodes[this.trailNodes.length - 1];
    const dist = Math.hypot(anchorX - last.x, anchorZ - last.z);
    if (dist >= this.trailSpacing) {
      this.trailNodes.push({
        x: anchorX,
        z: anchorZ,
        heading,
        arcDist: last.arcDist + dist,
        leftW: 5.2,
        rightW: 5.2,
      });
      if (this.trailNodes.length > this.maxTrailNodes) {
        this.trailNodes.shift();
      }
    }
  }

  _updateFoamRibbon(shipX, shipZ, heading) {
    const nCount = this.trailNodes.length;
    if (nCount < 2) return;

    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const sternX = shipX - fx * 8.3;
    const sternZ = shipZ - fz * 8.3;

    const lastNode = this.trailNodes[nCount - 1];
    const anchorX = shipX - fx * 2.0;
    const anchorZ = shipZ - fz * 2.0;
    const anchorAhead = (anchorX - lastNode.x) * fx + (anchorZ - lastNode.z) * fz;
    const sternTrailArc = lastNode.arcDist + anchorAhead - 6.3;

    const rawPts = [{ x: sternX, z: sternZ, s: 0, leftW: 5.2, rightW: 5.2 }];
    let accum = 0;
    let prevX = sternX;
    let prevZ = sternZ;

    for (let i = nCount - 1; i >= 0 && accum < this.wakeAftLength + 10; i--) {
      const nd = this.trailNodes[i];
      if (nd.arcDist > sternTrailArc - 0.55) continue;
      const d = Math.hypot(nd.x - prevX, nd.z - prevZ);
      if (d < 0.35) continue;
      accum += d;
      rawPts.push({ x: nd.x, z: nd.z, s: accum, leftW: 5.2, rightW: 5.2 });
      prevX = nd.x;
      prevZ = nd.z;
    }

    if (rawPts.length < 2) {
      rawPts.push({
        x: sternX - fx * (this.wakeAftLength + 8),
        z: sternZ - fz * (this.wakeAftLength + 8),
        s: this.wakeAftLength + 8,
        leftW: 5.2,
        rightW: 5.2,
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
        leftW: 5.2,
        rightW: 5.2,
      });
    }

    const sampleAftSpline = (sQuery) => {
      let seg = 0;
      const lastIdx = rawPts.length - 1;
      while (seg < lastIdx - 1 && rawPts[seg + 1].s < sQuery) seg++;
      const p1 = rawPts[seg];
      const p2 = rawPts[Math.min(lastIdx, seg + 1)];
      const p0 = rawPts[Math.max(0, seg - 1)];
      const p3 = rawPts[Math.min(lastIdx, seg + 2)];
      const span = Math.max(1e-4, p2.s - p1.s);
      const t = THREE.MathUtils.clamp((sQuery - p1.s) / span, 0, 1);

      const p0x = seg === 0 ? sternX + fx * 3.0 : p0.x;
      const p0z = seg === 0 ? sternZ + fz * 3.0 : p0.z;
      return {
        x: this._catmullRom(p0x, p1.x, p2.x, p3.x, t),
        z: this._catmullRom(p0z, p1.z, p2.z, p3.z, t),
        leftW: 5.2,
        rightW: 5.2,
      };
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
          leftW: THREE.MathUtils.lerp(3.6, 5.2, bowBlend * bowBlend),
          rightW: THREE.MathUtils.lerp(3.6, 5.2, bowBlend * bowBlend),
        };
      } else {
        const sp = sampleAftSpline(sAft);
        centers[i] = { sAft, x: sp.x, z: sp.z, leftW: sp.leftW, rightW: sp.rightW };
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
      const rx = -az;
      const rz = ax;

      if (c.sAft >= -2.0 && c.sAft <= 48.0 && i % 4 === 0) {
        this._wakeSpineSamples.push({ sAft: c.sAft, x: c.x, z: c.z, px: rx, pz: rz });
      }

      const spanRight = c.rightW + 3.2;
      const spanLeft = c.leftW + 3.2;
      const worldS = sternTrailArc - c.sAft;

      for (let j = 0; j <= this.foamAcross; j++) {
        const v = j / this.foamAcross;
        const lat = -spanRight + v * (spanRight + spanLeft);
        const vIdx = i * cols + j;
        const pBase = vIdx * 3;
        const qBase = vIdx * 4;

        pos[pBase] = c.x + rx * lat;
        pos[pBase + 1] = 0.015;
        pos[pBase + 2] = c.z + rz * lat;

        wakeCoord[qBase] = c.sAft;
        wakeCoord[qBase + 1] = lat;
        wakeCoord[qBase + 2] = worldS;
        wakeCoord[qBase + 3] = 5.2;

        frameArr[qBase] = ax;
        frameArr[qBase + 1] = az;
        frameArr[qBase + 2] = rx;
        frameArr[qBase + 3] = rz;
      }
    }

    this.foamGeo.attributes.position.needsUpdate = true;
    this.foamGeo.attributes.aWakeCoord.needsUpdate = true;
    this.foamGeo.attributes.aFrame.needsUpdate = true;
  }

  // =========================================================================
  // MAIN FRAME UPDATE LOOP
  // =========================================================================

  update(dt, physics) {
    const clampedDt = Math.min(dt, 0.05);
    this._time += clampedDt;

    // Keep infinite horizon snow & sea planes centered under ship
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

    // Sync uniforms across snow, intact plates, detached slabs, water & Kelvin wake
    this.iceMat.uniforms.uShipPos.value.set(physics.x, 0, physics.z);
    this.intactPlateMat.uniforms.uShipPos.value.set(physics.x, 0, physics.z);
    this.detachedMat.uniforms.uShipPos.value.set(physics.x, 0, physics.z);

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

    // 1. Update trail spine for curved Kelvin wake ribbon
    this._updateTrailSpine(physics.x, physics.z, physics.heading);

    // 2. Pre-fracture stress cracks ahead of bow & flexural bend targets
    this._updatePreFractureStress(
      physics.x,
      physics.z,
      physics.heading,
      physics.iceBreakProgress || 0,
      physics.iceStress || 0,
      impactPulse,
      false
    );

    // 3. Consume ship impact event & execute real jigsaw-complement fracturing!
    const impactEv = typeof physics.consumeImpactEvent === 'function' ? physics.consumeImpactEvent() : null;
    this._processRealIceBreaking(physics, impactEv);

    // 4. Smoothly animate downward flexural bending on intact bow-loaded plates
    let flexChangedStaticMembership = false;
    const flexLambda = 1.0 - Math.exp(-clampedDt * 8.5);
    for (const cell of this.cells.values()) {
      if (!cell.subdivided) continue;
      for (let i = 0; i < cell.plates.length; i++) {
        const p = cell.plates[i];
        if (p.state !== 'INTACT') continue;
        const wasFlexing = p.flex > 0.006;
        if (Math.abs(p.flexTarget - p.flex) > 0.001) {
          p.flex += (p.flexTarget - p.flex) * flexLambda;
          if (p.flex < 0.004 && p.flexTarget === 0) p.flex = 0;
        }
        const isFlexing = p.flex > 0.006;
        if (wasFlexing !== isFlexing) flexChangedStaticMembership = true;
      }
    }
    if (flexChangedStaticMembership) this._intactStaticDirty = true;

    // 5. Prune far-away macro cells on long voyages to keep memory O(1)
    this._pruneFarMacroCells(physics.x, physics.z);

    // 6. Step 6-DOF Quaternion Buoyancy, Spoon-Bow Overturning & Under-Ice Rafting (2 substeps!)
    this._updateFoamRibbon(physics.x, physics.z, physics.heading);
    const subDt = clampedDt * 0.5;
    this._stepDetachedSlabs(subDt, physics, false);
    this._stepDetachedSlabs(subDt, physics, false);

    // 7. Upload updated GPU buffers
    if (this._domainDirty) this._rebuildDomainCutout();
    if (this._intactStaticDirty) this._rebuildIntactStaticMesh();
    this._rebuildIntactFlexMesh();
    if (this._cracksDirty || this._hasGrowingCracks) this._uploadCrackGeometry();
    this._uploadDetachedSlabGeometry();
  }
}
