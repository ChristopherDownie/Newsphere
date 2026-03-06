/**
 * YouTubePlayerManager
 *
 * Manages hidden YouTube IFrame players for 24/7 live news streams.
 * Each player is created off-screen and controlled via the YT IFrame API.
 * Volume is controlled per-player for spatial audio mixing.
 */

// YouTube IFrame API types (minimal subset)
declare global {
    interface Window {
        YT: typeof YT;
        onYouTubeIframeAPIReady: (() => void) | undefined;
    }
    namespace YT {
        class Player {
            constructor(elementId: string | HTMLElement, config: PlayerConfig);
            playVideo(): void;
            pauseVideo(): void;
            stopVideo(): void;
            setVolume(volume: number): void;
            getVolume(): number;
            mute(): void;
            unMute(): void;
            isMuted(): boolean;
            getPlayerState(): number;
            getIframe(): HTMLIFrameElement;
            destroy(): void;
        }
        interface PlayerConfig {
            height?: string | number;
            width?: string | number;
            videoId?: string;
            host?: string;
            playerVars?: Record<string, string | number>;
            events?: {
                onReady?: (event: { target: Player }) => void;
                onStateChange?: (event: { target: Player; data: number }) => void;
                onError?: (event: { target: Player; data: number }) => void;
            };
        }
        enum PlayerState {
            UNSTARTED = -1,
            ENDED = 0,
            PLAYING = 1,
            PAUSED = 2,
            BUFFERING = 3,
            CUED = 5,
        }
    }
}

export interface YouTubeSource {
    nodeId: number;
    videoId: string;
    name: string;
}

interface ManagedPlayer {
    player: YT.Player | null;
    nodeId: number;
    videoId: string;
    name: string;
    containerId: string;
    ready: boolean;
    currentVolume: number;
}

export class YouTubePlayerManager {
    private players: Map<string, ManagedPlayer> = new Map(); // keyed by nodeId string
    private container: HTMLDivElement;
    private apiReady: boolean = false;
    private pendingSources: YouTubeSource[] = [];
    private onAllReadyCallback: (() => void) | null = null;

    constructor() {
        // Create hidden container for YouTube iframes
        this.container = document.createElement('div');
        this.container.id = 'yt-players-container';
        // A perfectly safe invisible anchor that won't clip fixed descendants in any browser
        this.container.style.cssText =
            'position:absolute;top:0;left:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:50;';
        document.body.appendChild(this.container);
    }

    /**
     * Load the YouTube IFrame API script and wait for it to be ready.
     */
    loadAPI(): Promise<void> {
        return new Promise((resolve) => {
            if (window.YT && window.YT.Player) {
                this.apiReady = true;
                resolve();
                return;
            }

            // Set the global callback
            window.onYouTubeIframeAPIReady = () => {
                this.apiReady = true;
                // Create any pending players
                for (const source of this.pendingSources) {
                    this._createPlayer(source);
                }
                this.pendingSources = [];
                resolve();
            };

            // Load the script
            const tag = document.createElement('script');
            tag.src = 'https://www.youtube.com/iframe_api';
            const firstScript = document.getElementsByTagName('script')[0];
            firstScript.parentNode!.insertBefore(tag, firstScript);
        });
    }

    /**
     * Add a YouTube source. If the API isn't ready yet, it will be queued.
     */
    addSource(source: YouTubeSource): void {
        if (this.apiReady) {
            this._createPlayer(source);
        } else {
            this.pendingSources.push(source);
        }
    }

    /**
     * Set callback for when all registered players are ready.
     */
    onAllReady(callback: () => void): void {
        this.onAllReadyCallback = callback;
    }

    private _createPlayer(source: YouTubeSource): void {
        const containerId = `yt-player-${source.nodeId}`;

        // Create a container div for this player
        const div = document.createElement('div');
        div.id = containerId;
        this.container.appendChild(div);

        const managed: ManagedPlayer = {
            player: null,
            nodeId: source.nodeId,
            videoId: source.videoId,
            name: source.name,
            containerId,
            ready: false,
            currentVolume: 0,
        };

        this.players.set(source.nodeId.toString(), managed);

        // Create the YT.Player with the video ID directly
        managed.player = new YT.Player(containerId, {
            height: '1',
            width: '1',
            videoId: source.videoId,
            playerVars: {
                autoplay: 0,
                controls: 0,
                modestbranding: 1,
                rel: 0,
                mute: 1, // Start muted to allow autoplay
                playsinline: 1,
                origin: window.location.origin,
            },
            events: {
                onReady: (_event) => {
                    managed.ready = true;
                    // Video is already loaded via videoId, just mark ready
                    console.log(`[YT] Player ready: ${source.name}`);
                    this._checkAllReady();
                },
                onStateChange: (event) => {
                    // If video ends, try to restart (live streams shouldn't end)
                    if (event.data === 0 /* ENDED */) {
                        setTimeout(() => {
                            event.target.playVideo();
                        }, 2000);
                    }
                },
                onError: (event) => {
                    console.warn(`[YT] Error ${event.data} for ${source.name}`);
                    // Error 150 = embedding restricted; Error 101 = not found
                    // Try reloading after a delay
                    if (event.data === 150 || event.data === 101 || event.data === 2) {
                        setTimeout(() => {
                            try {
                                (event.target as any).loadVideoById(source.videoId, 0);
                            } catch {
                                console.warn(`[YT] Could not reload ${source.name}`);
                            }
                        }, 5000);
                    }
                },
            },
        });
    }

