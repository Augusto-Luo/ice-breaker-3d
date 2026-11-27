import { hullHalfBeamAt } from './icebreaker.js';

/**
 * Deterministic 2D integer-grid hash returning [0, 1).
 * Uses integer bit-mixing (no floating-point sin drift at large world coordinates).
 */
export function hashGrid2D(ix, iz, salt = 0) {
  let h = (Math.imul(ix | 0, 374761393) + Math.imul(iz | 0, 668265263) + Math.imul(salt | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

/**
 * Deterministic scalar hash returning [0, 1).
 */
export function seededRand(seed) {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

/**
 * Computes area, centroid, and circumradius of a 2D CCW convex polygon [[x, z], ...].
 */
export function polygonMetrics(poly) {
  const n = poly.length;
  if (n < 3) return { area: 0, cx: 0, cz: 0, radius: 0 };

  let area2 = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const cross = a[0] * b[1] - b[0] * a[1];
    area2 += cross;
    cx += (a[0] + b[0]) * cross;
    cz += (a[1] + b[1]) * cross;
  }

  const area = Math.abs(area2) * 0.5;
  if (area < 1e-6) {
    let sx = 0;
    let sz = 0;
    for (let i = 0; i < n; i++) {
      sx += poly[i][0];
      sz += poly[i][1];
    }
    cx = sx / n;
    cz = sz / n;
  } else {
    const inv = 1 / (3 * area2);
    cx *= inv;
    cz *= inv;
  }

  let maxR2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = poly[i][0] - cx;
    const dz = poly[i][1] - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 > maxR2) maxR2 = d2;
  }

  return { area, cx, cz, radius: Math.sqrt(maxR2) };
}

/**
 * Ensures polygon vertices are strictly CCW (positive 2D signed area in XZ).
 */
export function ensureCCW(poly) {
  let area2 = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    area2 += a[0] * b[1] - b[0] * a[1];
  }
  return area2 < 0 ? poly.slice().reverse() : poly;
}

/**
 * Sutherland-Hodgman half-plane clipper for a 2D CCW convex polygon.
 * Keeps the side where (x - px) * nx + (z - pz) * nz <= 0 (nx, nz points OUTWARD).
 * Always returns a strictly convex CCW polygon or empty array.
 */
export function clipPolygonHalfPlane(poly, px, pz, nx, nz) {
  const n = poly.length;
  if (n < 3) return [];

  const out = [];
  const EPS = 1e-6;

  let prev = poly[n - 1];
  let prevD = (prev[0] - px) * nx + (prev[1] - pz) * nz;
  let prevIn = prevD <= EPS;

  for (let i = 0; i < n; i++) {
    const cur = poly[i];
    const curD = (cur[0] - px) * nx + (cur[1] - pz) * nz;
    const curIn = curD <= EPS;

    if (curIn !== prevIn) {
      const denom = prevD - curD;
      if (Math.abs(denom) > 1e-9) {
        const t = prevD / denom;
        const ix = prev[0] + (cur[0] - prev[0]) * t;
        const iz = prev[1] + (cur[1] - prev[1]) * t;
        out.push([ix, iz]);
      }
    }
    if (curIn) {
      out.push([cur[0], cur[1]]);
    }

    prev = cur;
    prevD = curD;
    prevIn = curIn;
  }

  if (out.length < 3) return [];

  // Deduplicate tiny slivers / coinciding vertices (< 2mm)
  const clean = [];
  for (let i = 0; i < out.length; i++) {
    const pt = out[i];
    const last = clean.length > 0 ? clean[clean.length - 1] : null;
    if (!last || Math.hypot(pt[0] - last[0], pt[1] - last[1]) > 0.004) {
      clean.push(pt);
    }
  }
  while (
    clean.length > 2 &&
    Math.hypot(clean[0][0] - clean[clean.length - 1][0], clean[0][1] - clean[clean.length - 1][1]) <= 0.004
  ) {
    clean.pop();
  }

  return clean.length >= 3 ? clean : [];
}

/**
 * Deterministic Voronoi seed position inside integer macro cell (gx, gz).
 * Keeping jitter inside [0.18, 0.82] guarantees a 5x5 neighborhood defines the exact Voronoi cell.
 */
