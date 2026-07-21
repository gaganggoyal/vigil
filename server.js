#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { URL } = require('url');

const config = require('./src/config');
const { RecorderManager } = require('./src/recorder');
const { StorageManager } = require('./src/storage');
const { LiveManager } = require('./src/live');
const onvif = require('./src/onvif');
const { humanBytes, slugify, checkFfmpeg, maskUrl, run } = require('./src/util');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

let cfg = config.load();
const recorder = new RecorderManager(cfg);
const storage = new StorageManager(cfg);
const live = new LiveManager();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function sendErr(res, status, msg) {
  sendJson(res, status, { ok: false, error: msg });
}
function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function publicCam(cam) {
  return {
    id: cam.id,
    name: cam.name,
    url: maskUrl(cam.url),
    subUrl: cam.subUrl ? maskUrl(cam.subUrl) : '',
    enabled: cam.enabled,
    hasUrl: !!cam.url,
    hasSub: !!cam.subUrl,
  };
}
// Keep the stored (real) url when the client resends a masked value or blank.
function resolveUrl(incoming, existing) {
  if (incoming == null) return existing || '';
  if (incoming === '') return existing || '';
  if (incoming.includes('••••')) return existing || '';
  return incoming;
}
const isSafeName = (n) => typeof n === 'string' && /^[\w.\-:]+$/.test(n) && !n.includes('..');

// ---------------------------------------------------------------------------
// Static + media serving (with HTTP Range support for video seeking)
// ---------------------------------------------------------------------------
async function serveFile(req, res, filePath, { download } = {}) {
  let st;
  try {
    st = await fsp.stat(filePath);
  } catch {
    return sendErr(res, 404, 'not found');
  }
  if (!st.isFile()) return sendErr(res, 404, 'not found');

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes' };
  if (download) headers['Content-Disposition'] = `attachment; filename="${path.basename(filePath)}"`;

  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
    if (Number.isNaN(start) || start < 0) start = 0;
    if (Number.isNaN(end) || end >= st.size) end = st.size - 1;
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    headers['Content-Length'] = end - start + 1;
    res.writeHead(206, headers);
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  }
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------
async function apiState() {
  const usage = await storage.usageSummary(cfg.cameras);
  return {
    ok: true,
    app: 'Vigil',
    settings: {
      port: cfg.port,
      host: cfg.host,
      storageDir: cfg.storageDir,
      segmentSeconds: cfg.segmentSeconds,
      retention: cfg.retention,
      recordAudio: cfg.recordAudio,
    },
    cameras: cfg.cameras.map(publicCam),
    status: recorder.allStatus(),
    usage: {
      ...usage,
      diskHuman: {
        total: humanBytes(usage.disk.total),
        free: humanBytes(usage.disk.free),
        used: humanBytes(usage.disk.used),
      },
      recordingsHuman: humanBytes(usage.recordingsBytes),
    },
  };
}

async function addCamera(body) {
  if (!body.url || typeof body.url !== 'string') throw new Error('An RTSP url is required.');
  const name = (body.name || '').trim() || `Camera ${cfg.cameras.length + 1}`;
  let id = slugify(body.id || name);
  const existing = new Set(cfg.cameras.map((c) => c.id));
  let base = id, n = 2;
  while (existing.has(id)) id = `${base}-${n++}`;
  const cam = { id, name, url: body.url.trim(), subUrl: (body.subUrl || '').trim(), enabled: body.enabled !== false };
  cfg = config.update((c) => c.cameras.push(cam));
  recorder.config = cfg;
  recorder.reconcile();
  return publicCam(cfg.cameras.find((c) => c.id === id));
}

async function editCamera(id, body) {
  const cam = cfg.cameras.find((c) => c.id === id);
  if (!cam) throw new Error('camera not found');
  cfg = config.update((c) => {
    const t = c.cameras.find((x) => x.id === id);
    if (body.name != null) t.name = String(body.name).trim() || t.name;
    t.url = resolveUrl(body.url, t.url);
    t.subUrl = body.subUrl != null && body.subUrl.includes('••••') ? t.subUrl : (body.subUrl ?? t.subUrl);
    if (body.enabled != null) t.enabled = !!body.enabled;
  });
  recorder.config = cfg;
  // Restart this camera's recorder so url/enabled changes take effect.
  recorder.stopCamera(id);
  recorder.reconcile();
  return publicCam(cfg.cameras.find((c) => c.id === id));
}