    private _checkAllReady(): void {
        const allReady = Array.from(this.players.values()).every((p) => p.ready);
        if (allReady && this.onAllReadyCallback) {
            this.onAllReadyCallback();
        }
    }

    /**
     * Start all players. Must be called after a user gesture.
     * Players remain MUTED — the per-frame spatial volume loop
     * will unmute individual players when their volume > 0.
     */
    playAll(): void {
        this.players.forEach((managed) => {
            if (managed.ready && managed.player) {
                try {
                    // Keep the player muted and at volume 0.
                    // The animate loop's setVolume() will handle unmuting.
                    managed.player.setVolume(0);
                    managed.currentVolume = 0;
                    // Start playback while muted (mute:1 was set in playerVars)
                    managed.player.playVideo();
                } catch (e) {
                    console.warn(`[YT] Play failed for ${managed.name}:`, e);
                }
            }
        });
    }

    /**
     * Pause all players.
     */
    pauseAll(): void {
        this.players.forEach((managed) => {
            if (managed.ready && managed.player) {
                try {
                    managed.player.pauseVideo();
                } catch (e) {
                    // ignore
                }
            }
        });
    }

    /**
     * Set volume for a specific node's player (0 - 100).
     * Handles mute/unmute automatically: mutes when vol=0, unmutes when vol>0.
     */
    setVolume(nodeId: string, volume: number): void {
        const managed = this.players.get(nodeId);
        if (managed && managed.ready && managed.player) {
            const clamped = Math.max(0, Math.min(100, Math.round(volume)));
            try {
                if (clamped === 0) {
                    // Mute and set volume 0 for true silence
                    if (managed.currentVolume !== 0) {
                        managed.player.mute();
                        managed.player.setVolume(0);
                        managed.currentVolume = 0;
                    }
                } else {
                    // Unmute if currently at 0, then set volume
                    if (managed.currentVolume === 0) {
                        managed.player.setVolume(clamped);
                        managed.player.unMute();
                    } else if (managed.currentVolume !== clamped) {
                        managed.player.setVolume(clamped);
                    }
                    managed.currentVolume = clamped;
                }
            } catch {
                // ignore during transitions
            }
        }
    }

    /**
     * Mute all players.
     */
    muteAll(): void {
        this.players.forEach((managed) => {
            if (managed.ready && managed.player) {
                try {
                    managed.player.mute();
                } catch {
                    // ignore
                }
            }
        });
    }

    /**
     * Unmute all players.
     */
    unmuteAll(): void {
        this.players.forEach((managed) => {
            if (managed.ready && managed.player) {
                try {
                    managed.player.unMute();
                } catch {
                    // ignore
                }
            }
        });
    }

    /**
     * Get the iframe element for a specific player (for future video display in focus mode).
     */
    getIframe(nodeId: string): HTMLIFrameElement | null {
        const managed = this.players.get(nodeId);
        if (managed && managed.ready && managed.player) {
            try {
                return managed.player.getIframe();
            } catch {
                return null;
            }
        }
        return null;
    }

    /**
     * Return iframe to the hidden container and reset its size.
     */
    resetIframe(nodeId: string): void {
        const managed = this.players.get(nodeId);
        if (managed && managed.ready && managed.player) {
            try {
                const iframe = managed.player.getIframe();
                const container = document.getElementById(managed.containerId);
                if (iframe && container && iframe.parentElement !== container) {
                    container.appendChild(iframe);
                }
            } catch {
                // ignore
            }
        }
    }

    /**
     * Force a specific player to resume playback.
     * Useful after moving the iframe to a new DOM parent.
     */
    playSource(nodeId: string): void {
        const managed = this.players.get(nodeId);
        if (managed && managed.ready && managed.player) {
            try {
                managed.player.playVideo();
            } catch {
                // ignore
            }
        }
    }

    /**
     * Check if a player is currently playing.
     */
    isPlaying(nodeId: string): boolean {
        const managed = this.players.get(nodeId);
        if (managed && managed.ready && managed.player) {
            try {
                return managed.player.getPlayerState() === 1;
            } catch {
                return false;
            }
        }
        return false;
    }

    /**
     * Get all managed player node IDs.
     */
    getNodeIds(): string[] {
        return Array.from(this.players.keys());
    }
}
