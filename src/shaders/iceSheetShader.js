import * as THREE from 'three';
import { PALETTE, SUN_DIRECTION } from '../palette.js';

/**
 * Shared procedural cold-press snowfield GLSL (fine Rotring-pen stipple clusters,
 * delicate wind-scoured snow-crust smudges, macro tone drift & razor-crisp cobalt shadow).
 * Used identically by:
 * - Infinite background snow plane (`iceBgMesh`, stencil == 0)
 * - Active 3D intact Voronoi ice plates (`intactStaticMesh` / `intactFlexMesh`, stencil -> 2)
 * - Detached, overturning 3D fractured ice slabs (`detachedMesh`, sampling world-locked aOriginXZ!)
 *
 * Sharing bit-exact snow GLSL guarantees ZERO visible seams on intact ice AND causes
 * snow stipples/smudges to stay physically glued to a broken slab as it slides & flips!
 */
const SNOW_SURFACE_GLSL = /* glsl */ `
  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  float snowStippleClusters(vec2 wp, float fade) {
    if (fade < 0.01) return 0.0;

    vec2 dx = dFdx(wp);
    vec2 dy = dFdy(wp);
    float pxFootprint = clamp(sqrt(length(dx) * length(dy)), 0.028, 0.20);
    float dotRadius = max(0.052, pxFootprint * 0.80);
    float aa = max(0.020, pxFootprint * 0.44);

    float ink = 0.0;

    // 1A. Primary organic stipple constellations
    {
      float cellSize = 8.4;
      vec2 grid = wp / cellSize;
      vec2 cid = floor(grid);
      vec2 local = (fract(grid) - 0.5) * cellSize;
      float present = hash21(cid + vec2(19.7, 73.1));
      if (present < 0.52) {
        vec2 cCenter = (hash22(cid + vec2(4.1, 8.3)) - 0.5) * (cellSize * 0.62);
        vec2 rel = local - cCenter;
        if (dot(rel, rel) < 4.4) {
          float rot = (hash21(cid + vec2(8.7, 3.2)) - 0.5) * 2.2;
          float cr = cos(rot);
          float sr = sin(rot);
          vec2 rRel = vec2(rel.x * cr - rel.y * sr, rel.x * sr + rel.y * cr);
          for (int i = 0; i < 6; i++) {
            float fi = float(i);
            vec2 rnd = hash22(cid * 17.3 + vec2(fi * 3.7, fi * 11.1));
            if (i >= 3 && rnd.x > 0.64) continue;
            vec2 offset = vec2((rnd.x - 0.5) * 2.10, (rnd.y - 0.5) * 0.90);
            float r = dotRadius * (0.74 + rnd.y * 0.46);
            float strength = 0.78 + 0.22 * hash21(cid + vec2(fi * 5.1, 2.3));
            float d = length(rRel - offset);
            ink = max(ink, (1.0 - smoothstep(r - aa, r + aa, d)) * strength);
          }
        }
      }
    }

    // 1B. Secondary fine lone pinpoints & delicate twin micro-specks
    {
      float cellSize = 5.0;
      vec2 grid = (wp + vec2(2.7, 1.9)) / cellSize;
      vec2 cid = floor(grid);
      vec2 local = (fract(grid) - 0.5) * cellSize;
      float present = hash21(cid + vec2(91.3, 14.2));
      if (present < 0.34) {
        vec2 cCenter = (hash22(cid + vec2(12.9, 5.4)) - 0.5) * (cellSize * 0.66);
        vec2 rel = local - cCenter;
        float r1 = dotRadius * (0.72 + 0.36 * hash21(cid + vec2(4.4, 9.9)));
        float d1 = length(rel);
        ink = max(ink, (1.0 - smoothstep(r1 - aa, r1 + aa, d1)) * 0.90);
        if (present < 0.15) {
          vec2 off2 = (hash22(cid + vec2(33.1, 47.7)) - 0.5) * vec2(0.85, 0.55);
          float d2 = length(rel - off2);
          ink = max(ink, (1.0 - smoothstep(r1 * 0.78 - aa, r1 * 0.78 + aa, d2)) * 0.78);
        }
        if (present < 0.07) {
          vec2 off3 = (hash22(cid + vec2(61.5, 22.9)) - 0.5) * vec2(1.15, 0.68);
          float d3 = length(rel - off3);
          ink = max(ink, (1.0 - smoothstep(r1 * 0.68 - aa, r1 * 0.68 + aa, d3)) * 0.68);
        }
      }
    }

    // 1C. Ultra-delicate ink nib micro-flecks
    {
      float cellSize = 3.2;
      vec2 grid = (wp + vec2(-1.4, 3.8)) / cellSize;
      vec2 cid = floor(grid);
      vec2 local = (fract(grid) - 0.5) * cellSize;
      float present = hash21(cid + vec2(42.7, 81.9));
      if (present < 0.16) {
        vec2 cCenter = (hash22(cid + vec2(7.3, 15.8)) - 0.5) * (cellSize * 0.68);
        vec2 rel = local - cCenter;
        float r = dotRadius * 0.62;
        float d = length(rel);
        ink = max(ink, (1.0 - smoothstep(r - aa, r + aa, d)) * 0.56);
      }
    }

    return ink * fade;
  }

  vec2 snowSurfaceBlemishes(vec2 wp, float fade) {
    if (fade < 0.01) return vec2(0.0);

    float smudgeAcc = 0.0;
    float warmAcc = 0.0;

    {
      float cellSize = 6.8;
      vec2 grid = (wp + vec2(4.3, -3.1)) / cellSize;
      vec2 cid = floor(grid);
      vec2 local = (fract(grid) - 0.5) * cellSize;
      float present = hash21(cid + vec2(53.4, 28.9));
      if (present < 0.34) {
        vec2 center = (hash22(cid + vec2(7.7, 19.3)) - 0.5) * (cellSize * 0.58);
        vec2 rel = local - center;
        vec2 dims = vec2(0.36 + hash21(cid + 1.3) * 0.62, 0.16 + hash21(cid + 2.9) * 0.28);
        float ang = (hash21(cid + 5.1) - 0.5) * 1.65;
        float ca = cos(ang);
        float sa = sin(ang);
        vec2 rotRel = vec2(rel.x * ca - rel.y * sa, rel.x * sa + rel.y * ca);
        float wobble = (valueNoise(wp * 2.4 + cid * 3.1) - 0.5) * 0.42;
        float d = length(rotRel / dims) + wobble;
        float patchMask = (1.0 - smoothstep(0.45, 1.02, d)) * (0.42 + 0.58 * valueNoise(wp * 3.8));
        smudgeAcc = max(smudgeAcc, patchMask * 0.85);
        warmAcc = hash21(cid + vec2(17.1, 6.2));
      }
    }

    {
      float cellSize = 4.1;
      vec2 grid = (wp + vec2(-2.9, 5.4)) / cellSize;
      vec2 cid = floor(grid);
      vec2 local = (fract(grid) - 0.5) * cellSize;
      float present = hash21(cid + vec2(66.2, 11.7));
      if (present < 0.24) {
        vec2 center = (hash22(cid + vec2(21.4, 9.8)) - 0.5) * (cellSize * 0.62);
        vec2 rel = local - center;
        vec2 dims = vec2(0.24 + hash21(cid + 3.7) * 0.28, 0.08 + hash21(cid + 8.3) * 0.10);
        float ang = 0.28 + (hash21(cid + 9.4) - 0.5) * 0.55;
        float ca = cos(ang);
        float sa = sin(ang);
        vec2 rotRel = vec2(rel.x * ca - rel.y * sa, rel.x * sa + rel.y * ca);
        float d = length(rotRel / dims);
        float fleck = 1.0 - smoothstep(0.42, 1.0, d);
        if (fleck > smudgeAcc) {
          smudgeAcc = max(smudgeAcc, fleck * 0.62);
          warmAcc = 0.25;
        }
      }
    }

    return vec2(smudgeAcc * fade, warmAcc);
  }

  vec3 shadeSnowTop(
    vec2 snowXZ,
    vec3 worldPos,
    float viewDist,
    float castShadow,
    float nearShipFadeMul,
    vec3 snowLit,
    vec3 snowWarm,
    vec3 snowShadow,
    vec3 smudgeCool,
    vec3 smudgeWarm,
    vec3 stippleColor,
    vec3 shipPos
  ) {
    float macroDrift = valueNoise(snowXZ * 0.045) * 0.65 + valueNoise(snowXZ * 0.14) * 0.35;
    vec3 snowBase = mix(snowWarm, snowLit, smoothstep(0.25, 0.78, macroDrift));
    vec3 shadowTint = mix(snowShadow * 0.97, snowShadow * 1.03, macroDrift);
    vec3 col = mix(shadowTint, snowBase, castShadow);

    vec3 viewDir = normalize(cameraPosition - worldPos);
    float angleFade = smoothstep(0.09, 0.28, abs(viewDir.y));
    float distFade = 1.0 - smoothstep(130.0, 265.0, viewDist);
    float nearShipFade = mix(1.0, smoothstep(3.0, 5.6, length(worldPos.xz - shipPos.xz)), nearShipFadeMul);
    float detailFade = distFade * nearShipFade * angleFade;

    vec2 blemish = snowSurfaceBlemishes(snowXZ, detailFade);
    vec3 smudgeTint = mix(smudgeCool, smudgeWarm, blemish.y * 0.45);
    col = mix(col, smudgeTint, blemish.x * mix(0.14, 0.46, castShadow));

    float stipple = snowStippleClusters(snowXZ, detailFade);
    col = mix(col, stippleColor, stipple * mix(0.32, 0.92, castShadow));

    float horizonMelt = smoothstep(225.0, 395.0, viewDist);
    col = mix(col, snowLit, horizonMelt);

    return col;
  }
`;

