import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import {
  MASTER_SEED,
  createPRNG,
  lerp,
  noise2D,
  evaluateGeography,
  RoadNavigationGraph,
  buildMasterTerrainSlabGeometry,
  buildMasterRoadGeometry,
  buildMasterRouteLinesGeometry,
  buildOrganicConiferVariantGeometry,
  buildRockVariantGeometry,
  generateMasterAssetPlacements
} from './terrain.js';

// ============================================================================
// 1. PROCEDURAL MICRO-BUMP TEXTURE & THREE.JS SCENE INITIALIZATION
// ============================================================================
function createProceduralDetailTextures() {
  const size = 256;
  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = size;
  bumpCanvas.height = size;
  const ctx = bumpCanvas.getContext('2d');
  const imgData = ctx.createImageData(size, size);
  const data = imgData.data;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const u = (px / size) * 24.0;
      const v = (py / size) * 24.0;
      const n = 0.5 + 0.28 * noise2D(u, v) + 0.15 * noise2D(u * 2.7, v * 2.7) + 0.07 * noise2D(u * 6.5, v * 6.5);
      const c = Math.max(0, Math.min(255, Math.floor(n * 255)));
      const idx = (py * size + px) * 4;
      data[idx] = c;
      data[idx + 1] = c;
      data[idx + 2] = c;
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);
  const bumpTex = new THREE.CanvasTexture(bumpCanvas);
  bumpTex.wrapS = THREE.RepeatWrapping;
  bumpTex.wrapT = THREE.RepeatWrapping;
  bumpTex.repeat.set(16, 16);
  return bumpTex;
}

const container = document.getElementById('canvas-container');
let layerSpacing = 4.45;
const roadGraph = new RoadNavigationGraph();

// V3.3: terrain-wide grid planner. Road graph remains for the legacy patrol.
// The grid is built once from the shared deterministic master placements.
const freeNav = { obstacles: [], cell: 0.42, half: 9.35 };
function configureFreeNavigation(placements) {
  const trees = (placements.treeCohorts || []).flat();
  const rocks = (placements.rockCohorts || []).flat();
  freeNav.obstacles = [
    ...trees.map(t => ({x:t.x,z:t.z,r:0.24*Math.max(t.sx||1,t.sz||1)})),
    ...rocks.map(r => ({x:r.x,z:r.z,r:0.23*Math.max(r.sx||1,r.sz||1)}))
  ];
}
function planFreeTerrain(sx, sz, gx, gz) {
  const half = freeNav.half, cell = freeNav.cell;
  const n = Math.floor(2*half/cell)+1;
  const clamp = v => Math.max(0,Math.min(n-1,Math.round((v+half)/cell)));
  const toIndex = (ix,iz) => iz*n+ix;
  const toWorld = i => -half+i*cell;
  const startX=clamp(sx), startZ=clamp(sz), goalX=clamp(gx), goalZ=clamp(gz);
  const blocked = new Uint8Array(n*n), slopeCost = new Float32Array(n*n);
  for(let z=0;z<n;z++) for(let x=0;x<n;x++) {
    const wx=toWorld(x), wz=toWorld(z), id=toIndex(x,z);
    const e=evaluateGeography(wx,wz);
    const dx=evaluateGeography(wx+0.14,wz).y-evaluateGeography(wx-0.14,wz).y;
    const dz=evaluateGeography(wx,wz+0.14).y-evaluateGeography(wx,wz-0.14).y;
    const slope=Math.hypot(dx,dz)/0.28;
    slopeCost[id]=slope;
    if(slope>0.60 || freeNav.obstacles.some(o=>Math.hypot(o.x-wx,o.z-wz)<o.r+0.17) ||
      (ugvState.obstacleActive && Math.hypot(wx-roadGraph.obstacleWorldPos.x,wz-roadGraph.obstacleWorldPos.z)<0.80)) blocked[id]=1;
  }
  const start=toIndex(startX,startZ), goal=toIndex(goalX,goalZ);
  // Allow the UGV to leave its current cell, even if a tree canopy overlaps it.
  blocked[start]=0;
  if(blocked[goal]) return null;
  const g=new Float32Array(n*n).fill(Infinity), prev=new Int32Array(n*n).fill(-1), closed=new Uint8Array(n*n);
  const queue=[[0,start]]; g[start]=0;
  const directions=[[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
  let iterations=0;
  while(queue.length && iterations++<n*n*6) {
    queue.sort((a,b)=>b[0]-a[0]);
    const current=queue.pop()[1];
    if(closed[current])continue;
    if(current===goal)break;
    closed[current]=1;
    const x=current%n,z=Math.floor(current/n);
    for(const [dx,dz] of directions) {
      const nx=x+dx,nz=z+dz;
      if(nx<0||nz<0||nx>=n||nz>=n)continue;
      const next=toIndex(nx,nz);
      if(blocked[next]||closed[next])continue;
      if(dx&&dz&&(blocked[toIndex(nx,z)]||blocked[toIndex(x,nz)]))continue;
      const candidate=g[current]+Math.hypot(dx,dz)*(1+slopeCost[next]*2.5);
      if(candidate<g[next]) {
        g[next]=candidate;prev[next]=current;
        queue.push([candidate+Math.hypot(goalX-nx,goalZ-nz),next]);
      }
    }
  }
  if(!Number.isFinite(g[goal]))return null;
  const path=[];let at=goal;
  while(at!==-1){const x=at%n,z=Math.floor(at/n);path.push(new THREE.Vector3(toWorld(x),evaluateGeography(toWorld(x),toWorld(z)).y+0.032,toWorld(z)));at=prev[at];}
  path.reverse();
  // Remove redundant collinear cells, without rounding across obstacles.
  const compact=[];
  for(let i=0;i<path.length;i++) {
    if(i>0&&i<path.length-1) {
      const a=path[i-1],b=path[i],c=path[i+1];
      if(Math.abs((b.x-a.x)*(c.z-b.z)-(b.z-a.z)*(c.x-b.x))<0.0001)continue;
    }
    compact.push(path[i]);
  }
  compact[0]=new THREE.Vector3(sx,evaluateGeography(sx,sz).y+0.032,sz);
  compact[compact.length-1]=new THREE.Vector3(gx,evaluateGeography(gx,gz).y+0.032,gz);
  return compact;
}

const microBumpTex = createProceduralDetailTextures();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x080B0E);
scene.fog = new THREE.FogExp2(0x080B0E, 0.006);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  preserveDrawingBuffer: true,
  powerPreference: 'high-performance'
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
container.appendChild(renderer.domElement);

const aspect = window.innerWidth / window.innerHeight;
const frustumSize = 25.4;
const camera = new THREE.OrthographicCamera(
  (-frustumSize * aspect) / 2,
  (frustumSize * aspect) / 2,
  frustumSize / 2,
  -frustumSize / 2,
  -120,
  240
);

const CAMERA_PRESETS = {
  infographic: { pos: new THREE.Vector3(-20.0, 17.2, 22.0), target: new THREE.Vector3(0.4, 6.2, -0.2), zoom: 1.00 },
  iso:         { pos: new THREE.Vector3(-22.0, 22.0, 22.0), target: new THREE.Vector3(0.5, 6.2, 0.0),  zoom: 0.96 },
  top:         { pos: new THREE.Vector3(0.0, 46.0, 0.01),   target: new THREE.Vector3(0.0, 6.2, 0.0),  zoom: 0.92 },
  ugv:         { pos: new THREE.Vector3(-10.5, 4.6, 12.0),  target: new THREE.Vector3(0.8, 0.2, 3.2),  zoom: 2.55 }
};

camera.position.copy(CAMERA_PRESETS.infographic.pos);
camera.zoom = CAMERA_PRESETS.infographic.zoom;
camera.updateProjectionMatrix();

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(CAMERA_PRESETS.infographic.target);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.update();

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.26,
  0.42,
  0.84
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// Cinematic Lighting Rig
const hemiLight = new THREE.HemisphereLight(0xa4c8eb, 0x1a2218, 0.88);
scene.add(hemiLight);

const sunLight = new THREE.DirectionalLight(0xfff0d4, 2.95);
sunLight.position.set(-24, 35, 19);
sunLight.castShadow = true;
sunLight.shadow.mapSize.width = 2048;
sunLight.shadow.mapSize.height = 2048;
sunLight.shadow.camera.near = 2;
sunLight.shadow.camera.far = 95;
const d = 22;
sunLight.shadow.camera.left = -d;
sunLight.shadow.camera.right = d;
sunLight.shadow.camera.top = d;
sunLight.shadow.camera.bottom = -d;
sunLight.shadow.bias = -0.0005;
scene.add(sunLight);

const rimLight = new THREE.DirectionalLight(0xff841a, 0.90);
rimLight.position.set(22, 15, -20);
scene.add(rimLight);

// ============================================================================
// 2. UGV HIERARCHY, INSTANCING & LIDAR POINT CLOUD HELPERS
// ============================================================================
function createUGVHierarchyGroup(modeStyle) {
  const root = new THREE.Group();
  root.name = `UGV_Rig_${modeStyle}`;

  const chassisGroup = new THREE.Group();
  chassisGroup.name = 'UGV_Chassis_Body';
  root.add(chassisGroup);

  let bodyMat, accentMat, darkMat, sensorMat;
  if (modeStyle === 'SENSE') {
    bodyMat = new THREE.MeshBasicMaterial({ color: 0x00f0ff, wireframe: true });
    accentMat = new THREE.MeshBasicMaterial({ color: 0xb8ff00 });
    darkMat = bodyMat;
    sensorMat = accentMat;
  } else if (modeStyle === 'UNDERSTAND') {
    bodyMat = new THREE.MeshBasicMaterial({ color: 0xFF7900, wireframe: true });
    accentMat = new THREE.MeshBasicMaterial({ color: 0xFF9933 });
    darkMat = bodyMat;
    sensorMat = accentMat;
  } else if (modeStyle === 'DECIDE') {
    bodyMat = new THREE.MeshStandardMaterial({ color: 0xd0d6de, roughness: 0.4, metalness: 0.3 });
    accentMat = new THREE.MeshBasicMaterial({ color: 0xFF7900 });
    darkMat = new THREE.MeshStandardMaterial({ color: 0x2A2E32, roughness: 0.6 });
    sensorMat = accentMat;
  } else {
    bodyMat = new THREE.MeshStandardMaterial({ color: 0x2A2E32, roughness: 0.42, metalness: 0.55 });
    accentMat = new THREE.MeshStandardMaterial({ color: 0xFF7900, roughness: 0.35, metalness: 0.25 });
    darkMat = new THREE.MeshStandardMaterial({ color: 0x14171A, roughness: 0.78, metalness: 0.2 });
    sensorMat = new THREE.MeshStandardMaterial({ color: 0xFF7900, emissive: 0xFF7900, emissiveIntensity: 0.45 });
  }

  const hull = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.14, 0.76), bodyMat);
  hull.position.set(0, 0.17, 0);
  hull.castShadow = true;
  chassisGroup.add(hull);

  const deck = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.06, 0.68), accentMat);
  deck.position.set(0, 0.26, 0);
  deck.castShadow = true;
  chassisGroup.add(deck);

  const aiMod = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.13, 0.30), bodyMat);
  aiMod.position.set(0, 0.35, -0.15);
  aiMod.castShadow = true;
  chassisGroup.add(aiMod);

  const frontCam = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.07, 0.09), darkMat);
  frontCam.position.set(0, 0.31, 0.33);
  chassisGroup.add(frontCam);

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.18, 10), darkMat);
  mast.position.set(0, 0.41, 0.09);
  chassisGroup.add(mast);

  const puck = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.065, 16), sensorMat);
  puck.position.set(0, 0.52, 0.09);
  chassisGroup.add(puck);

  const wheelPivots = [];
  const wheelRollers = [];
  const wheelCoords = [
    { x: -0.28, z:  0.25, isFront: true },
    { x:  0.28, z:  0.25, isFront: true },
    { x: -0.28, z: -0.25, isFront: false },
    { x:  0.28, z: -0.25, isFront: false }
  ];

  for (const wc of wheelCoords) {
    const steerPivot = new THREE.Group();
    steerPivot.position.set(wc.x, 0.14, wc.z);
    root.add(steerPivot);

    const rollGroup = new THREE.Group();
    steerPivot.add(rollGroup);

    const tireGeo = new THREE.CylinderGeometry(0.14, 0.14, 0.115, 16);
    tireGeo.rotateZ(Math.PI / 2);
    const tire = new THREE.Mesh(tireGeo, darkMat);
    tire.castShadow = true;
    rollGroup.add(tire);

    const hub = new THREE.Mesh(new THREE.BoxGeometry(0.125, 0.04, 0.16), accentMat);
    rollGroup.add(hub);

    if (wc.isFront) wheelPivots.push(steerPivot);
    wheelRollers.push(rollGroup);
  }

  if (modeStyle === 'SENSE') {
    const scanRingGeo = new THREE.RingGeometry(0.65, 0.72, 32);
    scanRingGeo.rotateX(-Math.PI / 2);
    const scanRing = new THREE.Mesh(
      scanRingGeo,
      new THREE.MeshBasicMaterial({ color: 0x00ffff, side: THREE.DoubleSide, transparent: true, opacity: 0.65 })
    );
    scanRing.position.y = 0.03;
    root.add(scanRing);
    root.userData.scanRing = scanRing;
  } else if (modeStyle === 'UNDERSTAND') {
    const locRingGeo = new THREE.RingGeometry(0.55, 0.64, 28);
    locRingGeo.rotateX(-Math.PI / 2);
    const locRing = new THREE.Mesh(locRingGeo, new THREE.MeshBasicMaterial({ color: 0xFF7900, side: THREE.DoubleSide }));
    locRing.position.y = 0.03;
    root.add(locRing);
  }

  root.userData.wheelPivots = wheelPivots;
  root.userData.wheelRollers = wheelRollers;
  root.userData.chassisGroup = chassisGroup;
  return root;
}

function createInstancedCohort(geometry, material, transforms, castShadow = false, receiveShadow = false) {
  const inst = new THREE.InstancedMesh(geometry, material, transforms.length);
  inst.castShadow = castShadow;
  inst.receiveShadow = receiveShadow;
  const dummy = new THREE.Object3D();
  for (let i = 0; i < transforms.length; i++) {
    const t = transforms[i];
    dummy.position.set(t.x, t.y, t.z);
    dummy.rotation.set(t.rotX || 0, t.rotY, t.rotZ || 0);
    dummy.scale.set(t.sx, t.sy, t.sz);
    dummy.updateMatrix();
    inst.setMatrixAt(i, dummy.matrix);
  }
  inst.instanceMatrix.needsUpdate = true;
  return inst;
}

function buildSenseLiDARPointCloudGeometry(slabData, placements, treeGeos, densityRatio = 0.90) {
  const rng = createPRNG(MASTER_SEED + 3030);
  const posList = [];
  const colList = [];
  const { minY, maxY } = slabData;
  const ySpan = Math.max(0.01, maxY - minY);

  function evaluateLiDARSpectrum(worldY, isRoadOrTree) {
    const normH = Math.min(1.0, Math.max(0.0, (worldY - minY) / ySpan));
    const c = new THREE.Color();
    if (isRoadOrTree === 2) return c.setRGB(0.05, 0.42, 1.0);
    if (normH < 0.22) c.lerpColors(new THREE.Color(0x0044ff), new THREE.Color(0xb4ff00), normH / 0.22);
    else if (normH < 0.48) c.lerpColors(new THREE.Color(0xb4ff00), new THREE.Color(0x00f0ff), (normH - 0.22) / 0.26);
    else if (normH < 0.76) c.lerpColors(new THREE.Color(0x00f0ff), new THREE.Color(0x0038ff), (normH - 0.48) / 0.28);
    else c.lerpColors(new THREE.Color(0x0038ff), new THREE.Color(0x7000ff), (normH - 0.76) / 0.24);
    return c;
  }

  const tPos = slabData.topGeo.attributes.position;
  for (let i = 0; i < tPos.count; i++) {
    if (rng() > densityRatio) continue;
    const vx = tPos.getX(i), vy = tPos.getY(i), vz = tPos.getZ(i);
    const isRoad = slabData.roadMasks[i] > 0.45 ? 2 : 0;
    const c = evaluateLiDARSpectrum(vy, isRoad);
    posList.push(vx, vy + 0.018, vz);
    colList.push(c.r, c.g, c.b);
  }

  const ptsPerTree = Math.floor(85 * densityRatio);
  for (const tr of placements.allTreesFlat) {
    const tGeo = treeGeos[tr.variant];
    const tp = tGeo.attributes.position;
    const vCount = tp.count;
    const cosY = Math.cos(tr.rotY), sinY = Math.sin(tr.rotY);

    for (let k = 0; k < ptsPerTree; k++) {
      const vi = Math.floor(rng() * vCount);
      const lx = tp.getX(vi) * tr.sx;
      const ly = tp.getY(vi) * tr.sy;
      const lz = tp.getZ(vi) * tr.sz;
      const wx = tr.x + (lx * cosY - lz * sinY);
      const wy = tr.y + ly;
      const wz = tr.z + (lx * sinY + lz * cosY);
      const c = evaluateLiDARSpectrum(wy, 1);
      posList.push(wx, wy, wz);
      colList.push(c.r, c.g, c.b);
    }
  }

  const ptGeo = new THREE.BufferGeometry();
  ptGeo.setAttribute('position', new THREE.Float32BufferAttribute(posList, 3));
  ptGeo.setAttribute('color', new THREE.Float32BufferAttribute(colList, 3));
  return ptGeo;
}

