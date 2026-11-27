import * as THREE from 'three';
import { PALETTE, SUN_DIRECTION } from '../palette.js';

/**
 * Infinite Polar Snow Sheet Material:
 * - Off-white cold-press paper tone (#f3f5f6)
 * - Signature crisp cerulean-cobalt cast shadow (#6283ab)
 * - Authentic reference-matched fine hand-inked stipple clusters, lone ink pinpoints,
 *   delicate snow-crust smudges / wind-scoured ice blemishes across the vast white ice field
 * - Masked by stencil == 0 so the jagged vector-carved open sea channel punches through cleanly
 */
export function createIceSheetMaterial() {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.lights,
    {
      uSnowLit: { value: new THREE.Color(PALETTE.snowLit) },
      uSnowWarm: { value: new THREE.Color(PALETTE.snowWarmVar) },
      uSnowShadow: { value: new THREE.Color(PALETTE.snowShadow) },
      uSnowSmudgeCool: { value: new THREE.Color('#c8d2dc') },
      uSnowSmudgeWarm: { value: new THREE.Color('#d7d6d2') },
      uStippleColor: { value: new THREE.Color(PALETTE.stippleInk) },
      uSunDir: { value: SUN_DIRECTION.clone() },
      uShipPos: { value: new THREE.Vector3(0, 0, 0) },
    },
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

    // Layer 1: Fine Rotring-pen ink stipple clusters & lone pinpoints (reference snowfield signature!)
    float snowStippleClusters(vec2 wp, float fade) {
      if (fade < 0.01) return 0.0;

      // Use geometric mean of derivatives so grazing angles never stretch dots into chunky bars
      vec2 dx = dFdx(wp);
      vec2 dy = dFdy(wp);
      float pxFootprint = clamp(sqrt(length(dx) * length(dy)), 0.028, 0.20);
      float dotRadius = max(0.052, pxFootprint * 0.80);
      float aa = max(0.020, pxFootprint * 0.44);

      float ink = 0.0;

      // 1A. Primary organic stipple constellations (3..6 crisp pinpoint dots, varied rotation & density)
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

      // 1B. Secondary fine lone pinpoints & delicate twin micro-specks across open snow
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

      // 1C. Ultra-delicate ink nib micro-flecks / faint surface grit specks
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

    // Layer 2: Organic pale snow-crust smudges & wind-scoured ice blemishes (paper/ice micro-patina)
    // Returns vec2(smudgeStrength, warmMix)
    vec2 snowSurfaceBlemishes(vec2 wp, float fade) {
      if (fade < 0.01) return vec2(0.0);

      float smudgeAcc = 0.0;
      float warmAcc = 0.0;

      // 2A. Delicate irregular pale smudge patches (soft wind-dusted snow-crust marks)
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
          // Organic edge wobble via value noise so smudges never look like CG ovals
          float wobble = (valueNoise(wp * 2.4 + cid * 3.1) - 0.5) * 0.42;
          float d = length(rotRel / dims) + wobble;
          float patchMask = (1.0 - smoothstep(0.45, 1.02, d)) * (0.42 + 0.58 * valueNoise(wp * 3.8));
          smudgeAcc = max(smudgeAcc, patchMask * 0.85);
          warmAcc = hash21(cid + vec2(17.1, 6.2));
        }
      }

      // 2B. Tiny faint sastrugi / frost-pit micro-flecks (very restrained, crisp near-ground texture)
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
          float ang = 0.28 + (hash21(cid + 9.4) - 0.5) * 0.55; // Gentle prevailing wind direction
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

    void main() {
      // Very subtle large-scale cold-press snow drift tone modulation (keeps scene ultra clean)
      float macroDrift = valueNoise(vWorldPos.xz * 0.045) * 0.65 + valueNoise(vWorldPos.xz * 0.14) * 0.35;
      vec3 snowBase = mix(uSnowWarm, uSnowLit, smoothstep(0.25, 0.78, macroDrift));

      // Razor-sharp thresholded cast shadow -> iconic steel-cobalt shadow color
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

      // Subtle cool wash richness inside shadow
      vec3 shadowTint = mix(uSnowShadow * 0.97, uSnowShadow * 1.03, macroDrift);
      vec3 col = mix(shadowTint, snowBase, castShadow);

      // View-angle & distance fade (keeps specks crisp in both elevated & low-angle views without horizon clutter)
      vec3 viewDir = normalize(cameraPosition - vWorldPos);
      float angleFade = smoothstep(0.09, 0.28, abs(viewDir.y));
      float distFade = 1.0 - smoothstep(130.0, 265.0, vViewDist);
      float nearShipFade = smoothstep(3.0, 5.6, length(vWorldPos.xz - uShipPos.xz));
      float detailFade = distFade * nearShipFade * angleFade;

      // Delicate pale ice-surface smudges & snow-crust blemishes
      vec2 blemish = snowSurfaceBlemishes(vWorldPos.xz, detailFade);
      vec3 smudgeTint = mix(uSnowSmudgeCool, uSnowSmudgeWarm, blemish.y * 0.45);
      col = mix(col, smudgeTint, blemish.x * mix(0.14, 0.46, castShadow));

      // Crisp scattered editorial ink stipple dots & micro-specks (signature reference snowfield detail!)
      float stipple = snowStippleClusters(vWorldPos.xz, detailFade);
      col = mix(col, uStippleColor, stipple * mix(0.32, 0.92, castShadow));

      // Seamless whiteout melt into sky far toward horizon
      float horizonMelt = smoothstep(225.0, 395.0, vViewDist);
      col = mix(col, uSnowLit, horizonMelt);

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    lights: true,
    // Three.js requires stencilWrite: true to enable GL_STENCIL_TEST; writeMask 0x00 keeps stencil untouched!
    stencilWrite: true,
    stencilWriteMask: 0x00,
    stencilFunc: THREE.EqualStencilFunc,
    stencilRef: 0,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilZPass: THREE.KeepStencilOp,
  });
}
