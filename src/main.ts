import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createNoise3D } from 'simplex-noise';
import { generateGraph, NodeType, BOUNDS_RADIUS } from './graph';
import type { GraphData, GraphNode } from './graph';
import { AudioVisualizer } from './audioVisualizer';
import { initLandingParticles, stopLandingParticles } from './landingParticles';
import { YouTubePlayerManager } from './youtubePlayer';
import { TopicDetector } from './topicDetector';

// --- Configuration ---
const THEMES = {
  dark: {
    backgroundColor: 0x070b19,
    edgeColor: 0x4488ff,
    ambientDustColor: 0x7777ff,
    hubDustColor: 0x7777ff,
    ambientDustOpacity: 0.4,
    nodeTextDimmed: '#666677',
    asteroidColor: 0x555577
  },
  light: {
    backgroundColor: 0xf8fafc, // Crisp off-white (Slate 50)
    edgeColor: 0x0f172a, // Very dark slate (almost black) for connections
    ambientDustColor: 0x94a3b8, // Visible mid-grey dust (Slate 400)
    hubDustColor: 0x0ea5e9, // Bright sky blue for hub focus (Sky 500)
    ambientDustOpacity: 0.6, // Transparent enough to be subtle
    nodeTextDimmed: '#94a3b8',
    asteroidColor: 0x000000
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
let asteroidsMesh: THREE.InstancedMesh;

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

const focusButtonsContainer = document.getElementById('focus-buttons-container') as HTMLDivElement;
const focusExitBtn = document.getElementById('focus-exit-btn') as HTMLButtonElement;
const watchStreamBtn = document.getElementById('watch-stream-btn') as HTMLButtonElement;

const videoPanelContainer = document.getElementById('video-panel-container') as HTMLDivElement;
const videoWrapper = document.getElementById('video-wrapper') as HTMLDivElement;
const closeVideoBtn = document.getElementById('close-video-btn') as HTMLButtonElement;
const expandVideoBtn = document.getElementById('expand-video-btn') as HTMLButtonElement;
const glcanvas = document.getElementById('glcanvas') as HTMLCanvasElement;

// Deep Dive panel elements
const deepDivePanel = document.getElementById('deep-dive-panel') as HTMLDivElement;
const deepDiveTitle = document.getElementById('deep-dive-title') as HTMLHeadingElement;
const deepDiveArticles = document.getElementById('deep-dive-articles') as HTMLUListElement;
const deepDiveCloseBtn = document.getElementById('deep-dive-close-btn') as HTMLButtonElement;

// Transcript elements
const transcriptContainer = document.getElementById('transcript-container') as HTMLDivElement;
const transcriptPlaceholder = document.getElementById('transcript-placeholder') as HTMLParagraphElement;

// Speech Recognition state
const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
let recognition: any = null;
let isTranscribing = false;

// Topic detection
const topicBadge = document.getElementById('deep-dive-topic-badge') as HTMLSpanElement;
const topicDetector = new TopicDetector();

let searchTerm: string = '';

// UI state
let isSourcesPanelOpen = false;
let isVideoPanelOpen = false;
let isVideoExpanded = false;
let isDeepDiveOpen = false;


let audioListener: THREE.AudioListener;
let targetMasterVolume = 0.3; // matches new default
let unmutedVolume = 0.3; // Store volume before muting
let currentMasterVolume = 0.0;
let isAudioActive = false;
let isMuted = false;

// YouTube Player Manager (replaces HTMLAudioElement pipeline)
const ytManager = new YouTubePlayerManager();

// Map each YouTube player's nodeId to its 3D position for distance-based volume
const audioNodePositions: Map<string, THREE.Vector3> = new Map();

const nodeLabels: Map<number, HTMLDivElement> = new Map();

// Focus-mode fade targets for smooth transitions
const audioFadeTargets: Map<string, number> = new Map();
// Smoothed fade values for gradual volume transitions
const audioFadeCurrents: Map<string, number> = new Map();

// --- Procedural Frequency Data for Visualizers ---
const audioVisualizers: Map<string, AudioVisualizer> = new Map();
const proceduralFreqData: Map<string, Uint8Array> = new Map();

// --- Woosh Sound State ---
let wooshGain: GainNode | null = null;
let wooshLowpass: BiquadFilterNode | null = null;
let previousCameraPos = new THREE.Vector3();
let smoothedSpeed = 0;

// --- Ambient Hum State ---
let ambientHumGain: GainNode | null = null;
let ambientHumInitialized = false;

// --- Spatial Audio Cue Layer ---
// Per-stream oscillator + StereoPanner + Gain for directional presence cues
interface SpatialCueNode {
  oscillator: OscillatorNode;
  panner: StereoPannerNode;
  gain: GainNode;
  filter: BiquadFilterNode;
}
const spatialCueNodes: Map<string, SpatialCueNode> = new Map();
let spatialCuesInitialized = false;

// --- Fly-to Animation State ---
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
  camera.position.set(500, 700, 1600);

  // Audio Setup (Three.js AudioListener for woosh only)
  audioListener = new THREE.AudioListener();
  camera.add(audioListener);

  // Load YouTube IFrame API
  ytManager.loadAPI();

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
  createAsteroids();

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

      if (asteroidsMesh) {
        const mat = asteroidsMesh.material as THREE.MeshBasicMaterial;
        mat.color.setHex(themeConfig.asteroidColor);
        mat.wireframe = currentTheme === 'light';
        mat.opacity = currentTheme === 'light' ? 0.3 : 0.6;
        mat.blending = currentTheme === 'light' ? THREE.NormalBlending : THREE.AdditiveBlending;
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

  // Escape key for Focus Mode / Video Mode
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (isVideoPanelOpen) {
        closeVideoPanel();
      } else if (focusedNodeId !== null) {
        exitFocusMode();
      }
    }
  });

  // Interrupt flying on manual user interaction
  renderer.domElement.addEventListener('pointerdown', () => { isFlying = false; });
  renderer.domElement.addEventListener('wheel', () => { isFlying = false; });

  // Focus Exit Button
  focusExitBtn.addEventListener('click', () => {
    exitFocusMode();
  });

  // Watch Stream logic
  watchStreamBtn.addEventListener('click', () => {
    if (focusedNodeId !== null) {
      openDeepDive(focusedNodeId);
      openVideoPanel(focusedNodeId.toString());
      startTranscription();
    }
  });

  closeVideoBtn.addEventListener('click', () => {
    closeVideoPanel();
  });

  expandVideoBtn.addEventListener('click', () => {
    toggleVideoExpand();
  });

  // Deep Dive close button
  deepDiveCloseBtn.addEventListener('click', () => {
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
        ytManager.unmuteAll();
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
        ytManager.muteAll();
      } else {
        // Unmute
        targetMasterVolume = unmutedVolume > 0 ? unmutedVolume : 0.3;
        volumeSlider.value = targetMasterVolume.toString();
        muteBtn.innerText = 'MUTE';
        muteBtn.classList.remove('muted');
        ytManager.unmuteAll();
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

      // Start the ambient hum immediately (audible during tutorial)
      setupAmbientHum();

      // 1. Hide landing page
      landingPage.classList.add('hidden');

      // 2. Show tutorial overlay
      if (tutorialOverlay) {
        tutorialOverlay.classList.remove('hidden');

        // 3. After 3.5 seconds, fade out tutorial and show the 3D world
        setTimeout(() => {
          tutorialOverlay.classList.add('fade-out');
          appContainer.classList.remove('hidden');
          stopLandingParticles();

          // 4. Start YouTube live streams AFTER tutorial fades
          // (audio should only be heard when user zooms into the sphere)
          isAudioActive = true;
          ytManager.playAll();

          // 5. Diagnostic: check YouTube player status after 10 seconds
          setTimeout(() => {
            const nodeIds = ytManager.getNodeIds();
            let playingCount = 0;
            nodeIds.forEach(id => {
              if (ytManager.isPlaying(id)) playingCount++;
            });
            console.log(`[YT Diagnostic] ${playingCount}/${nodeIds.length} streams are playing after 10s`);
          }, 10000);

          // 6. Remove tutorial from DOM after fade completes
          setTimeout(() => {
            tutorialOverlay.style.display = 'none';
          }, 1500);
        }, 3500);
      } else {
        // Fallback: no tutorial element, just show app
        appContainer.classList.remove('hidden');
        stopLandingParticles();
        isAudioActive = true;
        ytManager.playAll();
      }
    });
  }

  // Initialize landing experience
  initLandingParticles();
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

    // If it's a Stream Hub, attach YouTube live stream audio
    if (node.type === NodeType.StreamHub) {
      setupYouTubeAudio(node);

      // Create spherical audio visualizer around this hub
      const visualizer = new AudioVisualizer(node.size, currentTheme);
      visualizer.setPosition(node.position);
      scene.add(visualizer.group);
      audioVisualizers.set(node.id.toString(), visualizer);

      // Initialize procedural frequency data array (128 bins to match old analyser)
      proceduralFreqData.set(node.id.toString(), new Uint8Array(128));

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

/**
 * Create a rich ambient hum drone from layered sine oscillators.
 * Plays from the moment the user clicks Enter and fades based on proximity to the sphere.
 */
function setupAmbientHum() {
  if (ambientHumInitialized) return;
  const ctx = audioListener.context;
  if (ctx.state !== 'running') return;

  // Master gain for the entire hum layer
  const masterGain = ctx.createGain();
  masterGain.gain.value = 0.35; // Starting volume

  // Bandpass to shape the overall drone timbre
  const shaper = ctx.createBiquadFilter();
  shaper.type = 'lowpass';
  shaper.frequency.value = 220;
  shaper.Q.value = 0.8;

  // Layer 1: Deep fundamental (55 Hz - A1)
  const osc1 = ctx.createOscillator();
  osc1.type = 'sine';
  osc1.frequency.value = 55;
  const gain1 = ctx.createGain();
  gain1.gain.value = 0.5;
  osc1.connect(gain1);
  gain1.connect(shaper);

  // Layer 2: Fifth above (82 Hz - roughly E2)
  const osc2 = ctx.createOscillator();
  osc2.type = 'sine';
  osc2.frequency.value = 82;
  const gain2 = ctx.createGain();
  gain2.gain.value = 0.3;
  osc2.connect(gain2);
  gain2.connect(shaper);

  // Layer 3: Octave above (110 Hz - A2)
  const osc3 = ctx.createOscillator();
  osc3.type = 'sine';
  osc3.frequency.value = 110;
  const gain3 = ctx.createGain();
  gain3.gain.value = 0.15;
  osc3.connect(gain3);
  gain3.connect(shaper);

  // Layer 4: Sub-bass rumble with slight detuning for warmth
  const osc4 = ctx.createOscillator();
  osc4.type = 'sine';
  osc4.frequency.value = 55.3; // Slight detune for beating/warmth
  const gain4 = ctx.createGain();
  gain4.gain.value = 0.25;
  osc4.connect(gain4);
  gain4.connect(shaper);

  // Pipeline: shaper -> masterGain -> destination
  shaper.connect(masterGain);
  masterGain.connect(audioListener.getInput());

  osc1.start();
  osc2.start();
  osc3.start();
  osc4.start();

  ambientHumGain = masterGain;
  ambientHumInitialized = true;
  console.log('[Audio] Ambient hum initialized');
}

function setupYouTubeAudio(node: GraphNode) {
  if (!node.youtubeVideoId) return;

  // Register this source with the YouTube Player Manager
  ytManager.addSource({
    nodeId: node.id,
    videoId: node.youtubeVideoId,
    name: node.text,
  });

  // Store position for distance-based volume calculation
  audioNodePositions.set(node.id.toString(), node.position);

  // Initialize fade targets
  audioFadeTargets.set(node.id.toString(), 1.0);
  audioFadeCurrents.set(node.id.toString(), 0.0);
}

/**
 * Compute stereo pan value for a node based on its position relative to the camera.
 * Returns -1 (hard left) to +1 (hard right), 0 = center.
 */
function computeStereoPan(nodePos: THREE.Vector3): number {
  // Get camera's right vector from its world matrix
  const cameraRight = new THREE.Vector3();
  cameraRight.setFromMatrixColumn(camera.matrixWorld, 0); // Column 0 = right axis
  cameraRight.normalize();

  // Vector from camera to node
  const toNode = new THREE.Vector3().subVectors(nodePos, camera.position);

  // Project onto the right axis — positive = right, negative = left
  const dot = toNode.dot(cameraRight);

  // Normalize: use the distance to the node so angular position matters, not distance
  const dist = toNode.length();
  if (dist < 0.01) return 0; // Node is at camera position

  // The dot/dist gives cos(angle) from the right axis, which ranges [-1, 1]
  // Clamp and apply a slight curve to keep it feeling natural
  const rawPan = Math.max(-1, Math.min(1, dot / dist));

  // Apply a gentle curve: exaggerate center, flatten extremes for smoother feel
  return rawPan * 0.85; // Cap at ±0.85 to avoid jarring hard-pans
}

/**
 * Initialize the spatial audio cue layer — one quiet oscillator per stream
 * routed through a StereoPannerNode for real directional audio cues.
 * Must be called after AudioContext is resumed (user gesture).
 */
function initSpatialCues() {
  if (spatialCuesInitialized) return;
  const ctx = audioListener.context;
  if (ctx.state !== 'running') return; // Wait until context is active

  const nodeIds = ytManager.getNodeIds();
  nodeIds.forEach((nodeId, index) => {
    // Create a unique low-frequency tone per stream (spaced across 80-200 Hz)
    const baseFreq = 80 + (index * 17) % 120;

    const oscillator = ctx.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = baseFreq;

    // Lowpass filter to make the tone very soft and ambient
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 150;
    filter.Q.value = 0.5;

    // Stereo panner — the star of the show
    const panner = ctx.createStereoPanner();
    panner.pan.value = 0;

    // Gain node — starts silent, driven by spatial proximity
    const gain = ctx.createGain();
    gain.gain.value = 0;

    // Pipeline: oscillator -> filter -> panner -> gain -> destination
    oscillator.connect(filter);
    filter.connect(panner);
    panner.connect(gain);
    gain.connect(audioListener.getInput());

    oscillator.start();

    spatialCueNodes.set(nodeId, { oscillator, panner, gain, filter });
  });

  spatialCuesInitialized = true;
  console.log(`[Spatial] Initialized ${nodeIds.length} spatial audio cues`);
}

/**
 * Generate procedural frequency data that looks organic and alive.
 * Uses simplex noise and time-based oscillation to simulate audio-reactive visuals.
 */
function generateProceduralFrequency(nodeId: string, time: number, energyLevel: number = 0.0): Uint8Array {
  const data = proceduralFreqData.get(nodeId);
  if (!data) return new Uint8Array(128);

  const seed = parseInt(nodeId) * 137.5; // Unique per node
  // Speed up noise progression heavily with tension
  const t = time * (0.001 + energyLevel * 0.003);

  for (let i = 0; i < data.length; i++) {
    // Lower bins (bass) should be more active
    const freqFactor = 1.0 - (i / data.length) * 0.6;

    // Multi-octave noise for organic feel
    const n1 = noise3D(i * 0.15 + seed, t * 1.2, 0) * 0.5 + 0.5;
    const n2 = noise3D(i * 0.3 + seed + 100, t * 2.4, 0) * 0.3 + 0.5;
    const n3 = noise3D(i * 0.05 + seed + 200, t * 0.6, 0) * 0.4 + 0.5;

    // Pulsing envelope
    const pulse = Math.sin(t * 1.5 + seed * 0.01) * 0.3 + 0.7;
    const pulse2 = Math.sin(t * 0.7 + seed * 0.02 + i * 0.1) * 0.2 + 0.8;

    // Combine everything
    const baseValue = (n1 * 0.5 + n2 * 0.3 + n3 * 0.2) * freqFactor * pulse * pulse2;
    // Boost amplitude directly proportional to energy
    const energyBoost = baseValue + (baseValue * energyLevel * 1.5);

    // Scale to 0-255 range with some randomness for liveliness
    data[i] = Math.min(255, Math.max(0, Math.floor(energyBoost * 200 + Math.random() * 15)));
  }

  return data;
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

function createAsteroids() {
  const asteroidCount = 1200;
  // Dodecahedron provides a perfect low-poly 'asteroid rock' geometry
  const geometry = new THREE.DodecahedronGeometry(1.5, 0);

  const material = new THREE.MeshBasicMaterial({
    color: THEMES[currentTheme].asteroidColor,
    wireframe: currentTheme === 'light',
    transparent: true,
    opacity: currentTheme === 'light' ? 0.3 : 0.6,
    depthWrite: false, // Blends nicely with glowing elements behind
    blending: currentTheme === 'light' ? THREE.NormalBlending : THREE.AdditiveBlending
  });

  asteroidsMesh = new THREE.InstancedMesh(geometry, material, asteroidCount);

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Euler();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();

  for (let i = 0; i < asteroidCount; i++) {
    // Distribute randomly between radius 500 and 900 (Bounding sphere is 350)
    const radius = 500 + Math.random() * 400;
    const angle = Math.random() * Math.PI * 2;
    // Y-axis variance gives the belt thickness
    const y = (Math.random() - 0.5) * 120;

    position.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);

    // Random spin
    rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    quaternion.setFromEuler(rotation);

    // Varied scales: big rocks, small pebbles
    const s = Math.random() * 5 + 1;
    scale.set(s, s, s);

    matrix.compose(position, quaternion, scale);
    asteroidsMesh.setMatrixAt(i, matrix);

    // Very subtle color variations to make rocks unique
    const colorVariation = new THREE.Color(0x8888aa).multiplyScalar(0.5 + Math.random() * 0.5);
    asteroidsMesh.setColorAt(i, colorVariation);
  }

  // Tilt the belt orbit slightly for a dramatic dynamic effect
  asteroidsMesh.rotation.x = 0.15;
  asteroidsMesh.rotation.z = -0.1;

  asteroidsMesh.instanceMatrix.needsUpdate = true;
  if (asteroidsMesh.instanceColor) asteroidsMesh.instanceColor.needsUpdate = true;

  scene.add(asteroidsMesh);
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

    // Clamp within bounding sphere so nodes never escape
    const nodeDist = node.position.length();
    if (nodeDist > BOUNDS_RADIUS) {
      node.position.multiplyScalar(BOUNDS_RADIUS / nodeDist);
    }

    // Dynamic scale pulsing
    let audioPulse = 0;

    if (node.type === NodeType.StreamHub) {
      // --- Tension Director Logic ---
      if (ytManager.isPlaying(node.id.toString())) {
        // Slow simplex noise to determine tension state for this specific node
        const tensionNoise = noise3D(node.basePosition.x * 0.05, node.basePosition.y * 0.05, time * 0.00005);
        // Map noise (-1 to 1) to energy (0 to 1) with a skew towards lower energy (mostly calm)
        const targetEnergy = Math.max(0, Math.min(1, (tensionNoise * 1.5) - 0.2));
        // Smooth changes
        node.energyLevel = (node.energyLevel || 0) + (targetEnergy - (node.energyLevel || 0)) * 0.01;
      } else {
        // Cool down if not playing
        node.energyLevel = (node.energyLevel || 0) * 0.95;
      }

      const eLevel = node.energyLevel || 0;

      // Jitter high-tension nodes slightly in space to simulate physical stress
      if (eLevel > 0.4) {
        node.velocity.x += (Math.random() - 0.5) * eLevel * 0.3;
        node.velocity.y += (Math.random() - 0.5) * eLevel * 0.3;
        node.velocity.z += (Math.random() - 0.5) * eLevel * 0.3;
      }

      // Generate procedural frequency data for this node
      const dataArray = generateProceduralFrequency(node.id.toString(), time, eLevel);

      // Update the spherical audio visualizer with procedural frequency data
      const visualizer = audioVisualizers.get(node.id.toString());
      if (visualizer) {
        visualizer.update(dataArray, time, eLevel);
        visualizer.setPosition(node.position);
      }

      // Sum lower-mid frequencies (bass/vocals) from procedural data
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
        const eLevel = node.energyLevel || 0;
        // Map audio pulse (0 to ~2.5) to a lerp factor (0 to 0.8 max)
        let flashIntensity = Math.min(0.8, audioPulse * 0.4);

        // Boost flash if tension is high, and shift color towards red
        let targetHigh;
        if (eLevel > 0.4) {
          targetHigh = new THREE.Color(0xff4422); // Tension Orange/Red
          flashIntensity = Math.min(1.0, flashIntensity + eLevel * 0.6);
        } else {
          targetHigh = currentTheme === 'light' ? new THREE.Color(0x000000) : new THREE.Color(0xffffff);
        }

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

    // Calculate a high-frequency (treble) explosion factor per hub using procedural data
    const hubTrebleFactors: Map<number, number> = new Map();
    for (const hub of graphData.nodes) {
      if (hub.type === NodeType.StreamHub) {
        const dataArray = proceduralFreqData.get(hub.id.toString());
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
        let finalX = hub.position.x + (rx * multiplier);
        let finalY = hub.position.y + (oy * multiplier);
        let finalZ = hub.position.z + (rz * multiplier);

        // Clamp within bounding sphere so particles never escape
        const finalDist = Math.sqrt(finalX * finalX + finalY * finalY + finalZ * finalZ);
        if (finalDist > BOUNDS_RADIUS) {
          const clampScale = BOUNDS_RADIUS / finalDist;
          finalX *= clampScale;
          finalY *= clampScale;
          finalZ *= clampScale;
        }

        positions[pIdx] = finalX;
        positions[pIdx + 1] = finalY;
        positions[pIdx + 2] = finalZ;
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

      // Clamp within bounding sphere
      const dist = Math.sqrt(px * px + py * py + pz * pz);
      if (dist > BOUNDS_RADIUS) {
        const s = BOUNDS_RADIUS / dist;
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


function playStreamIntroAnimation(iframe: HTMLIFrameElement) {
  // Hide iframe initially
  iframe.style.opacity = '0';
  iframe.style.transition = 'opacity 1.5s ease-in-out';

  // Create canvas for particle effect inside videoWrapper
  const oldCanvas = document.getElementById('stream-intro-canvas');
  if (oldCanvas) oldCanvas.remove();

  const canvas = document.createElement('canvas');
  canvas.id = 'stream-intro-canvas';
  canvas.style.position = 'absolute';
  canvas.style.top = '0';
  canvas.style.left = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.zIndex = '50'; // Below iframe 
  canvas.style.pointerEvents = 'none';
  canvas.style.borderRadius = '0 0 12px 12px';
  videoWrapper.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    iframe.style.opacity = '1';
    return;
  }

  // Handle resizing
  const rect = videoWrapper.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;

  // Particle System
  const particles: any[] = [];
  const numParticles = 80;
  for (let i = 0; i < numParticles; i++) {
    particles.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      vx: (Math.random() - 0.5) * 2,
      vy: (Math.random() - 0.5) * 2,
      radius: Math.random() * 2 + 1,
      target: {
        x: canvas.width / 2 + (Math.random() - 0.5) * 50,
        y: canvas.height / 2 + (Math.random() - 0.5) * 50
      }
    });
  }

  let startTime = Date.now();

  function animateCanvas() {
    if (!ctx) return;
    const now = Date.now();
    const elapsed = now - startTime;
    // 2.5 seconds total intro
    const progress = Math.min(elapsed / 2500, 1.0);

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Smooth transition: 
    // 0 -> 0.6: particles float and connect
    // 0.6 -> 1.0: converge to center
    const convergePhase = Math.max(0, (progress - 0.6) / 0.4);

    // Draw connecting lines
    ctx.strokeStyle = `rgba(68, 136, 255, ${0.5 * (1 - convergePhase)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 60) {
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
        }
      }
    }
    ctx.stroke();

    // Update and draw particles
    ctx.fillStyle = `rgba(136, 170, 255, ${0.8 * (1 - convergePhase)})`;
    for (const p of particles) {
      if (convergePhase === 0) {
        // Float around
        p.x += p.vx;
        p.y += p.vy;

        // Bounce off walls
        if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
        if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
      } else {
        // Converge to center rapidly
        // Easing to target
        p.x += (p.target.x - p.x) * 0.15;
        p.y += (p.target.y - p.y) * 0.15;
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
    }

    if (progress < 1.0) {
      requestAnimationFrame(animateCanvas);
      // Midway fade in the video wrapper
      if (progress > 0.7 && iframe.style.opacity === '0') {
        iframe.style.opacity = '1';
      }
    } else {
      iframe.style.opacity = '1';
      // Fade out canvas
      canvas.style.transition = 'opacity 0.5s';
      canvas.style.opacity = '0';
      setTimeout(() => {
        if (videoWrapper.contains(canvas)) videoWrapper.removeChild(canvas);
      }, 500);
    }
  }

  animateCanvas();
}

function playStreamOutroAnimation(iframe: HTMLIFrameElement, onComplete: () => void) {
  // Fade out iframe
  iframe.style.transition = 'opacity 0.8s ease-in-out';
  iframe.style.opacity = '0';

  const oldCanvas = document.getElementById('stream-outro-canvas');
  if (oldCanvas) oldCanvas.remove();

  const canvas = document.createElement('canvas');
  canvas.id = 'stream-outro-canvas';
  canvas.style.position = 'absolute';
  canvas.style.top = '0';
  canvas.style.left = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.zIndex = '52'; // Above iframe to hide it
  canvas.style.pointerEvents = 'none';
  canvas.style.borderRadius = '0 0 12px 12px';
  videoWrapper.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    onComplete();
    return;
  }

  const rect = videoWrapper.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;

  const particles: any[] = [];
  const numParticles = 80;
  for (let i = 0; i < numParticles; i++) {
    // Start scattered
    particles.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      vx: (Math.random() - 0.5),
      vy: (Math.random() - 0.5),
      radius: Math.random() * 2 + 1
    });
  }

  let startTime = Date.now();

  function animateCanvas() {
    if (!ctx) return;
    const now = Date.now();
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / 1200, 1.0); // 1.2 seconds outro

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Target center
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;

    const convergePhase = progress;

    ctx.strokeStyle = `rgba(68, 136, 255, ${0.8 * convergePhase})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        if (dx * dx + dy * dy < 6400) { // Connect if < 80px
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
        }
      }
    }
    ctx.stroke();

    // Fade out completely at the very end
    const alpha = progress > 0.9 ? 1.0 - ((progress - 0.9) * 10) : 1.0;

    ctx.fillStyle = `rgba(136, 170, 255, ${1.0 * convergePhase * alpha})`;
    for (const p of particles) {
      // Accelerate towards center
      p.vx += (cx - p.x) * 0.08 * convergePhase;
      p.vy += (cy - p.y) * 0.08 * convergePhase;

      // Add friction
      p.vx *= 0.85;
      p.vy *= 0.85;

      p.x += p.vx;
      p.y += p.vy;

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
    }

    if (progress < 1.0) {
      requestAnimationFrame(animateCanvas);
    } else {
      setTimeout(() => {
        if (videoWrapper.contains(canvas)) videoWrapper.removeChild(canvas);
        onComplete();
      }, 50);
    }
  }

  animateCanvas();
}

function openVideoPanel(nodeIdStr: string) {
  const iframe = ytManager.getIframe(nodeIdStr);
  if (!iframe) return;

  // Set panel title to the node's name
  const videoPanelTitle = document.getElementById('video-panel-title');
  if (videoPanelTitle && focusedNodeId !== null) {
    const node = graphData.nodes[focusedNodeId];
    videoPanelTitle.textContent = node.text + ' — Live';
  }

  // Position the panel near the hub in screen space
  positionPanelNearHub();

  // Reset expanded state
  isVideoExpanded = false;
  videoPanelContainer.classList.remove('expanded');

  // Show the panel and blur the background
  videoPanelContainer.classList.remove('hidden');
  glcanvas.classList.add('bg-blurred');
  focusButtonsContainer.classList.add('hidden');
  isVideoPanelOpen = true;

  // Overlay the iframe on top of the video-wrapper using CSS positioning
  // (instead of moving it in the DOM, which would reload the iframe and break playback)
  syncIframeToWrapper(iframe);

  // Play particle intro animation
  playStreamIntroAnimation(iframe);
}

/**
 * Sync the position/size of the iframe with the video-wrapper element.
 * The iframe stays in its original DOM position but is visually repositioned.
 */
function syncIframeToWrapper(iframe: HTMLIFrameElement) {
  const rect = videoWrapper.getBoundingClientRect();
  iframe.style.position = 'fixed';
  iframe.style.left = rect.left + 'px';
  iframe.style.top = rect.top + 'px';
  iframe.style.width = rect.width + 'px';
  iframe.style.height = rect.height + 'px';
  iframe.style.zIndex = '51';
  iframe.style.pointerEvents = 'none'; // Preclude interactions like pausing or revealing controls
  iframe.style.borderRadius = '0 0 12px 12px';
}

/**
 * Reset the iframe back to its hidden 1x1 state.
 */
function resetIframeStyles(iframe: HTMLIFrameElement) {
  iframe.style.position = '';
  iframe.style.left = '';
  iframe.style.top = '';
  iframe.style.width = '';
  iframe.style.height = '';
  iframe.style.zIndex = '';
  iframe.style.opacity = '';
  iframe.style.pointerEvents = '';
  iframe.style.borderRadius = '';
}

/**
 * Position the compact video panel near the focused hub in screen space.
 * When the deep-dive detail panel is open (right side), bias the video to the left.
 */
function positionPanelNearHub() {
  if (focusedNodeId === null || isVideoExpanded) return;

  const node = graphData.nodes[focusedNodeId];
  const v = node.position.clone();
  v.project(camera);

  const halfW = window.innerWidth / 2;
  const halfH = window.innerHeight / 2;
  const screenX = (v.x * halfW) + halfW;
  const screenY = -(v.y * halfH) + halfH;

  const panelW = 420;
  const panelH = 280;

  let panelLeft: number;
  let panelTop = screenY - 140; // Center vertically on the hub

  if (isDeepDiveOpen) {
    // Deep-dive panel is on the right — place video to the LEFT of the hub
    panelLeft = screenX - panelW - 60;
    // If that goes off-screen left, clamp to left edge
    if (panelLeft < 20) panelLeft = 20;
    // Extra safety: don't overlap the deep-dive panel (right side, 320px wide + 20px margin)
    const maxRight = window.innerWidth - 320 - 40;
    if (panelLeft + panelW > maxRight) {
      panelLeft = maxRight - panelW;
    }
  } else {
    // Default: place to the right of the hub
    panelLeft = screenX + 60;
    if (panelLeft + panelW > window.innerWidth - 20) {
      panelLeft = screenX - panelW - 60; // Flip to left side
    }
  }

  if (panelLeft < 20) panelLeft = 20;
  if (panelTop < 20) panelTop = 20;
  if (panelTop + panelH > window.innerHeight - 80) {
    panelTop = window.innerHeight - panelH - 80;
  }

  videoPanelContainer.style.left = panelLeft + 'px';
  videoPanelContainer.style.top = panelTop + 'px';
}

function toggleVideoExpand() {
  isVideoExpanded = !isVideoExpanded;
  if (isVideoExpanded) {
    videoPanelContainer.classList.add('expanded');
    expandVideoBtn.textContent = '⊡';
    expandVideoBtn.title = 'Collapse';
  } else {
    videoPanelContainer.classList.remove('expanded');
    expandVideoBtn.textContent = '⛶';
    expandVideoBtn.title = 'Expand';
    positionPanelNearHub();
  }

  // Re-sync iframe position after expand/collapse transition
  if (focusedNodeId !== null) {
    const iframe = ytManager.getIframe(focusedNodeId.toString());
    if (iframe) {
      // Wait for CSS transition to finish, then re-sync
      setTimeout(() => syncIframeToWrapper(iframe), 450);
    }
  }
}

function closeVideoPanel() {
  if (focusedNodeId !== null) {
    const iframe = ytManager.getIframe(focusedNodeId.toString());
    if (iframe && isVideoPanelOpen) {
      // Play outro animation before actually closing the panel
      playStreamOutroAnimation(iframe, () => {
        finishCloseVideoPanel(iframe);
      });
      return;
    }
  }
  finishCloseVideoPanel(null);
}

function finishCloseVideoPanel(iframe: HTMLIFrameElement | null) {
  if (iframe) {
    resetIframeStyles(iframe);
  }
  videoPanelContainer.classList.add('hidden');
  videoPanelContainer.classList.remove('expanded');
  glcanvas.classList.remove('bg-blurred');
  focusButtonsContainer.classList.remove('hidden');
  isVideoPanelOpen = false;
  isVideoExpanded = false;
  expandVideoBtn.textContent = '⛶';
  expandVideoBtn.title = 'Expand';
}

/**
 * Open the Deep Dive experience for a focused StreamHub node.
 * Shows the detail panel, auto-opens the video, and dims the constellation.
 */
function openDeepDive(nodeId: number) {
  const node = graphData.nodes[nodeId];
  if (!node || node.type !== NodeType.StreamHub) return;

  // Populate the detail panel
  deepDiveTitle.textContent = node.text;

  // Find connected Article nodes and list their headlines
  deepDiveArticles.innerHTML = '';
  const connectedArticles: GraphNode[] = [];
  for (const connId of node.connections) {
    const connNode = graphData.nodes[connId];
    if (connNode && connNode.type === NodeType.Article) {
      connectedArticles.push(connNode);
    }
  }

  // Also gather articles connected to those articles (2nd degree) for richer content
  const articleIds = new Set(connectedArticles.map(a => a.id));
  for (const article of connectedArticles) {
    for (const connId of article.connections) {
      const connNode = graphData.nodes[connId];
      if (connNode && connNode.type === NodeType.Article && !articleIds.has(connNode.id)) {
        connectedArticles.push(connNode);
        articleIds.add(connNode.id);
        if (connectedArticles.length >= 20) break; // Cap at 20 headlines
      }
    }
    if (connectedArticles.length >= 20) break;
  }

  for (const article of connectedArticles.slice(0, 20)) {
    const li = document.createElement('li');
    li.textContent = article.text;
    li.addEventListener('click', () => {
      flyToNode(article.id);
    });
    deepDiveArticles.appendChild(li);
  }

  // Show the deep dive panel
  deepDivePanel.classList.remove('hidden');
  isDeepDiveOpen = true;

  // Dim the constellation
  glcanvas.classList.add('constellation-dimmed');
}

/**
 * Start live transcription using the Web Speech API.
 * Listens via the microphone and transcribes audio playing through speakers.
 */
function startTranscription() {
  if (!SpeechRecognition) {
    transcriptPlaceholder.textContent = 'Speech recognition not supported in this browser.';
    return;
  }

  stopTranscription(); // Clean up any previous session
  topicDetector.reset();

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  // Clear old transcript
  transcriptContainer.innerHTML = '';
  let interimEl: HTMLParagraphElement | null = null;

  recognition.onresult = (event: any) => {
    let interimText = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;

      if (event.results[i].isFinal) {
        // Remove interim element if present
        if (interimEl) {
          interimEl.remove();
          interimEl = null;
        }

        // Add final line
        const p = document.createElement('p');
        p.className = 'transcript-line';
        const trimmed = transcript.trim();
        p.textContent = trimmed;
        transcriptContainer.appendChild(p);

        // Feed to topic detector
        topicDetector.feedText(trimmed);
        updateTopicBadge();

        // Auto-scroll to bottom
        transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
      } else {
        interimText += transcript;
      }
    }

    // Show interim text
    if (interimText) {
      if (!interimEl) {
        interimEl = document.createElement('p');
        interimEl.className = 'transcript-line interim';
        transcriptContainer.appendChild(interimEl);
      }
      interimEl.textContent = interimText;
      transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
    }
  };

  recognition.onerror = (event: any) => {
    console.warn('Speech recognition error:', event.error);
    if (event.error === 'not-allowed') {
      transcriptPlaceholder.textContent = 'Microphone access denied.';
      transcriptContainer.innerHTML = '';
      transcriptContainer.appendChild(transcriptPlaceholder);
    }
  };

  // Auto-restart on end (speech recognition can stop after silence)
  recognition.onend = () => {
    if (isTranscribing) {
      try {
        recognition.start();
      } catch (_) { /* already started */ }
    }
  };

  try {
    recognition.start();
    isTranscribing = true;
  } catch (e) {
    console.warn('Failed to start speech recognition:', e);
  }
}

