import * as THREE from 'three';
import { PALETTE, SUN_DIRECTION } from '../palette.js';

/**
 * Custom Ligne Claire Cel-Shaded Material with crisp thresholded directional shadows.
 * Directly uses exact illustration colors (no tone-mapping washout) and supports InstancedMesh.
 */
export function createCelMaterial({
  litColor,
  shadowColor,
  deepShadowColor = null,
  map = null,
  receiveShadow = true,
  terminator = 0.06,
  doubleSide = false,
  polygonOffset = false,
  transparent = false,
  opacity = 1.0,
} = {}) {
  const cLit = new THREE.Color(litColor);
  const cShadow = new THREE.Color(shadowColor);
  const cDeep = deepShadowColor
    ? new THREE.Color(deepShadowColor)
    : cShadow.clone().multiplyScalar(0.88);

  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.lights,
    {
      uLitColor: { value: cLit },
      uShadowColor: { value: cShadow },
      uDeepShadowColor: { value: cDeep },
      uSunDir: { value: SUN_DIRECTION.clone() },
      uTerminator: { value: terminator },
      uReceiveShadow: { value: receiveShadow ? 1.0 : 0.0 },
      uMap: { value: map },
      uUseMap: { value: map ? 1.0 : 0.0 },
      uOpacity: { value: opacity },
    },
  ]);

  const vertexShader = /* glsl */ `
    #include <common>
    #include <shadowmap_pars_vertex>

    varying vec3 vWorldNormal;
    varying vec3 vWorldPos;
    varying vec2 vUv;

    void main() {
      vUv = uv;
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

    uniform vec3 uLitColor;
    uniform vec3 uShadowColor;
    uniform vec3 uDeepShadowColor;
    uniform vec3 uSunDir;
    uniform float uTerminator;
    uniform float uReceiveShadow;
    uniform sampler2D uMap;
    uniform float uUseMap;
    uniform float uOpacity;

    varying vec3 vWorldNormal;
    varying vec3 vWorldPos;
    varying vec2 vUv;

    void main() {
      vec3 N = normalize(vWorldNormal);
      if (!gl_FrontFacing) N = -N;

      vec3 L = normalize(uSunDir);
      float ndl = dot(N, L);

      // Razor-crisp 2-tone architectural cel terminator
      float celLit = smoothstep(uTerminator - 0.03, uTerminator + 0.03, ndl);

      // Thresholded PCF directional shadow -> razor-sharp vector-like cast shadow
      float castShadow = 1.0;
      #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
        if (uReceiveShadow > 0.5 && ndl > -0.05) {
          float raw = getShadow(
            directionalShadowMap[0],
            directionalLightShadows[0].shadowMapSize,
            directionalLightShadows[0].shadowIntensity,
            directionalLightShadows[0].shadowBias,
            directionalLightShadows[0].shadowRadius,
            vDirectionalShadowCoord[0]
          );
          castShadow = smoothstep(0.38, 0.62, raw);
        }
      #endif

      float litFactor = min(celLit, castShadow);

      // Subtle architectural deeper shade on strongly turned-away / downward soffits
      float deepTone = smoothstep(-0.32, -0.58, ndl);
      float underBoost = smoothstep(-0.2, -0.75, N.y) * 0.65;
      vec3 shadedBase = mix(uShadowColor, uDeepShadowColor, clamp(max(deepTone * 0.55, underBoost), 0.0, 1.0));

      vec3 col = mix(shadedBase, uLitColor, litFactor);

      // Optional crisp decal texture (e.g. CTSC hull lettering, deck seams, helipad markings)
      if (uUseMap > 0.5) {
        vec4 tex = texture2D(uMap, vUv);
        // Dark ink decals remain crisp in both lit and shadow
        col = mix(col, tex.rgb * mix(0.76, 1.0, litFactor), tex.a);
      }

      gl_FragColor = vec4(col, uOpacity);
    }
  `;

  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    lights: true,
    side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    transparent,
    polygonOffset,
    polygonOffsetFactor: polygonOffset ? 1 : 0,
    polygonOffsetUnits: polygonOffset ? 1 : 0,
  });
}

/**
 * Unlit flat ink / accent material (for windows, crisp markings, fine rigging, fracture cracks).
 */
export function createFlatInkMaterial(color = PALETTE.ink, {
  transparent = false,
  opacity = 1.0,
  doubleSide = false,
  polygonOffset = false,
  depthWrite = true,
} = {}) {
  return new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    transparent,
    opacity,
    side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    polygonOffset,
    polygonOffsetFactor: polygonOffset ? -1 : 0,
    polygonOffsetUnits: polygonOffset ? -2 : 0,
    depthWrite,
  });
}

/**
 * Normal + Linear Depth + Part ID G-Buffer Material for Ligne Claire screen-space ink outlines.
 * Encodes view-space octahedral normal in RG, linear depth in B, and normalized part ID in A.
 */
export function createGBufferMaterial({
  partId = 1,
  useInstanceId = false,
  doubleSide = false,
  farPlane = 700.0,
  stencilWrite = false,
  stencilWriteMask = 0xff,
  stencilFunc = THREE.AlwaysStencilFunc,
  stencilRef = 0,
  stencilFail = THREE.KeepStencilOp,
  stencilZFail = THREE.KeepStencilOp,
  stencilZPass = THREE.KeepStencilOp,
} = {}) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uPartId: { value: partId / 255.0 },
      uFarPlane: { value: farPlane },
    },
    defines: useInstanceId ? { USE_INSTANCE_PART_ID: '' } : {},
    vertexShader: /* glsl */ `
      #ifdef USE_INSTANCE_PART_ID
        attribute float aPartId;
        varying float vPartId;
      #endif

      varying vec3 vViewNormal;
      varying float vLinearDepth;

      void main() {
        #ifdef USE_INSTANCE_PART_ID
          vPartId = aPartId;
        #endif

        #ifdef USE_INSTANCING
          mat4 mv = modelViewMatrix * instanceMatrix;
          vec4 viewPos = mv * vec4(position, 1.0);
          vViewNormal = normalize(mat3(mv) * normal);
        #else
          vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
          vViewNormal = normalize(normalMatrix * normal);
        #endif

        vLinearDepth = -viewPos.z;
        gl_Position = projectionMatrix * viewPos;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uPartId;
      uniform float uFarPlane;

      #ifdef USE_INSTANCE_PART_ID
        varying float vPartId;
      #endif

      varying vec3 vViewNormal;
      varying float vLinearDepth;

      // Octahedral normal encoding into [0, 1]^2
      vec2 octEncode(vec3 n) {
        n /= (abs(n.x) + abs(n.y) + abs(n.z) + 1e-6);
        if (n.z < 0.0) {
          vec2 s = vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
          n.xy = (1.0 - abs(n.yx)) * s;
        }
        return n.xy * 0.5 + 0.5;
      }

      void main() {
        vec3 n = normalize(vViewNormal);
        if (!gl_FrontFacing) n = -n;
        vec2 encN = octEncode(n);
        float depthNorm = clamp(vLinearDepth / uFarPlane, 0.0, 1.0);
        #ifdef USE_INSTANCE_PART_ID
          float idVal = vPartId / 255.0;
        #else
          float idVal = uPartId;
        #endif
        gl_FragColor = vec4(encN, depthNorm, idVal);
      }
    `,
    side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    stencilWrite,
    stencilWriteMask,
    stencilFunc,
    stencilRef,
    stencilFail,
    stencilZFail,
    stencilZPass,
  });

  return mat;
}
