import * as THREE from 'three';

export const NodeType = {
    Core: 0,
    StreamHub: 1,
    Article: 2
} as const;
export type NodeType = typeof NodeType[keyof typeof NodeType];

export interface GraphNode {
    id: number;
    type: NodeType;
    position: THREE.Vector3;
    basePosition: THREE.Vector3; // For drift return
    velocity: THREE.Vector3;
    size: number;
    connections: number[];
    color: THREE.Color;
    text: string;
    youtubeVideoId?: string;
    energyLevel?: number; // 0.0 to 1.0 (audio tension level)
}

export interface Edge {
    source: number;
    target: number;
}

export interface GraphData {
    nodes: GraphNode[];
    edges: Edge[];
}

export const BOUNDS_RADIUS = 340; // Must stay within the visual bounding sphere (350)

export const GRAPH_CONFIG = {
    streamHubCountMin: 28,
    streamHubCountMax: 28, // Matches the number of real outlets
    streamHubDistanceSpread: 320, // Spread further to accommodate more hubs

    clusterSizeMin: 50,
    clusterSizeMax: 300,
    clusterRadius: 60, // Max radius from node center for cluster particles
    clusterSigma: 0.4, // Gaussian sigma as fraction of clusterRadius (controls tightness)

    knnConnections: 3, // k = 3
    bridgeEdgesCount: 15,

    nodeSizes: {
        core: 6.0,
        streamHubMin: 2.0,
        streamHubMax: 4.0,
        articleMin: 0.2,
        articleMax: 1.0,
    }
};

function randomRange(min: number, max: number) {
    return Math.random() * (max - min) + min;
}

function randomPointInSphere(radius: number): THREE.Vector3 {
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = Math.cbrt(Math.random()) * radius;

    const sinPhi = Math.sin(phi);
    return new THREE.Vector3(
        r * sinPhi * Math.cos(theta),
        r * sinPhi * Math.sin(theta),
        r * Math.cos(phi)
    );
}

