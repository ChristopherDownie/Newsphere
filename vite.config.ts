import { defineConfig } from 'vite';

export default defineConfig({
    server: {
        host: true, // Listen on all local IPs
        proxy: {
            '/api/npr-live': {
                target: 'https://npr-ice.streamguys1.com',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api\/npr-live/, '/live.mp3'),
            },
            '/api/bloomberg': {
                target: 'https://playerservices.streamtheworld.com',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api\/bloomberg/, '/api/livestream-redirect/WRCAAM.mp3'),
            },
            '/api/wnyc': {
                target: 'https://fm939.wnyc.org',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api\/wnyc/, '/wnycfm'),
            },
            '/api/wqxr': {
                target: 'https://stream.wqxr.org',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api\/wqxr/, '/wqxr'),
            },
            '/api/wqxr-newsounds': {
                target: 'https://stream.wqxr.org',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api\/wqxr-newsounds/, '/wqxr-web'),
            },
            '/api/kqed': {
                target: 'https://streams.kqed.org',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api\/kqed/, '/kqedradio'),
            },
            '/api/npr-news': {
                target: 'https://npr-ice.streamguys1.com',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api\/npr-news/, '/live.mp3?_=2'),
            },
            '/api/npr-talk': {
                target: 'https://npr-ice.streamguys1.com',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api\/npr-talk/, '/live.mp3?_=3'),
            }
        }
    }
});