/**
 * Stop live transcription and clear the transcript container.
 */
function stopTranscription() {
  isTranscribing = false;
  if (recognition) {
    try {
      recognition.onend = null; // Prevent auto-restart
      recognition.stop();
    } catch (_) { /* not started */ }
    recognition = null;
  }

  // Reset to placeholder
  if (transcriptContainer) {
    transcriptContainer.innerHTML = '';
    transcriptContainer.appendChild(transcriptPlaceholder);
    transcriptPlaceholder.textContent = 'Listening for audio…';
  }

  // Hide topic badge
  topicBadge.classList.add('hidden');
}

/**
 * Update the topic badge and hub node color based on detected topic.
 */
function updateTopicBadge() {
  const result = topicDetector.getTopTopic();

  if (!result) {
    topicBadge.classList.add('hidden');
    return;
  }

  // Update badge
  topicBadge.textContent = `${result.emoji} ${result.name}`;
  topicBadge.style.backgroundColor = result.color;
  topicBadge.classList.remove('hidden');

  // Update the hub node's 3D color
  if (focusedNodeId !== null) {
    const node = graphData.nodes[focusedNodeId];
    if (node && node.type === NodeType.StreamHub) {
      node.currentTopic = result.name;
      node.color.setHex(result.threeColor);
      nodeMesh.setColorAt(focusedNodeId, node.color);
      if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;
    }
  }
}

