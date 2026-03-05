import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createNoise3D } from 'simplex-noise';
import { generateGraph, NodeType } from './graph';
import type { GraphData, GraphNode } from './graph';

// --- Configuration ---
const CONFIG = {
  backgroundColor: 0x070b19, // Dark sleek navy/black
  edgeOpacity: 0.4,
  edgeColor: 0x4488ff, // Bright glowing blue
  dustCount: 40000,
  dustOpacity: 0.4,
  dustColor: 0x7777ff, // Muted grey dust
  driftSpeed: 0.0002,
  driftAmplitude: 2.0,
  dustSwirlSpeed: 0.0005,
  edgeSegments: 10,   // For curved strings
  edgeHangAmount: 0.15, // How much the string hangs down
  springStiffness: 0.05, // How strongly strings pull on nodes
  damping: 0.85, // Friction to prevent chaotic bouncing
  baseReturnStrength: 0.08, // Pulls towards their noise-disordered home
  pulseSpeed: 0.002,
  pulseAmplitude: 0.4
};

// --- Global State ---
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let controls: OrbitControls;
let graphData: GraphData;

let nodeMesh: THREE.InstancedMesh;
let edgesLine: THREE.LineSegments;
let dustPoints: THREE.Points;

// Per-dust-particle data for hub-anchored positioning
let dustHubIndices: Int32Array; // Index into graphData.nodes for each dust particle's parent hub (-1 = free)
let dustLocalOffsets: Float32Array; // x,y,z local offset from hub for each particle

const noise3D = createNoise3D();
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

let hoveredNodeId: number | null = null;
let selectedNodeId: number | null = null;
const tooltipEl = document.getElementById('tooltip') as HTMLDivElement;
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const searchResultsEl = document.getElementById('search-results') as HTMLUListElement;

const sourcesBtn = document.getElementById('sources-btn') as HTMLButtonElement;
const sourcesPanel = document.getElementById('sources-panel') as HTMLDivElement;
const sourcesList = document.getElementById('sources-list') as HTMLUListElement;
const labelsContainer = document.getElementById('labels-container') as HTMLDivElement;
const focusExitBtn = document.getElementById('focus-exit-btn') as HTMLButtonElement;

let searchTerm: string = '';

// UI state
let isSourcesPanelOpen = false;

let audioListener: THREE.AudioListener;
let targetMasterVolume = 0.3; // matches new default
let unmutedVolume = 0.3; // Store volume before muting
let currentMasterVolume = 0.0;
let isAudioActive = false;
let isMuted = false;
const activeAudioElements: HTMLAudioElement[] = [];

let focusedNodeId: number | null = null;
const nodeLabels: Map<number, HTMLDivElement> = new Map();

// Audio fade targets for smooth transitions
const audioFadeTargets: Map<string, number> = new Map();

// Fly-to Animation State
let isFlying = false;
let targetCameraPos = new THREE.Vector3();
let targetControlsCenter = new THREE.Vector3();

const dummy = new THREE.Object3D();
const color = new THREE.Color();

init();
animate(0);

