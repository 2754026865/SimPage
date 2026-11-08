import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

export const wallpaperPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');

// Every Worker upstream is local and deterministic. No production KV or network.
export function createLocalWorker({ port, password = 'test-local-runtime-only' } = {}) {
  const upstreamCalls = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    scriptPath: '.cache/build/worker.js', modules: true,
    host: '127.0.0.1', ...(port ? { port } : {}),
    compatibilityDate: '2024-03-26', cf: false,
    kvNamespaces: ['SIMPAGE_DATA', 'SESSIONS'],
    durableObjects: Object.fromEntries(['VisitorCounterDO', 'LoginRateLimitDO', 'AppStateDO'].map((className, index) =>
      [['VISITOR_COUNTER', 'LOGIN_RATE_LIMIT', 'APP_STATE'][index], { className, useSQLite: true }])),
    sitePath: 'public',
    bindings: { ADMIN_PASSWORD: password },
    outboundService: async request => {
      const url = new URL(request.url);
      upstreamCalls.push(url.origin + url.pathname);
      if (url.origin === 'https://api.bimg.cc' && url.pathname === '/today') {
        return new Response(null, { status: 302, headers: { Location: 'https://bing.com/test-wallpaper.png' } });
      }
      if (url.origin === 'https://bing.com' && url.pathname === '/test-wallpaper.png') {
        return new Response(wallpaperPng, { headers: { 'Content-Type': 'image/png' } });
      }
      if (url.origin === 'https://geocoding-api.open-meteo.com') {
        return Response.json({ results: [{ latitude: 39.9, longitude: 116.4, name: url.searchParams.get('name') }] });
      }
      if (url.origin === 'https://api.open-meteo.com') {
        return Response.json({ current_weather: { temperature: 18, windspeed: 5, weathercode: 1, time: '2026-11-08T12:00' } });
      }
      if (url.origin === 'https://iconcc.439933.xyz') {
        return Response.json({ ok: true, short_url: 'https://example.com/test-icon.png' });
      }
      throw new Error('Unexpected upstream in local test: ' + url.origin);
    },
  }));
  return { mf, upstreamCalls };
}

