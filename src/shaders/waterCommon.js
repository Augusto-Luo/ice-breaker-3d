import * as THREE from 'three';
import { PALETTE, SUN_DIRECTION } from '../palette.js';

/**
 * Shared uniform defaults & GLSL water shading core used by BOTH:
 * - waterShader.js (infinite open Arctic sea channel plane)
 * - wakeShader.js  (high-resolution 3D undulating Kelvin wake & foam mesh)
 *
 * Keeping the ambient swell field, planar reflection projection, Arctic sky Fresnel,
 * and calligraphic sunlight glints 100% identical guarantees zero seam where the
 * 3D wake surface transitions back into the open polar channel.
 */
export function createSharedWaterUniforms() {
  return {
    uWaterAbyss: { value: new THREE.Color(PALETTE.waterAbyss) },
    uWaterBase: { value: new THREE.Color(PALETTE.waterDeep) },
    uWaterMid: { value: new THREE.Color(PALETTE.waterMid) },
    uWaterCrest: { value: new THREE.Color(PALETTE.waterCrest) },
    uWaterShadow: { value: new THREE.Color(PALETTE.waterShadow) },
    uSkyReflect: { value: new THREE.Color(PALETTE.waterSkyReflect) },
    uHorizonGlow: { value: new THREE.Color(PALETTE.waterHorizonGlow) },
    uSunGlint: { value: new THREE.Color(PALETTE.waterSunGlint) },
    uSunDir: { value: SUN_DIRECTION.clone() },
    uTime: { value: 0 },
    tReflection: { value: null },
    uHasReflection: { value: 0.0 },
    uReflMatrix: { value: new THREE.Matrix4() },
  };
}

/**
 * Shared GLSL noise, smooth jittered organic droplet field, and sharp-crested
 * trochoidal polar ocean wave functions.
 */
export const WATER_WAVE_GLSL = /* glsl */ `
  float wHash21(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
  }

  vec2 wHash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
  }

  float wNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(wHash21(i), wHash21(i + vec2(1.0, 0.0)), f.x),
      mix(wHash21(i + vec2(0.0, 1.0)), wHash21(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  // Organic jittered round/oval foam droplets with natural size variation (zero grid regularity!)
  float organicDroplets(vec2 p, float radius) {
    vec2 cell = floor(p);
    vec2 local = fract(p);
    float acc = 0.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 neighbor = vec2(float(x), float(y));
        vec2 rnd = wHash22(cell + neighbor);
        if (rnd.x > 0.36) continue;
        vec2 rnd2 = wHash22(cell + neighbor + vec2(17.3, 41.7));
        vec2 pt = neighbor + 0.14 + 0.72 * rnd;
        vec2 diff = local - pt;
        // Organic teardrop elongation along flow axis
        diff.x *= 0.68;
        float r = radius * (0.52 + 0.72 * rnd2.x);
        float d = length(diff);
        acc = max(acc, 1.0 - smoothstep(r * 0.38, r, d));
      }
    }
    return acc;
  }

  // Trochoidal (Gerstner-inspired) sharp wave crests & broader glossy troughs + analytical derivative
  // Returns vec2(value in ~[-1.12, 1.24], dValue/dPhase)
  vec2 trochoid(float p) {
    float s1 = sin(p);
    float c1 = cos(p);
    float s2 = sin(2.0 * p - 0.40);
    float c2 = cos(2.0 * p - 0.40);
    float s3 = sin(3.0 * p - 0.80);
    float c3 = cos(3.0 * p - 0.80);
    return vec2(s1 + 0.30 * s2 + 0.07 * s3, c1 + 0.60 * c2 + 0.21 * c3);
  }

  // Multi-directional Arctic channel swells + crisp capillary ripples
  // Returns vec3(height, dH_dx, dH_dz)
  vec3 evalAmbientOcean(vec2 wp, float t, float agitation) {
    vec2 d1 = normalize(vec2(0.76, 0.65));
    vec2 d2 = normalize(vec2(-0.56, 0.83));
    vec2 d3 = normalize(vec2(0.93, -0.37));
    vec2 d4 = normalize(vec2(-0.31, -0.95));

    float k1 = 0.56;
    float k2 = 1.08;
    float k3 = 1.98;
    float k4 = 3.45;

    // Organic fluid domain warp so ambient ocean swells feel painterly rather than parallel stripes
    float warp = (wNoise(wp * 0.18 + vec2(t * 0.12, -t * 0.09)) - 0.5) * 1.48;
    float p1 = dot(wp, d1) * k1 - t * 1.22 + warp;
    float p2 = dot(wp, d2) * k2 - t * 1.70 - warp * 0.75;
    float p3 = dot(wp, d3) * k3 + t * 2.30 + warp * 0.42;
    float p4 = dot(wp, d4) * k4 - t * 3.05;

    float a1 = 0.28;
    float a2 = 0.22;
    float a3 = 0.13 * (1.0 + agitation * 0.60);
    float a4 = 0.075 * (1.0 + agitation * 0.85);

    vec2 w1 = trochoid(p1);
    vec2 w2 = trochoid(p2);
    vec2 w3 = trochoid(p3);
    vec2 w4 = trochoid(p4);

    float h = w1.x * a1 + w2.x * a2 + w3.x * a3 + w4.x * a4;

    vec2 grad =
      d1 * (w1.y * a1 * k1) +
      d2 * (w2.y * a2 * k2) +
      d3 * (w3.y * a3 * k3) +
      d4 * (w4.y * a4 * k4);

    // Fine directional capillary ripples for slender sunlit sparkle ridges
    vec2 capUvA = wp * 2.10 + vec2(t * 0.82, -t * 0.58);
    vec2 capUvB = wp * 3.90 + vec2(-t * 1.05, t * 0.88);
    float c0 = wNoise(capUvA);
    float cx = wNoise(capUvA + vec2(0.14, 0.0));
    float cz = wNoise(capUvA + vec2(0.0, 0.14));
    float f0 = wNoise(capUvB);
    float fx = wNoise(capUvB + vec2(0.12, 0.0));
    float fz = wNoise(capUvB + vec2(0.0, 0.12));

    vec2 microGrad =
      vec2(cx - c0, cz - c0) * (0.95 + agitation * 0.65) +
      vec2(fx - f0, fz - f0) * (0.58 + agitation * 0.55);

    return vec3(h, grad.x + microGrad.x, grad.y + microGrad.y);
  }
`;

