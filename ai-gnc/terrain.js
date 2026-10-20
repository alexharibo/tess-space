import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

export const MASTER_SEED = 42140184;
export const SLAB_SIZE = 19.8;
export const SLAB_THICKNESS = 0.46;
export const ROAD_Z_MIN = -SLAB_SIZE * 0.455;
export const ROAD_Z_MAX =  SLAB_SIZE * 0.455;
export const BYPASS_Z_START = -2.6;
export const BYPASS_Z_END = 2.2;

export function createPRNG(seed) {
  let s = seed >>> 0;
  return function() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const perm = new Uint8Array(512);
{
  const rng = createPRNG(MASTER_SEED);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
}

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
export function lerp(a, b, t) { return a + t * (b - a); }
function grad2(hash, x, y) {
  const h = hash & 7;
  const u = h < 4 ? x : y;
  const v = h < 4 ? y : x;
  return ((h & 1) ? -u : u) + ((h & 2) ? -2.0 * v : 2.0 * v);
}

export function noise2D(x, y) {
  const X = Math.floor(x) & 255;
  const Y = Math.floor(y) & 255;
  x -= Math.floor(x);
  y -= Math.floor(y);
  const u = fade(x);
  const v = fade(y);
  const A = perm[X] + Y;
  const B = perm[X + 1] + Y;
  return lerp(
    lerp(grad2(perm[A], x, y), grad2(perm[B], x - 1, y), u),
    lerp(grad2(perm[A + 1], x, y - 1), grad2(perm[B + 1], x - 1, y - 1), u),
    v
  ) * 0.5;
}

export function ridgedAlpineMultifractal(x, z, octaves = 7) {
  const wx = x + 0.72 * noise2D(x * 0.26 + 4.1, z * 0.26 - 2.3) + 0.25 * noise2D(x * 0.65, z * 0.65);
  const wz = z + 0.72 * noise2D(x * 0.26 - 5.7, z * 0.26 + 1.9) + 0.25 * noise2D(x * 0.65 + 3.1, z * 0.65);

  let sum = 0.0, freq = 0.21, amp = 0.58, weight = 1.0;
  for (let i = 0; i < octaves; i++) {
    let n = 1.0 - Math.abs(noise2D(wx * freq + i * 13.7, wz * freq - i * 9.3));
    n = Math.pow(Math.max(0.0, n), 1.65);
    n *= weight;
    weight = Math.min(1.0, Math.max(0.0, n * 2.05));
    sum += n * amp;
    freq *= 2.12;
    amp *= 0.47;
  }
  return sum;
}

export function getRoadCenterX(z) {
  const nz = z / (SLAB_SIZE * 0.5);
  return 3.10 * Math.sin(nz * Math.PI * 0.92) + 0.95 * Math.cos(nz * Math.PI * 0.48) - 0.35 * nz;
}

export function getRoadTangent2D(z) {
  const dz = 0.01;
  const dx = getRoadCenterX(z + dz) - getRoadCenterX(z - dz);
  const len = Math.hypot(dx, 2 * dz);
  return { x: dx / len, z: (2 * dz) / len };
}

export function getBypassOffsetX(z) {
  if (z <= BYPASS_Z_START || z >= BYPASS_Z_END) return 0.0;
  const t = (z - BYPASS_Z_START) / (BYPASS_Z_END - BYPASS_Z_START);
  const s = Math.sin(t * Math.PI);
  return 2.15 * (s * s);
}

export function evaluateGeography(x, z) {
  const roadX = getRoadCenterX(z);
  const distMainRoad = Math.abs(x - roadX);

  let distBypass = 999.0;
  if (z >= BYPASS_Z_START && z <= BYPASS_Z_END) {
    const bx = roadX + getBypassOffsetX(z);
    distBypass = Math.abs(x - bx);
  }
  const distRoad = Math.min(distMainRoad, distBypass * 1.15);

  const roadHalfW = 0.53;
  const shoulderOuterW = 1.35;
  let roadCarveMask = 1.0;
  let shoulderFactor = 0.0;

  if (distRoad <= roadHalfW) {
    roadCarveMask = 0.0;
    shoulderFactor = 1.0;
  } else if (distRoad < shoulderOuterW) {
    const t = (distRoad - roadHalfW) / (shoulderOuterW - roadHalfW);
    roadCarveMask = t * t * (3.0 - 2.0 * t);
    shoulderFactor = Math.max(0.0, 1.0 - t * 1.55);
  }

  // V3.2: open, gently undulating ground with ONE rear-right landmark.
  // The four layers use this exact same deterministic elevation function.
  const valleyFloorY = 0.26 + 0.085 * Math.sin(z * 0.19 + 0.5);
  const softRoll = 0.12 * noise2D(x * 0.29 + 4.1, z * 0.29 - 2.3)
                 + 0.045 * noise2D(x * 0.85, z * 0.85);
  const hill = 0.46 * Math.exp(-(((x + 4.6) / 3.7) ** 2 + ((z - 3.8) / 3.5) ** 2));
  // In the current isometric scene negative Z is the rear edge.
  const rearRightMountain = 2.30 * Math.exp(-(((x - 6.0) / 2.7) ** 2 + ((z + 6.1) / 2.9) ** 2));
  const rawMountainY = Math.max(-0.12, softRoll + hill + rearRightMountain);

  const minEdge = Math.min((SLAB_SIZE * 0.5) - Math.abs(x), (SLAB_SIZE * 0.5) - Math.abs(z));
  const edgeTaper = Math.max(0.08, Math.min(1.0, Math.pow(Math.max(0, minEdge) / 1.55, 0.82)));

  const shoulderBerm = (distMainRoad > roadHalfW && distMainRoad < roadHalfW + 0.55)
    ? 0.012 * Math.sin(((distMainRoad - roadHalfW) / 0.55) * Math.PI)
    : 0.0;

  return {
    y: valleyFloorY + (rawMountainY * roadCarveMask * edgeTaper) + shoulderBerm,
    roadMask: 1.0 - roadCarveMask,
    shoulderFactor,
    distRoad
  };
}

export function evaluateSlope(x, z) {
  const eps = 0.07;
  const hx = evaluateGeography(x + eps, z).y - evaluateGeography(x - eps, z).y;
  const hz = evaluateGeography(x, z + eps).y - evaluateGeography(x, z - eps).y;
  return Math.min(1.0, Math.hypot(hx, hz) / (2.0 * eps * 1.45));
}

export class RoadNavigationGraph {
  constructor() {
    this.nodes = [];
    this.adj = new Map();
    this.mainChainIds = [];
    this.bypassChainIds = [];
    this.obstacleNodeId = null;
    this.obstacleWorldPos = new THREE.Vector3();
    this.buildValidatedGraph();
  }

  addNode(x, z, kind = 'main') {
    const id = this.nodes.length;
    const y = evaluateGeography(x, z).y + 0.032;
    this.nodes.push({ id, x, y, z, kind, blocked: false });
    this.adj.set(id, []);
    return id;
  }

  addEdge(u, v) {
    const nu = this.nodes[u], nv = this.nodes[v];
    const w = Math.hypot(nu.x - nv.x, nu.y - nv.y, nu.z - nv.z);
    this.adj.get(u).push({ to: v, weight: w });
    this.adj.get(v).push({ to: u, weight: w });
  }

  buildValidatedGraph() {
    const mainSteps = 90;
    let splitStart = -1, splitEnd = -1, obsCand = -1, bestObsDist = Infinity;

    for (let i = 0; i <= mainSteps; i++) {
      const t = i / mainSteps;
      const z = ROAD_Z_MIN + t * (ROAD_Z_MAX - ROAD_Z_MIN);
      const x = getRoadCenterX(z);
      const id = this.addNode(x, z, 'main');
      this.mainChainIds.push(id);
      if (i > 0) this.addEdge(this.mainChainIds[i - 1], id);

      if (Math.abs(z - BYPASS_Z_START) < 0.15 && splitStart === -1) splitStart = id;
      if (Math.abs(z - BYPASS_Z_END) < 0.15 && splitEnd === -1) splitEnd = id;
      if (Math.abs(z - (-0.25)) < bestObsDist) {
        bestObsDist = Math.abs(z - (-0.25));
        obsCand = id;
      }
    }

    this.obstacleNodeId = obsCand;
    const obsN = this.nodes[this.obstacleNodeId];
    this.obstacleWorldPos.set(obsN.x, obsN.y, obsN.z);

    const bypassSteps = 22;
    let prevId = splitStart;
    for (let j = 1; j < bypassSteps; j++) {
      const t = j / bypassSteps;
      const z = this.nodes[splitStart].z + t * (this.nodes[splitEnd].z - this.nodes[splitStart].z);
      const x = getRoadCenterX(z) + getBypassOffsetX(z);
      const bId = this.addNode(x, z, 'bypass');
      this.bypassChainIds.push(bId);
      this.addEdge(prevId, bId);
      prevId = bId;
    }
    this.addEdge(prevId, splitEnd);
  }

  setObstacleActive(active) {
    for (const n of this.nodes) n.blocked = false;
    if (active && this.obstacleNodeId !== null) {
      for (let off = -2; off <= 2; off++) {
        const nid = this.obstacleNodeId + off;
        if (nid >= 0 && nid < this.mainChainIds.length) this.nodes[nid].blocked = true;
      }
    }
  }

  findNearestValidNode(x, z) {
    let bestId = 0, bestDist = Infinity;
    for (const n of this.nodes) {
      if (n.blocked) continue;
      const d = Math.hypot(n.x - x, n.z - z);
      if (d < bestDist) { bestDist = d; bestId = n.id; }
    }
    return { node: this.nodes[bestId], distance: bestDist };
  }

  findShortestPath(startId, goalId) {
    if (startId === goalId) return [this.nodes[startId]];
    const dist = new Float64Array(this.nodes.length).fill(Infinity);
    const prev = new Int32Array(this.nodes.length).fill(-1);
    const visited = new Uint8Array(this.nodes.length);
    dist[startId] = 0;

    for (let step = 0; step < this.nodes.length; step++) {
      let u = -1, minD = Infinity;
      for (let i = 0; i < this.nodes.length; i++) {
        if (!visited[i] && dist[i] < minD) { minD = dist[i]; u = i; }
      }
      if (u === -1 || u === goalId) break;
      visited[u] = 1;

      for (const edge of this.adj.get(u)) {
        const v = edge.to;
        if (visited[v] || this.nodes[v].blocked) continue;
        const penalty = this.nodes[v].kind === 'bypass' ? 1.08 : 1.0;
        const alt = dist[u] + edge.weight * penalty;
        if (alt < dist[v]) { dist[v] = alt; prev[v] = u; }
      }
    }

    if (dist[goalId] === Infinity) return null;
    const path = [];
    let curr = goalId;
    while (curr !== -1) { path.push(this.nodes[curr]); curr = prev[curr]; }
    path.reverse();
    return path;
  }
}

export function buildMasterTerrainSlabGeometry(subdivisions) {
  const topGeo = new THREE.PlaneGeometry(SLAB_SIZE, SLAB_SIZE, subdivisions, subdivisions);
  topGeo.rotateX(-Math.PI / 2);

  const pos = topGeo.attributes.position;
  const count = pos.count;
  const elevations = new Float32Array(count);
  const slopes = new Float32Array(count);
  const roadMasks = new Float32Array(count);
  const shoulderMasks = new Float32Array(count);
  let minY = Infinity, maxY = -Infinity;

  for (let i = 0; i < count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const geoData = evaluateGeography(x, z);
    const slp = evaluateSlope(x, z);
    pos.setY(i, geoData.y);
    elevations[i] = geoData.y;
    slopes[i] = slp;
    roadMasks[i] = geoData.roadMask;
    shoulderMasks[i] = geoData.shoulderFactor;
    if (geoData.y < minY) minY = geoData.y;
    if (geoData.y > maxY) maxY = geoData.y;
  }
  topGeo.computeVertexNormals();

  const skirtPositions = [], skirtNormals = [], skirtIndices = [];
  const baseBottomY = -SLAB_THICKNESS;
  const cols = subdivisions + 1;

  function addSkirtEdge(getIdxFn, nx, nz, flipWinding) {
    const startVert = skirtPositions.length / 3;
    for (let k = 0; k < cols; k++) {
      const idx = getIdxFn(k);
      const vx = pos.getX(idx), vy = pos.getY(idx), vz = pos.getZ(idx);
      skirtPositions.push(vx, vy, vz, vx, baseBottomY, vz);
      skirtNormals.push(nx, 0, nz, nx, 0, nz);
    }
    for (let k = 0; k < subdivisions; k++) {
      const a = startVert + k * 2, b = a + 1, c = a + 2, d = a + 3;
      if (flipWinding) skirtIndices.push(a, c, b, c, d, b);
      else skirtIndices.push(a, b, c, c, b, d);
    }
  }

  addSkirtEdge((k) => k, 0, -1, false);
  addSkirtEdge((k) => subdivisions * cols + k, 0, 1, true);
  addSkirtEdge((k) => k * cols, -1, 0, true);
  addSkirtEdge((k) => k * cols + subdivisions, 1, 0, false);

  const skirtGeo = new THREE.BufferGeometry();
  skirtGeo.setAttribute('position', new THREE.Float32BufferAttribute(skirtPositions, 3));
  skirtGeo.setAttribute('normal', new THREE.Float32BufferAttribute(skirtNormals, 3));
  skirtGeo.setIndex(skirtIndices);

  return { topGeo, skirtGeo, elevations, slopes, roadMasks, shoulderMasks, minY, maxY };
}

export function buildMasterRoadGeometry() {
  const steps = 220, halfW = 0.66, shoulderW = 0.98;
  const positions = [], uvs = [], colors = [], indices = [];

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const z = -SLAB_SIZE * 0.5 + t * SLAB_SIZE;
    const cx = getRoadCenterX(z);
    const tang = getRoadTangent2D(z);
    const nx = -tang.z, nz = tang.x;

    const offsets = [-shoulderW, -halfW, 0.0, halfW, shoulderW];
    const lifts = [0.008, 0.022, 0.030, 0.022, 0.008];
    const colWeights = [0.52, 0.95, 1.0, 0.95, 0.52];

    for (let j = 0; j < 5; j++) {
      // Clip the road's actual mesh to the terrain boundary on both axes.
      // The previous near-edge clamp left a visible triangular cut at the slab edge.
      const px = Math.max(-SLAB_SIZE*.5,Math.min(SLAB_SIZE*.5,cx + nx * offsets[j]));
      const pz = i === 0 ? -SLAB_SIZE*.5 : i === steps ? SLAB_SIZE*.5 : Math.max(-SLAB_SIZE*.5,Math.min(SLAB_SIZE*.5,z + nz * offsets[j]));
      const py = evaluateGeography(px, pz).y + lifts[j];
      positions.push(px, py, pz);
      uvs.push(j / 4, t * 32.0);
      colors.push(colWeights[j], colWeights[j], colWeights[j]);
    }
  }

  for (let i = 0; i < steps; i++) {
    const r1 = i * 5, r2 = (i + 1) * 5;
    for (let j = 0; j < 4; j++) {
      indices.push(r1 + j, r1 + j + 1, r2 + j, r1 + j + 1, r2 + j + 1, r2 + j);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

export function buildMasterRouteLinesGeometry() {
  const steps = 200, trackOffset = 0.28, parts = [];
  for (const side of [-1, 1]) {
    const curvePts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const z = -SLAB_SIZE * 0.49 + t * (SLAB_SIZE * 0.98);
      const cx = getRoadCenterX(z);
      const tang = getRoadTangent2D(z);
      const px = cx - tang.z * (side * trackOffset);
      const pz = z + tang.x * (side * trackOffset);
      const py = evaluateGeography(px, pz).y + 0.042;
      curvePts.push(new THREE.Vector3(px, py, pz));
    }
    parts.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(curvePts), 180, 0.025, 5, false));
  }
  return BufferGeometryUtils.mergeGeometries(parts);
}