// ============================================================================
// 3. SHARED UGV NAVIGATION STATE & ROUTE DISPATCHER
// ============================================================================
const ugvState = {
  mode: 'PATROL',
  paused: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  speedMultiplier: 0.8,
  baseSpeedMps: 2.35,
  currentSpeed: 0.0,
  patrolDirection: 1,
  obstacleActive: false,
  followCamera: false,
  x: 0.0,
  y: 0.0,
  z: 3.8,
  headingRad: 0.0,
  steeringAngleRad: 0.0,
  wheelSpinRad: 0.0,
  activeCurve: null,
  curveLength: 0.0,
  distanceAlongCurve: 0.0,
  targetNode: null,
  routeStatusText: 'AUTONOMOUS PATROL',
  arrivalHold: 0,
  autonomousIndex: 0
};

let currentMasterData = null;
let layerObjects = [];
let hudAnchors = [];
const dynamicRefs = {
  sensePointMat: null,
  understandWireMat: null,
  understandTreeMat: null,
  decideRouteMesh: null,
  destMarkers: [],
  obstacleMeshes: []
};

function showToastMessage(msg, durationMs = 4200) {
  const el = document.getElementById('nav-toast');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.style.display = 'none'; }, durationMs);
}

function updateDynamicRouteVisuals() {
  if (!dynamicRefs.decideRouteMesh || !ugvState.activeCurve) return;
  if (dynamicRefs.decideRouteMesh.geometry) dynamicRefs.decideRouteMesh.geometry.dispose();
  const tubeGeo = new THREE.TubeGeometry(ugvState.activeCurve, 120, 0.075, 6, false);
  tubeGeo.translate(0, 0.045, 0);
  dynamicRefs.decideRouteMesh.geometry = tubeGeo;
}

function initUGVPatrol() {
  ugvState.mode = 'PATROL';
  const pts = roadGraph.mainChainIds.map(id => {
    const n = roadGraph.nodes[id];
    return new THREE.Vector3(n.x, n.y, n.z);
  });
  if (ugvState.patrolDirection < 0) pts.reverse();
  const curve = new THREE.CatmullRomCurve3(pts);
  ugvState.activeCurve = curve;
  ugvState.curveLength = curve.getLength();

  let bestU = 0, bestD = Infinity;
  for (let i = 0; i <= 200; i++) {
    const u = i / 200;
    const p = curve.getPointAt(u);
    const d = Math.hypot(p.x - ugvState.x, p.z - ugvState.z);
    if (d < bestD) { bestD = d; bestU = u; }
  }
  ugvState.distanceAlongCurve = bestU * ugvState.curveLength;
  ugvState.routeStatusText = 'CONTINUOUS PATROL';
  updateDynamicRouteVisuals();
}

function dispatchUGVToTargetNode(goalNode) {
  const pts = planFreeTerrain(ugvState.x,ugvState.z,goalNode.x,goalNode.z);
  if(!pts || pts.length<2) {
    ugvState.routeStatusText='NO SAFE TERRAIN ROUTE';
    showToastMessage('Destination is blocked by terrain, vegetation or obstacle. Choose another point.');
    return false;
  }
  // Polyline interpolation prevents Catmull-Rom overshoot into obstacles.
  const curve = new THREE.CurvePath();
  for(let i=1;i<pts.length;i++) {
    if(pts[i].distanceTo(pts[i-1])>0.001)curve.add(new THREE.LineCurve3(pts[i-1],pts[i]));
  }
  ugvState.activeCurve=curve;
  ugvState.curveLength=Math.max(0.01,curve.getLength());
  ugvState.distanceAlongCurve=0;
  ugvState.targetNode=goalNode;
  ugvState.arrivalHold=0;
  ugvState.routeStatusText='FREE TERRAIN NAVIGATION';
  updateDynamicRouteVisuals();
  return true;
}

// Persistent autonomy: safe off-road goals; visitors can override with a click.
const autonomousWaypoints = [
  [-6.5, 5.6], [-3.2, -4.6], [3.6, -5.5], [6.3, 3.9], [1.1, 5.9], [-5.1, -1.0]
];
function dispatchNextAutonomousWaypoint() {
  for (let attempt=0; attempt<autonomousWaypoints.length; attempt++) {
    const i=ugvState.autonomousIndex++ % autonomousWaypoints.length;
    const [x,z]=autonomousWaypoints[i];
    if (dispatchUGVToTargetNode({x,z,y:evaluateGeography(x,z).y+0.032})) {
      ugvState.routeStatusText='AUTONOMOUS EXPLORATION';
      return true;
    }
  }
  // Guaranteed fallback to the already-tested road patrol if all off-road goals are blocked.
  initUGVPatrol();
  ugvState.mode='DESTINATION';
  return false;
}

// ============================================================================
// 4. BUILD ALL 4 SYNCHRONIZED GNC STAGE LAYERS
// ============================================================================
function disposeSceneLayers() {
  for (const item of layerObjects) {
    scene.remove(item.group);
    item.group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
        else obj.material.dispose();
      }
    });
  }
  layerObjects = [];
  hudAnchors = [];
  dynamicRefs.destMarkers = [];
  dynamicRefs.obstacleMeshes = [];
  document.getElementById('hud-layer').innerHTML = '';
}

function buildSynchronizedInteractiveProps(boulderGeo) {
  dynamicRefs.destMarkers = [];
  dynamicRefs.obstacleMeshes = [];
  const obsPos = roadGraph.obstacleWorldPos;

  layerObjects.forEach((layer, idx) => {
    const destGroup = new THREE.Group();
    destGroup.visible = false;
    const ringGeo = new THREE.RingGeometry(0.28, 0.42, 24);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xFF7900, side: THREE.DoubleSide });
    destGroup.add(new THREE.Mesh(ringGeo, ringMat));

    const beamGeo = new THREE.CylinderGeometry(0.03, 0.03, 1.35, 8);
    beamGeo.translate(0, 0.675, 0);
    destGroup.add(new THREE.Mesh(beamGeo, ringMat));
    layer.group.add(destGroup);
    dynamicRefs.destMarkers.push(destGroup);

    const obsGroup = new THREE.Group();
    obsGroup.position.copy(obsPos);
    obsGroup.visible = ugvState.obstacleActive;

    if (idx === 0) {
      const m = new THREE.Mesh(boulderGeo, new THREE.MeshBasicMaterial({ color: 0xff3b30, wireframe: true }));
      m.scale.set(1.5, 1.3, 1.5);
      obsGroup.add(m);
    } else if (idx === 1) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.8, 1.1), new THREE.MeshBasicMaterial({ color: 0xFF7900, wireframe: true }));
      box.position.y = 0.4;
      obsGroup.add(box);
    } else if (idx === 2) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.85, 1.15), new THREE.MeshBasicMaterial({ color: 0xF87171, wireframe: true }));
      box.position.y = 0.42;
      obsGroup.add(box);
    } else {
      const rock = new THREE.Mesh(boulderGeo, new THREE.MeshStandardMaterial({ vertexColors: true, color: 0x5a524c, roughness: 0.88 }));
      rock.scale.set(1.55, 1.35, 1.55);
      rock.castShadow = true;
      rock.receiveShadow = true;
      obsGroup.add(rock);
    }

    layer.group.add(obsGroup);
    dynamicRefs.obstacleMeshes.push(obsGroup);
  });

  hudAnchors.push({
    group: layerObjects[2].group,
    localPos: new THREE.Vector3(obsPos.x, obsPos.y + 1.15, obsPos.z),
    html: '🚧 ROAD OBSTACLE — REROUTING',
    cls: 'hud-tag hud-alert',
    textRaw: '🚧 ROAD OBSTACLE',
    requiresObstacle: true
  });
}

function updateLayerVerticalPositions(spacing) {
  for (const item of layerObjects) {
    item.group.position.set(0, item.mult * spacing + 6.2, 0);
    item.group.updateMatrixWorld(true);
  }
}

function buildDOMHudElements() {
  const hudContainer = document.getElementById('hud-layer');
  hudContainer.innerHTML = '';
  for (const anchor of hudAnchors) {
    const el = document.createElement('div');
    el.className = anchor.cls;
    el.innerHTML = anchor.html;
    hudContainer.appendChild(el);
    anchor.el = el;
  }
}

function buildCompleteFourStageScene(qualityMode = 'high') {
  disposeSceneLayers();

  const presets = {
    performance: { subs: 170, trees: 130, rocks: 65 },
    high:        { subs: 240, trees: 175, rocks: 90 },
    ultra:       { subs: 290, trees: 245, rocks: 130 }
  };
  const cfg = presets[qualityMode] || presets.high;
  const lidarDensity = parseFloat(document.getElementById('lidar-density-slider').value);
  const lidarSizeMult = parseFloat(document.getElementById('lidar-size-slider').value);
  const wireAlpha = parseFloat(document.getElementById('wire-slider').value);

  const slabData = buildMasterTerrainSlabGeometry(cfg.subs);
  const masterRoadGeo = buildMasterRoadGeometry();
  const masterRouteLinesGeo = buildMasterRouteLinesGeometry();
  const treeGeos = [0, 1, 2, 3, 4].map(i => buildOrganicConiferVariantGeometry(i));
  const rockGeos = [0, 1, 2].map(i => buildRockVariantGeometry(i));
  const placements = generateMasterAssetPlacements(cfg.trees, cfg.rocks);
  // Shared cutouts: affect CONTROL, SENSE, UNDERSTAND, DECIDE, LiDAR and A* together.
  const keepTree = t => ![
    [1.8,3.3,2.65], [-3.7,1.0,2.35], [5.1,-5.2,2.0],
    [-5.6,2.8,1.15], [5.8,2.2,1.15], [-3.6,-5.9,1.15]
  ].some(([x,z,r])=>Math.hypot(t.x-x,t.z-z)<r);
  placements.treeCohorts.forEach((cohort,i)=>{placements.treeCohorts[i]=cohort.filter(keepTree);});
  placements.allTreesFlat=placements.treeCohorts.flat();
  configureFreeNavigation(placements);
  // Visual anti-vehicle obstacles are also real A* navigation obstacles.
  for(const [x,z] of [[-5.6,2.8],[5.8,2.2],[-3.6,-5.9]]) freeNav.obstacles.push({x,z,r:.72});

  currentMasterData = { slabData, masterRoadGeo, treeGeos, rockGeos, placements };

  function createStageColoredTerrainGeo(colorEvalFn) {
    const geo = slabData.topGeo.clone();
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const ySpan = Math.max(0.01, slabData.maxY - slabData.minY);

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const normH = (y - slabData.minY) / ySpan;
      const slp = slabData.slopes[i];
      const rMask = slabData.roadMasks[i];
      const sMask = slabData.shoulderMasks[i];
      const c = colorEvalFn(normH, slp, rMask, sMask, x, y, z);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geo;
  }

  const slabSkirtMatDark = new THREE.MeshStandardMaterial({
    color: 0x0d1117,
    roughness: 0.88,
    metalness: 0.12
  });

  // 1. SENSE LAYER
  const groupSense = new THREE.Group();
  groupSense.name = '01_SENSE';
  const senseTerrainGeo = createStageColoredTerrainGeo((normH, slp, rMask) => {
    if (rMask > 0.45) return new THREE.Color(0.01, 0.06, 0.22);
    const contour = Math.abs(Math.sin(normH * 44.0)) > 0.93 ? 0.25 : 0.04;
    return new THREE.Color(0.01, 0.03 + contour * 0.4, 0.09 + contour);
  });
  const senseBaseMesh = new THREE.Mesh(senseTerrainGeo, new THREE.MeshBasicMaterial({ vertexColors: true }));
  groupSense.add(senseBaseMesh);
  groupSense.add(new THREE.Mesh(slabData.skirtGeo, slabSkirtMatDark));

  const senseRoadMesh = new THREE.Mesh(masterRoadGeo, new THREE.MeshBasicMaterial({ color: 0x072a8a }));
  groupSense.add(senseRoadMesh);
  groupSense.add(new THREE.Mesh(masterRouteLinesGeo, new THREE.MeshBasicMaterial({ color: 0x00f0ff })));

  const senseTreeMat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.14 });
  const senseTreeInsts = treeGeos.map((g, v) => {
    const inst = createInstancedCohort(g, senseTreeMat, placements.treeCohorts[v]);
    groupSense.add(inst);
    return inst;
  });

  const senseRockMat = new THREE.MeshBasicMaterial({ color: 0x3b1eff, wireframe: true, transparent: true, opacity: 0.35 });
  const senseRockInsts = rockGeos.map((g, v) => {
    const inst = createInstancedCohort(g, senseRockMat, placements.rockCohorts[v]);
    groupSense.add(inst);
    return inst;
  });

  const senseUGV = createUGVHierarchyGroup('SENSE');
  groupSense.add(senseUGV);

  const lidarGeo = buildSenseLiDARPointCloudGeometry(slabData, placements, treeGeos, lidarDensity);
  const lidarMat = new THREE.PointsMaterial({
    vertexColors: true,
    size: 0.062 * lidarSizeMult,
    transparent: true,
    opacity: 0.92,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  dynamicRefs.sensePointMat = lidarMat;
  groupSense.add(new THREE.Points(lidarGeo, lidarMat));
  scene.add(groupSense);
  layerObjects.push({
    key: '01_SENSE', group: groupSense, mult: 1.5,
    terrainMesh: senseBaseMesh, roadMesh: senseRoadMesh,
    treeInsts: senseTreeInsts, rockInsts: senseRockInsts, ugvRig: senseUGV
  });

  // 2. UNDERSTAND LAYER
  const groupUnderstand = new THREE.Group();
  groupUnderstand.name = '02_UNDERSTAND';
  const undTerrainGeo = createStageColoredTerrainGeo((normH, slp) => {
    const contourLine = Math.abs(Math.sin(normH * 50.0)) > 0.92 ? 0.42 : 0.0;
    const r = 0.04 + normH * 0.24 + slp * 0.14 + contourLine;
    const g = 0.008 + normH * 0.06 + slp * 0.03 + contourLine * 0.22;
    return new THREE.Color(r, g, 0.002);
  });
  const undBaseMesh = new THREE.Mesh(
    undTerrainGeo,
    new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.86 })
  );
  groupUnderstand.add(undBaseMesh);
  groupUnderstand.add(new THREE.Mesh(slabData.skirtGeo, new THREE.MeshBasicMaterial({ color: 0x1a0800 })));

  const undWireMat = new THREE.MeshBasicMaterial({
    color: 0xFF7900, wireframe: true, transparent: true, opacity: wireAlpha * 0.58
  });
  dynamicRefs.understandWireMat = undWireMat;
  const undWireMesh = new THREE.Mesh(slabData.topGeo, undWireMat);
  undWireMesh.position.y = 0.008;
  groupUnderstand.add(undWireMesh);

  const undRoadMesh = new THREE.Mesh(masterRoadGeo, new THREE.MeshBasicMaterial({ color: 0x3d1400 }));
  groupUnderstand.add(undRoadMesh);
  groupUnderstand.add(new THREE.Mesh(masterRouteLinesGeo, new THREE.MeshBasicMaterial({ color: 0xFF7900 })));

  const undTreeMat = new THREE.MeshBasicMaterial({
    color: 0xFF7900, wireframe: true, transparent: true, opacity: wireAlpha * 0.65
  });
  dynamicRefs.understandTreeMat = undTreeMat;
  const undTreeInsts = treeGeos.map((g, v) => {
    const inst = createInstancedCohort(g, undTreeMat, placements.treeCohorts[v]);
    groupUnderstand.add(inst);
    return inst;
  });

  const undRockMat = new THREE.MeshBasicMaterial({ color: 0xff9433, wireframe: true, transparent: true, opacity: 0.52 });
  const undRockInsts = rockGeos.map((g, v) => {
    const inst = createInstancedCohort(g, undRockMat, placements.rockCohorts[v]);
    groupUnderstand.add(inst);
    return inst;
  });

  // Per-instance perception colors; geometry and transforms stay identical.
  const perceptionBase = new THREE.Color(0xFF7900);
  for (const inst of [...undTreeInsts, ...undRockInsts]) {
    for (let i = 0; i < inst.count; i++) inst.setColorAt(i, perceptionBase);
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  }

  const undUGV = createUGVHierarchyGroup('UNDERSTAND');
  groupUnderstand.add(undUGV);

  // V3.9: Remove distracting elevation/GPS annotation pins and HUD boxes.

  scene.add(groupUnderstand);
  layerObjects.push({
    key: '02_UNDERSTAND', group: groupUnderstand, mult: 0.5,
    terrainMesh: undBaseMesh, roadMesh: undRoadMesh,
    treeInsts: undTreeInsts, rockInsts: undRockInsts, ugvRig: undUGV
  });

  // V3.5: DECIDE-only cartographic shader. Shared terrain geometry remains unchanged.
  // Contours follow actual local terrain height, rather than a flat image overlay.
  function createDecideTopoMaterial() {
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.98,
      metalness: 0, side: THREE.FrontSide
    });
    mat.onBeforeCompile = shader => {
      shader.vertexShader = 'varying float vDecideHeight;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n vDecideHeight = position.y;'
      );
      shader.fragmentShader = 'varying float vDecideHeight;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        `float contourPhase = vDecideHeight * 10.0;
         float contourDistance = abs(fract(contourPhase) - 0.5);
         float contourAA = max(fwidth(contourPhase) * 0.7, 0.012);
         float contourStroke = 1.0 - smoothstep(0.015, 0.015 + contourAA, contourDistance);
         vec3 topoInk = vec3(0.014, 0.017, 0.021);
         vec3 topoLine = vec3(0.43, 0.47, 0.49);
         gl_FragColor.rgb = mix(topoInk, topoLine, contourStroke * 0.87);
         #include <dithering_fragment>`
      );
    };
    mat.customProgramCacheKey = () => 'tess-decide-topo-v35';
    return mat;
  }

  // 3. DECIDE LAYER
  const groupDecide = new THREE.Group();
  groupDecide.name = '03_DECIDE';
  const decTerrainGeo = createStageColoredTerrainGeo(() => new THREE.Color(1, 1, 1));
  const decTerrainMesh = new THREE.Mesh(decTerrainGeo, createDecideTopoMaterial());
  decTerrainMesh.receiveShadow = false;
  decTerrainMesh.castShadow = false;
  groupDecide.add(decTerrainMesh);
  groupDecide.add(new THREE.Mesh(slabData.skirtGeo, slabSkirtMatDark));

  const decRoadMesh = new THREE.Mesh(
    masterRoadGeo,
    new THREE.MeshStandardMaterial({ color: 0x0b0d10, roughness: 0.98 })
  );
  decRoadMesh.receiveShadow = true;
  groupDecide.add(decRoadMesh);

  const bypassPts = roadGraph.bypassChainIds.map(id => {
    const n = roadGraph.nodes[id];
    return new THREE.Vector3(n.x, n.y + 0.03, n.z);
  });
  if (bypassPts.length > 2) {
    const bypassCurve = new THREE.CatmullRomCurve3(bypassPts);
    groupDecide.add(new THREE.Mesh(
      new THREE.TubeGeometry(bypassCurve, 40, 0.04, 6, false),
      new THREE.MeshBasicMaterial({ color: 0x88929e, transparent: true, opacity: 0.45 })
    ));
  }

  const decideRouteMesh = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ color: 0xFF7900 })
  );
  groupDecide.add(decideRouteMesh);
  dynamicRefs.decideRouteMesh = decideRouteMesh;

  const decTreeMat = new THREE.MeshBasicMaterial({ color: 0x9da5aa, wireframe: true, transparent: true, opacity: 0.58 });
  const decTreeInsts = treeGeos.map((g, v) => {
    const inst = createInstancedCohort(g, decTreeMat, placements.treeCohorts[v], true, true);
    groupDecide.add(inst);
    return inst;
  });

  const decRockMat = new THREE.MeshBasicMaterial({ color: 0x818990, wireframe: true, transparent: true, opacity: 0.56 });
  const decRockInsts = rockGeos.map((g, v) => {
    const inst = createInstancedCohort(g, decRockMat, placements.rockCohorts[v], true, true);
    groupDecide.add(inst);
    return inst;
  });

  const decUGV = createUGVHierarchyGroup('DECIDE');
  groupDecide.add(decUGV);

  // V3.9.14.7: removed the old flat orange mission-target plane. It floated
  // above the topographic terrain and created the misleading square with tiny trees.
  // The real planned route remains drawn by decideRouteMesh above.

  // V3.5: no floating DECIDE labels between layers; ground-anchored mission area remains.


  scene.add(groupDecide);
  layerObjects.push({
    key: '03_DECIDE', group: groupDecide, mult: -0.5,
    terrainMesh: decTerrainMesh, roadMesh: decRoadMesh,
    treeInsts: decTreeInsts, rockInsts: decRockInsts, ugvRig: decUGV
  });

  // 4. CONTROL LAYER
  const groupControl = new THREE.Group();
  groupControl.name = '04_CONTROL';
  const ctrlTerrainGeo = createStageColoredTerrainGeo((normH, slp, rMask, sMask, x, y, z) => {
    const detailNoise = noise2D(x * 2.0, z * 2.0) * 0.5 + 0.5;
    if (rMask > 0.55) return new THREE.Color(0.13, 0.11, 0.09);
    if (sMask > 0.15) {
      return new THREE.Color().lerpColors(
        new THREE.Color(0x273517),
        new THREE.Color(0x4b3c2d),
        Math.min(1.0, sMask * 1.35)
      );
    }
    const rockBlend = Math.min(1.0, Math.max(0.0, (slp - 0.28) * 2.5 + Math.max(0, normH - 0.54) * 1.45));
    const mossColor = new THREE.Color(0x1e3413).lerp(new THREE.Color(0x3a4e1c), detailNoise);
    const heatherColor = new THREE.Color(0x3c3421).lerp(new THREE.Color(0x2a3e18), 1.0 - normH);
    const graniteColor = new THREE.Color(0x484440).lerp(new THREE.Color(0x6b6660), detailNoise);
    return mossColor.lerp(heatherColor, Math.min(1.0, normH * 1.3)).lerp(graniteColor, rockBlend);
  });

  const ctrlTerrainMesh = new THREE.Mesh(
    ctrlTerrainGeo,
    new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.86, metalness: 0.04,
      bumpMap: microBumpTex, bumpScale: 0.06
    })
  );
  ctrlTerrainMesh.receiveShadow = true;
  ctrlTerrainMesh.castShadow = true;
  groupControl.add(ctrlTerrainMesh);
  groupControl.add(new THREE.Mesh(slabData.skirtGeo, slabSkirtMatDark));

  const ctrlRoadMesh = new THREE.Mesh(
    masterRoadGeo,
    new THREE.MeshStandardMaterial({
      vertexColors: true, color: 0x352f29, roughness: 0.94,
      bumpMap: microBumpTex, bumpScale: 0.028
    })
  );
  ctrlRoadMesh.receiveShadow = true;
  groupControl.add(ctrlRoadMesh);
  // Keep bright planning route on DECIDE, not on the physical CONTROL landscape.

  const ctrlTreeMat = new THREE.MeshStandardMaterial({ vertexColors: true, color: 0x2d5823, roughness: 0.82, metalness: 0.02 });
  const ctrlTreeInsts = treeGeos.map((g, v) => {
    const inst = createInstancedCohort(g, ctrlTreeMat, placements.treeCohorts[v], true, true);
    groupControl.add(inst);
    return inst;
  });

  const ctrlRockMat = new THREE.MeshStandardMaterial({
    vertexColors: true, color: 0x5c5752, roughness: 0.88, metalness: 0.05,
    bumpMap: microBumpTex, bumpScale: 0.045
  });
  const ctrlRockInsts = rockGeos.map((g, v) => {
    const inst = createInstancedCohort(g, ctrlRockMat, placements.rockCohorts[v], true, true);
    groupControl.add(inst);
    return inst;
  });

  const ctrlUGV = createUGVHierarchyGroup('CONTROL');
  groupControl.add(ctrlUGV);

  scene.add(groupControl);
  layerObjects.push({
    key: '04_CONTROL', group: groupControl, mult: -1.5,
    terrainMesh: ctrlTerrainMesh, roadMesh: ctrlRoadMesh,
    treeInsts: ctrlTreeInsts, rockInsts: ctrlRockInsts, ugvRig: ctrlUGV
  });

  buildSynchronizedInteractiveProps(rockGeos[0]);
  setupMissionVisuals();
  setupSatellites();
  createEnvironmentDetails();
  updateLayerVerticalPositions(layerSpacing);
  buildDOMHudElements();
  initUGVPatrol();
  ugvState.mode = 'DESTINATION';
  dispatchNextAutonomousWaypoint();
  syncUGVAcrossAllLayers(0);
  runRealGeometryValidation();
}