function init() {
  const canvas = document.getElementById('glcanvas') as HTMLCanvasElement;

  // Scene setup
  scene = new THREE.Scene();
  scene.background = new THREE.Color(CONFIG.backgroundColor);

  // Camera - start outside the bounding sphere
  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, 10000);
  camera.position.set(300, 400, 900);

  // Audio Setup
  audioListener = new THREE.AudioListener();
  camera.add(audioListener);

  // Renderer
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.5;

  // Enable keyboard panning/orbiting
  controls.listenToKeyEvents(window);
  // Optional: Set keys for panning instead of orbiting, if desired.
  // By default, arrow keys orbit. We can allow the user to easily move around.
  controls.keyPanSpeed = 14.0;

  // Generate Data
  graphData = generateGraph();

  createBounds();
  createNodes();
  createEdges();
  createDust();

  // Events
  window.addEventListener('resize', onWindowResize);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('dblclick', onDoubleClick);

  // Search
  searchInput.addEventListener('input', (e) => {
    searchTerm = (e.target as HTMLInputElement).value.trim().toLowerCase();
    updateSearchResults();
  });

  // Hide search results if clicked outside
  document.addEventListener('click', (e) => {
    if (!searchInput.contains(e.target as Node) && !searchResultsEl.contains(e.target as Node)) {
      searchResultsEl.classList.add('hidden');
    }
  });

  searchInput.addEventListener('focus', () => {
    if (searchTerm.length > 0) {
      updateSearchResults();
    }
  });

  // Sources Panel
  sourcesBtn.addEventListener('click', () => {
    isSourcesPanelOpen = !isSourcesPanelOpen;
    if (isSourcesPanelOpen) {
      sourcesPanel.classList.remove('hidden');
    } else {
      sourcesPanel.classList.add('hidden');
    }
  });

  // Escape key for Focus Mode
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && focusedNodeId !== null) {
      exitFocusMode();
    }
  });

  // Interrupt flying on manual user interaction
  renderer.domElement.addEventListener('pointerdown', () => { isFlying = false; });
  renderer.domElement.addEventListener('wheel', () => { isFlying = false; });

  // Focus Exit Button
  focusExitBtn.addEventListener('click', () => {
    exitFocusMode();
  });

  // Landing Page Enter Button
  const enterBtn = document.getElementById('enter-btn');
  const landingPage = document.getElementById('landing-page');
  const appContainer = document.getElementById('app');

  const volumeSlider = document.getElementById('volume-slider') as HTMLInputElement;
  const muteBtn = document.getElementById('mute-btn') as HTMLButtonElement;

  if (volumeSlider && muteBtn) {
    targetMasterVolume = parseFloat(volumeSlider.value);
    unmutedVolume = targetMasterVolume;

    volumeSlider.addEventListener('input', (e) => {
      const val = parseFloat((e.target as HTMLInputElement).value);
      if (isMuted && val > 0) {
        // Unmute if slider is moved
        isMuted = false;
        muteBtn.innerText = 'MUTE';
        muteBtn.classList.remove('muted');
      }
      targetMasterVolume = val;
      unmutedVolume = val;
    });

    muteBtn.addEventListener('click', () => {
      isMuted = !isMuted;
      if (isMuted) {
        // Mute
        targetMasterVolume = 0;
        volumeSlider.value = '0';
        muteBtn.innerText = 'UNMUTE';
        muteBtn.classList.add('muted');
      } else {
        // Unmute
        targetMasterVolume = unmutedVolume > 0 ? unmutedVolume : 0.3;
        volumeSlider.value = targetMasterVolume.toString();
        muteBtn.innerText = 'MUTE';
        muteBtn.classList.remove('muted');
      }
    });
  }

  if (enterBtn && landingPage && appContainer) {
    const tutorialOverlay = document.getElementById('tutorial-overlay');

    enterBtn.addEventListener('click', () => {
      // Browser requires user interaction to resume audio context
      if (audioListener.context.state === 'suspended') {
        audioListener.context.resume();
      }
      isAudioActive = true;

      // Start the live streams globally
      activeAudioElements.forEach(el => {
        el.play().catch(e => console.warn('Audio play error:', e));
      });

      // 1. Hide landing page
      landingPage.classList.add('hidden');

      // 2. Show tutorial overlay
      if (tutorialOverlay) {
        tutorialOverlay.classList.remove('hidden');

        // 3. After 3.5 seconds, fade out tutorial and show the 3D world
        setTimeout(() => {
          tutorialOverlay.classList.add('fade-out');
          appContainer.classList.remove('hidden');

          // 4. Remove tutorial from DOM after fade completes
          setTimeout(() => {
            tutorialOverlay.style.display = 'none';
          }, 1500);
        }, 3500);
      } else {
        // Fallback: no tutorial element, just show app
        appContainer.classList.remove('hidden');
      }
    });
  }
}

