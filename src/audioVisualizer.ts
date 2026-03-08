import * as THREE from 'three';

/**
 * AudioVisualizer
 * 
 * Creates a solid glowing sphere around a StreamHub node whose vertices
 * are displaced sporadically outward along their normals based on audio
 * frequency data. Uses SphereGeometry for smooth rounded surfaces with
 * blended frequency band mapping for organic but non-jagged displacement.
 */

const NUM_FREQUENCY_BANDS = 64;

export class AudioVisualizer {
    public group: THREE.Group;

    private solidMesh: THREE.Mesh;
    private glowMesh: THREE.Mesh;
    private basePositions: Float32Array;
    private normals: Float32Array;
    private vertexCount: number;
    private smoothedBands: Float32Array;
    private radius: number;
    private vertexSeeds: Float32Array;
    private vertexBandMap: Uint8Array;

    private baseSolidColor: THREE.Color = new THREE.Color();
    private baseGlowColor: THREE.Color = new THREE.Color();
    private intenseSolidColor: THREE.Color = new THREE.Color(0xff4422); // Orange/Red
    private intenseGlowColor: THREE.Color = new THREE.Color(0xff5533);

    constructor(nodeSize: number, theme: 'dark' | 'light' = 'dark') {
        this.group = new THREE.Group();
        this.radius = Math.max(2, nodeSize * 0.8);

        // --- Solid sphere with smooth surface ---
        const geometry = new THREE.SphereGeometry(this.radius, 64, 48);

        const posAttr = geometry.getAttribute('position');
        this.vertexCount = posAttr.count;
        this.basePositions = new Float32Array(posAttr.array.length);
        this.basePositions.set(posAttr.array as Float32Array);

        const normAttr = geometry.getAttribute('normal');
        this.normals = new Float32Array(normAttr.array.length);
        this.normals.set(normAttr.array as Float32Array);

        // Random seed per vertex
        this.vertexSeeds = new Float32Array(this.vertexCount);
        for (let i = 0; i < this.vertexCount; i++) {
            this.vertexSeeds[i] = Math.random() * Math.PI * 2;
        }

        // Map each vertex to a frequency band using spatial hash
        this.vertexBandMap = new Uint8Array(this.vertexCount);
        for (let i = 0; i < this.vertexCount; i++) {
            const bx = this.basePositions[i * 3];
            const by = this.basePositions[i * 3 + 1];
            const bz = this.basePositions[i * 3 + 2];
            const theta = Math.atan2(bz, bx);
            const phi = Math.acos(Math.max(-1, Math.min(1, by / this.radius)));
            const spatialHash = (theta * 7.3 + phi * 11.7 + this.vertexSeeds[i] * 3.1);
            this.vertexBandMap[i] = Math.abs(Math.floor(spatialHash * NUM_FREQUENCY_BANDS / (Math.PI * 2))) % NUM_FREQUENCY_BANDS;
        }

        // Solid surface material
        const solidHex = theme === 'light' ? 0x333333 : 0x33ffaa;
        this.baseSolidColor.setHex(solidHex);
        const solidMaterial = new THREE.MeshBasicMaterial({
            color: this.baseSolidColor.clone(),
            transparent: true,
            opacity: 0.35,
            depthWrite: false,
            blending: theme === 'light' ? THREE.NormalBlending : THREE.AdditiveBlending,
            side: THREE.DoubleSide,
        });

        this.solidMesh = new THREE.Mesh(geometry, solidMaterial);
        this.group.add(this.solidMesh);

        // --- Outer glow halo ---
        const glowGeo = new THREE.SphereGeometry(this.radius * 1.15, 32, 24);
        const glowHex = theme === 'light' ? 0x555555 : 0x66ffdd;
        this.baseGlowColor.setHex(glowHex);
        const glowMat = new THREE.MeshBasicMaterial({
            color: this.baseGlowColor.clone(),
            transparent: true,
            opacity: 0.08,
            depthWrite: false,
            blending: theme === 'light' ? THREE.NormalBlending : THREE.AdditiveBlending,
            side: THREE.DoubleSide,
        });
        this.glowMesh = new THREE.Mesh(glowGeo, glowMat);
        this.group.add(this.glowMesh);

        this.smoothedBands = new Float32Array(NUM_FREQUENCY_BANDS).fill(0);
    }

