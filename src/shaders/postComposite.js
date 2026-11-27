import * as THREE from 'three';
import { PALETTE } from '../palette.js';

/**
 * Fullscreen Ligne Claire Post-Processing Compositor:
 * 1. Crisp uniform-weight screen-space ink outlines from Octahedral Normal + Linear Depth + Part ID
 * 2. Authentic cold-press illustration paper grain across the canvas
 * 3. Ultra-clean subtle editorial framing finish
 */
export function createPostCompositePass(farPlane = 700.0) {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      tBeauty: { value: null },
      tGBuffer: { value: null },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uDpr: { value: 1.0 },
      uFarPlane: { value: farPlane },
      uInkColor: { value: new THREE.Color(PALETTE.ink) },
      uPaperStrength: { value: 0.032 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tBeauty;
      uniform sampler2D tGBuffer;
      uniform vec2 uResolution;
      uniform float uDpr;
      uniform float uFarPlane;
      uniform vec3 uInkColor;
      uniform float uPaperStrength;

      varying vec2 vUv;

      vec3 octDecode(vec2 f) {
        f = f * 2.0 - 1.0;
        vec3 n = vec3(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
        float t = max(-n.z, 0.0);
        n.x += n.x >= 0.0 ? -t : t;
        n.y += n.y >= 0.0 ? -t : t;
        return normalize(n);
      }

      // Cold-press illustration paper tooth (high-frequency + subtle fiber grain)
      float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      float paperNoise(vec2 px) {
        vec2 i = floor(px);
        vec2 f = fract(px);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash12(i);
        float b = hash12(i + vec2(1.0, 0.0));
        float c = hash12(i + vec2(0.0, 1.0));
        float d = hash12(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }

      vec3 linearToSrgb(vec3 c) {
        c = max(c, vec3(0.0));
        vec3 lo = c * 12.92;
        vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
        return mix(lo, hi, step(vec3(0.0031308), c));
      }

      void main() {
        vec4 beautyLin = texture2D(tBeauty, vUv);
        vec3 beautyRgb = linearToSrgb(beautyLin.rgb);
        vec3 inkSrgb = linearToSrgb(uInkColor);
        vec4 gc = texture2D(tGBuffer, vUv);

        // Keep ink stroke width crisp & uniform in CSS pixels across 1x/2x displays
        vec2 stepUv = (max(0.85, uDpr * 0.62)) / uResolution;

        // 4-tap Roberts Cross around pixel center (extra crisp, avoids bloated 3px ink!)
        vec4 g0 = texture2D(tGBuffer, vUv + vec2(-stepUv.x, -stepUv.y) * 0.72);
        vec4 g1 = texture2D(tGBuffer, vUv + vec2( stepUv.x, -stepUv.y) * 0.72);
        vec4 g2 = texture2D(tGBuffer, vUv + vec2(-stepUv.x,  stepUv.y) * 0.72);
        vec4 g3 = texture2D(tGBuffer, vUv + vec2( stepUv.x,  stepUv.y) * 0.72);

        vec3 nC = octDecode(gc.rg);
        vec3 n0 = octDecode(g0.rg);
        vec3 n1 = octDecode(g1.rg);
        vec3 n2 = octDecode(g2.rg);
        vec3 n3 = octDecode(g3.rg);

        float dC = gc.b * uFarPlane;
        float d0 = g0.b * uFarPlane;
        float d1 = g1.b * uFarPlane;
        float d2 = g2.b * uFarPlane;
        float d3 = g3.b * uFarPlane;

        // 1. Grazing-angle-compensated depth discontinuity (crisp silhouettes, zero flat-plane artifacts)
        float grazing = 1.0 - clamp(abs(nC.z), 0.0, 1.0);
        float depthScale = max(1.0, dC * 0.018) * (1.0 + pow(grazing, 2.2) * 5.5);
        float depthDiff = max(abs(d0 - d3), abs(d1 - d2)) / depthScale;
        float depthEdge = smoothstep(0.28, 0.78, depthDiff);

        // 2. Normal crease discontinuity (90-degree architectural corners & crisp facets)
        float nDiffA = 1.0 - clamp(dot(n0, n3), -1.0, 1.0);
        float nDiffB = 1.0 - clamp(dot(n1, n2), -1.0, 1.0);
        float normalDiff = max(nDiffA, nDiffB);
        float normalEdge = smoothstep(0.30, 0.60, normalDiff);

        // 3. Part ID boundary discontinuity (clean contours between ship modules, lifeboat, floes, ice/water bank)
        float idDiffA = abs(g0.a - g3.a);
        float idDiffB = abs(g1.a - g2.a);
        float idEdge = smoothstep(0.0018, 0.0036, max(idDiffA, idDiffB));

        // Combine all three crisp ink triggers
        float edge = max(max(depthEdge, normalEdge), idEdge * 0.94);

        // Use closest neighbor depth so foreground masts against sky stay razor-crisp
        // while distant snow-to-sky horizon (d > 240m) fades completely to 0!
        float minD = min(dC, min(min(d0, d1), min(d2, d3)));
        float farFade = 1.0 - smoothstep(145.0, 245.0, minD);
        edge *= farFade;

        vec3 col = mix(beautyRgb, inkSrgb, clamp(edge * 0.92, 0.0, 0.95));

        // Authentic cold-press illustration paper tooth & organic grain
        vec2 cssPx = vUv * (uResolution / max(1.0, uDpr));
        float fineTooth = hash12(floor(cssPx * 1.15)) - 0.5;
        float medFiber = paperNoise(cssPx * 0.24) - 0.5;
        float coarseWash = paperNoise(cssPx * 0.055 + vec2(17.2, 9.4)) - 0.5;
        float grain = fineTooth * 0.42 + medFiber * 0.43 + coarseWash * 0.15;

        // Slightly more perceptible tooth on bright snow paper, gentler on dark navy ocean
        float luma = dot(col, vec3(0.299, 0.587, 0.114));
        float paperMod = mix(0.45, 1.0, smoothstep(0.15, 0.85, luma));
        col += grain * uPaperStrength * paperMod;

        // Ultra-subtle editorial paper edge breath (barely perceptible, keeps focus crisp)
        vec2 vc = vUv - 0.5;
        float vig = 1.0 - dot(vc, vc) * 0.048;
        col *= vig;

        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
  });

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  scene.add(quad);

  return {
    scene,
    camera,
    material,
    setSize(width, height, dpr) {
      material.uniforms.uResolution.value.set(width, height);
      material.uniforms.uDpr.value = dpr;
    },
  };
}