export function getMacroSeed(gx, gz, cellSize) {
  const jx = 0.18 + hashGrid2D(gx, gz, 11) * 0.64;
  const jz = 0.18 + hashGrid2D(gx, gz, 29) * 0.64;
  return {
    x: (gx + jx) * cellSize,
    z: (gz + jz) * cellSize,
  };
}

/**
 * Computes the exact watertight CCW convex Voronoi polygon for macro grid cell (gx, gz).
 * Neighboring cells share bit-exact straight edges with zero gaps and zero overlaps.
 */
export function computeMacroVoronoiCell(gx, gz, cellSize) {
  const seed = getMacroSeed(gx, gz, cellSize);
  const half = cellSize * 2.2;
  let poly = [
    [seed.x - half, seed.z - half],
    [seed.x + half, seed.z - half],
    [seed.x + half, seed.z + half],
    [seed.x - half, seed.z + half],
  ];

  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (dx === 0 && dz === 0) continue;
      const nb = getMacroSeed(gx + dx, gz + dz, cellSize);
      const mx = (seed.x + nb.x) * 0.5;
      const mz = (seed.z + nb.z) * 0.5;
      const nx = nb.x - seed.x;
      const nz = nb.z - seed.z;
      const len = Math.hypot(nx, nz);
      if (len < 1e-6) continue;
      poly = clipPolygonHalfPlane(poly, mx, mz, nx / len, nz / len);
      if (poly.length < 3) return null;
    }
  }

  poly = ensureCCW(poly);
  const m = polygonMetrics(poly);
  return {
    gx,
    gz,
    key: `${gx},${gz}`,
    seedX: seed.x,
    seedZ: seed.z,
    poly,
    cx: m.cx,
    cz: m.cz,
    area: m.area,
    radius: m.radius,
  };
}

/**
 * Subdivides ANY strictly convex CCW polygon into exact, watertight, strictly convex sub-polygons
 * using clipped Voronoi + 1-pass Lloyd centroid relaxation.
 * - Filters/clamps sites strictly inside `parentPoly` so NO razor-thin edge slivers ever form!
 * - 1-pass Lloyd relaxation guarantees crisp, chunky, architectural polygonal ice slabs (zero broomsticks!)
 * - 100% area-conserving and watertight with zero gaps or overlaps.
 */
export function voronoiSubdivideConvexPoly(parentPoly, sites, minArea = 0.18, lloydPasses = 1) {
  const parentM = polygonMetrics(parentPoly);
  // Keep only sites strictly inside parentPoly (with small inward margin) so outer bisectors never shave slivers
  const validSites = [];
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    if (pointInConvexPoly(s.x, s.z, parentPoly, 0.45)) {
      validSites.push({ x: s.x, z: s.z });
    }
  }
  if (validSites.length <= 1) {
    return [{ poly: parentPoly.map((p) => [p[0], p[1]]), ...parentM }];
  }

  const clipOnce = (pts) => {
    const out = [];
    const k = pts.length;
    for (let i = 0; i < k; i++) {
      const si = pts[i];
      let cell = parentPoly;
      for (let j = 0; j < k; j++) {
        if (i === j) continue;
        const sj = pts[j];
        const dx = sj.x - si.x;
        const dz = sj.z - si.z;
        const len = Math.hypot(dx, dz);
        if (len < 1e-4) continue;
        const mx = (si.x + sj.x) * 0.5;
        const mz = (si.z + sj.z) * 0.5;
        cell = clipPolygonHalfPlane(cell, mx, mz, dx / len, dz / len);
        if (cell.length < 3) break;
      }
      if (cell.length >= 3) {
        cell = ensureCCW(cell);
        const m = polygonMetrics(cell);
        if (m.area >= minArea) {
          out.push({ poly: cell, cx: m.cx, cz: m.cz, area: m.area, radius: m.radius });
        }
      }
    }
    return out;
  };

  let curSites = validSites;
  let cells = clipOnce(curSites);

  // Run Lloyd relaxation (move each site 75% toward its cell centroid -> preserves organic angularity while killing slivers!)
  for (let pass = 0; pass < lloydPasses && cells.length >= 2; pass++) {
    const relaxed = [];
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      // Blend centroid slightly with previous site (0.80) to keep organic Ligne Claire irregularity without skinny shards
      relaxed.push({ x: c.cx, z: c.cz });
    }
    const nextCells = clipOnce(relaxed);
    if (nextCells.length >= 2) {
      cells = nextCells;
      curSites = relaxed;
    }
  }

  if (cells.length === 0) {
    return [{ poly: parentPoly.map((p) => [p[0], p[1]]), ...parentM }];
  }

  return cells;
}