async function deleteCamera(id, alsoFootage) {
  const cam = cfg.cameras.find((c) => c.id === id);
  if (!cam) throw new Error('camera not found');
  recorder.stopCamera(id);
  cfg = config.update((c) => { c.cameras = c.cameras.filter((x) => x.id !== id); });
  recorder.config = cfg;
  if (alsoFootage) {
    await fsp.rm(path.join(cfg.storageDir, id), { recursive: true, force: true }).catch(() => {});
  }
  return { ok: true };
}

async function updateSettings(body) {
  const restartRecorders = body.storageDir != null || body.segmentSeconds != null || body.recordAudio != null;
  const oldPort = cfg.port;
  cfg = config.update((c) => {
    if (body.storageDir != null && String(body.storageDir).trim()) c.storageDir = String(body.storageDir).trim();
    if (body.segmentSeconds != null) c.segmentSeconds = Math.max(30, parseInt(body.segmentSeconds, 10) || 600);
    if (body.recordAudio != null) c.recordAudio = !!body.recordAudio;
    if (body.port != null) c.port = parseInt(body.port, 10) || c.port;
    if (body.retention && typeof body.retention === 'object') {
      c.retention.minFreeGB = num(body.retention.minFreeGB, c.retention.minFreeGB);
      c.retention.maxUsagePercent = num(body.retention.maxUsagePercent, c.retention.maxUsagePercent);
      c.retention.maxDays = num(body.retention.maxDays, c.retention.maxDays);
    }
  });
  recorder.config = cfg;
  storage.config = cfg;
  if (restartRecorders) {
    storage.ensureStorageWritable();
    await recorder.stopAll();
    recorder.stopping = false;
    recorder.startAll();
  }
  return { ok: true, portChanged: cfg.port !== oldPort };
}
const num = (v, d) => (v === '' || v == null || Number.isNaN(Number(v)) ? d : Number(v));