function createSnowUniforms() {
  return {
    uSnowLit: { value: new THREE.Color(PALETTE.snowLit) },
    uSnowWarm: { value: new THREE.Color(PALETTE.snowWarmVar) },
    uSnowShadow: { value: new THREE.Color(PALETTE.snowShadow) },
    uSnowSmudgeCool: { value: new THREE.Color('#c8d2dc') },
    uSnowSmudgeWarm: { value: new THREE.Color('#d7d6d2') },
    uStippleColor: { value: new THREE.Color(PALETTE.stippleInk) },
    uSideLit: { value: new THREE.Color(PALETTE.snowEdgeShade) },
    uSideShadow: { value: new THREE.Color(PALETTE.snowEdgeDark) },
    uSideWaterline: { value: new THREE.Color('#5a81a4') },
    uUnderLit: { value: new THREE.Color('#6a97b8') },      // Crisp upturned wet glacial-blue underside!
    uUnderShadow: { value: new THREE.Color('#395f82') },   // Shaded wet glacial ice keel
    uWetSnowTint: { value: new THREE.Color('#b6cce0') },   // Damp snow after dipping under seawater
    uSunDir: { value: SUN_DIRECTION.clone() },
    uShipPos: { value: new THREE.Vector3(0, 0, 0) },
  };
}