// ============================================================================
// 5. DELTA-TIME KINEMATICS, RAYCASTER, VALIDATION & EXPORTERS
// ============================================================================
function syncUGVAcrossAllLayers(dt) {
  if (!ugvState.activeCurve || layerObjects.length < 4) return;

  const targetSpeed = ugvState.paused ? 0.0 : (ugvState.baseSpeedMps * ugvState.speedMultiplier);
  ugvState.currentSpeed = lerp(ugvState.currentSpeed, targetSpeed, Math.min(1.0, dt * 4.5));

  if (dt > 0 && !ugvState.paused && !missionState.active) {
    if (ugvState.obstacleActive && ugvState.mode === 'PATROL') {
      const distToObs = Math.hypot(ugvState.x - roadGraph.obstacleWorldPos.x, ugvState.z - roadGraph.obstacleWorldPos.z);
      if (distToObs < 2.2) {
        const endNodeId = ugvState.patrolDirection > 0
          ? roadGraph.mainChainIds[roadGraph.mainChainIds.length - 1]
          : roadGraph.mainChainIds[0];
        dispatchUGVToTargetNode(roadGraph.nodes[endNodeId]);
      }
    }

    ugvState.distanceAlongCurve += ugvState.currentSpeed * dt;
    if (ugvState.distanceAlongCurve >= ugvState.curveLength) {
      if (ugvState.mode === 'PATROL') {
        ugvState.patrolDirection *= -1;
        const endNodeId = ugvState.patrolDirection > 0
          ? roadGraph.mainChainIds[roadGraph.mainChainIds.length - 1]
          : roadGraph.mainChainIds[0];
        dispatchUGVToTargetNode(roadGraph.nodes[endNodeId]);
        ugvState.mode = 'PATROL';
        ugvState.routeStatusText = 'CONTINUOUS PATROL';
      } else {
        ugvState.distanceAlongCurve = ugvState.curveLength;
        ugvState.currentSpeed = 0.0;
        ugvState.routeStatusText = 'SCANNING DESTINATION';
        ugvState.arrivalHold += dt;
        if (ugvState.arrivalHold >= 3.2 && !satelliteEvent.active) {
          for (const marker of dynamicRefs.destMarkers) marker.visible=false;
          dispatchNextAutonomousWaypoint();
        }
      }
    }
  }

  const u = Math.min(1.0, Math.max(0.0, ugvState.distanceAlongCurve / Math.max(0.001, ugvState.curveLength)));
  const pos = missionState.active ? new THREE.Vector3(missionState.x, 0, missionState.z) : ugvState.activeCurve.getPointAt(u);
  const lookU = Math.min(1.0, u + 0.015);
  const nextPos = missionState.active ? new THREE.Vector3(missionState.nextX, 0, missionState.nextZ) : ugvState.activeCurve.getPointAt(lookU);

  ugvState.x = pos.x;
  ugvState.z = pos.z;
  ugvState.y = evaluateGeography(pos.x, pos.z).y + 0.025;

  if (nextPos.distanceTo(pos) > 0.001) {
    const desiredYaw = Math.atan2(nextPos.x - pos.x, nextPos.z - pos.z);
    let diff = desiredYaw - ugvState.headingRad;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    ugvState.steeringAngleRad = Math.max(-0.45, Math.min(0.45, diff * 3.2));
    ugvState.headingRad += diff * Math.min(1.0, dt * 8.0 || 1.0);
  }

  ugvState.wheelSpinRad += (ugvState.currentSpeed * dt) / 0.14;

  for (const layer of layerObjects) {
    const rig = layer.ugvRig;
    if (!rig) continue;
    rig.position.set(ugvState.x, ugvState.y, ugvState.z);
    rig.rotation.y = ugvState.headingRad;
    if (rig.userData.wheelPivots) {
      for (const piv of rig.userData.wheelPivots) piv.rotation.y = ugvState.steeringAngleRad;
    }
    if (rig.userData.wheelRollers) {
      for (const rol of rig.userData.wheelRollers) rol.rotation.x = ugvState.wheelSpinRad;
    }
    if (rig.userData.scanRing) {
      rig.userData.scanRing.scale.setScalar(1.15 + 0.65 * (0.5 + 0.5 * Math.sin(performance.now() * 0.006)));
    }
  }

  if (ugvState.followCamera) {
    const ctrlLayerY = layerObjects[activeStageFocus >= 0 ? activeStageFocus : 3].group.position.y;
    controls.target.lerp(new THREE.Vector3(ugvState.x, ctrlLayerY + ugvState.y + 1.5, ugvState.z), 0.08);
  }

  const deg = Math.round(((ugvState.headingRad * 180) / Math.PI + 360) % 360);
  document.getElementById('tel-coords').textContent = `${ugvState.x.toFixed(2)}, ${ugvState.z.toFixed(2)} m`;
  document.getElementById('tel-elev').textContent = `${ugvState.y.toFixed(2)} m | ${deg}°`;
  document.getElementById('tel-mode-badge').textContent = ugvState.routeStatusText;

  if (ugvState.mode === 'DESTINATION') {
    const remDist = Math.max(0, ugvState.curveLength - ugvState.distanceAlongCurve);
    const pct = Math.round(u * 100);
    const eta = ugvState.currentSpeed > 0.05 ? `${(remDist / ugvState.currentSpeed).toFixed(1)}s` : '0.0s';
    document.getElementById('tel-progress').textContent = `${pct}% (${remDist.toFixed(1)}m rem)`;
    document.getElementById('tel-eta').textContent = eta;
  } else {
    document.getElementById('tel-progress').textContent = `Loop (${(u * 100).toFixed(0)}%)`;
    document.getElementById('tel-eta').textContent = 'Continuous';
  }
}

function updateHUDPositions() {
  const showHud = document.getElementById('chk-hud').checked;
  const w = window.innerWidth, h = window.innerHeight;
  const worldVec = new THREE.Vector3();

  for (const anchor of hudAnchors) {
    if (!showHud || activeStageFocus === -1 || !anchor.group.visible || (anchor.requiresObstacle && !ugvState.obstacleActive)) {
      anchor.el.style.display = 'none';
      continue;
    }
    anchor.el.style.display = 'block';
    worldVec.copy(anchor.localPos).applyMatrix4(anchor.group.matrixWorld);
    worldVec.project(camera);
    anchor.el.style.left = `${(worldVec.x * 0.5 + 0.5) * w}px`;
    anchor.el.style.top = `${(-(worldVec.y * 0.5) + 0.5) * h}px`;
  }
}

function runRealGeometryValidation() {
  const refLayer = layerObjects[3];
  const refT = refLayer.terrainMesh.geometry.attributes.position.array;
  const refR = refLayer.roadMesh.geometry.attributes.position.array;
  const tolerance = 1e-6;
  let allPassed = true, globalMaxDev = 0;

  const startId = roadGraph.mainChainIds[0];
  const endId = roadGraph.mainChainIds[roadGraph.mainChainIds.length - 1];
  const testPath = roadGraph.findShortestPath(startId, endId);
  const graphConnected = Array.isArray(testPath) && testPath.length > 1;
  if (!graphConnected) allPassed = false;

  const report = {
    project: 'TESS_SPACE_AI_GNC_V3',
    timestamp: new Date().toISOString(),
    seed: MASTER_SEED,
    reference_layer: refLayer.key,
    numerical_tolerance_m: tolerance,
    overall_validation_passed: true,
    navigation_verification: {
      road_graph_node_count: roadGraph.nodes.length,
      end_to_end_graph_connected: graphConnected,
      active_route_valid: Boolean(ugvState.activeCurve && ugvState.curveLength > 0)
    },
    measured_layer_comparisons: {}
  };

  for (let idx = 0; idx < 3; idx++) {
    const curLayer = layerObjects[idx];
    const curT = curLayer.terrainMesh.geometry.attributes.position.array;
    const curR = curLayer.roadMesh.geometry.attributes.position.array;

    let maxTerrainDev = 0;
    for (let i = 0; i < refT.length; i++) maxTerrainDev = Math.max(maxTerrainDev, Math.abs(refT[i] - curT[i]));

    let maxRoadDev = 0;
    for (let i = 0; i < refR.length; i++) maxRoadDev = Math.max(maxRoadDev, Math.abs(refR[i] - curR[i]));

    let maxTreeMatrixDev = 0;
    for (let v = 0; v < refLayer.treeInsts.length; v++) {
      const refArr = refLayer.treeInsts[v].instanceMatrix.array;
      const curArr = curLayer.treeInsts[v].instanceMatrix.array;
      for (let j = 0; j < refArr.length; j++) maxTreeMatrixDev = Math.max(maxTreeMatrixDev, Math.abs(refArr[j] - curArr[j]));
    }

    let maxRockMatrixDev = 0;
    for (let v = 0; v < refLayer.rockInsts.length; v++) {
      const refArr = refLayer.rockInsts[v].instanceMatrix.array;
      const curArr = curLayer.rockInsts[v].instanceMatrix.array;
      for (let j = 0; j < refArr.length; j++) maxRockMatrixDev = Math.max(maxRockMatrixDev, Math.abs(refArr[j] - curArr[j]));
    }

    const ugvPosDev = curLayer.ugvRig.position.distanceTo(refLayer.ugvRig.position);
    const layerMax = Math.max(maxTerrainDev, maxRoadDev, maxTreeMatrixDev, maxRockMatrixDev, ugvPosDev);
    globalMaxDev = Math.max(globalMaxDev, layerMax);
    const layerPass = (layerMax <= tolerance) && graphConnected;
    if (!layerPass) allPassed = false;

    report.measured_layer_comparisons[curLayer.key] = {
      max_terrain_vertex_deviation_m: maxTerrainDev,
      max_road_vertex_deviation_m: maxRoadDev,
      max_tree_matrix_deviation: maxTreeMatrixDev,
      max_rock_matrix_deviation: maxRockMatrixDev,
      synchronized_ugv_position_deviation_m: ugvPosDev,
      status: layerPass ? 'PASS' : 'FAIL'
    };
  }

  report.overall_validation_passed = allPassed;
  const badge = document.getElementById('val-badge');
  badge.className = allPassed ? 'status-badge status-pass' : 'status-badge status-fail';
  badge.textContent = allPassed
    ? `VALIDATED: PASS (${globalMaxDev.toFixed(6)}m)`
    : `VALIDATION FAIL (${globalMaxDev.toFixed(4)}m)`;

  return report;
}

