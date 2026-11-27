import * as THREE from 'three';

/**
 * Curated Ligne Claire / Japanese editorial illustration palette
 * calibrated directly from the reference artwork.
 */
export const PALETTE = {
  // Paper & Snow
  snowLit: '#f3f5f6',
  snowWarmVar: '#eef1f3',
  snowShadow: '#6283ab',       // Signature crisp cerulean-cobalt cast shadow on snow
  snowEdgeShade: '#97aec4',    // Thin vertical edge of broken ice sheet / floes
  snowEdgeDark: '#6884a3',     // Shaded vertical edge of broken ice floes

  // Arctic Sea Water & Wake Foam (Deep, Restrained Editorial Ligne Claire Palette)
  waterAbyss: '#0b1b2f',       // Deepest rolling wave troughs
  waterDeep: '#152e4a',        // Rich authoritative Prussian-indigo open lead
  waterMid: '#1c3d60',         // Calm sunlit mid-swell maritime cobalt
  waterCrest: '#254e76',       // Restrained sunlit wave-ridge cel highlight
  waterAeration: '#1f4a6b',    // Subtle subsurface aerated cerulean prop wash
  waterShadow: '#0b1a2e',      // Cast shadow falling across open channel water
  waterBankRim: '#0e2035',     // Subtle deeper navy band hugging ice shelf
  waterSkyReflect: '#375978',  // Quiet muted Arctic sky Fresnel slate-blue sheen
  waterHorizonGlow: '#537796', // Restrained polar horizon grazing reflection
  waterSunGlint: '#acc5dc',    // Subtle sparse cool-silver wave-crest pinpoints (never glaring!)
  foamWhite: '#eef2f6',        // Stylized crisp white propeller wash & delicate crest wisps
  foamShadow: '#6682a0',       // Cool shaded wake foam inside cast shadow

  // Icebreaker Hull & Architecture
  hullBlueLit: '#2f659c',      // Maritime cobalt blue lower hull
  hullBlueShadow: '#1e426c',   // Shaded cobalt hull
  hullWhiteLit: '#eff2f5',     // Upper bow white sheer band
  hullWhiteShadow: '#7d98b5',  // Shaded bow sheer band

  cabinLit: '#eceff3',         // Crisp off-white superstructure
  cabinShadow: '#7b95b1',      // Steel-blue cel shadow on white superstructure
  cabinDeepShadow: '#647f9d',  // Recessed soffits / under-bridge overhangs

  deckLit: '#bcc4cb',          // Cool neutral architectural grey deck
  deckShadow: '#768ca1',       // Shaded grey deck

  funnelDarkLit: '#222d39',    // Dark charcoal-navy smokestack top
  funnelDarkShadow: '#141c25',

  windowDark: '#162230',       // Crisp dark navy windows & louvers
  windowGlint: '#334d68',      // Minimal crisp reflection accent on bridge glass

  lifeboatLit: '#ee9126',      // Iconic warm safety-amber lifeboat accent
  lifeboatShadow: '#b45c14',   // Warm-shaded amber lifeboat

  metalDarkLit: '#3a4959',     // Winches, cranes, bollards, radar base
  metalDarkShadow: '#232e3b',

  // Ink Linework
  ink: '#151c24',              // Crisp architectural India ink contour
  inkSoft: '#2b3948',          // Subtle deck seam / helipad marking ink
  stippleInk: '#25313e',       // Delicate scattered snowfield ink dots
};

/**
 * Sun direction vector (normalized, pointing FROM origin TOWARD sun).
 * Calibrated so that at initial ship heading (+Z) viewed from Illustration Camera (+X, +Y, +Z):
 * - Port side (+X) & upper decks (+Y) are brightly sunlit
 * - Forward superstructure face (+Z) sits in crisp cool steel-blue cel shadow
 * - Cast shadow stretches cleanly toward screen-left (~9 o'clock) showing hull, bridge wings & masts
 */
export const SUN_DIRECTION = new THREE.Vector3(0.79, 0.58, -0.24).normalize();

export const SHIP_DIMS = {
  length: 18.2,
  beam: 4.7,
  draft: 0.75,
  freeboard: 1.55,
};