async function testCamera(body, id) {
  let url = body && body.url;
  if (id) {
    const cam = cfg.cameras.find((c) => c.id === id);
    if (cam) url = resolveUrl(url, cam.url);
  }
  if (!url) throw new Error('no url to test');
  const res = await run('ffprobe', [
    '-v', 'error', '-rtsp_transport', 'tcp', '-timeout', '8000000',
    '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,avg_frame_rate',
    '-of', 'json', url,
  ], { timeout: 12000 });
  if (res.code !== 0) {
    return { ok: false, error: (res.stderr.trim().split('\n').pop() || 'could not connect').slice(0, 200) };
  }
  let info = {};
  try { info = JSON.parse(res.stdout).streams[0] || {}; } catch {}
  return { ok: true, codec: info.codec_name, width: info.width, height: info.height, fps: info.avg_frame_rate };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
async function handle(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const parts = u.pathname.split('/').filter(Boolean);
  const method = req.method;

  try {
    // ---- Pages / static ----
    if (method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      return serveFile(req, res, path.join(PUBLIC_DIR, 'index.html'));
    }
    // Full-screen camera wall for TVs — short URL so it's easy to type on a remote.
    if (method === 'GET' && u.pathname === '/tv') {
      return serveFile(req, res, path.join(PUBLIC_DIR, 'tv.html'));
    }
    if (method === 'GET' && parts[0] === 'public' && isSafeName(parts[1] || '')) {
      return serveFile(req, res, path.join(PUBLIC_DIR, parts[1]));
    }
    if (method === 'GET' && u.pathname === '/favicon.ico') {
      return serveFile(req, res, path.join(PUBLIC_DIR, 'favicon.svg'));
    }

    // ---- API ----
    if (parts[0] === 'api') {
      if (method === 'GET' && parts[1] === 'state') return sendJson(res, 200, await apiState());
      if (method === 'GET' && parts[1] === 'health') return sendJson(res, 200, { ok: true });

      // Cameras + recorder health only — no disk walk, cheap enough for the TV
      // wall to poll every few seconds.
      if (method === 'GET' && parts[1] === 'status') {
        return sendJson(res, 200, { ok: true, cameras: cfg.cameras.map(publicCam), status: recorder.allStatus() });
      }

      if (method === 'GET' && parts[1] === 'discover') {
        const devices = await onvif.discover(4000);
        return sendJson(res, 200, { ok: true, devices });
      }

      if (parts[1] === 'settings' && (method === 'PUT' || method === 'POST')) {
        return sendJson(res, 200, await updateSettings(await readBody(req)));
      }

      if (parts[1] === 'cameras') {
        // /api/cameras
        if (!parts[2]) {
          if (method === 'GET') return sendJson(res, 200, { ok: true, cameras: cfg.cameras.map(publicCam) });
          if (method === 'POST') return sendJson(res, 201, { ok: true, camera: await addCamera(await readBody(req)) });
        }
        const id = parts[2];
        const sub = parts[3];
        // /api/cameras/:id
        if (!sub) {
          if (method === 'PUT' || method === 'PATCH') return sendJson(res, 200, { ok: true, camera: await editCamera(id, await readBody(req)) });
          if (method === 'DELETE') return sendJson(res, 200, await deleteCamera(id, u.searchParams.get('footage') === '1'));
        }
        // /api/cameras/:id/test|live|snapshot|recordings
        if (sub === 'test' && method === 'POST') return sendJson(res, 200, await testCamera(await readBody(req), id));
        if (sub === 'live' && method === 'GET') {
          const cam = cfg.cameras.find((c) => c.id === id);
          if (!cam) return sendErr(res, 404, 'camera not found');
          return live.attach(cam, res); // streams until the client disconnects
        }
        if (sub === 'snapshot' && method === 'GET') {
          const cam = cfg.cameras.find((c) => c.id === id);
          if (!cam) return sendErr(res, 404, 'camera not found');
          try {
            const jpg = await live.snapshot(cam);
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpg.length, 'Cache-Control': 'no-store' });
            return res.end(jpg);
          } catch (e) {
            return serveFile(req, res, path.join(PUBLIC_DIR, 'offline.svg'));
          }
        }
        if (sub === 'recordings' && method === 'GET') {
          const files = await storage.listCameraFiles(id);
          const days = [...new Set(files.map((f) => f.day))].sort().reverse();
          const day = u.searchParams.get('day');
          const list = (day ? files.filter((f) => f.day === day) : files)
            .map((f) => ({ name: f.name, size: f.size, sizeHuman: humanBytes(f.size), mtime: f.mtime, day: f.day, time: f.name.slice(11, 19).replace(/-/g, ':') }));
          return sendJson(res, 200, { ok: true, days, files: list });
        }
      }
      return sendErr(res, 404, 'unknown api route');
    }

    // ---- Media (recorded clips) ----
    if ((parts[0] === 'media' || parts[0] === 'download') && parts.length === 3) {
      const [, id, name] = parts;
      if (!isSafeName(id) || !isSafeName(name) || !name.endsWith('.mp4')) return sendErr(res, 400, 'bad path');
      return serveFile(req, res, path.join(cfg.storageDir, id, name), { download: parts[0] === 'download' });
    }

    return sendErr(res, 404, 'not found');
  } catch (e) {
    return sendErr(res, 400, e.message || 'error');
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main() {
  console.log('  Vigil — turning this machine into a 24/7 camera recorder\n');

  const ff = await checkFfmpeg();
  if (!ff.ok) {
    console.error('  ✗ ffmpeg was not found on your PATH.');
    console.error('    Install it, then run again:');
    console.error('      macOS:   brew install ffmpeg');
    console.error('      Ubuntu:  sudo apt install ffmpeg');
    console.error('      Windows: winget install Gyan.FFmpeg\n');
    process.exit(1);
  }
  console.log(`  ✓ ffmpeg ${ff.version}`);

  try {
    storage.ensureStorageWritable();
    console.log(`  ✓ storage: ${cfg.storageDir}`);
  } catch (e) {
    console.error(`  ✗ cannot write to storage dir ${cfg.storageDir}: ${e.message}`);
    process.exit(1);
  }

  recorder.startAll();
  const enabled = cfg.cameras.filter((c) => c.enabled).length;
  console.log(`  ✓ ${enabled} camera(s) recording, ${cfg.cameras.length} configured`);

  // Retention loop: check every 60s.
  const retentionTimer = setInterval(() => {
    storage.enforceRetention(cfg.cameras).catch((e) => console.warn('[storage]', e.message));
  }, 60_000);
  storage.enforceRetention(cfg.cameras).catch(() => {});

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => { try { sendErr(res, 500, e.message); } catch {} });
  });
  server.on('clientError', (err, socket) => { try { socket.destroy(); } catch {} });

  server.listen(cfg.port, cfg.host, () => {
    console.log(`\n  ➜  Dashboard:  http://localhost:${cfg.port}`);
    printLanUrls(cfg.port);
    console.log('\n  Press Ctrl+C to stop.\n');
  });

  async function shutdown() {
    console.log('\n  Shutting down — finishing current recordings…');
    clearInterval(retentionTimer);
    live.stopAll();
    await recorder.stopAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function printLanUrls(port) {
  const os = require('os');
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) console.log(`     On your network:  http://${ni.address}:${port}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