function renderAndDownload4K(includeInfographicOverlay = true) {
  const targetW = 3840, targetH = 2160;
  const origW = window.innerWidth, origH = window.innerHeight;

  renderer.setPixelRatio(1);
  renderer.setSize(targetW, targetH, false);
  composer.setSize(targetW, targetH);

  const a = targetW / targetH;
  camera.left = (-frustumSize * a) / 2;
  camera.right = (frustumSize * a) / 2;
  camera.top = frustumSize / 2;
  camera.bottom = -frustumSize / 2;
  camera.updateProjectionMatrix();

  composer.render();

  if (!includeInfographicOverlay) {
    const link = document.createElement('a');
    link.download = 'TESS_SPACE_AI_GNC_V3_CLEAN_3D_4K.png';
    link.href = renderer.domElement.toDataURL('image/png');
    link.click();
  } else {
    const outCanvas = document.createElement('canvas');
    outCanvas.width = targetW;
    outCanvas.height = targetH;
    const ctx = outCanvas.getContext('2d');
    ctx.drawImage(renderer.domElement, 0, 0, targetW, targetH);

    ctx.fillStyle = '#FF7900';
    ctx.font = '800 24px Inter, sans-serif';
    ctx.fillText('— TESS SPACE AI GNC', 140, 820);

    ctx.fillStyle = '#F4F4F2';
    ctx.font = '800 64px Inter, sans-serif';
    ctx.fillText('FOUR-STAGE', 140, 905);
    ctx.fillText('AUTONOMOUS', 140, 980);
    ctx.fillText('NAVIGATION', 140, 1055);

    const stages = [
      { title: 'SENSE',      y: 410,  bullets: ['Cameras', 'LiDAR', 'Vehicle data', 'Understand environment'] },
      { title: 'UNDERSTAND', y: 860,  bullets: ['Perception', 'Localization', 'Plan and adapt in real time'] },
      { title: 'DECIDE',     y: 1310, bullets: ['Path planning', 'Mission logic', 'Give operators confidence'] },
      { title: 'CONTROL',    y: 1760, bullets: ['Vehicle commands', 'Real-time response', 'Execute safely and repeatably'] }
    ];
    const iconCenterX = 3100, textLeftX = 3185;
    stages.forEach((st) => {
      ctx.beginPath();
      ctx.arc(iconCenterX, st.y, 48, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(8, 11, 14, 0.90)';
      ctx.fill();
      ctx.lineWidth = 5;
      ctx.strokeStyle = '#FF7900';
      ctx.stroke();

      ctx.textAlign = 'left';
      ctx.font = '800 42px Inter, sans-serif';
      ctx.fillStyle = '#F4F4F2';
      ctx.fillText(st.title, textLeftX, st.y + 10);

      ctx.font = '500 27px Inter, sans-serif';
      st.bullets.forEach((bText, bIdx) => {
        const by = st.y + 56 + bIdx * 40;
        ctx.fillStyle = '#FF7900';
        ctx.fillText('–', textLeftX, by);
        ctx.fillStyle = '#D5DCE4';
        ctx.fillText(bText, textLeftX + 28, by);
      });
    });

    const link = document.createElement('a');
    link.download = 'TESS_SPACE_AI_GNC_V3_INFOGRAPHIC_4K.png';
    link.href = outCanvas.toDataURL('image/png');
    link.click();
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(origW, origH);
  composer.setSize(origW, origH);
  const origA = origW / origH;
  camera.left = (-frustumSize * origA) / 2;
  camera.right = (frustumSize * origA) / 2;
  camera.updateProjectionMatrix();
}

// ============================================================================
// 6. EVENT LISTENERS & BOOT COMPLETION
// ============================================================================
const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();
let pointerDownPos = { x: 0, y: 0 };

renderer.domElement.addEventListener('pointerdown', (e) => {
  pointerDownPos = { x: e.clientX, y: e.clientY };
});

renderer.domElement.addEventListener('pointerup', (e) => {
  if (Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y) > 6) { endDiscovery(); return; }
  endDiscovery();
  if (missionState.active) { showToastMessage('MISSION ACTIVE · Destination selection locked'); return; }
  if (ugvState.mode !== 'DESTINATION') return;

  const rect = renderer.domElement.getBoundingClientRect();
  pointerNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(pointerNDC, camera);
  const clickableMeshes = layerObjects.filter(l => l.group.visible).flatMap(l => [l.terrainMesh, l.roadMesh]);
  const hits = raycaster.intersectObjects(clickableMeshes, false);

  if (hits.length > 0) {
    const hitPt = hits[0].point;
    const node = { x:hitPt.x, z:hitPt.z, y:evaluateGeography(hitPt.x,hitPt.z).y+0.032 };
    ugvState.arrivalHold=0;
    showToastMessage(`Free-terrain destination: (${node.x.toFixed(2)}m, ${node.z.toFixed(2)}m).`);
    for (const dm of dynamicRefs.destMarkers) {
      dm.position.set(node.x, node.y + 0.02, node.z);
      dm.visible = true;
    }
    ugvState.paused = false;
    document.getElementById('btn-play-pause').textContent = '⏸ PAUSE';
    dispatchUGVToTargetNode(node);
  }
});

const modeBtnPres = document.getElementById('mode-btn-pres');
const modeBtnStudio = document.getElementById('mode-btn-studio');
modeBtnPres.addEventListener('click', () => {
  document.body.className = 'presentation-active';
  modeBtnPres.classList.add('active');
  modeBtnStudio.classList.remove('active');
});
modeBtnStudio.addEventListener('click', () => {
  document.body.className = 'studio-active';
  modeBtnStudio.classList.add('active');
  modeBtnPres.classList.remove('active');
});

const btnPlayPause = document.getElementById('btn-play-pause');
btnPlayPause.addEventListener('click', () => {
  ugvState.paused = !ugvState.paused;
  btnPlayPause.textContent = ugvState.paused ? '▶ PLAY' : '⏸ PAUSE';
  btnPlayPause.classList.toggle('active-btn', !ugvState.paused);
});

const btnPatrol = document.getElementById('btn-mode-patrol');
const btnDest = document.getElementById('btn-mode-dest');
btnPatrol.addEventListener('click', () => {
  // Destination selection is the permanent default interaction.
  ugvState.mode = 'DESTINATION';
  return;
  btnPatrol.classList.add('active-btn');
  btnDest.classList.remove('active-btn');
  for (const dm of dynamicRefs.destMarkers) dm.visible = false;
  ugvState.paused = false;
  btnPlayPause.textContent = '⏸ PAUSE';
  initUGVPatrol();
  showToastMessage('Switched to continuous autonomous patrol.');
});
btnDest.addEventListener('click', () => {
  ugvState.mode = 'DESTINATION';
  btnDest.classList.add('active-btn');
  btnPatrol.classList.remove('active-btn');
  showToastMessage('SET DESTINATION active: Click any point on the road or terrain.');
});

const btnObstacle = document.getElementById('btn-obstacle');
btnObstacle.addEventListener('click', () => {
  ugvState.obstacleActive = !ugvState.obstacleActive;
  roadGraph.setObstacleActive(ugvState.obstacleActive);
  for (const om of dynamicRefs.obstacleMeshes) om.visible = ugvState.obstacleActive;
  btnObstacle.textContent = ugvState.obstacleActive ? '🚧 OBSTACLE: ON' : '🚧 OBSTACLE: OFF';
  btnObstacle.classList.toggle('warn-active', ugvState.obstacleActive);

  if (ugvState.obstacleActive && ugvState.mode === 'DESTINATION' && ugvState.targetNode) {
    dispatchUGVToTargetNode(ugvState.targetNode);
  }
});

document.getElementById('ugv-speed-slider').addEventListener('input', (e) => {
  ugvState.speedMultiplier = parseFloat(e.target.value);
  document.getElementById('ugv-speed-val').textContent = `${ugvState.speedMultiplier.toFixed(1)}x`;
});

const btnFollow = document.getElementById('btn-follow-ugv');
btnFollow.addEventListener('click', () => {
  if (activeStageFocus < 0) return;
  ugvState.followCamera = !ugvState.followCamera;
  btnFollow.classList.toggle('active-btn', ugvState.followCamera);
});

document.getElementById('btn-reset-view').addEventListener('click', () => {
  clearStageFocus(false);
  ugvState.followCamera = false;
  btnFollow.classList.remove('active-btn');
  const p = CAMERA_PRESETS.infographic;
  camera.position.copy(p.pos);
  camera.zoom = p.zoom;
  camera.updateProjectionMatrix();
  controls.target.copy(p.target);
  controls.update();
});

// V3.1: Stage focus from the existing right-side information column.
// Reuses the same scene and geometry; no additional assets or startup cost.
let activeStageFocus = -1;
let preferredStageCamera = 'iso';
const discovery={dismissed:false,step:0,elapsed:0,visited:0};
function endDiscovery(){
  discovery.dismissed=false;document.body.classList.add('stages-discovered');
  stageBlocks.forEach(b=>b.classList.remove('discovery-target'));
  document.getElementById('stage-discovery-arrow')?.classList.remove('visible');
  document.getElementById('control-guide')?.classList.remove('visible');
}

const stageBlocks = [...document.querySelectorAll('#infographic-column .stage-block')];
function clearStageFocus(restoreCamera = true) {
  activeStageFocus = -1;
  ugvState.followCamera = false;
  btnFollow?.classList.remove('active-btn');
  document.querySelectorAll('[data-camera="ugv"]').forEach(b=>b.classList.remove('selected'));
  document.body.classList.remove('single-stage');
  stageBlocks.forEach(b => { b.classList.remove('stage-selected'); b.setAttribute('aria-pressed', 'false'); });
  layerObjects.forEach(layer => { layer.group.visible = true; });
  document.querySelectorAll('.layer-vis').forEach(chk => { chk.checked = true; });
  if (restoreCamera) {
    const p = CAMERA_PRESETS.infographic;
    camera.position.copy(p.pos);
    controls.target.copy(p.target);
    camera.zoom = p.zoom;
    camera.updateProjectionMatrix();
    controls.update();
  }
}
stageBlocks.forEach((block, idx) => {
  block.setAttribute('role', 'button');
  block.setAttribute('tabindex', '0');
  block.setAttribute('aria-label', `Focus ${['SENSE','UNDERSTAND','DECIDE','CONTROL'][idx]} stage`);
  block.setAttribute('aria-pressed', 'false');
  const activate = () => {
    missionState.cinematic=false;
    if (activeStageFocus === idx) { clearStageFocus(); return; }
    activeStageFocus = idx;
    document.body.classList.add('single-stage');
    // Preserve Follow UGV when switching between individual stages.
    stageBlocks.forEach((b, i) => { b.classList.toggle('stage-selected', i === idx); b.setAttribute('aria-pressed', String(i === idx)); });
    layerObjects.forEach((layer, i) => { layer.group.visible = i === idx; });
    document.querySelectorAll('.layer-vis').forEach((chk, i) => { chk.checked = i === idx; });
    const centerY = layerObjects[idx].group.position.y;
    const target = new THREE.Vector3(0, centerY + 0.8, 0);
    const offset = preferredStageCamera === 'top' ? new THREE.Vector3(0, 24, 0.01) : new THREE.Vector3(-17, 13, 18);
    camera.position.copy(target).add(offset);
    controls.target.copy(ugvState.followCamera ? new THREE.Vector3(ugvState.x, centerY + ugvState.y + 1.5, ugvState.z) : target);
    camera.zoom = preferredStageCamera === 'top' ? 1.35 : 1.25;
    camera.updateProjectionMatrix();
    controls.update();
  };
  block.addEventListener('click', () => { endDiscovery(); activate(); });
  block.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });
});

// Website-style presentation controls reuse the existing, validated camera/export actions.
document.querySelectorAll('[data-camera]').forEach(button => {
  button.addEventListener('click', () => {
    endDiscovery();
    missionState.cinematic=false;
    const key = button.dataset.camera;
    document.querySelectorAll('[data-camera]').forEach(b => b.classList.toggle('selected', b === button));
    if (key === 'top' || key === 'iso') preferredStageCamera = key;
    if (key === 'ugv') {
      if (activeStageFocus < 0) return;
      ugvState.followCamera = true;
      btnFollow.classList.add('active-btn');
      return;
    }
    if (activeStageFocus >= 0 && (key === 'top' || key === 'iso')) {
      const idx=activeStageFocus;
      const centerY=layerObjects[idx].group.position.y;
      const target=new THREE.Vector3(0,centerY+.8,0);
      camera.position.copy(target).add(key === 'top' ? new THREE.Vector3(0,24,.01) : new THREE.Vector3(-17,13,18));
      controls.target.copy(target);camera.zoom=key === 'top'?1.35:1.25;camera.updateProjectionMatrix();controls.update();
      ugvState.followCamera=false;btnFollow.classList.remove('active-btn');
    } else document.getElementById(`cam-${key}`).click();
  });
});
document.getElementById('presentation-export').addEventListener('click', () => document.getElementById('btn-export-full-4k').click());
document.getElementById('btn-fullscreen').addEventListener('click', () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
  else document.exitFullscreen().catch(() => {});
});

document.getElementById('spacing-slider').addEventListener('input', (e) => {
  layerSpacing = parseFloat(e.target.value);
  document.getElementById('spacing-val').textContent = `${layerSpacing.toFixed(2)}m`;
  updateLayerVerticalPositions(layerSpacing);
  runRealGeometryValidation();
});

const camButtons = {
  infographic: document.getElementById('cam-infographic'),
  iso: document.getElementById('cam-iso'),
  top: document.getElementById('cam-top'),
  ugv: document.getElementById('cam-ugv')
};
Object.entries(camButtons).forEach(([key, btn]) => {
  btn.addEventListener('click', () => {
    clearStageFocus(false);
    ugvState.followCamera = false;
    btnFollow.classList.remove('active-btn');
    Object.values(camButtons).forEach(b => b.classList.remove('active-btn'));
    btn.classList.add('active-btn');
    const p = CAMERA_PRESETS[key];
    camera.position.copy(p.pos);
    camera.zoom = p.zoom;
    camera.updateProjectionMatrix();
    controls.target.copy(p.target);
    controls.update();
  });
});

document.getElementById('quality-select').addEventListener('change', (e) => buildCompleteFourStageScene(e.target.value));
document.getElementById('lidar-density-slider').addEventListener('change', (e) => {
  document.getElementById('lidar-density-val').textContent = `${Math.round(parseFloat(e.target.value) * 100)}%`;
  buildCompleteFourStageScene(document.getElementById('quality-select').value);
});
document.getElementById('lidar-size-slider').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  document.getElementById('lidar-size-val').textContent = `${v.toFixed(1)}x`;
  if (dynamicRefs.sensePointMat) dynamicRefs.sensePointMat.size = 0.062 * v;
});
document.getElementById('wire-slider').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  document.getElementById('wire-val').textContent = v.toFixed(2);
  if (dynamicRefs.understandWireMat) dynamicRefs.understandWireMat.opacity = v * 0.58;
  if (dynamicRefs.understandTreeMat) dynamicRefs.understandTreeMat.opacity = v * 0.65;
});
document.getElementById('bloom-slider').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  document.getElementById('bloom-val').textContent = v.toFixed(2);
  bloomPass.strength = v;
});

document.querySelectorAll('.layer-vis').forEach(chk => {
  chk.addEventListener('change', (e) => {
    const idx = parseInt(e.target.dataset.idx, 10);
    if (layerObjects[idx]) layerObjects[idx].group.visible = e.target.checked;
  });
});
document.getElementById('chk-shadows').addEventListener('change', (e) => {
  renderer.shadowMap.enabled = e.target.checked;
  scene.traverse(obj => { if (obj.material) obj.material.needsUpdate = true; });
});

document.getElementById('ugv-glb-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  new GLTFLoader().load(url, (gltf) => {
    layerObjects.forEach((layer) => {
      const rig = layer.ugvRig;
      if (rig.userData.chassisGroup) rig.remove(rig.userData.chassisGroup);
      const cloned = gltf.scene.clone(true);
      const box = new THREE.Box3().setFromObject(cloned);
      const size = new THREE.Vector3();
      box.getSize(size);
      cloned.scale.setScalar(0.85 / Math.max(size.x, size.y, size.z, 0.001));
      rig.add(cloned);
      rig.userData.chassisGroup = cloned;
    });
    showToastMessage(`Loaded custom UGV (${file.name}) across all 4 layers.`);
  });
});

document.getElementById('btn-export-full-4k').addEventListener('click', () => renderAndDownload4K(true));
document.getElementById('btn-export-clean-4k').addEventListener('click', () => renderAndDownload4K(false));
document.getElementById('btn-export-glb').addEventListener('click', () => {
  new GLTFExporter().parse(
    scene,
    (res) => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([res], { type: 'application/octet-stream' }));
      link.download = 'TESS_SPACE_AI_GNC_V3.glb';
      link.click();
    },
    (err) => console.error(err),
    { binary: true }
  );
});
document.getElementById('btn-export-json').addEventListener('click', () => {
  const report = runRealGeometryValidation();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  link.download = 'geometry_validation_v3.json';
  link.click();
});
document.getElementById('btn-export-layers').addEventListener('click', () => {
  const origBg = scene.background, origFog = scene.fog;
  const origVis = layerObjects.map(l => l.group.visible);
  scene.background = null;
  scene.fog = null;
  renderer.setClearColor(0x000000, 0);

  layerObjects.forEach((target) => {
    layerObjects.forEach(other => { other.group.visible = (other === target); });
    renderer.render(scene, camera);
    const link = document.createElement('a');
    link.download = `TESS_SPACE_V3_${target.key}.png`;
    link.href = renderer.domElement.toDataURL('image/png');
    link.click();
  });

  layerObjects.forEach((l, i) => { l.group.visible = origVis[i]; });
  scene.background = origBg;
  scene.fog = origFog;
});