/**
 * 1. Infinite Background Polar Snow Plane (`iceBgMesh`, stencil == 0):
 * Covers distant unbroken ice seamlessly to the horizon outside activated Voronoi cells.
 */
export function createIceSheetMaterial() {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.lights,
    createSnowUniforms(),
  ]);

  const vertexShader = /* glsl */ `
    #include <common>
    #include <shadowmap_pars_vertex>

    varying vec3 vWorldPos;
    varying float vViewDist;

    void main() {
      vec3 transformed = vec3(position);
      vec3 objectNormal = vec3(0.0, 1.0, 0.0);
      vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
      vec3 transformedNormal = normalize(normalMatrix * objectNormal);

      vWorldPos = worldPosition.xyz;
      vec4 mvPos = viewMatrix * worldPosition;
      vViewDist = -mvPos.z;

      #include <shadowmap_vertex>

      gl_Position = projectionMatrix * mvPos;
    }
  `;

  const fragmentShader = /* glsl */ `
    #include <common>
    #include <packing>
    #include <lights_pars_begin>
    #include <shadowmap_pars_fragment>

    uniform vec3 uSnowLit;
    uniform vec3 uSnowWarm;
    uniform vec3 uSnowShadow;
    uniform vec3 uSnowSmudgeCool;
    uniform vec3 uSnowSmudgeWarm;
    uniform vec3 uStippleColor;
    uniform vec3 uSunDir;
    uniform vec3 uShipPos;

    varying vec3 vWorldPos;
    varying float vViewDist;

    ${SNOW_SURFACE_GLSL}

    void main() {
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

      vec3 col = shadeSnowTop(
        vWorldPos.xz,
        vWorldPos,
        vViewDist,
        castShadow,
        1.0,
        uSnowLit,
        uSnowWarm,
        uSnowShadow,
        uSnowSmudgeCool,
        uSnowSmudgeWarm,
        uStippleColor,
        uShipPos
      );

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    lights: true,
    stencilWrite: true,
    stencilWriteMask: 0x00,
    stencilFunc: THREE.EqualStencilFunc,
    stencilRef: 0,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilZPass: THREE.KeepStencilOp,
  });
}

/**
 * 2. Active 3D Intact Voronoi Ice Plates Material (`intactStaticMesh` & `intactFlexMesh`):
 * - Top face (N.y > 0.65): bit-identical snow shading to `iceBgMesh` -> ZERO seam on intact ice!
 * - Exposed 3D vertical ice-shelf cliff wall (N.y <= 0.65): crisp cel-shaded fractured ice cross-section
 * - Writes stencil = 2 where visible so open-water `waterMesh` & 3D Kelvin `foamMesh` (stencil == 1)
 *   clip with razor precision to every jagged fractured polygonal bay!
 */
export function createIntactPlateMaterial() {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.lights,
    createSnowUniforms(),
  ]);

  const vertexShader = /* glsl */ `
    #include <common>
    #include <shadowmap_pars_vertex>

    varying vec3 vWorldPos;
    varying vec3 vWorldNormal;
    varying float vViewDist;

    void main() {
      vec3 transformed = vec3(position);
      vec3 objectNormal = normalize(normal);
      vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
      vec3 transformedNormal = normalize(normalMatrix * objectNormal);

      vWorldPos = worldPosition.xyz;
      vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
      vec4 mvPos = viewMatrix * worldPosition;
      vViewDist = -mvPos.z;

      #include <shadowmap_vertex>

      gl_Position = projectionMatrix * mvPos;
    }
  `;

  const fragmentShader = /* glsl */ `
    #include <common>
    #include <packing>
    #include <lights_pars_begin>
    #include <shadowmap_pars_fragment>

    uniform vec3 uSnowLit;
    uniform vec3 uSnowWarm;
    uniform vec3 uSnowShadow;
    uniform vec3 uSnowSmudgeCool;
    uniform vec3 uSnowSmudgeWarm;
    uniform vec3 uStippleColor;
    uniform vec3 uSideLit;
    uniform vec3 uSideShadow;
    uniform vec3 uSideWaterline;
    uniform vec3 uSunDir;
    uniform vec3 uShipPos;

    varying vec3 vWorldPos;
    varying vec3 vWorldNormal;
    varying float vViewDist;

    ${SNOW_SURFACE_GLSL}

    void main() {
      vec3 N = normalize(vWorldNormal);
      vec3 L = normalize(uSunDir);
      float ndl = dot(N, L);

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

      float isTop = smoothstep(0.58, 0.78, N.y);

      vec3 topCol = shadeSnowTop(
        vWorldPos.xz,
        vWorldPos,
        vViewDist,
        castShadow,
        1.0,
        uSnowLit,
        uSnowWarm,
        uSnowShadow,
        uSnowSmudgeCool,
        uSnowSmudgeWarm,
        uStippleColor,
        uShipPos
      );

      // Subtle cool shading when bow presses an intact lip into a gentle downward flexural bend
      float flexTiltShade = smoothstep(0.996, 0.965, N.y) * 0.10;
      topCol = mix(topCol, uSnowShadow, flexTiltShade * castShadow);

      float celLit = smoothstep(0.02, 0.09, ndl);
      float lit = min(celLit, castShadow);
      vec3 sideCol = mix(uSideShadow, uSideLit, lit);
      // Wet waterline band along the lower half of the 0.14m cliff wall
      float wlBand = 1.0 - smoothstep(0.01, 0.065, vWorldPos.y);
      sideCol = mix(sideCol, mix(uSideShadow * 0.85, uSideWaterline, lit), wlBand * 0.55);

      vec3 col = mix(sideCol, topCol, isTop);
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    lights: true,
    stencilWrite: true,
    stencilWriteMask: 0xff,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilRef: 2,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilZPass: THREE.ReplaceStencilOp,
  });
}