function createNodes() {
  const geometry = new THREE.SphereGeometry(1, 16, 16);
  // Unlit material for crisp nodes
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff });

  nodeMesh = new THREE.InstancedMesh(geometry, material, graphData.nodes.length);

  for (let i = 0; i < graphData.nodes.length; i++) {
    const node = graphData.nodes[i];

    dummy.position.copy(node.position);
    dummy.scale.set(node.size, node.size, node.size);
    dummy.updateMatrix();
    nodeMesh.setMatrixAt(i, dummy.matrix);
    nodeMesh.setColorAt(i, node.color);

    // If it's a Stream Hub, attach live streaming positional audio
    if (node.type === NodeType.StreamHub) {
      setupStreamingAudio(node);

      // Create HTML label overlay
      const label = document.createElement('div');
      label.className = 'node-label';
      label.textContent = node.text;
      labelsContainer.appendChild(label);
      nodeLabels.set(node.id, label);
    }
  }

  nodeMesh.instanceMatrix.needsUpdate = true;
  if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;

  scene.add(nodeMesh);

  // Populate Sources Sidebar List
  const streamHubs = graphData.nodes.filter(n => n.type === NodeType.StreamHub);
  streamHubs.forEach(hub => {
    const li = document.createElement('li');
    li.innerText = hub.text;
    li.addEventListener('click', () => {
      flyToNode(hub.id);
      if (window.innerWidth < 768) {
        sourcesPanel.classList.add('hidden'); // auto close on mobile/small screens
        isSourcesPanelOpen = false;
      }
    });
    sourcesList.appendChild(li);
  });
}

function createBounds() {
  const geometry = new THREE.SphereGeometry(350, 32, 32);
  const material = new THREE.MeshBasicMaterial({
    color: 0x4488ff,
    wireframe: true,
    transparent: true,
    opacity: 0.05,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const sphere = new THREE.Mesh(geometry, material);
  scene.add(sphere);
}

function setupStreamingAudio(node: GraphNode) {
  // Create a standard HTML Audio element
  const audioElement = new Audio(node.streamUrl);
  audioElement.crossOrigin = 'anonymous'; // CRITICAL for Web Audio API with external streams
  audioElement.loop = true;
  audioElement.volume = 1.0;

  // Tag element with node ID for focus muting
  audioElement.dataset.nodeId = node.id.toString();

  activeAudioElements.push(audioElement);

  // Create a Three.js PositionalAudio object
  const positionalAudio = new THREE.PositionalAudio(audioListener);
  positionalAudio.setMediaElementSource(audioElement);
  positionalAudio.setRefDistance(50);
  positionalAudio.setMaxDistance(500);
  positionalAudio.setRolloffFactor(1);
  positionalAudio.setVolume(1.0); // Base volume, will be affected by master and distance

  // Create an invisible object to hold audio
  const audioObj = new THREE.Object3D();
  audioObj.position.copy(node.position);
  audioObj.add(positionalAudio);
  scene.add(audioObj);

  // Start playing (will be silent until context resumes)
  audioElement.play().catch(e => console.warn("Audio playback failed:", e));
}

function createEdges() {
  const edgeMaterial = new THREE.LineBasicMaterial({
    color: CONFIG.edgeColor,
    transparent: true,
    opacity: CONFIG.edgeOpacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending // Soft overlapping lines
  });

  const numSegments = CONFIG.edgeSegments;
  const edgePositions = new Float32Array(graphData.edges.length * numSegments * 6);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(edgePositions, 3));

  edgesLine = new THREE.LineSegments(geometry, edgeMaterial);
  scene.add(edgesLine);
}

function createDust() {
  const dustGeo = new THREE.BufferGeometry();
  const dustPositions = new Float32Array(CONFIG.dustCount * 3);

  // Store hub associations for each dust particle
  dustHubIndices = new Int32Array(CONFIG.dustCount);
  dustLocalOffsets = new Float32Array(CONFIG.dustCount * 3);

  // Distribute dust mostly around hubs
  const hubs = graphData.nodes.filter(n => n.type === NodeType.Core || n.type === NodeType.StreamHub);

  for (let i = 0; i < CONFIG.dustCount; i++) {
    let hubIdx = -1; // -1 means free-floating
    let spread = 350; // Fill the full bounding sphere
    let originX = 0, originY = 0, originZ = 0;

    if (Math.random() > 0.5 && hubs.length > 0) {
      const hub = hubs[Math.floor(Math.random() * hubs.length)];
      hubIdx = hub.id;
      originX = hub.position.x;
      originY = hub.position.y;
      originZ = hub.position.z;
      spread = 80;
    }

    // Random point in sphere (local offset)
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = Math.cbrt(Math.random()) * spread;

    const ox = r * Math.sin(phi) * Math.cos(theta);
    const oy = r * Math.sin(phi) * Math.sin(theta);
    const oz = r * Math.cos(phi);

    // Store hub index and local offset for per-frame tracking
    dustHubIndices[i] = hubIdx;
    dustLocalOffsets[i * 3] = ox;
    dustLocalOffsets[i * 3 + 1] = oy;
    dustLocalOffsets[i * 3 + 2] = oz;

    // Initial position = hub origin + offset
    const pIdx = i * 3;
    dustPositions[pIdx] = originX + ox;
    dustPositions[pIdx + 1] = originY + oy;
    dustPositions[pIdx + 2] = originZ + oz;
  }

  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));

  // Use circular points for dust
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext('2d')!;
  ctx.beginPath();
  ctx.arc(8, 8, 8, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);

  const dustMat = new THREE.PointsMaterial({
    size: 1.5,
    color: CONFIG.dustColor,
    map: texture,
    transparent: true,
    opacity: CONFIG.dustOpacity,
    alphaTest: 0.1,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });

  dustPoints = new THREE.Points(dustGeo, dustMat);
  scene.add(dustPoints);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function onPointerMove(event: PointerEvent) {
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  // Tooltip positioning
  if (hoveredNodeId !== null) {
    tooltipEl.style.transform = `translate(${event.clientX + 15}px, ${event.clientY + 15}px)`;
  }
}