new ResizeObserver(() => {
  const w = container.clientWidth || window.innerWidth;
  const h = container.clientHeight || window.innerHeight;
  const a = w / h;
  camera.left = (-frustumSize * a) / 2;
  camera.right = (frustumSize * a) / 2;
  camera.top = frustumSize / 2;
  camera.bottom = -frustumSize / 2;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
}).observe(container);

// Shared, continuous mission clock; the four layers render the SAME event.
const missionState = {
  active:false, kind:null, elapsed:0, cooldown:25, next:'SQUAD',
  x:0,z:0,nextX:0,nextZ:0, roots:[], soldiers:[], crates:[], drones:[],
  sparks:[], artillery:[], savedPaused:false, snapshotShown:false, snapshotPending:false, startX:0, startZ:0, cinematic:false, cameraOriginal:null, focusPrevious:-1
};

// V3.9: one synchronized mission timeline, four stage-specific representations.
const missionPalette = [0x62dcff, 0xff7900, 0xeaeaea, 0x536450];
function makeMesh(parent, geo, color, x=0,y=0,z=0) {
  const m=new THREE.Mesh(geo,new THREE.MeshStandardMaterial({color,roughness:0.84,metalness:0.12}));
  m.position.set(x,y,z);parent.add(m);return m;
}
function makeSoldier(parent, tint) {
  const g=new THREE.Group();parent.add(g);
  const uniform=tint===0xeaeaea?0xeaeaea:tint===0xff7900?0xff8e30:0x6c7865;
  makeMesh(g,new THREE.BoxGeometry(.28,.38,.17),uniform,0,.62,0);
  makeMesh(g,new THREE.BoxGeometry(.32,.27,.20),0x303c37,0,.69,-.145);
  makeMesh(g,new THREE.BoxGeometry(.27,.05,.23),0x222b26,0,.82,-.145);
  for(const side of [-1,1])makeMesh(g,new THREE.BoxGeometry(.035,.34,.045),0x222b26,side*.135,.68,-.11);
  makeMesh(g,new THREE.SphereGeometry(.145,10,7),uniform,0,1.0,0);
  // Recognizable modern combat helmet: low shell, front rim, side rails and chin strap.
  makeMesh(g,new THREE.SphereGeometry(.18,12,8,0,Math.PI*2,0,Math.PI*.56),uniform,0,1.075,0);
  makeMesh(g,new THREE.BoxGeometry(.34,.055,.29),0x39463a,0,1.055,.015);
  makeMesh(g,new THREE.BoxGeometry(.045,.07,.22),0x252f29,-.175,1.035,0);
  makeMesh(g,new THREE.BoxGeometry(.045,.07,.22),0x252f29,.175,1.035,0);
  makeMesh(g,new THREE.BoxGeometry(.025,.19,.025),0x222724,-.13,.96,.06);
  makeMesh(g,new THREE.BoxGeometry(.025,.19,.025),0x222724,.13,.96,.06);
  makeMesh(g,new THREE.BoxGeometry(.20,.10,.10),0x2d3332,0,.9,.13);
  const legs=[];
  for(const side of [-1,1]){
    const leg=new THREE.Group();leg.position.set(side*.095,.42,0);g.add(leg);
    makeMesh(leg,new THREE.BoxGeometry(.105,.40,.12),uniform,0,-.20,0);
    makeMesh(leg,new THREE.BoxGeometry(.145,.19,.21),0x222824,0,-.355,.045);
    legs.push(leg);
    // Arm geometry is built only at the rifle below: two arms total.
  }
  // Two-handed rifle: trigger hand near stock, supporting hand on fore-end.
  const rifle=new THREE.Group();g.add(rifle);rifle.position.set(.04,.70,.23);
  makeMesh(rifle,new THREE.BoxGeometry(.10,.09,.57),0x222829,0,0,.10);
  makeMesh(rifle,new THREE.BoxGeometry(.045,.045,.29),0x171b1b,0,.012,.48);
  makeMesh(rifle,new THREE.BoxGeometry(.15,.10,.22),0x333a36,0,-.015,-.26);
  makeMesh(rifle,new THREE.BoxGeometry(.09,.08,.12),0x141b1b,0,.075,.01);
  makeMesh(rifle,new THREE.BoxGeometry(.15,.08,.16),0x333b38,0,-.02,-.17);
  makeMesh(rifle,new THREE.BoxGeometry(.06,.13,.08),0x232828,.02,-.10,-.01);
  for(const [x,z] of [[-.11,-.02],[.11,.32]]){
    makeMesh(rifle,new THREE.BoxGeometry(.115,.09,.12),0x202825,x,-.055,z);
    const upper=makeMesh(g,new THREE.BoxGeometry(.105,.20,.10),uniform,x<0?-.19:.19,.69,.075);
    upper.rotation.x=-.40;upper.rotation.z=x<0?-.26:.26;
    const forearm=makeMesh(g,new THREE.BoxGeometry(.09,.19,.09),uniform,x*.85,.62,.17+z*.28);
    forearm.rotation.x=.72;
  }
  g.userData.rifle=rifle;
  g.userData.legs=legs;
  g.visible=false;return g;
}
function makeDrone(parent, color) {
  const g=new THREE.Group();parent.add(g);
  makeMesh(g,new THREE.BoxGeometry(.34,.12,.25),color);
  makeMesh(g,new THREE.BoxGeometry(.22,.07,.12),0x202326,0,-.10,.07);
  const propellers=[];
  for(const x of [-.30,.30])for(const z of [-.28,.28]){
    const arm=makeMesh(g,new THREE.BoxGeometry(.40,.045,.055),color,x*.48,0,z*.48);
    arm.rotation.y=Math.sign(x*z)*.7;
    makeMesh(g,new THREE.CylinderGeometry(.072,.072,.055,10),0x282b2c,x,.045,z);
    const prop=makeMesh(g,new THREE.BoxGeometry(.28,.012,.035),0x949a9a,x,.088,z);
    propellers.push(prop);
    makeMesh(g,new THREE.BoxGeometry(.055,.04,.065),color,x,-.05,z);
  }
  g.userData.propellers=propellers;g.visible=false;return g;
}
function makeMedic(parent) {
  const g=new THREE.Group();parent.add(g);
  makeMesh(g,new THREE.BoxGeometry(.45,.28,.36),0xe9e8db,0,0,0);
  makeMesh(g,new THREE.BoxGeometry(.21,.025,.06),0xd9212d,0,.153,0);
  makeMesh(g,new THREE.BoxGeometry(.06,.025,.21),0xd9212d,0,.154,0);
  makeMesh(g,new THREE.BoxGeometry(.07,.11,.22),0xd9212d,0,0,.187);
  makeMesh(g,new THREE.BoxGeometry(.21,.11,.065),0xd9212d,0,0,.189);
  // Keep the red cross unobstructed on the lid and visible side.
  g.visible=false;return g;
}
// Stylized tracked tank: stage-specific appearance, clearly readable in profile.
function makeTankProp(parent, stage) {
  const group=new THREE.Group(); parent.add(group);
  const base=stage===3?0x414850:missionPalette[stage];
  const armor=stage===3?0x626b75:missionPalette[stage];
  const track=stage===3?0x171a1f:missionPalette[stage];
  const accent=stage===3?0xa83232:missionPalette[stage];
  makeMesh(group,new THREE.BoxGeometry(1.36,.25,.76),base,0,.43,0);
  makeMesh(group,new THREE.BoxGeometry(1.12,.19,.67),armor,-.06,.60,0);
  for(const side of [-1,1]){
    const z=side*.44;
    makeMesh(group,new THREE.BoxGeometry(1.43,.33,.22),track,0,.26,z);
    for(let j=0;j<6;j++){
      const wheel=makeMesh(group,new THREE.CylinderGeometry(.12,.12,.075,10),stage===3?0x353b42:track,-.56+j*.22,.23,z+side*.12);
      wheel.rotation.x=Math.PI/2;
    }
    makeMesh(group,new THREE.BoxGeometry(.9,.055,.08),accent,0,.44,z);
  }
  const turret=new THREE.Group();turret.position.set(-.06,.76,0);group.add(turret);
  makeMesh(turret,new THREE.BoxGeometry(.69,.24,.59),armor,0,0,0);
  makeMesh(turret,new THREE.BoxGeometry(.37,.13,.39),base,-.13,.17,0);
  makeMesh(turret,new THREE.BoxGeometry(.18,.065,.24),accent,-.28,.27,0);
  // Barrel points along the tank's local +X axis; turret turns towards the left-side impacts.
  const barrel=makeMesh(turret,new THREE.CylinderGeometry(.067,.09,1.23,12),track,.88,.035,0);
  barrel.rotation.z=Math.PI/2;
  makeMesh(turret,new THREE.CylinderGeometry(.095,.095,.12,12),armor,1.49,.035,0).rotation.z=Math.PI/2;
  const flash=makeMesh(turret,new THREE.SphereGeometry(.19,10,8),0xffc452,1.61,.035,0);
  flash.visible=false;
  group.userData.muzzleFlash=flash;group.userData.turret=turret;
  if(stage!==3)group.traverse(m=>{if(m.isMesh){m.material=m.material.clone();m.material.color.setHex(stage===0?0x45c8ff:stage===1?0xff7900:0xececec);m.material.wireframe=stage!==0;m.material.transparent=stage===0;m.material.opacity=stage===0?.68:1;}});
  group.visible=false;return group;
}
function artilleryLocation(){
  // Same right-hand road entry as the squad, with enough clearance for the whole tank.
  return roadPoint(.91);
}
function setupMissionVisuals() {
  missionState.roots=[];missionState.soldiers=[];missionState.crates=[];missionState.drones=[];missionState.sparks=[];missionState.artillery=[];
  for(let k=0;k<4;k++){
    const root=new THREE.Group();layerObjects[k].group.add(root);missionState.roots.push(root);
    const tint=missionPalette[k];
    const soldiers=Array.from({length:3},()=>makeSoldier(root,tint));
    const crate=makeMedic(root);
    const drones=Array.from({length:4},(_,i)=>makeDrone(root,i===3?0xff7900:(k===2?0xd0d0d0:0x1c2023)));
    const sparks=Array.from({length:21},(_,i)=>{
      const debris=i>=7;
      const spark=makeMesh(root,debris?new THREE.BoxGeometry(.07,.07,.07):new THREE.SphereGeometry(.08,7,5),debris?0x795438:(i%2?0xff7900:0xffd77a));
      spark.visible=false;return spark;
    });
    missionState.soldiers.push(soldiers);missionState.crates.push(crate);
    // Stage-consistent visual language: SENSE cyan, UNDERSTAND orange, DECIDE white, CONTROL natural.
    if(k!==3) for(const actor of [...soldiers,crate,...drones]) actor.traverse(obj=>{
      if(!obj.isMesh)return;
      obj.material=obj.material.clone();
      obj.material.color.setHex(k===0?0x45c8ff:k===1?0xff7900:0xececec);
      obj.material.wireframe=k!==0;
      obj.material.transparent=k===0;
      obj.material.opacity=k===0?.68:1;
    });
    missionState.drones.push(drones);missionState.sparks.push(sparks);missionState.artillery.push(makeTankProp(root,k));
  }
}
const ease=t=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);};
const mix=(a,b,t)=>a+(b-a)*t;
function roadPoint(t) {
  const ids=roadGraph.mainChainIds;
  const at=Math.max(0,Math.min(ids.length-1.00001,t*(ids.length-1)));
  const i=Math.floor(at),f=at-i;
  const a=roadGraph.nodes[ids[i]],b=roadGraph.nodes[ids[Math.min(ids.length-1,i+1)]];
  return {x:mix(a.x,b.x,f),z:mix(a.z,b.z,f)};
}
function startMission(kind) {
  if(missionState.active||satelliteEvent.active)return;
  missionState.active=true;missionState.kind=kind;missionState.elapsed=0;
  missionState.snapshotShown=false;missionState.snapshotPending=false;missionState.savedPaused=ugvState.paused;
  missionState.startX=ugvState.x;missionState.startZ=ugvState.z;
  ugvState.paused=false;
  for(const marker of dynamicRefs.destMarkers)marker.visible=false;
  document.body.classList.add('mission-active');
  // Keep stage discovery visible between missions.
  // If the visitor is in View All, move to CONTROL for a legible story.
  missionState.cinematic=activeStageFocus<0;
  missionState.focusPrevious=activeStageFocus;
  if(missionState.cinematic){
    missionState.cameraOriginal={position:camera.position.clone(),target:controls.target.clone(),zoom:camera.zoom};
    activeStageFocus=3;document.body.classList.add('single-stage');
    layerObjects.forEach((l,i)=>l.group.visible=i===3);
    stageBlocks.forEach((b,i)=>b.classList.toggle('stage-selected',i===3));
    ugvState.followCamera=false;
  }

  if(kind==='DRONE'){const flash=document.getElementById('isr-scan-pulse');if(flash){flash.classList.remove('active');void flash.offsetWidth;flash.classList.add('active');}}
  showToastMessage(kind==='SQUAD'?'SQUAD SUPPORT · Escort demonstration':'DRONE ENCOUNTER · Aerial response demonstration',3200);
}
function finishMission() {
  missionState.active=false;missionState.kind=null;missionState.elapsed=0;
  missionState.cooldown=30;missionState.next=missionState.next==='SQUAD'?'DRONE':'SQUAD';
  document.body.classList.remove('mission-active');
  if(missionState.cinematic){
    const old=missionState.cameraOriginal;
    activeStageFocus=-1;document.body.classList.remove('single-stage');
    layerObjects.forEach(l=>l.group.visible=true);
    stageBlocks.forEach(b=>b.classList.remove('stage-selected'));
    if(old){camera.position.copy(old.position);controls.target.copy(old.target);camera.zoom=old.zoom;camera.updateProjectionMatrix();}
    missionState.cinematic=false;
  }

  document.getElementById('mission-snapshot').classList.remove('visible');
  ugvState.paused=missionState.savedPaused;
  dispatchNextAutonomousWaypoint();
  ugvState.currentSpeed=0;
}
function updateMissionClock(dt) {
  const status=document.getElementById('mission-status');
  const countdown=document.getElementById('mission-countdown');
  const prompt=document.querySelector('.destination-prompt strong');
  if(!missionState.active){
    missionState.cooldown-=dt;
    if(missionState.cooldown<=0&&!satelliteEvent.active)startMission(missionState.next);
    status.textContent='NEXT · '+(missionState.next==='SQUAD'?'SQUAD SUPPORT & RECON':'DRONE ENCOUNTER');
    countdown.textContent='00:'+String(Math.max(0,Math.ceil(missionState.cooldown))).padStart(2,'0');
    if(prompt)prompt.textContent='CLICK ANYWHERE ON THE TERRAIN';
    return;
  }
  missionState.elapsed+=dt;
  const t=missionState.elapsed;
  const squad=missionState.kind==='SQUAD';
  const duration=squad?44:30;
  status.textContent=squad?'ACTIVE · SQUAD SUPPORT & RECON':'ACTIVE · DRONE ENCOUNTER';
  countdown.textContent='LIVE · '+String(Math.ceil(Math.max(0,duration-t)))+'s';
  if(prompt)prompt.textContent='MISSION ACTIVE · DESTINATION LOCKED';
  if(squad){
    // Enter right side, join at 7s, escort toward left edge, observe at 25s.
    const f=ease(t/24);
    const road=roadPoint(1-f);
    const retreat=ease((t-24)/6);
    const escortX=mix(missionState.startX,road.x,ease(t/5)),escortZ=mix(missionState.startZ,road.z,ease(t/5));
    // Reposition to the centre of the road, ready to observe the right-hand entrance.
    const observation=roadPoint(.52);
    missionState.x=mix(escortX,observation.x,retreat);missionState.z=mix(escortZ,observation.z,retreat);
    const next=roadPoint(1-ease(Math.min(24,t+.15)/24));
    const target=artilleryLocation();
    missionState.nextX=mix(next.x,target.x,retreat);missionState.nextZ=mix(next.z,target.z,retreat);
  }else{
    // UGV moves to centre to launch simulated scout.
    const road=roadPoint(.43);
    const f=ease(t/7);
    missionState.x=mix(missionState.startX,road.x,f);missionState.z=mix(missionState.startZ,road.z,f);
    missionState.nextX=road.x;missionState.nextZ=road.z-.01;
  }
  if(squad && t>=39) document.getElementById('mission-snapshot').classList.remove('visible');
  if(t>=duration)finishMission();
}
function updateCinematicCamera(dt){
  if(!missionState.active||!missionState.cinematic)return;
  const t=missionState.elapsed,squad=missionState.kind==='SQUAD';
  const tankPhase=squad&&t>=25;
  const point=tankPhase?artilleryLocation():squad?roadPoint(1-ease(t/24)):{x:missionState.x,z:missionState.z};
  const height=layerObjects[3].group.position.y+evaluateGeography(point.x,point.z).y;
  const aim=new THREE.Vector3(point.x,height+.65,point.z);
  const phase=t*.11;
  const radius=tankPhase?7.6:8.8;
  const desired=aim.clone().add(new THREE.Vector3(Math.sin(phase)*radius,6.5,Math.cos(phase)*radius));
  const factor=1-Math.exp(-dt*1.8);
  controls.target.lerp(aim,factor);camera.position.lerp(desired,factor);
  camera.zoom+=(1.12-camera.zoom)*factor;camera.updateProjectionMatrix();
}
function updateDiscovery(dt){
  if(missionState.active||satelliteEvent.active||document.hidden)return;
  discovery.elapsed+=dt;
  const index=Math.floor(discovery.elapsed/5)%4;
  if(index!==discovery.step||discovery.visited===0){
    discovery.step=index;discovery.visited++;
    stageBlocks.forEach((b,i)=>b.classList.toggle('discovery-target',i===index));
    const arrow=document.getElementById('stage-discovery-arrow');
    if(arrow){const block=stageBlocks[index];if(block){const rect=(block.querySelector('.stage-icon')||block).getBoundingClientRect();arrow.classList.add('visible');arrow.style.top=(rect.top+rect.height*.18)+'px';arrow.style.left=Math.max(6,rect.left-40)+'px';arrow.style.right='auto';}else{arrow.classList.remove('visible');}}
  }
  const guide=document.getElementById('control-guide');
  if(guide){
    guide.classList.add('visible');
    guide.textContent=discovery.elapsed%18<6?'↻ DRAG TO ROTATE THE TERRAIN':discovery.elapsed%18<12?'⌖ CLICK TERRAIN TO SET A WAYPOINT':'↗ SELECT SENSE / UNDERSTAND / DECIDE / CONTROL';
  }
}
function updateMissionVisuals(now) {
  if(!missionState.roots.length)return;
  const active=missionState.active, squad=missionState.kind==='SQUAD', t=missionState.elapsed;
  const here=roadPoint(1-ease(t/24));
  const next=roadPoint(1-ease(Math.min(24,t+.25)/24));
  const dx=next.x-here.x,dz=next.z-here.z,mag=Math.hypot(dx,dz)||1;
  const forward={x:dx/mag,z:dz/mag},side={x:-forward.z,z:forward.x};
  const visibleSquad=active&&squad&&t<24;
  const visibleDrone=active&&!squad;
  for(let k=0;k<4;k++){
    const soldiers=missionState.soldiers[k],crate=missionState.crates[k],drones=missionState.drones[k],sparks=missionState.sparks[k];
    const artillery=missionState.artillery[k];
    artillery.visible=active&&squad&&t>=26&&t<42;
    if(artillery.visible){
      const entry=roadPoint(.995),loc=artilleryLocation();
      const arrive=ease((t-26)/3),withdraw=ease((t-36)/5);
      const x=mix(entry.x,loc.x,arrive)+withdraw*(entry.x-loc.x);
      const z=mix(entry.z,loc.z,arrive)+withdraw*(entry.z-loc.z);
      artillery.position.set(x,evaluateGeography(x,z).y+.05,z);
      // Chassis faces the road; turret alone tracks the left-side impacts.
      const travel=roadPoint(.83);
      artillery.rotation.y=-Math.atan2(travel.z-entry.z,travel.x-entry.x);
      const impact=roadPoint(.035);
      const heading=Math.atan2(impact.z-z,impact.x-x);
      artillery.userData.turret.rotation.y=-heading-artillery.rotation.y;
      const pulse=(t-30)%1.45;
      artillery.userData.muzzleFlash.visible=t>=30&&t<35&&pulse<.17;
      artillery.userData.muzzleFlash.scale.setScalar(1+Math.max(0,.17-pulse)*3);
      const scanned=t>=32.3&&t<33.2;
      artillery.traverse(m=>{if(m.isMesh&&m!==artillery.userData.muzzleFlash){
        if(!m.userData.baseColor)m.userData.baseColor=m.material.color.clone();
        m.material.color.copy(m.userData.baseColor);
        if(scanned)m.material.color.lerp(new THREE.Color(k===0?0xfff384:k===1?0xffffff:k===2?0x54adff:0xffffff),.85);
      }});
    }
    soldiers.forEach((g,i)=>{
      g.visible=visibleSquad;
      if(!visibleSquad)return;
      const offsets=[1.10,-1.10,0],laterals=[0,0,.85];
      const x=here.x+forward.x*offsets[i]+side.x*laterals[i];
      const z=here.z+forward.z*offsets[i]+side.z*laterals[i];
      g.position.set(x,evaluateGeography(x,z).y+.05+Math.abs(Math.sin(now*.012+i))*0.035,z);
      g.rotation.y=Math.atan2(forward.x,forward.z);
      g.userData.rifle.rotation.x=[-.12,.24,.06][i];
      g.userData.rifle.rotation.y=[-.14,.18,0][i];
      g.userData.legs[0].rotation.x=Math.sin(now*.013+i)*.65;
      g.userData.legs[1].rotation.x=-Math.sin(now*.013+i)*.65;
    });
    crate.visible=active&&squad&&t>=7&&t<25;
    if(crate.visible)crate.position.set(ugvState.x,ugvState.y+.53,ugvState.z);
    drones.forEach((g,i)=>{
      g.visible=visibleDrone&&(i===3?t>=9&&t<29:t>=0&&t<25);
      if(!g.visible)return;
      let x,z,y;
      if(i<3){
        const a=ease(Math.min(t,12)/12);
        const b=ease(Math.max(0,t-12)/13);
        x=mix(4.8,-.5,a)-b*11.5+i*.55;
        z=mix(-5.5,-.7,a)+b*8+i*.5;
        y=evaluateGeography(x,z).y+2.5+i*.17;
      }else{
        const lift=ease((t-9)/3);
        const pursuit=ease((t-12)/11);
        const home=ease((t-22)/6);
        x=mix(mix(ugvState.x,-.6,pursuit)-pursuit*5.7,ugvState.x,home);
        z=mix(mix(ugvState.z,0,pursuit)+pursuit*3.7,ugvState.z,home);
        y=evaluateGeography(x,z).y+.8+lift*2*(1-home);
      }
      g.position.set(x,y+.06*Math.sin(now*.005+i),z);
      g.rotation.y=Math.sin(t*.4+i)*.13;
      g.userData.propellers.forEach((p,j)=>p.rotation.y=now*.035*(j%2?-1:1));
    });
    sparks.forEach((g,i)=>{
      const burst=i%7;
      const wave=Math.floor(i/7);
      const onset=29.2+burst*.56;
      const age=t-onset;
      const flash=wave===0;
      g.visible=active&&squad&&age>=0&&age<(flash?.54:3.6);
      if(!g.visible)return;
      const edge=roadPoint(.035);
      const spread=burst*.48;
      const x=edge.x+Math.sin(burst*3.1)*(.3+spread);
      const z=edge.z+Math.cos(burst*2.4)*(.3+spread);
      const ground=evaluateGeography(x,z).y;
      // Lightweight ballistic debris with one ground bounce; deterministic across stages.
      const vy=1.7+(i%5)*.22;
      const gravity=3.8;
      const flight=2*vy/gravity;
      const bounceAge=Math.max(0,age-flight);
      const height=age<flight ? vy*age-.5*gravity*age*age : Math.max(0,.35*bounceAge-1.9*bounceAge*bounceAge);
      const drift=Math.min(age,flight)+Math.max(0,bounceAge)*.25;
      g.position.set(x+Math.sin(i*2.9)*drift*.60,ground+.09+(flash?age*.7:height),z+Math.cos(i*4.1)*drift*.60);
      g.rotation.set(age*(1+i%3),age*(2+i%4),age*.7);
      g.scale.setScalar(flash?1.25+age*1.15:1.15);
    });
  }
  if(active&&squad&&t>=32.5&&!missionState.snapshotShown){
    missionState.snapshotShown=true;
    const el=document.getElementById('mission-snapshot');
    el.classList.add('visible');
    missionState.snapshotPending=true;
    const flash=document.getElementById('isr-scan-pulse');
    if(flash){flash.classList.remove('active');void flash.offsetWidth;flash.classList.add('active');}

    const snapshotTime = el?.querySelector('.snapshot-time');
    if (snapshotTime) snapshotTime.textContent = new Date().toLocaleTimeString();
  }
}

