import * as THREE from 'three';
import {
  createSharedWaterUniforms,
  WATER_WAVE_GLSL,
  WATER_LIGHTING_GLSL,
} from './waterCommon.js';

/**
 * Open Arctic Sea Channel Material (Enhanced Ligne Claire Polar Water):
 * - Deep Prussian-indigo open sea channel with crisp cel-stepped trochoidal ocean swells
 * - Real-time wave-rippled planar reflections of the icebreaker, ice banks & floating floes
 * - View-angle-calibrated Arctic sky Fresnel & calligraphic sunlit sparkle strokes (zero Aerial blotches!)
 * - Strictly masked by stencil == 1 so water only renders inside the carved channel
 */
export function createWaterMaterial() {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.lights,
    createSharedWaterUniforms(),
    {
      uShipPos: { value: new THREE.Vector3(0, 0, 0) },
      uShipForward: { value: new THREE.Vector2(0, 1) },
      uShipRight: { value: new THREE.Vector2(1, 0) },
      uShipSpeed: { value: 0.42 },
    },
  ]);

  const vertexShader = /* glsl */ `
    #include <common>
    #include <shadowmap_pars_vertex>

    varying vec3 vWorldPos;

    void main() {
      vec3 transformed = vec3(position);
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

    uniform vec3 uShipPos;
    uniform vec2 uShipForward;
    uniform vec2 uShipRight;
    uniform float uShipSpeed;

    varying vec3 vWorldPos;

    ${WATER_WAVE_GLSL}
    ${WATER_LIGHTING_GLSL}

    void main() {
      vec2 wp = vWorldPos.xz;
      vec2 rel = wp - uShipPos.xz;
      float lon = dot(rel, uShipForward);
      float lat = dot(rel, uShipRight);

      // Gentle ambient wave agitation near the vessel & carved wake region
      float nearShip = exp(-dot(rel, rel) / 1400.0);
      float agitation = nearShip * clamp(uShipSpeed * 0.75 + 0.18, 0.0, 1.0);

      // Evaluate shared sharp-crested trochoidal polar ocean swells & perturbed surface normal
      vec3 wave = evalAmbientOcean(wp, uTime, agitation);
      vec3 N = normalize(vec3(-wave.y * 0.46, 1.0, -wave.z * 0.46));

      // Razor-crisp directional cast shadow reception
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

      // Subtle trailing swell echo far behind the 3D wake ribbon so distant channel stays lively
      float farWake = exp(-pow(lat / 5.5, 2.0)) * smoothstep(-140.0, -48.0, lon) * (1.0 - smoothstep(-20.0, -4.0, lon));
      vec3 col = shadePolarWater(
        vWorldPos,
        N,
        wave.x,
        castShadow,
        farWake * 0.14 * max(0.0, wave.x),
        agitation * 0.35,
        0.0
      );

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    lights: true,
    // Render water only inside the carved channel stencil mask (stencil == 1)
    stencilWrite: true,
    stencilWriteMask: 0x00,
    stencilFunc: THREE.EqualStencilFunc,
    stencilRef: 1,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilZPass: THREE.KeepStencilOp,
  });
}
