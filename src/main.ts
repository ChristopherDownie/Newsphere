import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createNoise3D } from 'simplex-noise';
import { generateGraph, NodeType } from './graph';
import type { GraphData, GraphNode } from './graph';
import { AudioVisualizer } from './audioVisualizer';

// --- Configuration ---
const THEMES = {
  dark: {
    backgroundColor: 0x070b19,
    edgeColor: 0x4488ff,
    ambientDustColor: 0x7777ff,
    hubDustColor: 0x7777ff,
    ambientDustOpacity: 0.4,
    nodeTextDimmed: '#666677'
  },
  light: {
    backgroundColor: 0xe8e4e0, // Milky warm grey
    edgeColor: 0x00e5cc, // Neon teal connections
    ambientDustColor: 0x000000, // Pure black ambient dust
    hubDustColor: 0x111111, // Near-black hub dust
    ambientDustOpacity: 1.0, // Full opacity
    nodeTextDimmed: '#aaaaaa'
  }
};

let currentTheme: 'dark' | 'light' = 'dark';

const CONFIG = {
  ...THEMES.dark,
  edgeOpacity: 0.4,
  dustCount: 40000,
  hubDustOpacity: 0.8,
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
let hubDustPoints: THREE.Points;
let ambientDustPoints: THREE.Points;
let boundsSphere: THREE.Mesh;

// Per-dust-particle data for hub-anchored positioning
let hubDustHubIndices: Int32Array; // Index into graphData.nodes for each hub dust particle
let hubDustLocalOffsets: Float32Array;
let ambientDustOffsets: Float32Array; // x,y,z local offset from hub for each particle

const noise3D = createNoise3D();
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

let hoveredNodeId: number | null = null;
let selectedNodeId: number | null = null;
let focusedNodeId: number | null = null; // The node currently being focused for audio
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

// Map each audio element's nodeId to its 3D position for distance-based volume
const audioNodePositions: Map<string, THREE.Vector3> = new Map();

const nodeLabels: Map<number, HTMLDivElement> = new Map();

// Focus-mode fade targets for smooth transitions
const audioFadeTargets: Map<string, number> = new Map();

// --- Frequency Analysers ---
const audioAnalysers: Map<string, AnalyserNode> = new Map();
const audioGainNodes: Map<string, GainNode> = new Map();
const audioDataArrays: Map<string, Uint8Array<ArrayBuffer>> = new Map();
const audioVisualizers: Map<string, AudioVisualizer> = new Map();

// --- Woosh Sound State ---
let wooshGain: GainNode | null = null;
let wooshLowpass: BiquadFilterNode | null = null;
let previousCameraPos = new THREE.Vector3();
let smoothedSpeed = 0;

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

  // Procedural woosh sound
  setupWooshSound();

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

  // Theme Toggle Button
  const themeToggleBtn = document.getElementById('theme-toggle-btn') as HTMLButtonElement;
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      currentTheme = currentTheme === 'dark' ? 'light' : 'dark';

      // Update document body for CSS styling
      if (currentTheme === 'light') {
        document.body.classList.add('light-theme');
        themeToggleBtn.innerText = 'Theme: Light';
      } else {
        document.body.classList.remove('light-theme');
        themeToggleBtn.innerText = 'Theme: Dark';
      }

      // Apply theme settings to CONFIG
      const themeConfig = THEMES[currentTheme];
      Object.assign(CONFIG, themeConfig);

      // Update Materials dynamically
      scene.background = new THREE.Color(themeConfig.backgroundColor);
      if (edgesLine) {
        (edgesLine.material as THREE.LineBasicMaterial).color.setHex(themeConfig.edgeColor);
      }
      if (ambientDustPoints) {
        (ambientDustPoints.material as THREE.PointsMaterial).color.setHex(themeConfig.ambientDustColor);
        (ambientDustPoints.material as THREE.PointsMaterial).opacity = themeConfig.ambientDustOpacity;
      }
      if (hubDustPoints) {
        (hubDustPoints.material as THREE.PointsMaterial).color.setHex(themeConfig.hubDustColor);
        (hubDustPoints.material as THREE.PointsMaterial).blending = currentTheme === 'light' ? THREE.NormalBlending : THREE.AdditiveBlending;
      }
      if (ambientDustPoints) {
        (ambientDustPoints.material as THREE.PointsMaterial).blending = currentTheme === 'light' ? THREE.NormalBlending : THREE.AdditiveBlending;
      }
      if (edgesLine) {
        const edgeMat = edgesLine.material as THREE.LineBasicMaterial;
        edgeMat.blending = currentTheme === 'light' ? THREE.NormalBlending : THREE.AdditiveBlending;
        edgeMat.opacity = currentTheme === 'light' ? 1.0 : CONFIG.edgeOpacity;
        edgeMat.linewidth = currentTheme === 'light' ? 2 : 1;
      }

      // Update wireframe sphere
      if (boundsSphere) {
        const mat = boundsSphere.material as THREE.MeshBasicMaterial;
        if (currentTheme === 'light') {
          mat.color.setHex(0x333333);
          mat.opacity = 0.25;
          mat.blending = THREE.NormalBlending;
        } else {
          mat.color.setHex(0x4488ff);
          mat.opacity = 0.05;
          mat.blending = THREE.AdditiveBlending;
        }
      }

      // Update audio visualizer themes
      audioVisualizers.forEach(vis => vis.setTheme(currentTheme));

      // Trigger a re-render/update for nodes
      updatePhysics(performance.now());

      // Update all HTML labels color
      nodeLabels.forEach((el, i) => {
        const node = graphData.nodes[i];
        // Hide label if search is active and doesn't match
        if (searchTerm.length > 0 && !node.text.toLowerCase().includes(searchTerm)) {
          if (!el.classList.contains('dimmed')) {
            el.classList.add('dimmed');
            el.style.color = currentTheme === 'light' ? THEMES.light.nodeTextDimmed : THEMES.dark.nodeTextDimmed;
          }
        } else {
          el.classList.remove('dimmed');
          if (i === hoveredNodeId || i === selectedNodeId) {
            el.style.color = currentTheme === 'light' ? '#000000' : '#ffffff';
          } else {
            el.style.color = currentTheme === 'light' ? '#444444' : 'rgba(255, 255, 255, 0.9)';
          }
        }
      });
    });
  }

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

      // Create spherical audio visualizer around this hub
      const visualizer = new AudioVisualizer(node.size, currentTheme);
      visualizer.setPosition(node.position);
      scene.add(visualizer.group);
      audioVisualizers.set(node.id.toString(), visualizer);

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
  boundsSphere = new THREE.Mesh(geometry, material);
  scene.add(boundsSphere);
}