// V3.9.13: soft volumetric-looking scanning wedges, never weapon-like laser rays.
const lidarRigs=[];
function initializeLidarRigs(){
  for(let k=0;k<4;k++){
    const group=new THREE.Group();layerObjects[k].group.add(group);
    const material=new THREE.MeshBasicMaterial({color:[0x50dfff,0xffa040,0xffffff,0x79e7d8][k],transparent:true,opacity:.13,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending});
    const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(new Float32Array(9),3));geo.setIndex([0,1,2]);
    const fan=new THREE.Mesh(geo,material);fan.visible=false;fan.renderOrder=55;group.add(fan);
    const sweep=new THREE.Mesh(new THREE.RingGeometry(1.5,1.58,48,1,0,.33),new THREE.MeshBasicMaterial({color:[0x42dfff,0xff7900,0xeeeeee,0xffb050][k],transparent:true,opacity:.30,side:THREE.DoubleSide,depthWrite:false}));
    sweep.rotation.x=-Math.PI/2;sweep.visible=true;group.add(sweep);
    lidarRigs.push({fan,sweep});
  }
}
function updateLidarRigs(now){
  if(lidarRigs.length!==4)return;
  const t=missionState.elapsed,drone=missionState.kind==='DRONE';
  const scanning=missionState.active&&(drone?(t>=4.5&&t<8.5):(t>=31&&t<33.4));
  for(let k=0;k<4;k++){
    const {fan,sweep}=lidarRigs[k];
    const y=evaluateGeography(ugvState.x,ugvState.z).y+.07;
    sweep.position.set(ugvState.x,y,ugvState.z);
    sweep.rotation.z=now*.0007;
    sweep.material.opacity=.17+.08*Math.sin(now*.002);
    fan.visible=false;
    if(!scanning)continue;
    const target=drone?missionState.drones[k].find(g=>g.visible):missionState.artillery[k];
    if(!target||!target.visible)continue;
    const origin=new THREE.Vector3(ugvState.x,ugvState.y+.65,ugvState.z);
    const end=target.position.clone();end.y+=drone?.5:.65;
    const dir=end.clone().sub(origin),width=drone?.85:1.0;
    const side=new THREE.Vector3(-dir.z,0,dir.x).normalize().multiplyScalar(width);
    const phase=Math.sin(now*.005)*.55;
    const shifted=end.clone().addScaledVector(side,phase);
    const attr=fan.geometry.attributes.position;
    attr.setXYZ(0,origin.x,origin.y,origin.z);
    attr.setXYZ(1,shifted.x+side.x,shifted.y,shifted.z+side.z);
    attr.setXYZ(2,shifted.x-side.x,shifted.y,shifted.z-side.z);
    attr.needsUpdate=true;fan.geometry.computeBoundingSphere();fan.visible=true;
    fan.material.opacity=.11+.07*(.5+.5*Math.sin(now*.008));
  }
}
// V3.9.13 standalone GNSS-denied/restored visual narrative, DECIDE layer only.
const satelliteEvent={active:false,age:0,duration:29,models:[],beams:[],signalIcons:[],tower:null,waypoints:[],waypointIndex:0,previousSpeed:null,previousFocus:-1,previousCamera:null,done:false};
function buildSatelliteModel(stage){
  const root=new THREE.Group();
  const box=(p,w,h,d,c,x=0,y=0,z=0)=>makeMesh(p,new THREE.BoxGeometry(w,h,d),c,x,y,z);
  box(root,.72,.54,.55,0x9ca4ae);box(root,.38,.38,.65,0x515a66,0,-.02,.30);
  for(const side of [-1,1]){
    box(root,1.42,.045,.85,0x8b9cc4,side*1.17,0,0);
    for(let j=-1;j<=1;j++)box(root,.025,.065,.86,0x303a55,side*1.17+j*.39,.035,0);
  }
  const dish=new THREE.Mesh(new THREE.ConeGeometry(.43,.18,14,1,true),new THREE.MeshStandardMaterial({color:0xaab6c5,side:THREE.DoubleSide}));
  dish.position.y=.52;dish.rotation.x=Math.PI;root.add(dish);box(root,.045,.34,.045,0x434b56,0,.75,.06);
  root.scale.setScalar(.72);root.visible=false;return root;
}
function setupSatellites(){
  const e=satelliteEvent;e.models=[];e.beams=[];e.signalIcons=[];
  const root=layerObjects[3].group;
  const sat=buildSatelliteModel(2);root.add(sat);e.models.push(sat);
  for(let j=0;j<2;j++){
    const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3()]),new THREE.LineDashedMaterial({color:j?0xff9900:0x66ff9d,transparent:true,opacity:.8,dashSize:.24,gapSize:.12}));
    line.visible=false;root.add(line);e.beams.push(line);
  }
  const icons=new THREE.Group();
  for(let j=0;j<3;j++){
    const curve=new THREE.EllipseCurve(0,0,.3+j*.17,.2+j*.13,.45,Math.PI-.45,false,0);
    const arc=new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(25).map(p=>new THREE.Vector3(p.x,p.y,0))),new THREE.LineBasicMaterial({color:0x55ff9b}));icons.add(arc);
  }
  const cross=new THREE.Group();for(const a of [-Math.PI/4,Math.PI/4]){const bar=makeMesh(cross,new THREE.BoxGeometry(.07,.8,.05),0xff4040);bar.rotation.z=a;}icons.add(cross);icons.userData.cross=cross;icons.visible=false;root.add(icons);e.signalIcons.push(icons);
  const tower=new THREE.Group();root.add(tower);
  // Two hinged mountain hatches and retractable central radar mast.
  const baseX=5.1,baseZ=-5.2,ground=evaluateGeography(baseX,baseZ).y+.03;
  tower.position.set(baseX,ground,baseZ);tower.scale.setScalar(.48);
  const left=new THREE.Group(),right=new THREE.Group();tower.add(left,right);
  left.position.x=-.65;right.position.x=.65;
  makeMesh(left,new THREE.BoxGeometry(1.3,.11,1.55),0x514e42,.65,0,0);
  makeMesh(right,new THREE.BoxGeometry(1.3,.11,1.55),0x514e42,-.65,0,0);
  const mast=new THREE.Group();tower.add(mast);
  makeMesh(mast,new THREE.CylinderGeometry(.085,.12,1.8,8),0x7b838b,0,1,0);
  makeMesh(mast,new THREE.CylinderGeometry(.49,.52,.53,14),0x929aa7,0,2.05,0);
  for(let i=0;i<4;i++){
    const panel=makeMesh(mast,new THREE.BoxGeometry(.63,1.16,.12),0x7f8795,0,1.24,0);
    panel.position.x=Math.cos(i*Math.PI/2)*.48;panel.position.z=Math.sin(i*Math.PI/2)*.48;panel.rotation.y=i*Math.PI/2;
  }
  mast.position.y=-2.7;
  // The hatch is a permanent boulder-shaped part of the mountain, including when idle.
  const stoneGeo=new THREE.DodecahedronGeometry(1.48,0);
  const stoneMat=new THREE.MeshStandardMaterial({color:0x5c554a,roughness:1,flatShading:true});
  const stone=makeMesh(tower,stoneGeo,stoneMat,0,.18,0);stone.scale.set(1,.32,.83);
  // Rock stays in the landscape; a hinged upper section opens with the antenna.
  const lid=new THREE.Group();tower.add(lid);lid.position.set(-1.05,.32,0);
  const cap=makeMesh(lid,new THREE.DodecahedronGeometry(1.12,0),stoneMat,1.05,0,0);cap.scale.set(1,.30,.83);
  left.visible=false;right.visible=false;
  const dome=new THREE.Mesh(new THREE.SphereGeometry(8.3,32,16,0,Math.PI*2,0,Math.PI/2),new THREE.MeshBasicMaterial({color:0xff6542,transparent:true,opacity:.065,depthWrite:false,side:THREE.DoubleSide}));
  dome.visible=false;dome.scale.set(0.01,0.01,0.01);tower.add(dome);
  const rings=[];for(let i=0;i<3;i++){const ring=new THREE.Mesh(new THREE.TorusGeometry(3.4+i*.44,.018,5,72),new THREE.MeshBasicMaterial({color:0xff7846,transparent:true,opacity:.35,depthWrite:false}));ring.rotation.x=-Math.PI/2;ring.position.y=.22+i*.2;tower.add(ring);rings.push(ring);ring.visible=false;}
  tower.userData={left,right,mast,lid,dome,rings};e.tower=tower;
}
function gnssWaypointCandidates(){
  const candidates=[roadPoint(.14),roadPoint(.49),roadPoint(.83)];
  const shuffled=[...candidates].sort(()=>Math.random()-.5),result=[];
  for(const pt of shuffled){if(result.every(q=>Math.hypot(pt.x-q.x,pt.z-q.z)>5))result.push(pt);if(result.length===3)break;}
  return result;
}
function gnssDispatchNext(){
  const e=satelliteEvent;
  while(e.waypointIndex<e.waypoints.length){
    const pt=e.waypoints[e.waypointIndex++];
    if(dispatchUGVToTargetNode({x:pt.x,z:pt.z,y:evaluateGeography(pt.x,pt.z).y+.032})){
      ugvState.routeStatusText=`GNSS RESTORED · WAYPOINT ${e.waypointIndex}/${e.waypoints.length}`;
      return true;
    }
  }
  return false;
}
function beginGNSSScenario(){
  const e=satelliteEvent;
  if(e.active||missionState.active){showToastMessage('ANOTHER SCENARIO IS ACTIVE',2200);return;}
  e.active=true;e.age=0;e.waypoints=[roadPoint(.49)];e.waypointIndex=0;e.previousSpeed=ugvState.speedMultiplier;
  e.previousFocus=activeStageFocus;e.previousCamera={position:camera.position.clone(),target:controls.target.clone(),zoom:camera.zoom};
  missionState.cooldown=Math.max(missionState.cooldown,30);
  activeStageFocus=3;document.body.classList.add('single-stage');
  stageBlocks.forEach((b,i)=>{b.classList.toggle('stage-selected',i===3);b.setAttribute('aria-pressed',String(i===3));});
  layerObjects.forEach((l,i)=>l.group.visible=i===3);
  showToastMessage('SIMULATED GNSS DENIED · CONTROL STAGE',2900);
}
function endGNSSScenario(){
  const e=satelliteEvent;e.active=false;e.models.forEach(m=>m.visible=false);e.beams.forEach(b=>b.visible=false);e.signalIcons.forEach(g=>g.visible=false);
  if(e.previousSpeed!==null)ugvState.speedMultiplier=e.previousSpeed;
  e.tower.userData.mast.position.y=-2.7;e.tower.userData.lid.rotation.z=0;
  e.tower.userData.dome.visible=false;e.tower.userData.rings.forEach(r=>r.visible=false);
  missionState.cooldown=Math.max(missionState.cooldown,30);
  if(e.previousCamera){camera.position.copy(e.previousCamera.position);controls.target.copy(e.previousCamera.target);camera.zoom=e.previousCamera.zoom;camera.updateProjectionMatrix();}
  if(e.previousFocus<0)clearStageFocus(false);
  else {activeStageFocus=e.previousFocus;layerObjects.forEach((l,i)=>l.group.visible=i===e.previousFocus);stageBlocks.forEach((b,i)=>b.classList.toggle('stage-selected',i===e.previousFocus));}
}
function updateSatelliteEvent(dt,now){
  const e=satelliteEvent;if(!e.active)return;
  const center=new THREE.Vector3(0,layerObjects[3].group.position.y+.3,0);
  const focus=new THREE.Vector3(1.7,layerObjects[3].group.position.y+1.5,-2.2);
  const smooth=1-Math.exp(-dt*1.4);controls.target.lerp(focus,smooth);
  camera.position.lerp(new THREE.Vector3(11,layerObjects[3].group.position.y+12,14),smooth);
  e.age+=dt;const t=e.age,sat=e.models[0],icons=e.signalIcons[0];
  // Fly fully across the map, orbit while communicating, and exit the opposite edge.
  sat.visible=t<27;
  // Continuous coordinates at t=5 and t=21: never teleport into the dome.
  // Keep the entire satellite path continuous and inside the interference hemisphere
  // during the denied phase. Altitude is relative to the jammer's terrain elevation.
  const jammerX=5.1, jammerZ=-5.2;
  const sx=jammerX-2.15, sz=jammerZ;
  const flightY=e.tower.position.y+2.25;
  if(t<5){const f=t/5;sat.position.set(mix(-15,sx,f),flightY,mix(-10,sz,f));}
  else if(t<21){const ang=Math.PI+(t-5)*Math.PI*2/16;
    sat.position.set(jammerX+2.15*Math.cos(ang),flightY+.12*Math.sin(t*.32),jammerZ+1.75*Math.sin(ang));
  }else{const f=Math.min(1,(t-21)/6);sat.position.set(mix(sx,15,f),flightY,mix(sz,1.0,f));}
  sat.rotation.z=(t>5&&t<10)?.13*Math.sin(t*21):-.1;
  icons.visible=t<21;icons.position.copy(sat.position).add(new THREE.Vector3(0,.95,0));
  const denied=t>=5&&t<14;icons.children.slice(0,3).forEach(c=>c.material.color.setHex(denied?0xff4040:0x55ff99));icons.userData.cross.visible=denied;
  const {left,right,mast,lid,dome,rings}=e.tower.userData;
  const hatchOpen=Math.max(0,Math.min(1,(t-2)/1.4,(15-t)/1.4));
  lid.rotation.z=-hatchOpen*.9;
  const interference=Math.max(0,Math.min(1,(t-4)/1.5,(14-t)/1.3));
  dome.visible=interference>.01;dome.scale.setScalar(Math.max(.01,interference*(1+.035*Math.sin(t*6))));
  dome.material.opacity=.08+.035*Math.sin(t*4);
  rings.forEach((r,i)=>{r.visible=interference>.01;r.scale.setScalar(.65+((t*.36+i/3)%1)*.55);r.material.opacity=interference*(.4-((t*.36+i/3)%1)*.25);});
  mast.position.y=-2.7+2.7*Math.max(0,Math.min(1,(t-3.1)/1.5,(13.5-t)/1.5));
  for(let j=0;j<2;j++){
    const beam=e.beams[j];beam.visible=(j===0&&t>=15&&t<20)||(j===1&&t>=18&&t<21);
    if(!beam.visible)continue;
    const goal=j===0?{x:ugvState.x,z:ugvState.z}:e.waypoints[0];if(!goal)continue;
    const points=[sat.position.clone(),new THREE.Vector3(goal.x,evaluateGeography(goal.x,goal.z).y+.35,goal.z)];
    beam.geometry.setFromPoints(points);beam.computeLineDistances();
  }
  if(t>=19.4&&e.waypointIndex===0){ugvState.speedMultiplier=Math.max(e.previousSpeed*2,1.6);gnssDispatchNext();showToastMessage('GNSS RESTORED · WAYPOINT RECEIVED',3000);}
  // Each arrival triggers the next waypoint; the established path planner stays responsible for avoidance.
  if(e.waypointIndex>0&&e.waypointIndex<e.waypoints.length&&ugvState.distanceAlongCurve>=ugvState.curveLength-.025){gnssDispatchNext();showToastMessage(`GNSS ROUTE · WAYPOINT ${e.waypointIndex}/1`,1600);}
  if(e.waypointIndex===e.waypoints.length&&ugvState.distanceAlongCurve>=ugvState.curveLength-.025&&t>22)endGNSSScenario();
  if(t>180)endGNSSScenario();
}