/**
 * Close the deep dive detail panel.
 */
function closeDeepDive() {
  stopTranscription();
  deepDivePanel.classList.add('hidden');
  isDeepDiveOpen = false;
  glcanvas.classList.remove('constellation-dimmed');
}

function exitFocusMode() {
  if (isVideoPanelOpen) {
    closeVideoPanel();
  }

  // Close deep dive panel
  closeDeepDive();

  focusedNodeId = null;


  // Fade all YouTube streams back to full volume
  ytManager.getNodeIds().forEach(nodeId => {
    audioFadeTargets.set(nodeId, 1.0);
  });

  // Hide focus buttons
  focusButtonsContainer.classList.add('hidden');

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
    // If already in deep-dive for another node, close it first
    if (isDeepDiveOpen) {
      closeDeepDive();
      if (isVideoPanelOpen) {
        closeVideoPanel();
      }
    }

    focusedNodeId = nodeId;

    // Set fade targets: focused source stays full, others fade out
    ytManager.getNodeIds().forEach(nId => {
      if (nId === nodeId.toString()) {
        audioFadeTargets.set(nId, 1.0);
      } else {
        audioFadeTargets.set(nId, 0.0);
      }
    });

    // Show focus buttons ("Watch Stream" and "Exit Focus")
    focusButtonsContainer.classList.remove('hidden');


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

  // --- Ambient Hum: crossfade based on camera distance to sphere ---
  if (ambientHumGain) {
    const camDist = camera.position.length();
    let humTarget = 0.0;

    if (isMuted) {
      humTarget = 0.0;
    } else if (!isAudioActive) {
      // Before entering the 3D world, play hum at full volume
      humTarget = 0.35;
    } else {
      // Inside the 3D world: fade hum based on proximity to sphere center
      // Full hum when far (>500), silent when deep inside (<150)
      if (camDist > 500) {
        humTarget = 0.35;
      } else if (camDist < 150) {
        humTarget = 0.0;
      } else {
        // Smoothstep crossfade from 0.35 to 0.0 as distance goes from 500 to 150
        let t = (camDist - 150) / 350; // 0 at 150, 1 at 500
        t = t * t * (3 - 2 * t); // smoothstep
        humTarget = 0.35 * t;
      }
    }

    // Smooth the volume transition (~1.5s ramp at 60fps)
    ambientHumGain.gain.value += (humTarget - ambientHumGain.gain.value) * 0.03;
  }

  updatePhysics(time);
  updateInteraction();
  updateProximityLabels();

  if (asteroidsMesh) {
    asteroidsMesh.rotation.y = time * 0.00003; // Give the entire asteroid belt a slow, steady orbit
  }

  // Track the video panel and iframe position each frame
  if (isVideoPanelOpen && focusedNodeId !== null) {
    if (!isVideoExpanded) {
      positionPanelNearHub();
    }
    // Sync iframe overlay to the video-wrapper's screen position
    const iframe = ytManager.getIframe(focusedNodeId.toString());
    if (iframe) {
      syncIframeToWrapper(iframe);
    }
  }

  // --- Per-player spatial volume (YouTube IFrame API) ---
  // Compute volume for each YouTube stream based on camera distance to its node.
  {
    // Lazily initialize spatial cue oscillators (needs active AudioContext)
    if (!spatialCuesInitialized && isAudioActive) {
      initSpatialCues();
    }

    let globalEnvelope = 0.0;

    if (isAudioActive && !isMuted) {
      if (focusedNodeId !== null) {
        // In focus mode, keep full volume (fades handle per-node control)
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

    // Smooth the global envelope (0.02 factor ≈ gentle ~1s ramp at 60fps)
    if (Math.abs(currentMasterVolume - globalEnvelope) > 0.0005) {
      currentMasterVolume += (globalEnvelope - currentMasterVolume) * 0.02;
    } else {
      currentMasterVolume = globalEnvelope;
    }

    // Apply per-player spatial volume via YouTube API
    ytManager.getNodeIds().forEach(nodeId => {
      const nodePos = audioNodePositions.get(nodeId);

      // Focus-mode fade target
      const fadeTarget = audioFadeTargets.get(nodeId) ?? 1.0;

      // Smooth fade toward target (0.012 factor ≈ gradual ~3s swell at 60fps)
      const currentFade = audioFadeCurrents.get(nodeId) ?? 0.0;
      let newFade = currentFade;
      if (Math.abs(currentFade - fadeTarget) > 0.003) {
        newFade = currentFade + (fadeTarget - currentFade) * 0.012;
      } else {
        newFade = fadeTarget;
      }
      audioFadeCurrents.set(nodeId, newFade);

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

      // --- Stereo Pan & Volume Biasing ---
      let stereoPan = 0;
      if (nodePos) {
        stereoPan = computeStereoPan(nodePos);
      }

      // Apply volume bias: nodes on the left get a slight boost, right gets slight cut
      // This creates spatial separation even though YouTube audio is mono-controlled
      // Pan range is [-0.85, 0.85], bias range is [0.87, 1.13]
      const volumeBias = 1.0 + (stereoPan * -0.15);

      // Compute final volume (0-100 for YouTube API)
      // When muted or inactive, force volume to 0 — setVolume handles muting
      let finalVol = 0;
      if (isAudioActive && !isMuted) {
        finalVol = Math.max(0, Math.min(100, Math.round(
          currentMasterVolume * spatialGain * newFade * volumeBias * 100
        )));
      }
      ytManager.setVolume(nodeId, finalVol);

      // --- Update Spatial Audio Cue ---
      const cue = spatialCueNodes.get(nodeId);
      if (cue) {
        // Set real stereo panner position
        cue.panner.pan.value += (stereoPan - cue.panner.pan.value) * 0.1;

        // Cue volume: very quiet, proportional to proximity — only audible when close
        // Scale with master volume and spatial gain for consistency
        let cueVol = 0;
        if (isAudioActive && !isMuted) {
          cueVol = currentMasterVolume * spatialGain * newFade * 0.04; // Very subtle
        }
        cue.gain.gain.value += (cueVol - cue.gain.gain.value) * 0.08;
      }
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