function updatePhysics(time: number) {
  let needsEdgeUpdate = false;

  // Update node positions with drift
  for (let i = 0; i < graphData.nodes.length; i++) {
    const node = graphData.nodes[i];
    if (node.type === NodeType.Core) continue; // Keep central steady

    // Simplex noise based drift offset target
    const nx = noise3D(node.basePosition.x * 0.01, node.basePosition.y * 0.01, time * CONFIG.driftSpeed);
    const ny = noise3D(node.basePosition.y * 0.01, node.basePosition.z * 0.01, time * CONFIG.driftSpeed + 100);
    const nz = noise3D(node.basePosition.z * 0.01, node.basePosition.x * 0.01, time * CONFIG.driftSpeed + 200);

    const targetX = node.basePosition.x + nx * CONFIG.driftAmplitude * 2.5; // Amplify slightly for visibility
    const targetY = node.basePosition.y + ny * CONFIG.driftAmplitude * 2.5;
    const targetZ = node.basePosition.z + nz * CONFIG.driftAmplitude * 2.5;

    // 1. Soft force pulling towards the noise-displaced "home" position
    node.velocity.x += (targetX - node.position.x) * CONFIG.baseReturnStrength;
    node.velocity.y += (targetY - node.position.y) * CONFIG.baseReturnStrength;
    node.velocity.z += (targetZ - node.position.z) * CONFIG.baseReturnStrength;

    // 2. Spring force from connected strings
    for (let j = 0; j < node.connections.length; j++) {
      const otherNode = graphData.nodes[node.connections[j]];

      const dx = otherNode.position.x - node.position.x;
      const dy = otherNode.position.y - node.position.y;
      const dz = otherNode.position.z - node.position.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      const baseX = otherNode.basePosition.x - node.basePosition.x;
      const baseY = otherNode.basePosition.y - node.basePosition.y;
      const baseZ = otherNode.basePosition.z - node.basePosition.z;
      const originalDist = Math.sqrt(baseX * baseX + baseY * baseY + baseZ * baseZ);

      // Hooke's Law: pull/push based on string stretch from rest length
      if (dist > 0) {
        const stretch = dist - originalDist;
        const force = stretch * CONFIG.springStiffness;
        node.velocity.x += (dx / dist) * force;
        node.velocity.y += (dy / dist) * force;
        node.velocity.z += (dz / dist) * force;
      }
    }

    // Apply damping and apply velocity to position
    node.velocity.multiplyScalar(CONFIG.damping);
    node.position.add(node.velocity);

    // Dynamic scale pulsing
    const pulse = Math.sin(time * CONFIG.pulseSpeed + node.id) * CONFIG.pulseAmplitude;
    const dynamicSize = Math.max(0.1, node.size + pulse);

    // Update instance matrix
    dummy.position.copy(node.position);
    let scaleMultiplier = (i === hoveredNodeId) ? 1.5 : 1.0;
    dummy.scale.setScalar(dynamicSize * scaleMultiplier);
    dummy.updateMatrix();
    nodeMesh.setMatrixAt(i, dummy.matrix);

    // Update color based on hover, pulse intensity, and search
    let isMatched = true;
    if (searchTerm.length > 0) {
      if (!node.text.toLowerCase().includes(searchTerm)) {
        isMatched = false;
      }
    }

    if (!isMatched) {
      color.setHex(0x111122); // Dimmed out non-matches
    } else if (i === hoveredNodeId) {
      color.setHex(0xffffff); // Highlight bright white
    } else {
      color.copy(node.color);
      // Intensify color as it gets larger (pulse > 0)
      if (pulse > 0) {
        color.lerp(new THREE.Color(0xffffff), pulse / CONFIG.pulseAmplitude * 0.5);
      }
    }
    nodeMesh.setColorAt(i, color);

    needsEdgeUpdate = true;
  }

  nodeMesh.instanceMatrix.needsUpdate = true;
  if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;

  // Update edges geometry if nodes moved
  if (needsEdgeUpdate) {
    const positions = edgesLine.geometry.attributes.position.array as Float32Array;
    const numSegments = CONFIG.edgeSegments;

    for (let i = 0; i < graphData.edges.length; i++) {
      const edge = graphData.edges[i];
      const source = graphData.nodes[edge.source];
      const target = graphData.nodes[edge.target];

      const p0x = source.position.x, p0y = source.position.y, p0z = source.position.z;
      const p2x = target.position.x, p2y = target.position.y, p2z = target.position.z;

      // Control point for quadratic bezier that acts as gravity drop
      const dist = Math.sqrt((p2x - p0x) ** 2 + (p2y - p0y) ** 2 + (p2z - p0z) ** 2);

      // Calculate original distance (string's normal rest length)
      const b0x = source.basePosition.x, b0y = source.basePosition.y, b0z = source.basePosition.z;
      const b2x = target.basePosition.x, b2y = target.basePosition.y, b2z = target.basePosition.z;
      const restDist = Math.sqrt((b2x - b0x) ** 2 + (b2y - b0y) ** 2 + (b2z - b0z) ** 2);

      let actualHang = 0;
      if (dist < restDist) {
        // String is slack. The sag forms a curve similar to a catenary.
        // Sag approximates to half the side of a right triangle formed by hypotenuse (L) and base (D).
        actualHang = 0.5 * Math.sqrt(restDist * restDist - dist * dist);
      }

      // We can also allow a tiny bit of fundamental gravity drag if desired, 
      // but pure slack calculation is more highly realistic for taut strings.

      const p1x = (p0x + p2x) * 0.5;
      const p1y = (p0y + p2y) * 0.5 - actualHang;
      const p1z = (p0z + p2z) * 0.5;

      for (let s = 0; s < numSegments; s++) {
        const tA = s / numSegments;
        const tB = (s + 1) / numSegments;

        const mtA = 1 - tA, mtA2 = mtA * mtA, tA2 = tA * tA;
        const ax = mtA2 * p0x + 2 * mtA * tA * p1x + tA2 * p2x;
        const ay = mtA2 * p0y + 2 * mtA * tA * p1y + tA2 * p2y;
        const az = mtA2 * p0z + 2 * mtA * tA * p1z + tA2 * p2z;

        const mtB = 1 - tB, mtB2 = mtB * mtB, tB2 = tB * tB;
        const bx = mtB2 * p0x + 2 * mtB * tB * p1x + tB2 * p2x;
        const by = mtB2 * p0y + 2 * mtB * tB * p1y + tB2 * p2y;
        const bz = mtB2 * p0z + 2 * mtB * tB * p1z + tB2 * p2z;

        const idx = (i * numSegments + s) * 6;
        positions[idx] = ax;
        positions[idx + 1] = ay;
        positions[idx + 2] = az;
        positions[idx + 3] = bx;
        positions[idx + 4] = by;
        positions[idx + 5] = bz;
      }
    }
    edgesLine.geometry.attributes.position.needsUpdate = true;
  }

  // Update dust positions to track their parent hub nodes
  if (dustPoints && dustHubIndices) {
    const dustPositions = dustPoints.geometry.attributes.position.array as Float32Array;
    const freeDriftSpeed = 0.002; // Much faster than node drift
    const freeDriftAmplitude = 8.0;
    for (let i = 0; i < CONFIG.dustCount; i++) {
      const hubIdx = dustHubIndices[i];
      const pIdx = i * 3;
      if (hubIdx >= 0 && hubIdx < graphData.nodes.length) {
        // Anchored to a hub: position = hub's current position + stored local offset
        const hub = graphData.nodes[hubIdx];
        dustPositions[pIdx] = hub.position.x + dustLocalOffsets[pIdx];
        dustPositions[pIdx + 1] = hub.position.y + dustLocalOffsets[pIdx + 1];
        dustPositions[pIdx + 2] = hub.position.z + dustLocalOffsets[pIdx + 2];
      } else {
        // Free-floating: drift using simplex noise for organic movement
        const baseX = dustLocalOffsets[pIdx];
        const baseY = dustLocalOffsets[pIdx + 1];
        const baseZ = dustLocalOffsets[pIdx + 2];
        const seed = i * 0.1; // Unique per particle
        const nx = noise3D(baseX * 0.005 + seed, baseY * 0.005, time * freeDriftSpeed);
        const ny = noise3D(baseY * 0.005, baseZ * 0.005 + seed, time * freeDriftSpeed + 50);
        const nz = noise3D(baseZ * 0.005 + seed, baseX * 0.005, time * freeDriftSpeed + 100);
        let px = baseX + nx * freeDriftAmplitude;
        let py = baseY + ny * freeDriftAmplitude;
        let pz = baseZ + nz * freeDriftAmplitude;
        // Clamp within bounding sphere
        const dist = Math.sqrt(px * px + py * py + pz * pz);
        if (dist > 340) {
          const s = 340 / dist;
          px *= s; py *= s; pz *= s;
        }
        dustPositions[pIdx] = px;
        dustPositions[pIdx + 1] = py;
        dustPositions[pIdx + 2] = pz;
      }
    }
    dustPoints.geometry.attributes.position.needsUpdate = true;
  }

  // Edge breathing effect
  const edgeMat = edgesLine.material as THREE.LineBasicMaterial;
  edgeMat.opacity = CONFIG.edgeOpacity + Math.sin(time * 0.001) * 0.05;
}

