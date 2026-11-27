import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import {
  createSharedWaterUniforms,
  WATER_WAVE_GLSL,
  WATER_LIGHTING_GLSL,
} from './waterCommon.js';

/**
 * High-Resolution 3D Undulating Kelvin Wake Wave, Reflection & Foam Shader:
 * - True sculptural 3D trochoidal vertex displacement for diverging Kelvin echelon V-waves,
 *   curved parabolic transverse stern rollers, bow/shoulder surge waves, and bank-edge echoes
 * - Metric world-anchored arc-length coordinates (zero jumping/stretching when sailing or turning!)
 * - Shares exact waterCommon.js lighting + crisp wave-rippled real-time planar reflections so the
 *   inverted cobalt hull, amber lifeboat, white cabins, mast & floes dance across the rolling waves!
 * - Disciplined Ligne Claire foam: dark Prussian sea remains dominant (~75%), accented by airy
 *   vortex-shedding twin-propeller plumes, subsurface turquoise aeration, delicate Kelvin crest
 *   whitecap hairlines, organic rounded spray droplets (zero blocky rectangles!), and ice-bank lapping
 */
export function createWakeWaveMaterial() {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.lights,
    createSharedWaterUniforms(),
    {
      uFoamColor: { value: new THREE.Color(PALETTE.foamWhite) },
      uFoamShadow: { value: new THREE.Color(PALETTE.foamShadow) },
      uAerationColor: { value: new THREE.Color(PALETTE.waterAeration) },
      uAerationShadow: { value: new THREE.Color('#183959') },
      uThrottle: { value: 0.42 },
      uSpeed: { value: 0.45 },
      uRudder: { value: 0.0 },
      uImpactPulse: { value: 0.0 },
      uWakeLength: { value: 64.0 },
    },
  ]);

  // Shared Kelvin wake wave height + analytical local gradient (dH/dAlong, dH/dAcross)
  const WAKE_FIELD_GLSL = /* glsl */ `
    // Returns vec4(heightMeters, dH_dAlong, dH_dAcross, cuspCrestFactor)
    vec4 evalKelvinWakeField(
      float sAft,
      float lat,
      float worldS,
      float bankW,
      float t,
      float speedNorm,
      float throttleAbs,
      float rudder
    ) {
      float absLat = abs(lat);
      float sideSign = lat >= 0.0 ? 1.0 : -1.0;
      float motion = clamp(max(speedNorm, throttleAbs * 0.72), 0.16, 1.25);

      // Smooth organic fluid warp so Kelvin ridges flow naturally
      float warp = (wNoise(vec2(worldS * 0.16, lat * 0.38 + t * 0.12)) - 0.5) * 0.58;

      float aftOn = smoothstep(-1.6, 1.2, sAft);
      float aftDecay = 1.0 - smoothstep(28.0, 62.0, sAft);
      float aftEnv = aftOn * aftDecay;

      // -----------------------------------------------------------------------
      // 1. DIVERGING KELVIN ECHELON V-WAVES (Classic ~19.5° wedge arms!)
      // -----------------------------------------------------------------------
      float cuspLat = 1.50 + max(0.0, sAft) * 0.30;
      float armSigma = 1.10 + max(0.0, sAft) * 0.088;
      float armEnv = exp(-pow((absLat - cuspLat) / armSigma, 2.0));
      float innerArmEnv = exp(-pow((absLat - cuspLat * 0.56) / (armSigma * 0.88), 2.0)) * 0.56;
      float divEnv = max(armEnv, innerArmEnv) * aftEnv;

      // Diagonal echelon wavefronts radiating continuously outward & astern from stern quarters!
      float kAlongDiv = 0.86;
      float kLatDiv   = 1.22;
      float waveRate  = 3.1 + motion * 3.6;

      float phaseDiv1 = sAft * kAlongDiv - absLat * kLatDiv - t * waveRate + warp;
      float phaseDiv2 = sAft * (kAlongDiv * 1.58) - absLat * (kLatDiv * 1.52) - t * (waveRate * 1.24) - warp * 0.55;

      vec2 trDiv1 = trochoid(phaseDiv1);
      vec2 trDiv2 = trochoid(phaseDiv2);

      float hDiv = (trDiv1.x * 0.78 + trDiv2.x * 0.32) * divEnv;
      float dDivAlong = (trDiv1.y * kAlongDiv * 0.78 + trDiv2.y * kAlongDiv * 1.58 * 0.32) * divEnv;
      float dDivAcross = -(trDiv1.y * kLatDiv * 0.78 + trDiv2.y * kLatDiv * 1.52 * 0.32) * sideSign * divEnv;

      // -----------------------------------------------------------------------
      // 2. CURVED PARABOLIC TRANSVERSE STERN ROLLERS (Iconic rolling U-swells!)
      // -----------------------------------------------------------------------
      float curvFactor = 0.115 / (1.0 + max(0.0, sAft) * 0.055);
      float sCurved = sAft - curvFactor * lat * lat;
      float kTrans = 0.90;
      float phaseTrans = sCurved * kTrans - t * (waveRate * 0.86) + warp * 0.42;
      vec2 trTrans = trochoid(phaseTrans);

      float transLatEnv = exp(-pow(absLat / (cuspLat * 0.94 + 0.65), 2.2));
      float transAftEnv = smoothstep(-0.4, 2.0, sAft) * (1.0 - smoothstep(16.0, 46.0, sAft));
      float transEnv = transLatEnv * transAftEnv;

      float hTrans = trTrans.x * 0.64 * transEnv;
      float dTransAlong = trTrans.y * kTrans * 0.64 * transEnv;
      float dTransAcross = trTrans.y * (-2.0 * curvFactor * lat * kTrans) * 0.64 * transEnv;

      // -----------------------------------------------------------------------
      // 3. BOW & HULL-SHOULDER SURGING V-WAVES (Beside ship, sAft in [-16..+4])
      // -----------------------------------------------------------------------
      float sFromBow = sAft + 16.5;
      float bowWindow = smoothstep(0.0, 2.8, sFromBow) * (1.0 - smoothstep(18.0, 34.0, sFromBow));
      float bowArmLat = 1.65 + max(0.0, sFromBow) * 0.24;
      float bowArmEnv = exp(-pow((absLat - bowArmLat) / (0.85 + max(0.0, sFromBow) * 0.055), 2.0));
      float outsideHull = smoothstep(2.15, 2.75, absLat) + smoothstep(-0.8, 1.5, sAft);
      float bowEnv = bowWindow * bowArmEnv * clamp(outsideHull, 0.0, 1.0);

      float phaseBow = sFromBow * 1.12 - absLat * 1.65 - t * (waveRate * 1.06) + warp * 0.45;
      vec2 trBow = trochoid(phaseBow);
      float hBow = trBow.x * 0.50 * bowEnv;
      float dBowAlong = trBow.y * 1.12 * 0.50 * bowEnv;
      float dBowAcross = -trBow.y * 1.65 * sideSign * 0.50 * bowEnv;

      // -----------------------------------------------------------------------
      // 4. ICE-BANK REFLECTED WAVE INTERFERENCE (Kelvin swells echoing off ice walls!)
      // -----------------------------------------------------------------------
      float distToBank = max(0.0, bankW - absLat);
      float bankZone = exp(-pow(distToBank / 1.15, 2.0)) * aftOn * (1.0 - smoothstep(34.0, 58.0, sAft));
      float phaseBank = sAft * 1.25 + distToBank * 2.45 - t * (waveRate * 1.15) + warp;
      vec2 trBank = trochoid(phaseBank);
      float hBank = trBank.x * 0.30 * bankZone;
      float dBankAlong = trBank.y * 1.25 * 0.30 * bankZone;
      float dBankAcross = -trBank.y * 2.45 * sideSign * 0.30 * bankZone;

      float totalH = (hDiv + hTrans + hBow + hBank) * motion;
      float dAlong = (dDivAlong + dTransAlong + dBowAlong + dBankAlong) * motion;
      float dAcross = (dDivAcross + dTransAcross + dBowAcross + dBankAcross) * motion;

      // Constructive Kelvin cusp & transverse crest peak signal (drives specular glints & thin crest arcs!)
      float cuspCrest = clamp(
        max(
          max(0.0, trDiv1.x) * armEnv * aftEnv * 1.12,
          max(0.0, trTrans.x) * transEnv * 0.85
        ) * motion + max(0.0, trBow.x) * bowEnv * motion * 0.68,
        0.0,
        1.30
      );

      float turnBoost = 1.0 + clamp(-rudder * sideSign * 0.24, -0.15, 0.30);

      return vec4(totalH * turnBoost, dAlong * turnBoost, dAcross * turnBoost, cuspCrest * turnBoost);
    }
  `;

  const vertexShader = /* glsl */ `
    #include <common>
    #include <shadowmap_pars_vertex>

    // aWakeCoord = (sAftMeters, latMeters, worldArcDist, localBankHalfWidth)
    attribute vec4 aWakeCoord;
    // aFrame     = (alongDir.x, alongDir.z, acrossDir.x, acrossDir.z)
    attribute vec4 aFrame;

    uniform float uTime;
    uniform float uSpeed;
    uniform float uThrottle;
    uniform float uRudder;

    varying vec3 vWorldPos;
    varying vec4 vWakeCoord;
    varying vec4 vFrame;
    varying float vVertWaveH;

    ${WATER_WAVE_GLSL}
    ${WAKE_FIELD_GLSL}

    void main() {
      vWakeCoord = aWakeCoord;
      vFrame = aFrame;

      float sAft   = aWakeCoord.x;
      float lat    = aWakeCoord.y;
      float worldS = aWakeCoord.z;
      float bankW  = aWakeCoord.w;

      vec4 wake = evalKelvinWakeField(sAft, lat, worldS, bankW, uTime, uSpeed, uThrottle, uRudder);
      vec3 amb  = evalAmbientOcean(position.xz, uTime, 0.45);

      // Bold, sculptural 3D physical rolling wake wave displacement!
      // Troughs stay cleanly above flat waterMesh (y=0.0) while rolling Kelvin crests rise up to +0.165m!
      float dispY = 0.012 + clamp(wake.x * 0.112 + amb.x * 0.022, -0.004, 0.165);

      // Gerstner horizontal crest-pinching sharpens the 3D rolling wave ridges!
      vec2 alongXZ = normalize(aFrame.xy + vec2(1e-5, 0.0));
      vec2 acrossXZ = normalize(aFrame.zw + vec2(1e-5, 0.0));
      vec2 pinch = (alongXZ * wake.y + acrossXZ * wake.z) * -0.055;

      vec3 transformed = vec3(position.x + pinch.x, dispY, position.z + pinch.y);
      vVertWaveH = wake.x;

      vec3 objectNormal = vec3(0.0, 1.0, 0.0);
      vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
      vec3 transformedNormal = normalize(normalMatrix * objectNormal);
      vWorldPos = worldPosition.xyz;

      #include <shadowmap_vertex>

      gl_Position = projectionMatrix * viewMatrix * worldPosition;
    }
  `;

  const fragmentShader = /* glsl */ `
    #include <common>
    #include <packing>
    #include <lights_pars_begin>
    #include <shadowmap_pars_fragment>

    uniform vec3 uFoamColor;
    uniform vec3 uFoamShadow;
    uniform vec3 uAerationColor;
    uniform vec3 uAerationShadow;
    uniform float uThrottle;
    uniform float uSpeed;
    uniform float uRudder;
    uniform float uImpactPulse;
    uniform float uWakeLength;

    varying vec3 vWorldPos;
    varying vec4 vWakeCoord;
    varying vec4 vFrame;
    varying float vVertWaveH;

    ${WATER_WAVE_GLSL}
    ${WATER_LIGHTING_GLSL}
    ${WAKE_FIELD_GLSL}

    void main() {
      float sAft   = vWakeCoord.x;
      float lat    = vWakeCoord.y;
      float worldS = vWakeCoord.z;
      float bankW  = vWakeCoord.w;
      float absLat = abs(lat);

      // Seamless longitudinal & outer-margin feather so 3D wake blends 100% invisibly into waterMesh!
      float bowFade = smoothstep(-16.2, -13.0, sAft);
      float tailFade = 1.0 - smoothstep(uWakeLength - 14.0, uWakeLength - 0.8, sAft);
      float marginFade = 1.0 - smoothstep(bankW + 1.2, bankW + 2.6, absLat);
      float ribbonMask = bowFade * tailFade * marginFade;
      if (ribbonMask < 0.01) discard;

      float motion = clamp(max(uSpeed, uThrottle * 0.78), 0.16, 1.25);

      // -----------------------------------------------------------------------
      // 1. UNIFIED AMBIENT SWELL + SCULPTURAL 3D KELVIN WAKE NORMAL FIELD
      // -----------------------------------------------------------------------
      vec4 wake = evalKelvinWakeField(sAft, lat, worldS, bankW, uTime, uSpeed, uThrottle, uRudder);

      float propCorridor = exp(-pow(lat / (1.55 + max(0.0, sAft) * 0.070), 2.0))
        * smoothstep(-0.6, 1.5, sAft) * (1.0 - smoothstep(22.0, 52.0, sAft));
      float agitation = clamp(0.24 + wake.w * 0.65 + propCorridor * 0.75, 0.0, 1.35) * motion;

      vec3 amb = evalAmbientOcean(vWorldPos.xz, uTime, agitation);

      // Transform curved local wake slopes into true world-space XZ gradient!
      vec2 alongXZ = normalize(vFrame.xy + vec2(1e-5, 0.0));
      vec2 acrossXZ = normalize(vFrame.zw + vec2(1e-5, 0.0));
      vec2 wakeGradXZ = alongXZ * wake.y + acrossXZ * wake.z;

      // Swirling wake eddies inside the turbulent stern wash
      vec2 eddyUv = vec2(worldS * 0.82 + uTime * 0.52, lat * 1.40);
      float e0 = wNoise(eddyUv);
      float ex = wNoise(eddyUv + vec2(0.16, 0.0));
      float ey = wNoise(eddyUv + vec2(0.0, 0.16));
      vec2 eddyGradXZ = (alongXZ * (ex - e0) + acrossXZ * (ey - e0)) * (1.20 * propCorridor + 0.50 * wake.w) * motion;

      vec2 totalGradXZ = amb.yz * 0.44 + wakeGradXZ * 0.78 + eddyGradXZ * 0.40;
      vec3 N = normalize(vec3(-totalGradXZ.x, 1.0, -totalGradXZ.y));
      float combinedHeight = amb.x * 0.48 + wake.x * 1.02;

      // Crisp directional shadow reception
      float castShadow = 1.0;
      #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
        float rawS = getShadow(
          directionalShadowMap[0],
          directionalLightShadows[0].shadowMapSize,
          directionalLightShadows[0].shadowIntensity,
          directionalLightShadows[0].shadowBias,
          directionalLightShadows[0].shadowRadius,
          vDirectionalShadowCoord[0]
        );
        castShadow = smoothstep(0.36, 0.62, rawS);
      #endif

      // -----------------------------------------------------------------------
      // 2. AIRY, DISCIPLINED LIGNE CLAIRE WAKE FOAM (Preserves Deep Prussian Sea & Reflections!)
      // -----------------------------------------------------------------------
      // 2A. Feathered undulating twin-propeller plumes (world-locked via worldS!)
      float aftMask = smoothstep(-0.25, 0.75, sAft) * (1.0 - smoothstep(8.0, 44.0, sAft));
      float vortexSway = sin(worldS * 0.58 - uTime * 2.5) * (0.12 + max(0.0, sAft) * 0.016);
      float rudderShift = uRudder * smoothstep(0.0, 12.0, sAft) * (1.0 - smoothstep(14.0, 36.0, sAft)) * 0.80;
      float latOsc = lat + vortexSway + rudderShift;

      // Distinct twin-screw foam ribbons with glossy dark-blue & turquoise water breathing between them!
      float jetSpread = 0.68 + max(0.0, sAft) * 0.048;
      float jetWidth  = 0.30 + max(0.0, sAft) * 0.032;
      float plumePort = exp(-pow((latOsc - jetSpread) / jetWidth, 2.0));
      float plumeStbd = exp(-pow((latOsc + jetSpread) / jetWidth, 2.0));
      // Compact churning stern transom boil right behind the propellers (0..6.5m, never a huge white carpet!)
      float sternBoil = exp(-pow(latOsc / (0.95 + max(0.0, sAft) * 0.045), 2.0))
        * smoothstep(-0.3, 0.55, sAft) * (1.0 - smoothstep(1.2, 6.8, sAft));
      float propEnv = max(max(plumePort, plumeStbd), sternBoil * 0.92) * aftMask;

      // Multi-scale streaky & frothy cellular wake lace anchored to worldS!
      float driftS = worldS + uTime * (0.48 + motion * 0.65);
      float nStreak = wNoise(vec2(driftS * 0.62, latOsc * 3.10));
      float nEddy   = wNoise(vec2(driftS * 1.55 - uTime * 0.60, latOsc * 4.8 + nStreak * 1.9));
      float nCell   = wNoise(vec2(driftS * 3.20 + nEddy * 1.4, latOsc * 6.2 - nStreak * 1.5));
      float foamTex = nStreak * 0.44 + nEddy * 0.34 + nCell * 0.22;

      // Crisp feathered white foam wisps with natural frothy holes opening astern
      float rawPropFoam = propEnv * foamTex * (0.48 + 0.52 * motion);
      float propFoamMain = smoothstep(0.32, 0.41, rawPropFoam);
      float laceCut = smoothstep(0.26, 0.56, nCell) * smoothstep(2.5, 18.0, sAft);
      propFoamMain *= (1.0 - laceCut * 0.64);

      // Smooth organic rounded spray droplets (replaces old blocky grid rectangles!)
      float dropMask = smoothstep(0.16, 0.36, propEnv * motion) * (1.0 - smoothstep(16.0, 38.0, sAft));
      float droplets = organicDroplets(vec2(driftS * 1.55 + nEddy * 0.6, latOsc * 2.15 + nStreak * 0.85), 0.22) * dropMask;

      // 2B. Restrained Calligraphic Kelvin Cusp & Transverse Crest Foam Hairlines
      float crestBreak = wNoise(vec2(worldS * 1.10 - uTime * 0.72, lat * 2.05 + wake.x * 1.1));
      float crestBreak2 = wNoise(vec2(worldS * 2.45, lat * 4.20 - uTime * 1.05));
      float kelvinCrestFoam = smoothstep(
        0.82,
        0.95,
        wake.w * (0.62 + 0.46 * crestBreak) * (0.84 + 0.24 * crestBreak2)
      ) * smoothstep(0.0, 3.0, sAft) * (1.0 - smoothstep(22.0, 42.0, sAft));

      // Bow shoulder surge ripple + transient crisp foam burst on ice-ram/bump collision!
      float bowWindow = smoothstep(-16.0, -10.5, sAft) * (1.0 - smoothstep(-1.5, 2.0, sAft));
      float bowImpactBoost = uImpactPulse * exp(-pow((absLat - 2.45) / 0.92, 2.0)) * bowWindow * (0.48 + 0.52 * crestBreak);
      float bowFoam = max(
        smoothstep(0.74, 0.90, wake.w * (0.62 + 0.44 * crestBreak)) * bowWindow,
        smoothstep(0.22, 0.52, bowImpactBoost) * 0.88
      );

      // Subtle animated ice-bank lapping hairline
      float distToBank = max(0.0, bankW - absLat);
      float bankLapWave = smoothstep(0.34, 0.80, wake.x + amb.x * 0.40 + 0.16);
      float bankRimFoam = (1.0 - smoothstep(0.03, 0.18, distToBank))
        * smoothstep(0.54, 0.80, crestBreak * 0.56 + bankLapWave * 0.56)
        * smoothstep(-4.0, 3.0, sAft) * (1.0 - smoothstep(26.0, 46.0, sAft)) * motion * 0.34;

      float surfaceFoam = clamp(
        max(
          max(propFoamMain, droplets * 0.74),
          max(max(kelvinCrestFoam * 0.44, bowFoam * 0.52), bankRimFoam)
        ),
        0.0,
        1.0
      );

      // 2C. Subtle Subsurface Aerated Arctic Cerulean-Cobalt Bubble Wash
      float aerationEnv = max(
        propEnv * (0.58 + 0.42 * nStreak) * 0.82,
        wake.w * 0.22 * (0.55 + 0.45 * crestBreak)
      ) * motion;
      float aerationBand = smoothstep(0.28, 0.58, aerationEnv);

      // -----------------------------------------------------------------------
      // 3. SHADE FULL POLAR WATER + RESTRAINED REFLECTIONS ON 3D WAVES!
      // -----------------------------------------------------------------------
      vec3 waterCol = shadePolarWater(
        vWorldPos,
        N,
        combinedHeight,
        castShadow,
        clamp(wake.w * 0.82, 0.0, 1.05),
        clamp(propCorridor * 0.55 + wake.w * 0.60, 0.0, 1.0),
        surfaceFoam
      );

      // Blend subtle subsurface aerated cerulean-cobalt bubble trail beneath white foam
      vec3 litAeration = mix(uAerationShadow, uAerationColor, castShadow);
      waterCol = mix(waterCol, litAeration, aerationBand * 0.18 * (1.0 - surfaceFoam * 0.55));

      // Composite crisp Ligne Claire white foam crests & airy twin-propeller plumes on top
      vec3 litFoam = mix(uFoamShadow, uFoamColor, castShadow);
      vec3 crestFoamCol = mix(litFoam * vec3(0.78, 0.87, 0.96), litFoam, clamp(propFoamMain * 1.15 + sternBoil, 0.0, 1.0));
      vec3 finalCol = mix(waterCol, crestFoamCol, surfaceFoam * 0.90);

      gl_FragColor = vec4(finalCol, ribbonMask);
    }
  `;

  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    lights: true,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    stencilWrite: true,
    stencilWriteMask: 0x00,
    stencilFunc: THREE.EqualStencilFunc,
    stencilRef: 1, // Strictly clipped inside carved open water channel!
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilZPass: THREE.KeepStencilOp,
  });
}