/**
 * Shared GLSL fragment-shader water lighting, crisp wave-rippled real-time planar
 * reflection sampling, sculpted Arctic sky Fresnel, and calligraphic sun glints.
 */
export const WATER_LIGHTING_GLSL = /* glsl */ `
  uniform vec3 uWaterAbyss;
  uniform vec3 uWaterBase;
  uniform vec3 uWaterMid;
  uniform vec3 uWaterCrest;
  uniform vec3 uWaterShadow;
  uniform vec3 uSkyReflect;
  uniform vec3 uHorizonGlow;
  uniform vec3 uSunGlint;
  uniform vec3 uSunDir;
  uniform float uTime;
  uniform sampler2D tReflection;
  uniform float uHasReflection;
  uniform mat4 uReflMatrix;

  // Projects the wave-perturbed water surface into the real-time planar reflection target.
  // Calibrated distortion keeps reflected ship hull, CTSC silhouette, amber lifeboat, white cabins,
  // funnel, lattice mast, jagged ice banks and floating floes clearly recognizable in liquid wavy bars!
  vec4 sampleWaterReflection(
    vec3 worldPos,
    vec3 N,
    vec3 V,
    float waveHeight,
    float wakeBoost
  ) {
    if (uHasReflection < 0.5) return vec4(0.0);

    float distToCam = length(cameraPosition - worldPos);
    // Controlled distortion preserves crisp silhouette recognition while rippling visibly on Kelvin waves!
    float distortMeters = mix(0.20, 0.52, clamp(wakeBoost, 0.0, 1.0)) * clamp(distToCam / 38.0, 0.60, 1.35);

    vec3 mirrorBase = vec3(worldPos.x, 0.0, worldPos.z);
    vec2 viewXZ = normalize(vec2(V.x, V.z) + vec2(1e-5, 0.0));
    vec2 perpXZ = vec2(-viewXZ.y, viewXZ.x);

    // Classic editorial horizontal water-ripple slicing perpendicular to view ray
    float slicePhase = dot(worldPos.xz, viewXZ) * 4.6 + waveHeight * 5.2 - uTime * 3.2;
    float sliceWave = sin(slicePhase);
    vec2 perturbXZ = N.xz * distortMeters + perpXZ * (sliceWave * (0.09 + wakeBoost * 0.14));

    vec4 clipA = uReflMatrix * vec4(mirrorBase + vec3(perturbXZ.x, 0.0, perturbXZ.y), 1.0);
    vec2 uvA = (clipA.xy / max(clipA.w, 1e-4)) * 0.5 + 0.5;

    vec4 clipB = uReflMatrix * vec4(mirrorBase + vec3(perturbXZ.x * 0.42, 0.0, perturbXZ.y * 0.42), 1.0);
    vec2 uvB = (clipB.xy / max(clipB.w, 1e-4)) * 0.5 + 0.5;

    float inBoundsA = step(0.002, uvA.x) * step(uvA.x, 0.998) * step(0.002, uvA.y) * step(uvA.y, 0.998) * step(0.0, clipA.w);
    float inBoundsB = step(0.002, uvB.x) * step(uvB.x, 0.998) * step(0.002, uvB.y) * step(uvB.y, 0.998) * step(0.0, clipB.w);

    vec4 sA = texture2D(tReflection, clamp(uvA, 0.002, 0.998)) * inBoundsA;
    vec4 sB = texture2D(tReflection, clamp(uvB, 0.002, 0.998)) * inBoundsB;

    float aSum = sA.a * 0.62 + sB.a * 0.38;
    if (aSum < 0.01) return vec4(0.0);
    vec3 rgb = (sA.rgb * sA.a * 0.62 + sB.rgb * sB.a * 0.38) / max(aSum, 1e-4);

    // Graphic ripple-bar breakup: bright mirror ribbons on wave backs, clean dark ocean peeking in troughs!
    float barBreak = smoothstep(-0.55, 0.18, sliceWave * 0.50 + waveHeight * 0.72);
    float barFactor = mix(0.52, 1.0, barBreak);

    return vec4(rgb, clamp(aSum * barFactor, 0.0, 1.0));
  }

  // Unified Ligne Claire + Physically-Grounded Polar Water Lighting & Reflection Shading
  vec3 shadePolarWater(
    vec3 worldPos,
    vec3 N,
    float waveHeight,
    float castShadow,
    float wakeRidge,
    float wakeTurbulence,
    float foamCover
  ) {
    vec3 V = normalize(cameraPosition - worldPos);
    vec3 L = normalize(uSunDir);
    vec3 H = normalize(L + V);
    vec3 R = reflect(-V, N);

    float ndv = clamp(dot(N, V), 0.0, 1.0);
    float ndl = clamp(dot(N, L), 0.0, 1.0);
    float flatNdl = clamp(L.y, 0.0, 1.0);
    float viewElev = clamp(V.y, 0.0, 1.0); // ~0.25 Stern/Bow, ~0.60 Illustration, ~0.91 Aerial

    // -------------------------------------------------------------------------
    // 1. SCULPTURAL CEL-BANDED 3D WAVE RELIEF (Deep Prussian Troughs vs Calm Cobalt Ridges)
    // -------------------------------------------------------------------------
    float slopeSunDelta = (ndl - flatNdl) * 2.45;
    float relief = waveHeight * 0.50 + slopeSunDelta * 0.68 + wakeRidge * 0.34;

    // Subtle deep-indigo lee-side crease on rolling Kelvin wake ridges gives clear 3D depth without harshness
    float leeCrease = smoothstep(-0.32, -0.60, slopeSunDelta + waveHeight * 0.35) * (0.18 + wakeRidge * 0.58);
    float troughStep = smoothstep(-0.30, -0.04, relief);
    float midStep    = smoothstep( 0.14,  0.34, relief);
    float crestStep  = smoothstep( 0.46,  0.68, relief);

    vec3 col = mix(uWaterAbyss, uWaterBase, troughStep);
    col = mix(col, uWaterAbyss * 0.78, leeCrease * 0.50);
    col = mix(col, uWaterMid, midStep * 0.54);
    col = mix(col, uWaterCrest, crestStep * (0.24 + wakeRidge * 0.22));

    // -------------------------------------------------------------------------
    // 2. QUIET, RESTRAINED ARCTIC SKY FRESNEL (Preserves Deep Prussian-Indigo Dominance!)
    // -------------------------------------------------------------------------
    float fresnel = 0.010 + 0.990 * pow(1.0 - ndv, 5.4);
    float ry = clamp(R.y, 0.0, 1.0);
    float horizonBand = 1.0 - smoothstep(0.03, 0.24, ry);
    float midSkyBand  = 1.0 - smoothstep(0.16, 0.58, ry);

    vec3 skyEnv = mix(uWaterMid * 1.02, uSkyReflect, midSkyBand * 0.80);
    skyEnv = mix(skyEnv, uHorizonGlow, horizonBand * 0.26);

    float waveBackCatch = smoothstep(0.08, 0.48, waveHeight * 0.52 + slopeSunDelta * 0.34 + fresnel * 0.55);
    float skyWeight = mix(0.012, 0.105, fresnel) * mix(1.0, 0.22, smoothstep(0.52, 0.88, viewElev));
    col = mix(col, skyEnv, clamp(skyWeight * waveBackCatch * mix(0.32, 1.0, castShadow), 0.0, 0.105));

    // -------------------------------------------------------------------------
    // 3. SUBTLE, DEEPLY ABSORBED PLANAR REFLECTION (Never Milky or Over-Bright!)
    // -------------------------------------------------------------------------
    vec4 planarRefl = sampleWaterReflection(worldPos, N, V, waveHeight, wakeTurbulence);
    if (planarRefl.a > 0.01) {
      // Soft shoulder roll-off prevents bright white hull/cabins/floes from blowing out in dark water,
      // while cold deep-ocean absorption grounds reflections as understated indigo-slate echoes
      vec3 dampedRefl = planarRefl.rgb / (vec3(1.0) + planarRefl.rgb * 0.65);
      vec3 absorbedRefl = mix(dampedRefl, dampedRefl * vec3(0.36, 0.54, 0.76), 0.66);
      float reflFresnel = mix(0.085, 0.235, pow(1.0 - ndv, 2.25));
      float reflWeight = reflFresnel * mix(1.0, 0.30, smoothstep(0.60, 0.90, viewElev));
      reflWeight *= (1.0 - foamCover * 0.94) * mix(0.55, 1.0, castShadow);
      col = mix(col, absorbedRefl, clamp(planarRefl.a * reflWeight, 0.0, 0.22));
    }

    // -------------------------------------------------------------------------
    // 4. SPARSE, WHISPER-QUIET CALLIGRAPHIC SUNLIGHT ACCENTS (Disciplined Ligne Claire!)
    // -------------------------------------------------------------------------
    vec2 viewXZ = normalize(vec2(V.x, V.z) + vec2(1e-5, 0.0));
    vec2 acrossView = vec2(-viewXZ.y, viewXZ.x);
    vec2 glintCoord = vec2(
      dot(worldPos.xz, acrossView) * 0.52,
      dot(worldPos.xz, viewXZ) * 2.55
    );

    float gA = wNoise(glintCoord * 1.22 + vec2(uTime * 0.48, -uTime * 0.85) + N.xz * 1.25);
    float gB = wNoise(glintCoord * 2.55 + vec2(-uTime * 0.70, uTime * 1.12) + N.xz * 2.35);
    float shimmerStroke = gA * 0.58 + gB * 0.42;

    float ndh = clamp(dot(N, H), 0.0, 1.0);
    float flatNdh = clamp(H.y, 0.0, 1.0);
    float ndhBoost = (ndh - flatNdh) * mix(2.6, 1.4, smoothstep(0.52, 0.88, viewElev));
    float ridgeSunCatch = clamp(slopeSunDelta * 0.70 + ndhBoost * 0.50 + wakeRidge * 0.36, -1.0, 1.35);

    // 4A. Ultra-quiet steel-blue sunlit wave-ridge modeling (zero glare)
    float crestSheen = smoothstep(0.46, 0.74, ridgeSunCatch) * smoothstep(0.50, 0.78, shimmerStroke);
    col = mix(col, mix(uWaterCrest * 1.08, uSkyReflect, 0.42), crestSheen * (0.07 + wakeRidge * 0.07) * castShadow);

    // 4B. Rare, crisp micro-glints ONLY on the steepest sunlit wave peaks
    float lowAngleBoost = mix(0.02, 0.0, smoothstep(0.20, 0.55, viewElev));
    float aerialStrict = mix(0.0, 0.16, smoothstep(0.60, 0.90, viewElev));
    float glintVal = ridgeSunCatch * 0.48 + (shimmerStroke - 0.5) * 0.86 + max(0.0, waveHeight) * 0.10 + lowAngleBoost;
    float glintRibbon = smoothstep(0.77 + aerialStrict, 0.85 + aerialStrict, glintVal);
    float glintDiamond = smoothstep(0.85 + aerialStrict, 0.92 + aerialStrict, glintVal + (gB - 0.5) * 0.14);

    float wakeSpecFlash = smoothstep(0.76, 0.94, wakeRidge * 0.72 + slopeSunDelta * 0.48 + (shimmerStroke - 0.5) * 0.34);

    col = mix(col, uHorizonGlow, clamp(glintRibbon * 0.13 + wakeSpecFlash * 0.07, 0.0, 0.16) * castShadow);
    col = mix(col, uSunGlint, clamp(glintDiamond * 0.26 + wakeSpecFlash * glintRibbon * 0.11, 0.0, 0.28) * castShadow);

    // -------------------------------------------------------------------------
    // 5. CRISP CAST SHADOW COMPOSITE (Rich Velvet Midnight-Prussian Depth!)
    // -------------------------------------------------------------------------
    vec3 shadowWater = mix(uWaterShadow * 0.86, uWaterShadow * 1.14, troughStep * 0.5 + midStep * 0.5);
    if (planarRefl.a > 0.01) {
      vec3 dampedShadowRefl = planarRefl.rgb / (vec3(1.0) + planarRefl.rgb * 0.85);
      shadowWater = mix(shadowWater, dampedShadowRefl * vec3(0.24, 0.38, 0.56), clamp(planarRefl.a * 0.11 * (1.0 - foamCover), 0.0, 0.13));
    }
    col = mix(shadowWater, col, castShadow);

    return col;
  }
`;