function updateInteraction() {
  raycaster.setFromCamera(mouse, camera);

  const intersects = raycaster.intersectObject(nodeMesh);

  if (intersects.length > 0) {
    const instanceId = intersects[0].instanceId;
    if (instanceId !== undefined && instanceId !== hoveredNodeId) {
      hoveredNodeId = instanceId;
      const node = graphData.nodes[hoveredNodeId];

      document.body.style.cursor = 'pointer';

      // Update tooltip
      tooltipEl.classList.remove('hidden');
      const typeStr = node.type === NodeType.Core ? 'Core Hub' :
        (node.type === NodeType.StreamHub ? 'Stream Hub' : 'Article');
      tooltipEl.innerHTML = `<strong>${typeStr}</strong><br/>ID: ${node.id}<br/>Connections: ${node.connections.length}`;
    }
  } else {
    if (hoveredNodeId !== null) {
      hoveredNodeId = null;
      document.body.style.cursor = 'default';
      tooltipEl.classList.add('hidden');
    }
  }
}

function updateProximityLabels() {
  const v = new THREE.Vector3();
  const halfW = window.innerWidth / 2;
  const halfH = window.innerHeight / 2;

  nodeLabels.forEach((labelEl, id) => {
    const node = graphData.nodes[id];

    // Calculate distance from camera to node
    const distanceSq = camera.position.distanceToSquared(node.position);

    // Fade in text label between distances 120 and 600 (squared: 14400 and 360000)
    if (distanceSq < 360000) {
      // Map screen coordinates
      v.copy(node.position);
      v.project(camera);

      // Only show if in front of camera
      if (v.z < 1) {
        const screenX = (v.x * halfW) + halfW;
        const screenY = -(v.y * halfH) + halfH;

        labelEl.style.transform = `translate(-50%, -100%) translate(${screenX}px, ${screenY - 20}px)`;

        // Calculate opacity based on squared distance for smoother fade
        // Max opacity at distanceSq < 14400 (distance < 120)
        // 0 opacity at distanceSq > 360000 (distance > 600)
        let opacity = 1.0 - ((distanceSq - 14400) / (360000 - 14400));
        opacity = Math.max(0, Math.min(0.9, opacity)); // Cap at 0.9 for subtlety

        // If focused, force full opacity for this label
        if (focusedNodeId === id) {
          opacity = 1.0;
        }

        labelEl.style.opacity = opacity.toString();
        labelEl.style.display = opacity > 0 ? 'block' : 'none';
      } else {
        labelEl.style.opacity = '0';
        labelEl.style.display = 'none';
      }
    } else {
      labelEl.style.opacity = '0';
      labelEl.style.display = 'none';
    }
  });
}