function setupWooshSound() {
  const ctx = audioListener.context;

  // Create a looping buffer of white noise (2 seconds)
  const bufferSize = ctx.sampleRate * 2;
  const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  const noiseSource = ctx.createBufferSource();
  noiseSource.buffer = noiseBuffer;
  noiseSource.loop = true;

  // Bandpass filter — centered very deep (45 Hz) for a sub-bass underwater rumble
  const bandpass = ctx.createBiquadFilter();
  bandpass.type = 'bandpass';
  bandpass.frequency.value = 45;
  bandpass.Q.value = 1.5; // Resonant for that deep underwater pressure feel

  // Lowpass filter — cutoff rises with speed, starts extremely muffled
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 50; // Very deep/muffled at rest
  lowpass.Q.value = 1.2; // Some resonance for underwater character

  // Gain node — volume driven by camera speed
  const gain = ctx.createGain();
  gain.gain.value = 0;

  // Pipeline: noise -> bandpass -> lowpass -> gain -> destination
  noiseSource.connect(bandpass);
  bandpass.connect(lowpass);
  lowpass.connect(gain);
  gain.connect(audioListener.getInput());

  noiseSource.start();

  wooshGain = gain;
  wooshLowpass = lowpass;
  previousCameraPos.copy(camera.position);
}