/**
 * 3. Detached 6-DOF Fractured Ice Slabs Material (`detachedMesh`):
 * - Top face (`vLocalUp > 0.55`): world-locked snow texture via `aOriginXZ` (stipples stay glued
 *   to the exact detached chunk!) + damp seawater wash darkening (`aWetness`) when dipped/splashed!
 * - Side fracture walls (`|vLocalUp| <= 0.55`): stratified crisp glacial ice-edge thickness
 * - Underside (`vLocalUp < -0.55`): iconic deep wet polar blue-teal ice keel visible whenever
 *   the spoon bow levers & overturns a slab 90°-180°!
 */
export function createDetachedSlabMaterial() {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.lights,
    createSnowUniforms(),
  ]);

  const vertexShader = /* glsl */ `
    #include <common>
    #include <shadowmap_pars_vertex>

    attribute vec2 aOriginXZ;
    attribute float aLocalUp;
    attribute float aWetness;

    varying vec3 vWorldPos;
    varying vec3 vWorldNormal;
    varying vec2 vOriginXZ;
    varying float vLocalUp;
    varying float vWetness;
    varying float vViewDist;

    void main() {
      vec3 transformed = vec3(position);
      vec3 objectNormal = normalize(normal);
      vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
      vec3 transformedNormal = normalize(normalMatrix * objectNormal);

      vWorldPos = worldPosition.xyz;
      vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
      vOriginXZ = aOriginXZ;
      vLocalUp = aLocalUp;
      vWetness = aWetness;

      vec4 mvPos = viewMatrix * worldPosition;
      vViewDist = -mvPos.z;

      #include <shadowmap_vertex>

      gl_Position = projectionMatrix * mvPos;
    }
  `;

  const fragmentShader = /* glsl */ `
    #include <common>
    #include <packing>
    #include <lights_pars_begin>
    #include <shadowmap_pars_fragment>

    uniform vec3 uSnowLit;
    uniform vec3 uSnowWarm;
    uniform vec3 uSnowShadow;
    uniform vec3 uSnowSmudgeCool;
    uniform vec3 uSnowSmudgeWarm;
    uniform vec3 uStippleColor;
    uniform vec3 uSideLit;
    uniform vec3 uSideShadow;
    uniform vec3 uSideWaterline;
    uniform vec3 uUnderLit;
    uniform vec3 uUnderShadow;
    uniform vec3 uWetSnowTint;
    uniform vec3 uSunDir;
    uniform vec3 uShipPos;

    varying vec3 vWorldPos;
    varying vec3 vWorldNormal;
    varying vec2 vOriginXZ;
    varying float vLocalUp;
    varying float vWetness;
    varying float vViewDist;

    ${SNOW_SURFACE_GLSL}

    void main() {
      vec3 N = normalize(vWorldNormal);
      vec3 L = normalize(uSunDir);
      float ndl = dot(N, L);

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

      float celLit = smoothstep(0.02, 0.11, ndl);
      float lit = min(celLit, castShadow);

      // 1. Snow top face (world-locked stipples + tilted cel shading + seawater splash wetness)
      vec3 topCol = shadeSnowTop(
        vOriginXZ,
        vWorldPos,
        vViewDist,
        lit,
        0.0,
        uSnowLit,
        uSnowWarm,
        uSnowShadow,
        uSnowSmudgeCool,
        uSnowSmudgeWarm,
        uStippleColor,
        uShipPos
      );
      float wetBlend = clamp(vWetness, 0.0, 1.0) * 0.36;
      topCol = mix(topCol, mix(uSnowShadow, uWetSnowTint, lit), wetBlend);

      // 2. Stratified fractured ice side face (crisp snow cap transitioning into cool glacial blue lower body)
      vec3 sideUpper = mix(uSideShadow, uSideLit, lit);
      vec3 sideLower = mix(uUnderShadow, uSideWaterline, lit);
      float heightMix = smoothstep(-0.35, 0.45, vLocalUp);
      vec3 sideCol = mix(sideLower, sideUpper, heightMix);

      // 3. Wet seawater-soaked glacial underside (dramatically revealed when bow overturns a slab!)
      float iceGrain = valueNoise(vOriginXZ * 1.45) * 0.55 + valueNoise(vOriginXZ * 3.8) * 0.45;
      vec3 underLitVar = mix(uUnderLit * 0.90, uUnderLit * 1.12, iceGrain);
      vec3 underCol = mix(uUnderShadow, underLitVar, lit);

      float isTop = smoothstep(0.65, 0.85, vLocalUp);
      float isBottom = smoothstep(-0.65, -0.85, vLocalUp);
      vec3 col = mix(sideCol, topCol, isTop);
      col = mix(col, underCol, isBottom);

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    lights: true,
  });
}