export function buildOrganicConiferVariantGeometry(variantIdx) {
  const rng = createPRNG(MASTER_SEED + 1500 + variantIdx * 131);
  const parts = [];
  const specs = [
    { h: 2.05, r: 0.42, whorls: 9, frondsPerWhorl: 6, droop: 0.14 },
    { h: 1.80, r: 0.29, whorls: 8, frondsPerWhorl: 5, droop: 0.09 },
    { h: 1.48, r: 0.38, whorls: 7, frondsPerWhorl: 6, droop: 0.12 },
    { h: 1.12, r: 0.28, whorls: 6, frondsPerWhorl: 5, droop: 0.08 },
    { h: 0.72, r: 0.21, whorls: 4, frondsPerWhorl: 4, droop: 0.05 }
  ][variantIdx];

  function applyVertexColors(geo, isTrunk, heightNorm) {
    const cnt = geo.attributes.position.count;
    const cols = new Float32Array(cnt * 3);
    const pos = geo.attributes.position;
    for (let i = 0; i < cnt; i++) {
      if (isTrunk) {
        cols[i * 3] = 0.34; cols[i * 3 + 1] = 0.23; cols[i * 3 + 2] = 0.14;
      } else {
        const rad = Math.hypot(pos.getX(i), pos.getZ(i));
        const tipBright = Math.min(1.0, rad / (specs.r * 0.85));
        const shade = 0.36 + 0.42 * heightNorm + 0.26 * tipBright;
        cols[i * 3] = shade * 0.82; cols[i * 3 + 1] = shade * 1.06; cols[i * 3 + 2] = shade * 0.68;
      }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  }

  const trunkH = specs.h * 0.86;
  const trunkGeo = new THREE.CylinderGeometry(specs.r * 0.035, specs.r * 0.14, trunkH, 6, 4);
  trunkGeo.translate(0, trunkH * 0.5, 0);
  const leanX = (rng() - 0.5) * 0.06, leanZ = (rng() - 0.5) * 0.06;
  const tp = trunkGeo.attributes.position;
  for (let i = 0; i < tp.count; i++) {
    const yRatio = tp.getY(i) / trunkH;
    tp.setX(i, tp.getX(i) + leanX * yRatio * yRatio);
    tp.setZ(i, tp.getZ(i) + leanZ * yRatio * yRatio);
  }
  trunkGeo.computeVertexNormals();
  applyVertexColors(trunkGeo, true, 0);
  parts.push(trunkGeo);

  const startY = specs.h * 0.18, crownSpan = specs.h - startY;
  for (let w = 0; w < specs.whorls; w++) {
    const wNorm = w / (specs.whorls - 1);
    const yBase = startY + wNorm * crownSpan * 0.90;
    const envelope = Math.pow(1.0 - wNorm * 0.82, 0.88) * (0.88 + 0.22 * rng());
    const whorlRadius = specs.r * envelope;
    const fCount = w > specs.whorls - 3 ? 4 : specs.frondsPerWhorl;

    for (let f = 0; f < fCount; f++) {
      const azim = (f / fCount) * Math.PI * 2 + w * 1.1 + (rng() - 0.5) * 0.45;
      const boughLen = whorlRadius * (0.78 + 0.40 * rng());
      const boughW = boughLen * (0.52 + 0.18 * rng());
      const boughThick = (crownSpan / specs.whorls) * 1.15;

      const frond = new THREE.ConeGeometry(boughW, boughLen, 5, 2, false);
      frond.rotateZ(-Math.PI / 2 - specs.droop * (1.0 - wNorm * 0.5));
      frond.translate(boughLen * 0.42, 0, 0);
      frond.scale(1.0, boughThick / Math.max(0.1, boughW), 1.0);
      frond.rotateY(azim);
      frond.translate(leanX * wNorm, yBase + (rng() - 0.5) * 0.04, leanZ * wNorm);
      frond.computeVertexNormals();
      applyVertexColors(frond, false, wNorm);
      parts.push(frond);
    }
  }

  const leaderH = specs.h * 0.24;
  const leader = new THREE.ConeGeometry(specs.r * 0.16, leaderH, 6, 2);
  leader.translate(leanX, specs.h - leaderH * 0.35, leanZ);
  leader.computeVertexNormals();
  applyVertexColors(leader, false, 1.0);
  parts.push(leader);

  const merged = BufferGeometryUtils.mergeGeometries(parts);
  merged.computeVertexNormals();
  return merged;
}

export function buildRockVariantGeometry(variantIdx) {
  const geo = new THREE.IcosahedronGeometry(0.36, 2);
  const p = geo.attributes.position;
  const cols = new Float32Array(p.count * 3);

  for (let i = 0; i < p.count; i++) {
    let vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
    const n = noise2D(vx * 3.4 + variantIdx * 5.1, vz * 3.4 - variantIdx * 3.7);
    const cleave = Math.round((vy + 0.25) * 4.0) / 4.0;
    const facet = 0.80 + 0.36 * Math.abs(n) + 0.08 * cleave;
    vx *= facet * (1.28 + 0.14 * (variantIdx % 2));
    vy = Math.max(-0.08, vy * facet * 0.70);
    vz *= facet * 1.08;
    p.setXYZ(i, vx, vy, vz);

    const shade = 0.52 + 0.38 * Math.min(1.0, (vy + 0.1) / 0.45);
    cols[i * 3] = shade; cols[i * 3 + 1] = shade * 0.98; cols[i * 3 + 2] = shade * 0.94;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  geo.computeVertexNormals();
  return geo;
}

export function generateMasterAssetPlacements(targetTreeCount, targetRockCount) {
  const rng = createPRNG(MASTER_SEED + 999);
  const treeCohorts = [[], [], [], [], []];
  const allTreesFlat = [];

  let attempts = 0, maxAttempts = targetTreeCount * 15;
  while (allTreesFlat.length < targetTreeCount && attempts < maxAttempts) {
    attempts++;
    const x = (rng() - 0.5) * (SLAB_SIZE - 1.1);
    const z = (rng() - 0.5) * (SLAB_SIZE - 1.1);
    const geo = evaluateGeography(x, z);
    const slope = evaluateSlope(x, z);
    const clusterProb = 0.52 + 0.48 * noise2D(x * 0.36 + 7.2, z * 0.36 - 3.8);

    const clearing = (Math.hypot((x-1.8)/2.4,(z-3.3)/1.6)<1 || Math.hypot((x+4.4)/1.7,(z+1.2)/2.1)<1);
    if (!clearing && geo.distRoad > 1.28 && geo.y < 3.40 && slope < 0.66 && rng() < clusterProb) {
      let collision = false;
      for (let i = allTreesFlat.length - 1; i >= 0; i--) {
        const other = allTreesFlat[i];
        if (Math.hypot(x - other.x, z - other.z) < 0.38) { collision = true; break; }
      }
      if (!collision) {
        const elevRatio = Math.min(1.0, Math.max(0.0, geo.y / 3.0));
        const rPick = rng();
        let vIdx = 0;
        if (elevRatio > 0.62) vIdx = rPick < 0.45 ? 1 : (rPick < 0.78 ? 3 : 4);
        else vIdx = rPick < 0.32 ? 0 : (rPick < 0.56 ? 1 : (rPick < 0.80 ? 2 : (rPick < 0.92 ? 3 : 4)));

        const baseScale = 0.76 + rng() * 0.50;
        const sy = baseScale * (0.88 + rng() * 0.28);
        const tr = {
          variant: vIdx,
          x: Number(x.toFixed(5)), y: Number((geo.y - 0.03).toFixed(5)), z: Number(z.toFixed(5)),
          sx: Number(baseScale.toFixed(5)), sy: Number(sy.toFixed(5)), sz: Number(baseScale.toFixed(5)),
          rotX: Number(((rng() - 0.5) * 0.05).toFixed(5)),
          rotY: Number((rng() * Math.PI * 2).toFixed(5)),
          rotZ: Number(((rng() - 0.5) * 0.05).toFixed(5))
        };
        treeCohorts[vIdx].push(tr);
        allTreesFlat.push(tr);
      }
    }
  }

  const rockCohorts = [[], [], []];
  let rAttempts = 0, totalRocks = 0;
  while (totalRocks < targetRockCount && rAttempts < targetRockCount * 10) {
    rAttempts++;
    const x = (rng() - 0.5) * (SLAB_SIZE - 0.9);
    const z = (rng() - 0.5) * (SLAB_SIZE - 0.9);
    const geo = evaluateGeography(x, z);
    const slope = evaluateSlope(x, z);
    const nearRoadShoulder = (geo.distRoad > 0.96 && geo.distRoad < 2.15);
    const onRockySlope = (slope > 0.27 || geo.y > 1.30);

    if (geo.distRoad > 0.96 && (nearRoadShoulder || onRockySlope || rng() < 0.20)) {
      const vIdx = totalRocks % 3;
      const isRoadScree = nearRoadShoulder && rng() < 0.65;
      const sBase = isRoadScree ? (0.20 + rng() * 0.36) : (0.50 + rng() * 1.15);
      rockCohorts[vIdx].push({
        variant: vIdx,
        x: Number(x.toFixed(5)), y: Number((geo.y - 0.04).toFixed(5)), z: Number(z.toFixed(5)),
        sx: Number((sBase * (0.85 + rng() * 0.4)).toFixed(5)),
        sy: Number((sBase * (0.65 + rng() * 0.45)).toFixed(5)),
        sz: Number((sBase * (0.85 + rng() * 0.4)).toFixed(5)),
        rotX: Number(((rng() - 0.5) * 0.4).toFixed(5)),
        rotY: Number((rng() * Math.PI * 2).toFixed(5)),
        rotZ: Number(((rng() - 0.5) * 0.4).toFixed(5))
      });
      totalRocks++;
    }
  }
  return { treeCohorts, allTreesFlat, rockCohorts, totalRocks };
}
/* === EOF terrain.js === */