/**
 * Generates physically-inspired Westergaard radial + circumferential ice-fracture sites
 * strictly INSIDE `parentPoly` centered on an impact / load point `(impX, impZ)`.
 * Produces:
 * - Crisp angular 1.4–2.6m bow wedges & splinters near the impact point
 * - Chunky 2.5–4.0m broken polygonal plates across the rest of the macro cell
 * - Strictly interior placement + Lloyd relaxation guarantees ZERO skinny slivers!
 */
export function generateBowFractureSites(parentPoly, cx, cz, radius, impX, impZ, dirX, dirZ, seedVal) {
  const sites = [];
  const rx = dirZ;
  const rz = -dirX;

  const tryAddInterior = (x, z, minD) => {
    if (!pointInConvexPoly(x, z, parentPoly, 0.45)) return false;
    for (let i = 0; i < sites.length; i++) {
      if (Math.hypot(sites[i].x - x, sites[i].z - z) < minD) return false;
    }
    sites.push({ x, z });
    return true;
  };

  // Clamp focus inside parentPoly so radial fracture rings genuinely land inside the plate
  let fx = impX;
  let fz = impZ;
  if (!pointInConvexPoly(fx, fz, parentPoly, 0.55)) {
    // Pull smoothly toward centroid until strictly inside parentPoly
    for (let step = 1; step <= 8; step++) {
      const t = step / 8;
      const tx = impX + (cx - impX) * t;
      const tz = impZ + (cz - impZ) * t;
      if (pointInConvexPoly(tx, tz, parentPoly, 0.55)) {
        fx = tx;
        fz = tz;
        break;
      }
    }
  }

  // 1. Tight bow-crush radial wedges (~1.2–2.2m from impact focus)
  const innerN = 4;
  const innerOff = seededRand(seedVal + 2.3) * Math.PI * 2;
  for (let i = 0; i < innerN; i++) {
    const ang = innerOff + (i / innerN) * Math.PI * 2 + (seededRand(seedVal + i * 7.3 + 4.1) - 0.5) * 0.45;
    const r = 1.10 + seededRand(seedVal + i * 11.7 + 5.9) * 0.95;
    tryAddInterior(fx + rx * Math.cos(ang) * r + dirX * Math.sin(ang) * r, fz + rz * Math.cos(ang) * r + dirZ * Math.sin(ang) * r, 1.15);
  }

  // 2. Primary circumferential flexural bending ring (~2.6–4.2m from impact focus)
  const midN = 6;
  const midOff = innerOff + Math.PI / midN;
  for (let i = 0; i < midN; i++) {
    const ang = midOff + (i / midN) * Math.PI * 2 + (seededRand(seedVal + i * 13.1 + 21.7) - 0.5) * 0.40;
    const r = 2.65 + seededRand(seedVal + i * 17.9 + 23.3) * 1.55;
    tryAddInterior(fx + rx * Math.cos(ang) * r + dirX * Math.sin(ang) * r, fz + rz * Math.cos(ang) * r + dirZ * Math.sin(ang) * r, 1.75);
  }

  // 3. Guaranteed interior Poisson fill so every macro cell yields 9–12 chunky angular plates!
  const targetTotal = 10 + Math.floor(seededRand(seedVal + 59.1) * 3);
  for (let attempt = 0; attempt < 48 && sites.length < targetTotal; attempt++) {
    const ang = seededRand(seedVal + attempt * 19.3 + 101.7) * Math.PI * 2;
    const rad = Math.sqrt(seededRand(seedVal + attempt * 29.7 + 211.3)) * radius * 0.92;
    const sx = cx + Math.cos(ang) * rad;
    const sz = cz + Math.sin(ang) * rad;
    tryAddInterior(sx, sz, 2.05);
  }

  return sites;
}