function updateAudioFades() {
  // Smoothly lerp each audio element's volume toward its fade target
  activeAudioElements.forEach(el => {
    const nodeId = el.dataset.nodeId || '';
    const target = audioFadeTargets.get(nodeId) ?? 1.0;
    const current = el.volume;
    if (Math.abs(current - target) > 0.005) {
      el.volume = current + (target - current) * 0.03; // Smooth fade ~1-2 seconds
    } else {
      el.volume = target;
    }
  });
}

function exitFocusMode() {
  focusedNodeId = null;

  // Fade all audio streams back to full volume
  activeAudioElements.forEach(el => {
    const nodeId = el.dataset.nodeId || '';
    audioFadeTargets.set(nodeId, 1.0);
  });

  // Hide exit button
  focusExitBtn.classList.add('hidden');

  // Pull camera back and reset orbit center to scene origin
  targetCameraPos.copy(camera.position).add(camera.position.clone().normalize().multiplyScalar(150));
  targetControlsCenter.set(0, 0, 0); // Return orbit center to scene origin
  isFlying = true;
}

function flyToNode(nodeId: number) {
  selectedNodeId = nodeId;
  const node = graphData.nodes[selectedNodeId];

  // If focusing on a StreamHub, initiate Audio Focus Mode
  if (node.type === NodeType.StreamHub) {
    focusedNodeId = nodeId;

    // Set fade targets: focused source stays full, others fade out
    activeAudioElements.forEach(el => {
      const nId = el.dataset.nodeId || '';
      if (nId === nodeId.toString()) {
        audioFadeTargets.set(nId, 1.0);
      } else {
        audioFadeTargets.set(nId, 0.0);
      }
    });

    // Show exit button
    focusExitBtn.classList.remove('hidden');
  } else {
    // If we click on an Article, clear focus
    exitFocusMode();
  }

  // Calculate Fly-to Target (offset slightly so we don't end up INSIDE the node)
  targetControlsCenter.copy(node.position);
  const offset = new THREE.Vector3(0, 0, node.size * 5 + 10);
  targetCameraPos.copy(node.position).add(offset);

  isFlying = true;
}