// V3.9.14 environment additions. All stages share identical world coordinates.
const environmentalDetails=[];
function makeGroundPrintTexture(isBoot){
  const canvas=document.createElement('canvas');canvas.width=64;canvas.height=96;
  const ctx=canvas.getContext('2d');ctx.clearRect(0,0,64,96);
  ctx.fillStyle='rgba(255,255,255,.95)';
  if(isBoot){
    ctx.beginPath();ctx.roundRect(18,6,29,53,7);ctx.fill();
    ctx.beginPath();ctx.roundRect(17,62,30,24,5);ctx.fill();
    ctx.globalCompositeOperation='destination-out';
    for(let i=0;i<4;i++)ctx.fillRect(20,17+i*10,23,2);
  }else{
    // Three chunky tread lugs with gaps; each print is oriented along actual movement.
    for(let i=0;i<4;i++){
      const y=8+i*22;
      ctx.beginPath();ctx.moveTo(9,y);ctx.lineTo(55,y+4);ctx.lineTo(55,y+14);ctx.lineTo(9,y+10);ctx.closePath();ctx.fill();
    }
  }
  const tex=new THREE.CanvasTexture(canvas);tex.colorSpace=THREE.SRGBColorSpace;return tex;
}
function createEnvironmentDetails(){
  environmentalDetails.length=0;
  const barrierPositions=[[-5.6,2.8],[5.8,2.2],[-3.6,-5.9]];
  const summit=[5.1,-5.2];
  // Reuse one identical elevated mesh in every stage; whiten only the CONTROL skin.
  function drapedPatch(cx,cz,rx,rz,stage){
    // Faceted, 8–10 sided snow boulders: large patches like the hatch platform,
    // but with irregular polygon outlines instead of rectangular grid tiles.
    // Every stage receives the same geographic positions and topology.
    const positions=[],colors=[],indices=[];
    const grid=4,dx=2*rx/grid,dz=2*rz/grid;
    const white=new THREE.Color(stage===3?0xfafcfb:stage===2?0xd5d9d9:stage===1?0xffc59c:0x9ee5f7);
    const vertex=(x,y,z,col)=>{positions.push(x,y,z);colors.push(col.r,col.g,col.b);return positions.length/3-1;};
    for(let ix=0;ix<grid;ix++)for(let iz=0;iz<grid;iz++){
      const u=(ix+.5-grid/2)/(grid/2),v=(iz+.5-grid/2)/(grid/2);
      const jag=.10*Math.sin(ix*2.5+iz*.7)+.08*Math.cos(iz*3.1-ix*.9);
      const x=cx+(ix+.5-grid/2)*dx,z=cz+(iz+.5-grid/2)*dz;
      if(u*u+v*v>=.87+jag||evaluateGeography(x,z).y<=1.0)continue;
      const sides=((ix+iz)%2===0)?8:10;
      const shade=.97+.025*Math.sin(ix*4.7+iz*2.2);
      const topColor=white.clone().multiplyScalar(shade);
      const wallColor=white.clone().multiplyScalar(.79);
      const center=vertex(x,evaluateGeography(x,z).y+.11,z,topColor);
      const rim=[];
      const phase=.12*Math.sin(ix*3+iz*7);
      for(let j=0;j<sides;j++){
        const a=j*Math.PI*2/sides+phase;
        const jitter=.94+.09*Math.sin(j*2.8+ix*5.1+iz*3.2);
        const px=x+Math.cos(a)*dx*.76*jitter;
        const pz=z+Math.sin(a)*dz*.76*jitter;
        rim.push(vertex(px,evaluateGeography(px,pz).y+.095,pz,topColor));
      }
      for(let j=0;j<sides;j++){
        const next=(j+1)%sides;
        indices.push(center,rim[j],rim[next]);
        const a=rim[j]*3,b=rim[next]*3;
        const lowA=vertex(positions[a],positions[a+1]-.13,positions[a+2],wallColor);
        const lowB=vertex(positions[b],positions[b+1]-.13,positions[b+2],wallColor);
        indices.push(rim[j],lowA,lowB,rim[j],lowB,rim[next]);
      }
    }
    const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geo.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));geo.setIndex(indices);geo.computeVertexNormals();
    return new THREE.Mesh(geo,new THREE.MeshStandardMaterial({vertexColors:true,flatShading:true,roughness:1,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2}));
  }
  layerObjects.forEach((layer,k)=>{
    const group=new THREE.Group();layer.group.add(group);
    const metal=new THREE.MeshStandardMaterial({color:k===3?0x424b51:k===2?0xe2e2e2:k===1?0xff7900:0x42bbff,roughness:.62,metalness:.6});
    for(const [x,z] of barrierPositions){
      const cross=new THREE.Group();group.add(cross);cross.position.set(x,evaluateGeography(x,z).y+.5,z);cross.scale.setScalar(2.1);
      for(const a of [-Math.PI/4,Math.PI/4]){const beam=new THREE.Mesh(new THREE.BoxGeometry(.17,1.05,.20),metal);beam.rotation.z=a;cross.add(beam);}
      const spine=new THREE.Mesh(new THREE.BoxGeometry(1.05,.16,.18),metal);spine.rotation.y=.4;cross.add(spine);
    }
    // Organic mud basin: triangulated undulating edge, subtle concave surface and wet sediment rings.
    const mx=1.8,mz=3.3;
    const mudVertices=[],mudColors=[],mudIndices=[],segments=56,bands=12;
    const mudBase=new THREE.Color(k===3?0x332719:k===2?0x57524e:k===1?0xa35229:0x134f7c);
    const mudEdge=new THREE.Color(k===3?0x56412b:k===2?0x85817b:k===1?0xca7642:0x27729a);
    for(let r=0;r<=bands;r++)for(let j=0;j<=segments;j++){
      const theta=j/segments*Math.PI*2,rr=r/bands;
      const wobble=1+.11*Math.sin(theta*5+.3)+.08*Math.cos(theta*9-1.3)+.045*Math.sin(theta*17);
      const x=mx+Math.cos(theta)*1.73*rr*wobble,z=mz+Math.sin(theta)*1.30*rr*wobble;
      const depth=.10*(1-rr*rr);
      mudVertices.push(x,evaluateGeography(x,z).y+.095-depth,z);
      const color=mudBase.clone().lerp(mudEdge,Math.max(0,(rr-.52)/.48));
      color.multiplyScalar(1+.06*Math.sin(theta*13+rr*27));mudColors.push(color.r,color.g,color.b);
      if(r<bands&&j<segments){const q=r*(segments+1)+j;mudIndices.push(q,q+segments+1,q+1,q+1,q+segments+1,q+segments+2);}
    }
    const mudGeo=new THREE.BufferGeometry();mudGeo.setAttribute('position',new THREE.Float32BufferAttribute(mudVertices,3));mudGeo.setAttribute('color',new THREE.Float32BufferAttribute(mudColors,3));mudGeo.setIndex(mudIndices);mudGeo.computeVertexNormals();
    const mud=new THREE.Mesh(mudGeo,new THREE.MeshStandardMaterial({vertexColors:true,roughness:.27,metalness:.08,side:THREE.DoubleSide,depthWrite:true}));group.add(mud);
    // Fine irregular sediment pools give scale and avoid the previous solid circular disc.
    for(let n=0;n<8;n++){
      const a=n*2.399,rr=.26+.12*(n%4),x=mx+Math.cos(a)*rr,z=mz+Math.sin(a)*rr;
      const puddle=new THREE.Mesh(new THREE.CircleGeometry(.13+.055*(n%3),12),new THREE.MeshBasicMaterial({color:k===3?0x1b1b16:k===2?0x363636:k===1?0x8c4e26:0x0c3b5d,transparent:true,opacity:.45,depthWrite:false}));
      puddle.rotation.x=-Math.PI/2;puddle.position.set(x,evaluateGeography(x,z).y+.107,z);group.add(puddle);
    }
    // Summit snow has a broad, visibly contiguous cover; terrain itself unchanged.
    const snow=drapedPatch(summit[0],summit[1],2.55,2.20,k);
    group.add(snow);
    for(let n=0;n<11;n++){
      const a=n*2.399,rr=.5+(n%4)*.43,x=summit[0]+Math.cos(a)*rr,z=summit[1]+Math.sin(a)*rr*.8;
      const rock=new THREE.Mesh(new THREE.DodecahedronGeometry(.13+.06*(n%3),0),new THREE.MeshStandardMaterial({color:k===3?0x716d67:k===2?0xcccccc:k===1?0xff9a53:0x51a6bd,flatShading:true,roughness:1}));
      rock.position.set(x,evaluateGeography(x,z).y+.18,z);rock.scale.y=.52;group.add(rock);
    }
    // Shared patterned decal textures; every mark is reused from a bounded pool.
    const decals=[];
    const tireGeo=new THREE.PlaneGeometry(.18,.22);tireGeo.rotateX(-Math.PI/2);
    const bootGeo=new THREE.PlaneGeometry(.115,.215);bootGeo.rotateX(-Math.PI/2);
    const treadTexture=makeGroundPrintTexture(false),bootTexture=makeGroundPrintTexture(true);
    const matColor=k===3?0x704329:k===2?0x74716b:k===1?0x824128:0x185578;
    for(let n=0;n<208;n++){
      const isBoot=n>=128;
      const mat=new THREE.MeshBasicMaterial({map:isBoot?bootTexture:treadTexture,color:matColor,transparent:true,opacity:0,depthWrite:false,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-5,polygonOffsetUnits:-5});
      const mark=new THREE.Mesh(isBoot?bootGeo:tireGeo,mat);
      mark.visible=false;mark.renderOrder=12;group.add(mark);decals.push({mark,age:10,boot:isBoot});
    }
    environmentalDetails.push({decals,k,headTire:0,headBoot:128});
  });
}
// Tess Space field crew: distinct low-poly silhouettes, articulated gait, and remote.
let easterEgg={active:false,age:0,groups:[],savedPause:false,anchor:null,entry:null};
function createServiceTechnician(parent,k,i){
  const p=new THREE.Group();parent.add(p);
  const shirt=new THREE.MeshStandardMaterial({color:k===3?0x111417:k===2?0x45484a:k===1?0x452c24:0x173c48,roughness:.92});
  const pants=new THREE.MeshStandardMaterial({color:k===3?[0x33465b,0x252d38,0x41454a][i]:0x4b535c,roughness:.96});
  const skin=new THREE.MeshStandardMaterial({color:[0xe5b89b,0xb48767,0xe1b59a][i],roughness:1});
  const hair=new THREE.MeshStandardMaterial({color:[0xe0bd5c,0x3b2921,0x241e1a][i],roughness:1});
  const white=new THREE.MeshStandardMaterial({color:0xf1f2f0,roughness:.82});
  const dark=new THREE.MeshStandardMaterial({color:0x101215,roughness:.8});
  const orange=new THREE.MeshStandardMaterial({color:0xff7900,roughness:.8,side:THREE.DoubleSide});
  const add=(root,geo,mat,x=0,y=0,z=0)=>{const m=new THREE.Mesh(geo,mat);m.position.set(x,y,z);root.add(m);return m;};
  add(p,new THREE.BoxGeometry(.35,.43,.22),shirt,0,.68,0);
  add(p,new THREE.BoxGeometry(.30,.23,.19),pants,0,.36,0);
  add(p,new THREE.BoxGeometry(.15,.12,.14),skin,0,.96,0);
  add(p,new THREE.BoxGeometry(.235,.24,.22),skin,0,1.12,0);
  // Rear (-Z) tessellation emblem: orange hexagon and a small stylized T.
  const emblem=add(p,new THREE.RingGeometry(.072,.094,6),orange,0,.76,-.116);
  emblem.rotation.z=Math.PI/6;
  add(p,new THREE.BoxGeometry(.105,.022,.009),orange,0,.775,-.125);
  add(p,new THREE.BoxGeometry(.022,.095,.009),orange,0,.742,-.125);
  // Small front left chest insignia, not the large logo.
  add(p,new THREE.BoxGeometry(.055,.045,.007),orange,-.095,.78,.115);
  // Hair and caps: blonde long hair + cap, bearded + cap, short hair without cap.
  add(p,new THREE.BoxGeometry(.245,.065,.235),hair,0,1.26,0);
  if(i===0){
    add(p,new THREE.BoxGeometry(.052,.34,.12),hair,-.135,1.06,-.035);
    add(p,new THREE.BoxGeometry(.052,.34,.12),hair,.135,1.06,-.035);
  }
  if(i===1){
    add(p,new THREE.BoxGeometry(.23,.09,.075),hair,0,1.045,.115);
    add(p,new THREE.BoxGeometry(.075,.065,.055),hair,-.088,1.095,.122);
    add(p,new THREE.BoxGeometry(.075,.065,.055),hair,.088,1.095,.122);
  }
  if(i!==2){
    add(p,new THREE.BoxGeometry(.265,.08,.26),dark,0,1.30,0);
    add(p,new THREE.BoxGeometry(.24,.024,.135),dark,0,1.275,.16);
  }
  for(const side of [-1,1])add(p,new THREE.BoxGeometry(.027,.025,.01),dark,side*.058,1.145,.117);
  const legs=[],arms=[];
  for(const side of [-1,1]){
    const leg=new THREE.Group();leg.position.set(side*.09,.27,0);p.add(leg);
    add(leg,new THREE.BoxGeometry(.13,.31,.15),pants,0,-.15,0);
    add(leg,new THREE.BoxGeometry(.155,.085,.24),white,0,-.32,.055);
    legs.push(leg);
    const arm=new THREE.Group();arm.position.set(side*.245,.84,0);p.add(arm);
    add(arm,new THREE.BoxGeometry(.13,.23,.15),shirt,0,-.12,0);
    add(arm,new THREE.BoxGeometry(.105,.20,.12),skin,0,-.32,.01);
    add(arm,new THREE.BoxGeometry(.11,.095,.12),skin,0,-.44,.02);
    arms.push(arm);
  }
  if(i===0){
    const remote=add(p,new THREE.BoxGeometry(.22,.095,.15),dark,0,.65,.26);
    add(remote,new THREE.BoxGeometry(.11,.008,.07),orange,0,.05,0);
    add(remote,new THREE.CylinderGeometry(.009,.009,.12,6),dark,-.06,.10,0);
  }else if(i===1){
    add(p,new THREE.BoxGeometry(.19,.26,.035),dark,.25,.49,.15);
    add(p,new THREE.BoxGeometry(.14,.16,.009),orange,.25,.49,.17);
  }else{
    add(p,new THREE.BoxGeometry(.18,.15,.13),orange,.24,.40,.12);
    add(p,new THREE.BoxGeometry(.13,.027,.06),dark,.24,.49,.12);
  }
  p.userData={legs,arms,index:i};return p;
}
function triggerServiceEasterEgg(){
  if(easterEgg.active||missionState.active||satelliteEvent.active){showToastMessage('SERVICE CREW AVAILABLE BETWEEN MISSIONS',1800);return;}
  const e=easterEgg;e.active=true;e.age=0;e.groups=[];e.savedPause=ugvState.paused;ugvState.paused=true;
  e.anchor={x:ugvState.x,z:ugvState.z};
  // Enter from a clear shared corner of the terrain, not from the trees around the UGV.
  const ax=e.anchor.x,az=e.anchor.z;
  e.entry={x:Math.max(-8.5,Math.min(8.5,ax-4.0)),z:Math.max(-8.5,Math.min(8.5,az+3.5))};
  for(let k=0;k<4;k++){
    const team=new THREE.Group();layerObjects[k].group.add(team);
    for(let i=0;i<3;i++)createServiceTechnician(team,k,i);
    e.groups.push(team);
  }
  showToastMessage('TESS SPACE · FIELD SERVICE / REMOTE CHECK',2400);
}
document.addEventListener('keydown',ev=>{if(ev.key.toLowerCase()==='t'&&!ev.repeat&&!['INPUT','TEXTAREA'].includes(document.activeElement?.tagName))triggerServiceEasterEgg();});
const footprintState={lastUgv:null,lastSoldiers:[null,null,null],tireAccum:0,soldierAccum:[0,0,0],tireUntil:0,soldierUntil:[0,0,0],clock:0,step:[0,0,0]};
const inMud=(x,z)=>Math.hypot((x-1.8)/1.73,(z-3.3)/1.30)<.94;
function addImprint(x,z,yaw,isBoot){
  for(const details of environmentalDetails){
    const {decals,k}=details;
    const min=isBoot?176:0,max=isBoot?272:176;
    const head=isBoot?'headBoot':'headTire';
    const idx=details[head];details[head]=idx+1>=max?min:idx+1;
    const d=decals[idx];d.age=0;d.mark.visible=true;
    // On the dry ground outside the puddle, use the same temporary brown transfer.
    d.mark.position.set(x,evaluateGeography(x,z).y+(inMud(x,z)?.132:.145),z);
    d.mark.rotation.set(0,yaw,0);
    d.mark.material.opacity=k===3?.83:k===2?.47:.57;
    d.mark.scale.set(isBoot?1:1.04,1,1);
  }
}
function updateWorldExtras(dt){
  const e=easterEgg;
  if(e.active){
    e.age+=dt;const t=e.age;
    const arrive=Math.min(1,Math.max(0,(t-.2)/3.4));
    const leave=Math.min(1,Math.max(0,(t-8.1)/3.3));
    const easeV=v=>v*v*(3-2*v);
    const a=easeV(arrive),b=easeV(leave);
    const anchor=e.anchor,entry=e.entry;
    e.groups.forEach((team,k)=>team.children.forEach((p,i)=>{
      const tx=anchor.x+(i-1)*.68+.25,tz=anchor.z+1.02+(i===1?.25:0);
      const ex=entry.x+(i-1)*.42,ez=entry.z+i*.28;
      const x=ex+(tx-ex)*a+(ex-tx)*b,z=ez+(tz-ez)*a+(ez-tz)*b;
      const walking=arrive<1||leave>0;
      p.position.set(x,evaluateGeography(x,z).y, z);
      p.rotation.y=Math.atan2(walking?(tx-ex)*(leave>0?-1:1):anchor.x-x,walking?(tz-ez)*(leave>0?-1:1):anchor.z-z);
      const swing=walking?Math.sin(t*11+i*1.8)*.57:0;
      p.userData.legs[0].rotation.x=swing;p.userData.legs[1].rotation.x=-swing;
      p.userData.legs.forEach((leg,j)=>{leg.rotation.z=walking?Math.max(0,(-1+j*2)*swing)*.12:0;});
      p.userData.arms[0].rotation.x=-swing*.75+(i===0?-.42:0);
      p.userData.arms[1].rotation.x=swing*.75+(i===0?-.42:0);
      p.userData.arms.forEach((arm,j)=>{arm.rotation.z=walking?0:.14*Math.sin(t*6+j+i);});
    }));
    // Brief focus, without changing the established UGV navigation or camera mode.
    if(t<3.5&&activeStageFocus===3){
      const target=new THREE.Vector3(anchor.x,layerObjects[3].group.position.y+evaluateGeography(anchor.x,anchor.z).y+.7,anchor.z+.5);
      controls.target.lerp(target,Math.min(1,dt*1.6));
    }
    if(t>11.6){e.groups.forEach(g=>g.parent?.remove(g));e.active=false;ugvState.paused=e.savedPause;}
  }
  // Five-second persistence, even after the vehicle leaves the puddle.
  environmentalDetails.forEach(({decals,k})=>decals.forEach(d=>{
    if(!d.mark.visible)return;
    d.age+=dt;
    const fade=Math.max(0,1-d.age/5.0);
    d.mark.material.opacity=fade*(k===3?.84:k===2?.52:.67);
    if(fade<=0)d.mark.visible=false;
  }));
}
function updateMudImprints(dt){
  const f=footprintState;f.clock+=dt;
  const p={x:ugvState.x,z:ugvState.z};
  if(inMud(p.x,p.z))f.tireUntil=f.clock+5;
  if(f.lastUgv){
    const dx=p.x-f.lastUgv.x,dz=p.z-f.lastUgv.z,dist=Math.hypot(dx,dz);
    if(dist>.008&&dist<1.2){
      const yaw=Math.atan2(dx,dz),sideX=Math.cos(yaw),sideZ=-Math.sin(yaw);
      const active=f.clock<f.tireUntil;
      if(active){
        // Stamp at regular travel distances, including when a frame covers multiple steps.
        const spacing=.115;let covered=spacing-f.tireAccum;
        while(covered<=dist){
          const r=covered/dist;
          const x=f.lastUgv.x+dx*r,z=f.lastUgv.z+dz*r;
          for(const side of [-1,1])addImprint(x+side*.25*sideX,z+side*.25*sideZ,yaw,false);
          covered+=spacing;
        }
        f.tireAccum=(f.tireAccum+dist)%spacing;
      }else f.tireAccum=0;
    }
  }
  f.lastUgv=p;
  const walking=missionState.active&&missionState.kind==='SQUAD';
  for(let i=0;i<3;i++){
    const soldier=missionState.soldiers[3]?.[i];
    if(!walking||!soldier?.visible){f.lastSoldiers[i]=null;continue;}
    const x=soldier.position.x,z=soldier.position.z,last=f.lastSoldiers[i];
    if(inMud(x,z))f.soldierUntil[i]=f.clock+5;
    if(last){
      const dx=x-last.x,dz=z-last.z,dist=Math.hypot(dx,dz);
      if(dist>.006&&dist<.8&&f.clock<f.soldierUntil[i]){
        const yaw=Math.atan2(dx,dz),spacing=.23;
        let covered=spacing-f.soldierAccum[i];
        while(covered<=dist){
          const r=covered/dist,side=f.step[i]++%2?-.075:.075;
          addImprint(last.x+dx*r+Math.cos(yaw)*side,last.z+dz*r-Math.sin(yaw)*side,yaw,true);
          covered+=spacing;
        }
        f.soldierAccum[i]=(f.soldierAccum[i]+dist)%spacing;
      }else if(f.clock>=f.soldierUntil[i])f.soldierAccum[i]=0;
    }
    f.lastSoldiers[i]={x,z};
  }
}