    update(dataArray: Uint8Array, time: number, energyLevel: number = 0.0): void {
        const binCount = dataArray.length;

        // --- Aggregate into bands ---
        const binsPerBand = Math.max(1, Math.floor(binCount / NUM_FREQUENCY_BANDS));
        for (let b = 0; b < NUM_FREQUENCY_BANDS; b++) {
            let sum = 0;
            const start = b * binsPerBand;
            const end = Math.min(start + binsPerBand, binCount);
            for (let j = start; j < end; j++) {
                sum += dataArray[j];
            }
            const avg = sum / (end - start) / 255.0;
            this.smoothedBands[b] += (avg - this.smoothedBands[b]) * 0.35;
        }

        // --- Displace vertices ---
        const positions = this.solidMesh.geometry.getAttribute('position');
        const posArray = positions.array as Float32Array;
        const timeScale = time * 0.001;

        for (let i = 0; i < this.vertexCount; i++) {
            const i3 = i * 3;
            const bx = this.basePositions[i3];
            const by = this.basePositions[i3 + 1];
            const bz = this.basePositions[i3 + 2];
            const nx = this.normals[i3];
            const ny = this.normals[i3 + 1];
            const nz = this.normals[i3 + 2];

            // Blend 5 neighboring bands for smoother transitions
            const band = this.vertexBandMap[i];
            const b1 = (band - 2 + NUM_FREQUENCY_BANDS) % NUM_FREQUENCY_BANDS;
            const b2 = (band - 1 + NUM_FREQUENCY_BANDS) % NUM_FREQUENCY_BANDS;
            const b3 = (band + 1) % NUM_FREQUENCY_BANDS;
            const b4 = (band + 2) % NUM_FREQUENCY_BANDS;
            const amp = this.smoothedBands[band] * 0.4 +
                this.smoothedBands[b2] * 0.2 +
                this.smoothedBands[b3] * 0.2 +
                this.smoothedBands[b1] * 0.1 +
                this.smoothedBands[b4] * 0.1;

            // Smooth wobble
            const seed = this.vertexSeeds[i];
            const speed = timeScale * (1.0 + energyLevel * 2.0);
            const jitter = Math.sin(speed * 1.8 + seed) * 0.12 +
                Math.sin(speed * 3.2 + seed * 1.7) * 0.08 +
                Math.cos(speed * 2.1 + seed * 0.9) * 0.06;

            const displacement = amp * this.radius * (1.2 + energyLevel * 0.5) + jitter * this.radius * (0.12 + energyLevel * 0.1);

            posArray[i3] = bx + nx * displacement;
            posArray[i3 + 1] = by + ny * displacement;
            posArray[i3 + 2] = bz + nz * displacement;
        }

        positions.needsUpdate = true;
        this.solidMesh.geometry.computeVertexNormals();

        // --- Energy glow ---
        let totalEnergy = 0;
        for (let b = 0; b < NUM_FREQUENCY_BANDS; b++) {
            totalEnergy += this.smoothedBands[b];
        }
        const avgEnergy = totalEnergy / NUM_FREQUENCY_BANDS;

        const solidMat = this.solidMesh.material as THREE.MeshBasicMaterial;
        solidMat.opacity = 0.35 + avgEnergy * 0.5;
        solidMat.color.copy(this.baseSolidColor).lerp(this.intenseSolidColor, energyLevel);

        const glowMat = this.glowMesh.material as THREE.MeshBasicMaterial;
        glowMat.opacity = 0.05 + avgEnergy * 0.2;
        glowMat.color.copy(this.baseGlowColor).lerp(this.intenseGlowColor, energyLevel);
        this.glowMesh.scale.setScalar(1.15 + avgEnergy * 0.3 + energyLevel * 0.15);

        this.group.rotation.y += 0.003 + (energyLevel * 0.015);
        this.group.rotation.x += 0.002 + (energyLevel * 0.01);
    }

    setPosition(pos: THREE.Vector3): void {
        this.group.position.copy(pos);
    }

    setTheme(theme: 'dark' | 'light'): void {
        const solidHex = theme === 'light' ? 0x333333 : 0x33ffaa;
        this.baseSolidColor.setHex(solidHex);
        const solidMat = this.solidMesh.material as THREE.MeshBasicMaterial;
        // Don't overwrite the current color entirely, just base, so lerp works
        solidMat.color.copy(this.baseSolidColor);
        solidMat.blending = theme === 'light' ? THREE.NormalBlending : THREE.AdditiveBlending;

        const glowHex = theme === 'light' ? 0x555555 : 0x66ffdd;
        this.baseGlowColor.setHex(glowHex);
        const glowMat = this.glowMesh.material as THREE.MeshBasicMaterial;
        glowMat.color.copy(this.baseGlowColor);
        glowMat.blending = theme === 'light' ? THREE.NormalBlending : THREE.AdditiveBlending;
    }
}