// Box-Muller transform for Gaussian random values
function gaussianRandom(): number {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// Generate a radial offset from origin using Gaussian distribution, clamped to maxRadius
function gaussianRadialOffset(sigma: number, maxRadius: number): THREE.Vector3 {
    const ox = gaussianRandom() * sigma;
    const oy = gaussianRandom() * sigma;
    const oz = gaussianRandom() * sigma;
    const offset = new THREE.Vector3(ox, oy, oz);
    // Clamp to max radius so all particles stay within bounds
    if (offset.length() > maxRadius) {
        offset.normalize().multiplyScalar(maxRadius);
    }
    return offset;
}

export function getRandomNodeColor(type: NodeType): THREE.Color {
    if (type === NodeType.Core) return new THREE.Color(0xff2266); // Neon pinkish red
    if (type === NodeType.StreamHub) return new THREE.Color(0x00e5ff); // Cyan
    // Articles: mostly white, some pale blue
    return Math.random() > 0.8 ? new THREE.Color(0xffffff) : new THREE.Color(0xaaaaff);
}

export function generateGraph(): GraphData {
    const nodes: GraphNode[] = [];
    const edges: Edge[] = [];
    let nextId = 0;

    // 1. Core Hub
    const centralNode: GraphNode = {
        id: nextId++,
        type: NodeType.Core,
        position: new THREE.Vector3(0, 0, 0),
        basePosition: new THREE.Vector3(0, 0, 0),
        velocity: new THREE.Vector3(),
        size: GRAPH_CONFIG.nodeSizes.core,
        connections: [],
        color: getRandomNodeColor(NodeType.Core),
        text: "Global News Core Assembly",
        energyLevel: 0.0
    };
    nodes.push(centralNode);

    // Mock Data Arrays
    const outlets = [
        { name: "NBC News NOW", videoId: "enKWyZH6dVI" },
        { name: "ABC News Live", videoId: "_03-Efdda7s" },
        { name: "CBS News 24/7", videoId: "r6qOTHqM3NQ" },
        { name: "Al Jazeera English", videoId: "gCNeDWCI0vo" },
        { name: "CGTN", videoId: "BOy2xDU1LC8" },
        { name: "France 24 English", videoId: "Ap-UM1O9RBU" },
        { name: "DW News", videoId: "LuKwFajn37U" },
        { name: "Euronews", videoId: "pykpO5kQJ98" },
        { name: "India Today", videoId: "flcpBdx4dds" },
        { name: "LiveNOW from FOX", videoId: "zlt9KDUdvUY" },
        { name: "Africanews", videoId: "NQjabLGdP5g" },
        { name: "ABC News Australia", videoId: "vOTiJkg1voo" },
        { name: "NDTV", videoId: "HgRRa1A5Wk4" },
        { name: "NHK World Japan", videoId: "f0lYkdA-Gtw" },
        { name: "TeleSUR English", videoId: "3nN3vtMzxTo" },
        { name: "WION", videoId: "vfszY1JYbMc" },
        { name: "GB News", videoId: "QliL4CGc7iY" },
        { name: "Bloomberg Television", videoId: "iEpJwprxDdk" },
        { name: "Sky News", videoId: "c82yitE5rE4" },
        { name: "CNA", videoId: "XWq5kBlakcQ" },
        { name: "TRT World", videoId: "ABfFhWzWs0s" },
        { name: "Firstpost", videoId: "sP5j2k9f_Gw" },
        { name: "Republic World", videoId: "55tZ1Mc1bqk" },
        { name: "Agenda-Free TV", videoId: "ugCJZaFyCVU" },
        { name: "CNN News18", videoId: "c2JXUHrcRvU" },
        { name: "The Sun", videoId: "yp_hqUbayWg" },
        { name: "Reuters Live", videoId: "WqMPQjCiCjE" },
        { name: "Global News", videoId: "nqiC9PjInCw" },
    ];

    const headlinePrefixes = [
        "Breaking: ", "Update: ", "Exclusive: ", "Report: ", "Analysis: ", "Live: ", "Alert: "
    ];
    const headlineTopics = [
        "inflation data shows unexpected slowdown",
        "federal reserve signals rate decision ahead",
        "tech earnings exceed Wall Street expectations",
        "housing market shows signs of recovery",
        "unemployment claims drop to six-month low",
        "trade tensions escalate between major economies",
        "AI regulation bill advances in Congress",
        "oil prices surge after OPEC announcement",
        "healthcare reform legislation gains momentum",
        "immigration policy overhaul proposed",
        "climate summit yields new carbon pledges",
        "education funding bill passes committee vote",
        "consumer confidence index rises sharply",
        "infrastructure spending plan unveiled"
    ];

    // 2. Stream Hubs
    const numHubs = Math.floor(randomRange(GRAPH_CONFIG.streamHubCountMin, GRAPH_CONFIG.streamHubCountMax + 1));
    const hubIndices: number[] = [];

    for (let i = 0; i < numHubs; i++) {
        const pos = randomPointInSphere(GRAPH_CONFIG.streamHubDistanceSpread);
        // Push outwards a bit to avoid central occlusion
        if (pos.length() < GRAPH_CONFIG.streamHubDistanceSpread * 0.3) {
            pos.normalize().multiplyScalar(GRAPH_CONFIG.streamHubDistanceSpread * 0.3);
        }

        const outlet = outlets[i % outlets.length];
        const suffix = i >= outlets.length ? ` (Stream ${i + 1})` : "";

        const streamHub: GraphNode = {
            id: nextId++,
            type: NodeType.StreamHub,
            position: pos.clone(),
            basePosition: pos.clone(),
            velocity: new THREE.Vector3(),
            size: randomRange(GRAPH_CONFIG.nodeSizes.streamHubMin, GRAPH_CONFIG.nodeSizes.streamHubMax),
            connections: [],
            color: getRandomNodeColor(NodeType.StreamHub),
            text: outlet.name + suffix,
            youtubeVideoId: outlet.videoId,
            energyLevel: 0.0
        };
        nodes.push(streamHub);
        hubIndices.push(streamHub.id);

        // Edge: Core -> Stream Hub
        edges.push({ source: centralNode.id, target: streamHub.id });
        centralNode.connections.push(streamHub.id);
        streamHub.connections.push(centralNode.id);
    }

    // 3. Cluster Nodes
    const clusterNodeGroups: number[][] = []; // For bridge connections later

    for (const hubId of hubIndices) {
        const hubNode = nodes[hubId];
        const numArticles = Math.floor(randomRange(GRAPH_CONFIG.clusterSizeMin, GRAPH_CONFIG.clusterSizeMax + 1));
        const clusterIndices: number[] = [hubId]; // Include hub in KNN calculation

        for (let j = 0; j < numArticles; j++) {
            // Gaussian radial distribution centered on the hub node
            const sigma = GRAPH_CONFIG.clusterRadius * GRAPH_CONFIG.clusterSigma;
            const localOffset = gaussianRadialOffset(sigma, GRAPH_CONFIG.clusterRadius);
            const pos = hubNode.position.clone().add(localOffset);

            // Clamp within bounding sphere so no node escapes
            if (pos.length() > BOUNDS_RADIUS) {
                pos.normalize().multiplyScalar(BOUNDS_RADIUS);
            }

            // Long tail size distribution: many small, few larger
            const szT = Math.pow(Math.random(), 4); // Skew towards 0
            const size = GRAPH_CONFIG.nodeSizes.articleMin + szT * (GRAPH_CONFIG.nodeSizes.articleMax - GRAPH_CONFIG.nodeSizes.articleMin);

            const prefix = headlinePrefixes[Math.floor(Math.random() * headlinePrefixes.length)];
            const topic = headlineTopics[Math.floor(Math.random() * headlineTopics.length)];
            const headline = `${prefix} ${topic}`;

            const article: GraphNode = {
                id: nextId++,
                type: NodeType.Article,
                position: pos.clone(),
                basePosition: pos.clone(),
                velocity: new THREE.Vector3(),
                size,
                connections: [],
                color: getRandomNodeColor(NodeType.Article),
                text: headline,
                energyLevel: 0.0
            };
            nodes.push(article);
            clusterIndices.push(article.id);
        }
        clusterNodeGroups.push(clusterIndices);

        // 4. K-Nearest Neighbors within Cluster
        // Very naive O(N^2) for each cluster, but cluster size is small (up to 300) so it's fine.
        for (let i = 0; i < clusterIndices.length; i++) {
            const nodeA = nodes[clusterIndices[i]];
            // Find distances to all others in cluster
            const distances: { id: number, dist: number }[] = [];
            for (let j = 0; j < clusterIndices.length; j++) {
                if (i === j) continue;
                const nodeB = nodes[clusterIndices[j]];
                distances.push({
                    id: nodeB.id,
                    dist: nodeA.position.distanceToSquared(nodeB.position)
                });
            }
            distances.sort((a, b) => a.dist - b.dist);

            // Connect to K nearest
            const k = GRAPH_CONFIG.knnConnections;
            let connectedCount = 0;
            for (const d of distances) {
                if (connectedCount >= k) break;
                // Avoid duplicate edges
                if (!nodeA.connections.includes(d.id)) {
                    edges.push({ source: nodeA.id, target: d.id });
                    nodeA.connections.push(d.id);
                    nodes[d.id].connections.push(nodeA.id);
                }
                connectedCount++;
            }
        }
    }

    // 5. Inter-cluster bridge edges
    for (let b = 0; b < GRAPH_CONFIG.bridgeEdgesCount; b++) {
        const c1 = Math.floor(Math.random() * clusterNodeGroups.length);
        let c2 = Math.floor(Math.random() * clusterNodeGroups.length);
        if (c1 === c2) c2 = (c2 + 1) % clusterNodeGroups.length;

        const group1 = clusterNodeGroups[c1];
        const group2 = clusterNodeGroups[c2];

        const n1 = nodes[group1[Math.floor(Math.random() * group1.length)]];
        const n2 = nodes[group2[Math.floor(Math.random() * group2.length)]];

        if (!n1.connections.includes(n2.id)) {
            edges.push({ source: n1.id, target: n2.id });
            n1.connections.push(n2.id);
            n2.connections.push(n1.id);
        }
    }

    return { nodes, edges };
}