// Exposed to browser-side diagnostics, never affects mission logic.
window.__TESS_DIAGNOSTICS=()=>({
  layers:layerObjects.length,
  trees:currentMasterData?.placements?.allTreesFlat?.length??0,
  worldDetails:environmentalDetails.length,
  obstacles:freeNav.obstacles.length,
  satelliteActive:satelliteEvent.active,
  missionActive:missionState.active,
  easterEggActive:easterEgg.active,
  snapshotShowing:!!document.getElementById('mission-snapshot')?.classList.contains('visible')
});
// Initialize Scene & Disarm Boot Watchdog
buildCompleteFourStageScene('high');
initializeLidarRigs();
window.__TESS_BOOTED = true;
const loadingEl = document.getElementById('loading-overlay');
if (loadingEl) {
  loadingEl.style.opacity = '0';
  setTimeout(() => { loadingEl.style.display = 'none'; }, 350);
}

// Visual-only proximity perception. Uses the original deterministic placements,
// does not change obstacle avoidance, terrain, tree matrices or UGV geometry.
let perceptionLastUpdate = 0;
const perceptionWhite = new THREE.Color(0xffffff);
const perceptionOrange = new THREE.Color(0xFF7900);
const senseIdle = new THREE.Color(0x00d8ff);
const senseDetected = new THREE.Color(0x6e258c);
function updateProximityPerception(now) {
  if (!currentMasterData || now - perceptionLastUpdate < 110) return;
  perceptionLastUpdate = now;
  const layer = layerObjects[1];
  if (!layer) return;
  const senseLayer=layerObjects[0];
  if(senseLayer) for(let v=0;v<senseLayer.treeInsts.length;v++){
    const inst=senseLayer.treeInsts[v];
    currentMasterData.placements.treeCohorts[v].forEach((tree,i)=>{
      const d=Math.hypot(tree.x-ugvState.x,tree.z-ugvState.z);
      const strength=Math.max(0,Math.min(1,(2.5-d)/1.15));
      inst.setColorAt(i,senseIdle.clone().lerp(senseDetected,strength));
    });
    if(inst.instanceColor)inst.instanceColor.needsUpdate=true;
  }
  for (const [insts, cohorts, radius] of [
    [layer.treeInsts, currentMasterData.placements.treeCohorts, 2.1],
    [layer.rockInsts, currentMasterData.placements.rockCohorts, 1.65]
  ]) {
    for (let v = 0; v < insts.length; v++) {
      const inst = insts[v];
      const positions = cohorts[v];
      for (let i = 0; i < positions.length; i++) {
        const t = positions[i];
        const d = Math.hypot(t.x - ugvState.x, t.z - ugvState.z);
        const strength = Math.max(0, Math.min(1, (radius - d) / 0.75));
        inst.setColorAt(i, perceptionOrange.clone().lerp(perceptionWhite, strength));
      }
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    }
  }
}


// Capture an actual scene frame from a low forward-looking camera near the UGV.
// Separate low-resolution renderer keeps the main camera, layers and composer untouched.
let snapshotRenderer=null;
const snapshotCamera=new THREE.PerspectiveCamera(39, 16/9, .08, 80);
function renderMissionSnapshot(){
  if(!missionState.snapshotPending)return;
  missionState.snapshotPending=false;
  const originalVisibility=layerObjects.map(l=>l.group.visible);
  try{
    if(!snapshotRenderer){
      snapshotRenderer=new THREE.WebGLRenderer({antialias:false,alpha:false,preserveDrawingBuffer:true});
      snapshotRenderer.setSize(640,360,false);snapshotRenderer.setPixelRatio(1);
    }
    const target=artilleryLocation();
    const ugvX=missionState.x,ugvZ=missionState.z;
    // Capture from the SAME UGV position and direction on both stage layers.
    // Camera is a little offset to give the target a recognizable side profile.
    const look=new THREE.Vector3(target.x,target.z,0);
    const dx=target.x-ugvX,dz=target.z-ugvZ;
    const length=Math.max(.01,Math.hypot(dx,dz));
    const sideX=-dz/length,sideZ=dx/length;
    const outputs=[{stage:3,id:'mission-snapshot-control'},{stage:0,id:'mission-snapshot-sense'}];
    for(const out of outputs){
      const layer=layerObjects[out.stage];
      const x=ugvX+sideX*.36,z=ugvZ+sideZ*.36;
      snapshotCamera.position.set(x,layer.group.position.y+evaluateGeography(x,z).y+1.03,z);
      snapshotCamera.lookAt(target.x,layer.group.position.y+evaluateGeography(target.x,target.z).y+.69,target.z);
      layerObjects.forEach((l,i)=>l.group.visible=i===out.stage);
      snapshotRenderer.render(scene,snapshotCamera);
      const el=document.getElementById(out.id);
      if(el)el.src=snapshotRenderer.domElement.toDataURL('image/jpeg',.78);
    }
  }catch(e){console.warn('Dual ISR snapshot unavailable',e);}
  finally{layerObjects.forEach((l,i)=>l.group.visible=originalVisibility[i]);}
}
document.getElementById('mission-squad').addEventListener('click',e=>{e.stopPropagation();startMission('SQUAD');});
document.getElementById('mission-drone').addEventListener('click',e=>{e.stopPropagation();startMission('DRONE');});
document.getElementById('mission-gnss').addEventListener('click',e=>{e.stopPropagation();beginGNSSScenario();});
function updateIsrConnectors(){
  const frame=document.getElementById('mission-snapshot'),svg=document.getElementById('isr-connectors');
  if(!frame||!svg)return;
  const visible=frame.classList.contains('visible');svg.style.display=visible?'block':'none';
  if(!visible)return;
  const stage=activeStageFocus>=0?activeStageFocus:3;
  const world=new THREE.Vector3(ugvState.x,ugvState.y+.55+layerObjects[stage].group.position.y,ugvState.z).project(camera);
  const x=(world.x*.5+.5)*window.innerWidth,y=(-world.y*.5+.5)*window.innerHeight;
  const r=frame.getBoundingClientRect();
  [[r.left,r.top],[r.right,r.top],[r.left,r.bottom],[r.right,r.bottom]].forEach(([a,b],i)=>{
    const line=svg.children[i];if(!line)return;
    line.setAttribute('x1',x);line.setAttribute('y1',y);line.setAttribute('x2',a);line.setAttribute('y2',b);
  });
}
let lastTime = performance.now();
function animate(now) {
  requestAnimationFrame(animate);
  if (document.hidden) {
    lastTime = now;
    return;
  }
  const dt = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;
  updateDiscovery(dt);
  updateMissionClock(dt);
  updateSatelliteEvent(dt,now);
  updateWorldExtras(dt);
  syncUGVAcrossAllLayers(dt);
  updateProximityPerception(now);
  updateMissionVisuals(now);
  updateMudImprints(dt);
  updateLidarRigs(now);
  updateCinematicCamera(dt);
  renderMissionSnapshot();
  controls.update();
  composer.render();
  updateHUDPositions();
  updateIsrConnectors();
}
requestAnimationFrame(animate);
/* === EOF app.js === */