function setupStreamingAudio(node: GraphNode) {
  // Create HTML Audio element. CrossOrigin anonymous is required for proxying.
  const audioElement = new Audio(node.streamUrl);
  audioElement.crossOrigin = "anonymous";
  audioElement.loop = true;

  // We handle volume entirely through Web Audio GainNodes now,
  // but we still want the media element to not blast at 100% while WebAudio initializes
  audioElement.volume = 1.0;

  // Tag element with node ID
  audioElement.dataset.nodeId = node.id.toString();

  // Create Web Audio nodes
  const source = audioListener.context.createMediaElementSource(audioElement);
  const analyser = audioListener.context.createAnalyser();
  analyser.fftSize = 256; // 128 frequency bins
  const gainNode = audioListener.context.createGain();
  gainNode.gain.value = 0; // Start silent

  // Connect the pipeline: Source -> Analyser -> Gain -> Global Audio Listener Dest
  source.connect(analyser);
  analyser.connect(gainNode);
  gainNode.connect(audioListener.getInput());

  // Store references for the render loop
  audioAnalysers.set(node.id.toString(), analyser);
  audioGainNodes.set(node.id.toString(), gainNode);
  audioDataArrays.set(node.id.toString(), new Uint8Array(analyser.frequencyBinCount));

  activeAudioElements.push(audioElement);
  audioNodePositions.set(node.id.toString(), node.position);

  // Note: play() won't emit sound until context resumes and gain goes up
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
  const hubs = graphData.nodes.filter(n => n.type === NodeType.Core || n.type === NodeType.StreamHub);

  // We split dust roughly 50/50 between hubs and ambient
  const totalCount = CONFIG.dustCount;
  let hubCount = 0;
  let ambientCount = 0;

  // First pass to count sizes
  for (let i = 0; i < totalCount; i++) {
    if (Math.random() > 0.5 && hubs.length > 0) hubCount++;
    else ambientCount++;
  }

  // --- Hub Dust ---
  const hubDustGeo = new THREE.BufferGeometry();
  const hubDustPositions = new Float32Array(hubCount * 3);
  hubDustHubIndices = new Int32Array(hubCount);
  hubDustLocalOffsets = new Float32Array(hubCount * 3);

  // --- Ambient Dust ---
  const ambientDustGeo = new THREE.BufferGeometry();
  const ambientDustPositions = new Float32Array(ambientCount * 3);
  ambientDustOffsets = new Float32Array(ambientCount * 3);

  let hIdx = 0;
  let aIdx = 0;

  for (let i = 0; i < totalCount; i++) {
    if (Math.random() > 0.5 && hubs.length > 0) {
      // Hub Anchored
      const hub = hubs[Math.floor(Math.random() * hubs.length)];

      const u = Math.random();
      const v = Math.random();
      const theta = 2 * Math.PI * u;
      const phi = Math.acos(2 * v - 1);
      const r = Math.cbrt(Math.random()) * 80;

      const ox = r * Math.sin(phi) * Math.cos(theta);
      const oy = r * Math.sin(phi) * Math.sin(theta);
      const oz = r * Math.cos(phi);

      hubDustHubIndices[hIdx] = hub.id;
      hubDustLocalOffsets[hIdx * 3] = ox;
      hubDustLocalOffsets[hIdx * 3 + 1] = oy;
      hubDustLocalOffsets[hIdx * 3 + 2] = oz;

      hubDustPositions[hIdx * 3] = hub.position.x + ox;
      hubDustPositions[hIdx * 3 + 1] = hub.position.y + oy;
      hubDustPositions[hIdx * 3 + 2] = hub.position.z + oz;
      hIdx++;
    } else {
      // Free floating ambient
      const u = Math.random();
      const v = Math.random();
      const theta = 2 * Math.PI * u;
      const phi = Math.acos(2 * v - 1);
      const r = Math.cbrt(Math.random()) * 350; // Sphere radius

      const ox = r * Math.sin(phi) * Math.cos(theta);
      const oy = r * Math.sin(phi) * Math.sin(theta);
      const oz = r * Math.cos(phi);

      ambientDustOffsets[aIdx * 3] = ox;
      ambientDustOffsets[aIdx * 3 + 1] = oy;
      ambientDustOffsets[aIdx * 3 + 2] = oz;

      // Start at origin + offset
      ambientDustPositions[aIdx * 3] = ox;
      ambientDustPositions[aIdx * 3 + 1] = oy;
      ambientDustPositions[aIdx * 3 + 2] = oz;
      aIdx++;
    }
  }

  hubDustGeo.setAttribute('position', new THREE.BufferAttribute(hubDustPositions, 3));
  ambientDustGeo.setAttribute('position', new THREE.BufferAttribute(ambientDustPositions, 3));

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

  const hubDustMat = new THREE.PointsMaterial({
    size: 1.5,
    color: CONFIG.hubDustColor,
    map: texture,
    transparent: true,
    opacity: CONFIG.hubDustOpacity,
    alphaTest: 0.1,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });

  const ambientDustMat = new THREE.PointsMaterial({
    size: 1.5,
    color: CONFIG.ambientDustColor,
    map: texture,
    transparent: true,
    opacity: CONFIG.ambientDustOpacity,
    alphaTest: 0.1,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });

  hubDustPoints = new THREE.Points(hubDustGeo, hubDustMat);
  scene.add(hubDustPoints);

  ambientDustPoints = new THREE.Points(ambientDustGeo, ambientDustMat);
  scene.add(ambientDustPoints);
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
    let audioPulse = 0;

    if (node.type === NodeType.StreamHub) {
      const analyser = audioAnalysers.get(node.id.toString());
      const dataArray = audioDataArrays.get(node.id.toString());

      if (analyser && dataArray) {
        analyser.getByteFrequencyData(dataArray);

        // Update the spherical audio visualizer with frequency data
        const visualizer = audioVisualizers.get(node.id.toString());
        if (visualizer) {
          visualizer.update(dataArray, time);
          visualizer.setPosition(node.position);
        }

        // Sum lower-mid frequencies (bass/vocals)
        let sum = 0;
        const startBin = 2; // skip sub-bass noise
        const endBin = 30;  // out of 128 bins
        for (let b = startBin; b < endBin; b++) {
          sum += dataArray[b];
        }

        // Average and normalize 0-1
        const avg = sum / (endBin - startBin);
        const normalized = avg / 255.0;

        // Emphasize spikes using a power curve, scale up
        audioPulse = Math.pow(normalized, 1.5) * 2.5;
      }
    } else {
      // Default slow idle pulse for non-hubs
      audioPulse = Math.sin(time * CONFIG.pulseSpeed + node.id) * CONFIG.pulseAmplitude;
      if (audioPulse < 0) audioPulse = 0;
    }

    const dynamicSize = Math.max(0.1, node.size + audioPulse);

    // Update instance matrix
    dummy.position.copy(node.position);
    let scaleMultiplier = (i === hoveredNodeId) ? 1.5 : 1.0;
    // For StreamHubs, size the instanced sphere to match the visualizer radius
    // so raycast click/hover detection works. It blends in behind the visualizer.
    if (node.type === NodeType.StreamHub) {
      const vizRadius = Math.max(2, node.size * 0.8);
      dummy.scale.setScalar(vizRadius);
    } else {
      dummy.scale.setScalar(dynamicSize * scaleMultiplier);
    }
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
      // Dimmed out non-matches based on theme
      const dimColor = currentTheme === 'light' ? 0xdddddd : 0x111122;
      color.setHex(dimColor);
    } else if (i === hoveredNodeId) {
      const highColor = currentTheme === 'light' ? 0x000000 : 0xffffff;
      color.setHex(highColor);
    } else {
      if (currentTheme === 'light') {
        // Monochrome: render nodes as dark grey/black
        color.copy(node.color).lerp(new THREE.Color(0x222222), 0.7);
      } else {
        color.copy(node.color);
      }

      // Intensify color as it gets larger (pulse)
      if (audioPulse > 0.1) {
        // Map audio pulse (0 to ~2.5) to a lerp factor (0 to 0.8 max)
        const flashIntensity = Math.min(0.8, audioPulse * 0.4);
        const targetHigh = currentTheme === 'light' ? new THREE.Color(0x000000) : new THREE.Color(0xffffff);
        color.lerp(targetHigh, flashIntensity);
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

  // Update hub dust positions to track their parent hub nodes, with physical high-frequency expansion
  if (hubDustPoints && hubDustHubIndices) {
    const positions = hubDustPoints.geometry.attributes.position.array as Float32Array;

    // First, calculate a high-frequency (treble) explosion factor per hub
    const hubTrebleFactors: Map<number, number> = new Map();
    for (const hub of graphData.nodes) {
      if (hub.type === NodeType.StreamHub) {
        const dataArray = audioDataArrays.get(hub.id.toString());
        if (dataArray) {
          let sum = 0;
          // High frequencies are roughly bins 50 to 100 out of 128
          for (let b = 50; b < 100; b++) {
            sum += dataArray[b];
          }
          const avg = sum / 50;
          // Scale it to a 1.0 to 1.5 multiplier based on sharpness of sounds
          const factor = 1.0 + (avg / 255.0) * 0.8;
          hubTrebleFactors.set(hub.id, factor);
        }
      }
    }

    for (let i = 0; i < hubDustHubIndices.length; i++) {
      const hubIdx = hubDustHubIndices[i];
      const pIdx = i * 3;
      if (hubIdx >= 0 && hubIdx < graphData.nodes.length) {
        const hub = graphData.nodes[hubIdx];

        let multiplier = hubTrebleFactors.get(hub.id) || 1.0;

        // Add a continuous swirling motion using time based on particle index
        const swirlAngle = time * CONFIG.dustSwirlSpeed * multiplier;
        const ox = hubDustLocalOffsets[pIdx];
        const oy = hubDustLocalOffsets[pIdx + 1];
        const oz = hubDustLocalOffsets[pIdx + 2];

        // Rotate the offset around Y axis
        const cosA = Math.cos(swirlAngle);
        const sinA = Math.sin(swirlAngle);
        const rx = ox * cosA - oz * sinA;
        const rz = ox * sinA + oz * cosA;

        // Apply the physical burst multiplier pushing particles outward from center
        positions[pIdx] = hub.position.x + (rx * multiplier);
        positions[pIdx + 1] = hub.position.y + (oy * multiplier);
        positions[pIdx + 2] = hub.position.z + (rz * multiplier);
      }
    }
    hubDustPoints.geometry.attributes.position.needsUpdate = true;
  }

  // Update ambient dust to drift organically
  if (ambientDustPoints && ambientDustOffsets) {
    const positions = ambientDustPoints.geometry.attributes.position.array as Float32Array;
    const freeDriftSpeed = 0.002;
    const freeDriftAmplitude = 8.0;

    for (let i = 0; i < ambientDustOffsets.length / 3; i++) {
      const pIdx = i * 3;
      const baseX = ambientDustOffsets[pIdx];
      const baseY = ambientDustOffsets[pIdx + 1];
      const baseZ = ambientDustOffsets[pIdx + 2];
      const seed = i * 0.1; // Unique per particle

      const nx = noise3D(baseX * 0.005 + seed, baseY * 0.005, time * freeDriftSpeed);
      const ny = noise3D(baseY * 0.005, baseZ * 0.005 + seed, time * freeDriftSpeed + 50);
      const nz = noise3D(baseZ * 0.005 + seed, baseX * 0.005, time * freeDriftSpeed + 100);

      let px = baseX + nx * freeDriftAmplitude;
      let py = baseY + ny * freeDriftAmplitude;
      let pz = baseZ + nz * freeDriftAmplitude;

      // Clamp within bounding sphere (approx radius 340)
      const dist = Math.sqrt(px * px + py * py + pz * pz);
      if (dist > 340) {
        const s = 340 / dist;
        px *= s; py *= s; pz *= s;
      }

      positions[pIdx] = px;
      positions[pIdx + 1] = py;
      positions[pIdx + 2] = pz;
    }
    ambientDustPoints.geometry.attributes.position.needsUpdate = true;
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

  // --- Woosh: track camera velocity ---
  const cameraDelta = camera.position.distanceTo(previousCameraPos);
  previousCameraPos.copy(camera.position);

  // Smooth the speed to avoid jitter (exponential moving average)
  smoothedSpeed += (cameraDelta - smoothedSpeed) * 0.08;

  if (wooshGain && wooshLowpass) {
    // Map speed -> volume: ramp from 0 at rest to ~0.7 at high speed (louder underwater rush)
    const speedNorm = Math.min(smoothedSpeed / 25, 1.0);
    const targetWooshVol = speedNorm * speedNorm * 0.7; // quadratic, much louder
    wooshGain.gain.value += (targetWooshVol - wooshGain.gain.value) * 0.1;

    // Sphere proximity muffling: deeper inside = more muffled (underwater effect)
    const camDist = camera.position.length();
    const sphereRadius = 350;
    // 1.0 when outside sphere, drops toward 0.08 at dead center for heavy underwater muffling
    const proximityFactor = camDist >= sphereRadius
      ? 1.0
      : 0.08 + 0.92 * (camDist / sphereRadius);

    // Map speed -> lowpass cutoff: 50 Hz at rest up to 800 Hz at max speed,
    // then scale down by proximity (deeper muffling inside = underwater feel)
    const baseCutoff = 50 + speedNorm * 750;
    const targetCutoff = baseCutoff * proximityFactor;
    wooshLowpass.frequency.value += (targetCutoff - wooshLowpass.frequency.value) * 0.1;

    // Respect mute state
    if (isMuted || !isAudioActive) {
      wooshGain.gain.value = 0;
    }
  }

  updatePhysics(time);
  updateInteraction();
  updateProximityLabels();

  // --- Per-element spatial volume ---
  // Instead of Web Audio API positional audio, manually compute volume
  // for each stream based on camera distance to its node.
  {
    let globalEnvelope = 0.0;

    if (isAudioActive && !isMuted) {
      if (focusedNodeId !== null) {
        globalEnvelope = targetMasterVolume;
      } else {
        const camDist = camera.position.length();
        if (camDist < 150) {
          globalEnvelope = targetMasterVolume;
        } else if (camDist > 500) {
          globalEnvelope = 0.0;
        } else {
          let f = 1.0 - ((camDist - 150) / 350);
          f = f * f * (3 - 2 * f);
          globalEnvelope = targetMasterVolume * f;
        }
      }
    }

    // Smooth the global envelope
    if (Math.abs(currentMasterVolume - globalEnvelope) > 0.001) {
      currentMasterVolume += (globalEnvelope - currentMasterVolume) * 0.005;
    } else {
      currentMasterVolume = globalEnvelope;
    }

    // Apply per-element spatial volume
    activeAudioElements.forEach(el => {
      const nodeId = el.dataset.nodeId || '';
      const nodePos = audioNodePositions.get(nodeId);
      const gainNode = audioGainNodes.get(nodeId);

      // Focus-mode fade target
      const fadeTarget = audioFadeTargets.get(nodeId) ?? 1.0;

      // We use the GainNode for volume now, instead of the HTML element
      if (!gainNode) return;

      // Smooth fade toward target
      const currentFade = gainNode.gain.value;
      let newFade = currentFade;
      if (Math.abs(currentFade - fadeTarget) > 0.005) {
        newFade = currentFade + (fadeTarget - currentFade) * 0.03;
      } else {
        newFade = fadeTarget;
      }

      // Distance-based attenuation (generous range so streams overlap)
      let spatialGain = 1.0;
      if (nodePos) {
        const dist = camera.position.distanceTo(nodePos);
        const refDist = 200;  // Full volume within this range
        const maxDist = 800;  // Silent beyond this range
        if (dist > maxDist) {
          spatialGain = 0.0;
        } else if (dist > refDist) {
          // Smooth squared falloff for a gentle, overlapping mix
          const t = 1.0 - (dist - refDist) / (maxDist - refDist);
          spatialGain = t * t;
        }
      }

      // Apply the computed smooth gain
      gainNode.gain.value = Math.max(0, Math.min(1, currentMasterVolume * spatialGain * newFade));
    });
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