function updateSearchResults() {
  searchResultsEl.innerHTML = '';
  if (searchTerm.length === 0) {
    searchResultsEl.classList.add('hidden');
    return;
  }

  const matches = graphData.nodes.filter(n => n.text.toLowerCase().includes(searchTerm));

  if (matches.length > 0) {
    searchResultsEl.classList.remove('hidden');
    // Limit to 20 results to avoid massive DOM
    matches.slice(0, 20).forEach(node => {
      const li = document.createElement('li');
      li.innerText = node.text;
      li.addEventListener('click', () => {
        flyToNode(node.id);
        searchResultsEl.classList.add('hidden');
        searchInput.value = node.text;
        searchTerm = node.text.toLowerCase();
      });
      searchResultsEl.appendChild(li);
    });
  } else {
    searchResultsEl.classList.add('hidden');
  }
}

function onDoubleClick() {
  if (hoveredNodeId !== null) {
    flyToNode(hoveredNodeId);
  }
}

function animate(time: number) {
  requestAnimationFrame(animate);

  updatePhysics(time);
  updateInteraction();
  updateProximityLabels();
  updateAudioFades();

  if (audioListener) {
    let computedTargetVolume = 0.0;

    if (isAudioActive && !isMuted) {
      if (focusedNodeId !== null) {
        // In focus mode, bypass distance drop-off for master volume
        computedTargetVolume = targetMasterVolume;
      } else {
        // Normal global spatial mixing
        const distance = camera.position.length();

        // Calculate multiplier based on camera zoom relative to constellation
        // Start fading much further out (500) and reach max deeper in (150)
        if (distance < 150) {
          computedTargetVolume = targetMasterVolume; // Fully inside, maximum volume
        } else if (distance > 500) {
          computedTargetVolume = 0.0; // Fully outside bounds
        } else {
          // Fade between 150 and 500 with a smooth easing function
          let factor = 1.0 - ((distance - 150) / 350);
          factor = factor * factor * (3 - 2 * factor); // smoothstep mapping for organic feel
          computedTargetVolume = targetMasterVolume * factor;
        }
      }
    } else {
      computedTargetVolume = 0.0;
    }

    if (Math.abs(currentMasterVolume - computedTargetVolume) > 0.001) {
      currentMasterVolume += (computedTargetVolume - currentMasterVolume) * 0.005; // Much slower fade lerp (approx 3-5 seconds depending on framerate)
    } else {
      currentMasterVolume = computedTargetVolume;
    }
    audioListener.setMasterVolume(currentMasterVolume);
  }

  if (isFlying) {
    // Disable auto-rotate while flying so it doesn't push camera off target
    const wasAutoRotate = controls.autoRotate;
    controls.autoRotate = false;

    // Lerp camera and controls target for smooth flight
    camera.position.lerp(targetCameraPos, 0.05);
    controls.target.lerp(targetControlsCenter, 0.05);

    // Stop flying if close enough (loosened threshold to ensure it triggers)
    if (camera.position.distanceToSquared(targetCameraPos) < 25.0 &&
      controls.target.distanceToSquared(targetControlsCenter) < 25.0) {
      isFlying = false;
    }

    // Restore autoRotate if it was globally enabled
    if (!isFlying) controls.autoRotate = wasAutoRotate;
  }

  controls.update(); // only needed if damping or autoRotate is enabled
  renderer.render(scene, camera);
}
