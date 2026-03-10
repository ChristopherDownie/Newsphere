/**
 * TopicDetector
 * 
 * Analyzes transcript text using keyword scoring to detect the dominant topic
 * of a live news stream. Scores decay over time so the topic tracks what's
 * being discussed NOW, not minutes ago.
 */

export interface TopicDefinition {
    name: string;
    emoji: string;
    color: string;       // CSS color for badge
    threeColor: number;  // Hex for THREE.Color
    keywords: string[];
}

export interface TopicResult {
    name: string;
    emoji: string;
    color: string;
    threeColor: number;
    score: number;
}

export const TOPICS: TopicDefinition[] = [
    {
        name: 'Politics',
        emoji: '🏛️',
        color: '#6366f1',     // Indigo
        threeColor: 0x6366f1,
        keywords: [
            'president', 'congress', 'senate', 'legislation', 'election', 'vote',
            'democrat', 'republican', 'campaign', 'governor', 'policy', 'partisan',
            'bipartisan', 'amendment', 'impeach', 'cabinet', 'executive order',
            'political', 'politician', 'lawmaker', 'parliament', 'prime minister',
            'opposition', 'coalition', 'ballot', 'constituency', 'referendum',
            'democrat', 'republican', 'liberal', 'conservative', 'progressive',
            'white house', 'capitol', 'administration', 'judicial', 'supreme court'
        ]
    },
    {
        name: 'Economy',
        emoji: '💰',
        color: '#10b981',     // Emerald
        threeColor: 0x10b981,
        keywords: [
            'market', 'stocks', 'inflation', 'economy', 'gdp', 'trade', 'tariff',
            'unemployment', 'jobs', 'interest rate', 'federal reserve', 'fed',
            'wall street', 'nasdaq', 'dow jones', 'recession', 'growth', 'deficit',
            'debt', 'fiscal', 'monetary', 'earnings', 'profit', 'revenue',
            'investor', 'bond', 'treasury', 'banking', 'finance', 'financial',
            'economic', 'bitcoin', 'crypto', 'currency', 'dollar', 'consumer',
            'spending', 'retail', 'housing', 'mortgage', 'oil prices', 'commodity'
        ]
    },
    {
        name: 'World Affairs',
        emoji: '🌍',
        color: '#f59e0b',     // Amber
        threeColor: 0xf59e0b,
        keywords: [
            'war', 'conflict', 'military', 'troops', 'sanctions', 'diplomacy',
            'summit', 'nato', 'united nations', 'ambassador', 'foreign policy',
            'cease fire', 'ceasefire', 'peace talks', 'refugee', 'humanitarian',
            'invasion', 'occupation', 'alliance', 'treaty', 'international',
            'border', 'territory', 'sovereignty', 'missile', 'nuclear',
            'global', 'overseas', 'diplomatic', 'embassy', 'geopolitical',
            'negotiation', 'coalition', 'peacekeeping', 'deployment'
        ]
    },
    {
        name: 'Tech & Science',
        emoji: '🔬',
        color: '#06b6d4',     // Cyan
        threeColor: 0x06b6d4,
        keywords: [
            'artificial intelligence', 'ai', 'technology', 'tech', 'space',
            'nasa', 'climate', 'research', 'scientist', 'innovation', 'startup',
            'silicon valley', 'software', 'hardware', 'cybersecurity', 'hack',
            'data', 'algorithm', 'machine learning', 'robot', 'automation',
            'renewable', 'solar', 'electric vehicle', 'battery', 'quantum',
            'genome', 'vaccine', 'biotech', 'satellite', 'launch', 'orbit',
            'discovery', 'experiment', 'laboratory', 'breakthrough', 'patent',
            'internet', 'social media', 'app', 'digital', 'cloud computing'
        ]
    },
    {
        name: 'Breaking',
        emoji: '⚡',
        color: '#ef4444',     // Red
        threeColor: 0xef4444,
        keywords: [
            'breaking', 'urgent', 'just in', 'developing', 'alert',
            'emergency', 'crisis', 'shooting', 'explosion', 'earthquake',
            'disaster', 'evacuation', 'rescue', 'death toll', 'casualties',
            'wildfire', 'hurricane', 'tornado', 'flood', 'crash', 'attack',
            'suspect', 'manhunt', 'lockdown', 'active shooter', 'terror',
            'collapsed', 'mass casualty', 'missing', 'fatalities'
        ]
    },
    {
        name: 'General',
        emoji: '📰',
        color: '#8b5cf6',     // Violet
        threeColor: 0x8b5cf6,
        keywords: [
            'news', 'report', 'story', 'update', 'coverage', 'interview',
            'announcement', 'press conference', 'statement', 'investigation',
            'community', 'public', 'society', 'culture', 'sports', 'health',
            'education', 'crime', 'justice', 'court', 'trial', 'verdict',
            'weather', 'forecast', 'entertainment', 'celebrity'
        ]
    }
];

const DECAY_FACTOR = 0.92;  // Scores decay by 8% each feed cycle

export class TopicDetector {
    private scores: Map<string, number> = new Map();
    private feedCount = 0;

    constructor() {
        for (const topic of TOPICS) {
            this.scores.set(topic.name, 0);
        }
    }

    /**
     * Feed transcript text into the detector.
     * Scores all topics based on keyword matches and applies decay.
     */
    feedText(text: string): void {
        const lower = text.toLowerCase();
        this.feedCount++;

        // Apply decay to existing scores
        for (const topic of TOPICS) {
            const current = this.scores.get(topic.name) || 0;
            this.scores.set(topic.name, current * DECAY_FACTOR);
        }

        // Score each topic by counting keyword matches
        for (const topic of TOPICS) {
            let matchScore = 0;
            for (const keyword of topic.keywords) {
                if (lower.includes(keyword)) {
                    // Multi-word keywords get bonus weight
                    matchScore += keyword.includes(' ') ? 2.0 : 1.0;
                }
            }
            if (matchScore > 0) {
                const current = this.scores.get(topic.name) || 0;
                this.scores.set(topic.name, current + matchScore);
            }
        }
    }

    /**
     * Get the highest-scoring topic. Returns null if no meaningful signal yet.
     */
    getTopTopic(): TopicResult | null {
        if (this.feedCount < 2) return null; // Need at least a couple of feeds

        let bestTopic: TopicDefinition | null = null;
        let bestScore = 0;

        for (const topic of TOPICS) {
            const score = this.scores.get(topic.name) || 0;
            if (score > bestScore) {
                bestScore = score;
                bestTopic = topic;
            }
        }

        // Minimum threshold to avoid noise
        if (!bestTopic || bestScore < 1.5) return null;

        return {
            name: bestTopic.name,
            emoji: bestTopic.emoji,
            color: bestTopic.color,
            threeColor: bestTopic.threeColor,
            score: bestScore
        };
    }

    /**
     * Reset all scores (e.g., when switching to a different stream).
     */
    reset(): void {
        for (const topic of TOPICS) {
            this.scores.set(topic.name, 0);
        }
        this.feedCount = 0;
    }
}