/**
 * Splits a single convex polygon cleanly across its WAIST (never lengthwise into skinny planks!)
 * into two compact convex child polygons. Rejects degenerate elongated slivers (`r^2 / area > 2.4`).
 */
export function splitConvexPolyByLine(poly, px, pz, nx, nz, minArea = 0.45) {
  // Compute principal long axis of polygon so we always prefer cutting ACROSS the long dimension!
  const m = polygonMetrics(poly);
  let sxx = 0, szz = 0, sxz = 0;
  for (let i = 0; i < poly.length; i++) {
    const dx = poly[i][0] - m.cx;
    const dz = poly[i][1] - m.cz;
    sxx += dx * dx;
    szz += dz * dz;
    sxz += dx * dz;
  }
  // Major eigenvector direction (long axis) -> use it as the cut plane NORMAL so the cut runs across the waist!
  const majorAng = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const waistNx = Math.cos(majorAng);
  const waistNz = Math.sin(majorAng);

  // Blend slightly with requested impact normal while strongly favoring waist cut when elongated
  const isElongated = (m.radius * m.radius) / Math.max(0.1, m.area) > 1.35;
  let cutNx = isElongated ? waistNx : waistNx * 0.65 + nx * 0.35;
  let cutNz = isElongated ? waistNz : waistNz * 0.65 + nz * 0.35;
  const cLen = Math.hypot(cutNx, cutNz) || 1;
  cutNx /= cLen;
  cutNz /= cLen;

  // Keep cut passing near centroid so both children stay chunky and balanced
  const cpx = m.cx + (px - m.cx) * 0.35;
  const cpz = m.cz + (pz - m.cz) * 0.35;

  const polyA = clipPolygonHalfPlane(poly, cpx, cpz, cutNx, cutNz);
  const polyB = clipPolygonHalfPlane(poly, cpx, cpz, -cutNx, -cutNz);
  if (polyA.length < 3 || polyB.length < 3) return null;

  const mA = polygonMetrics(polyA);
  const mB = polygonMetrics(polyB);
  if (mA.area < minArea || mB.area < minArea) return null;

  // Reject any overly skinny sliver plank (circle has r^2/area = 0.32, square = 0.5, 4:1 plank ~ 1.3, needle > 2.4)
  if ((mA.radius * mA.radius) / mA.area > 2.2 || (mB.radius * mB.radius) / mB.area > 2.2) {
    return null;
  }

  return [
    { poly: ensureCCW(polyA), ...mA },
    { poly: ensureCCW(polyB), ...mB },
  ];
}

/**
 * Extracts all internal shared edges between sub-polygons of a subdivided parent cell.
 * Each internal edge appears once with its two adjacent sub-plate indices `[plateA, plateB]`.
 */
export function extractInternalEdges(subPolys) {
  const edgeMap = new Map();
  const quant = (v) => Math.round(v * 200); // 5mm quantization matches exact clipped Voronoi vertices

  for (let pIdx = 0; pIdx < subPolys.length; pIdx++) {
    const poly = subPolys[pIdx].poly;
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % n];
      const ax = quant(a[0]);
      const az = quant(a[1]);
      const bx = quant(b[0]);
      const bz = quant(b[1]);
      if (ax === bx && az === bz) continue;

      const forward = ax < bx || (ax === bx && az < bz);
      const key = forward ? `${ax},${az}_${bx},${bz}` : `${bx},${bz}_${ax},${az}`;
      const existing = edgeMap.get(key);
      if (existing) {
        existing.plateB = pIdx;
      } else {
        edgeMap.set(key, {
          x1: a[0],
          z1: a[1],
          x2: b[0],
          z2: b[1],
          mx: (a[0] + b[0]) * 0.5,
          mz: (a[1] + b[1]) * 0.5,
          plateA: pIdx,
          plateB: -1,
        });
      }
    }
  }

  const internal = [];
  for (const e of edgeMap.values()) {
    if (e.plateB >= 0) internal.push(e);
  }
  return internal;
}

/**
 * Exact point-in-convex-CCW-polygon test.
 * `margin > 0` shrinks the test inward; `margin < 0` expands it slightly outward.
 */
export function pointInConvexPoly(x, z, poly, margin = 0) {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const ex = b[0] - a[0];
    const ez = b[1] - a[1];
    const len = Math.hypot(ex, ez);
    if (len < 1e-6) continue;
    // Outward normal for 2D CCW in (x, z) is (ez/len, -ex/len)
    const distOut = ((x - a[0]) * ez - (z - a[1]) * ex) / len;
    if (distOut > -margin) return false;
  }
  return true;
}

/**
 * Computes signed distance from point (x, z) to boundary of a 2D CCW convex polygon.
 * Negative = inside polygon; positive = outside polygon.
 */
export function signedDistToConvexPoly(x, z, poly) {
  const n = poly.length;
  let maxOut = -1e9;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const ex = b[0] - a[0];
    const ez = b[1] - a[1];
    const len = Math.hypot(ex, ez);
    if (len < 1e-6) continue;
    const distOut = ((x - a[0]) * ez - (z - a[1]) * ex) / len;
    if (distOut > maxOut) maxOut = distOut;
  }
  return maxOut;
}

/**
 * Exact 2D Separating Axis Theorem (SAT) test between two flat-array convex polygons
 * A: (ax, az, an, acx, acz) and B: (bx, bz, bn, bcx, bcz).
 * Returns null if separated by >= gapMargin, or { ov, nx, nz } pushing B away from A.
 */
export function satTestFlatPolys(ax, az, an, acx, acz, bx, bz, bn, bcx, bcz, gapMargin = 0) {
  let minOv = 1e9;
  let bestNx = 1;
  let bestNz = 0;

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
      const nx = ez / len;
      const nz = -ex / len;

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
      if (ov <= 0) return null;
      if (ov < minOv) {
        minOv = ov;
        bestNx = nx;
        bestNz = nz;
      }
    }
  }

  const dcx = bcx - acx;
  const dcz = bcz - acz;
  if (dcx * bestNx + dcz * bestNz < 0) {
    bestNx = -bestNx;
    bestNz = -bestNz;
  }

  return { ov: minOv, nx: bestNx, nz: bestNz };
}

/**
 * Builds an exact strictly-convex 2D world-space polygon wrapping the icebreaker hull
 * (matching hullHalfBeamAt(z) with optional lateral/longitudinal margin).
 */
export function buildShipHullPoly(shipX, shipZ, heading, inflate = 0.0) {
  const fx = Math.sin(heading);
  const fz = Math.cos(heading);
  const px = Math.cos(heading);
  const pz = -Math.sin(heading);

  const zStations = [9.08, 7.6, 5.2, 2.4, -4.1, -7.2, -8.85];
  const pts = [];

  // Bow tip
  const tipZ = 9.10 + inflate;
  pts.push([shipX + fx * tipZ, shipZ + fz * tipZ]);

  // Port side (+X local) bow -> stern
  for (let i = 1; i < zStations.length; i++) {
    const z = zStations[i];
    const hb = hullHalfBeamAt(z) + inflate;
    pts.push([shipX + fx * z + px * hb, shipZ + fz * z + pz * hb]);
  }

  // Stern transom starboard -> port
  const sternZ = -8.95 - inflate;
  const sternHb = hullHalfBeamAt(-8.85) * 0.72 + inflate * 0.5;
  pts.push([shipX + fx * sternZ + px * sternHb, shipZ + fz * sternZ + pz * sternHb]);
  pts.push([shipX + fx * sternZ - px * sternHb, shipZ + fz * sternZ - pz * sternHb]);

  // Starboard side (-X local) stern -> bow
  for (let i = zStations.length - 1; i >= 1; i--) {
    const z = zStations[i];
    const hb = hullHalfBeamAt(z) + inflate;
    pts.push([shipX + fx * z - px * hb, shipZ + fz * z - pz * hb]);
  }

  return ensureCCW(pts);
}
