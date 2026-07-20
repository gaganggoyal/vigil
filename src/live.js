'use strict';

const { spawn } = require('./util');

const BOUNDARY = 'vigilframe';
const IDLE_MS = 15000; // stop the ffmpeg process this long after the last viewer leaves
const EOI_MARKER = Buffer.from([0xff, 0xd9]); // JPEG End-Of-Image marker

/**
 * One shared MJPEG stream per camera, produced on demand.
 *
 * Recording uses "-c copy" (no CPU). Live preview is the one place we spend a
 * little CPU, so we keep it cheap: we use the camera's low-res sub-stream when
 * available, cap the framerate, and scale down. Crucially, ONE ffmpeg process
 * feeds ALL browsers watching that camera, and it shuts off the moment nobody
 * is looking. MJPEG plays natively in an <img>, so the browser needs no plugin
 * or JavaScript video library at all.
 */
class LiveStream {
  constructor(cam) {
    this.cam = cam;
    this.proc = null;
    this.clients = new Set(); // http.ServerResponse objects
    this.latestFrame = null; // most recent JPEG buffer (also used for snapshots)
    this.latestAt = 0;
    this.buf = Buffer.alloc(0);
    this.idleTimer = null;
  }

  sourceUrl() {
    return this.cam.subUrl || this.cam.url;
  }

  start() {
    if (this.proc) return;
    const args = [
      '-nostdin', '-loglevel', 'error',
      '-rtsp_transport', 'tcp',
      '-timeout', '10000000',
      '-i', this.sourceUrl(),
      '-an', // no audio for preview
      '-r', '8', // 8 fps is smooth enough for a monitoring preview
      '-vf', 'scale=-2:480', // downscale to 480p tall; keeps CPU + bandwidth low
      '-q:v', '7',
      '-f', 'mjpeg',
      'pipe:1',
    ];
    this.proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.on('exit', () => {
      this.proc = null;
      // If viewers are still attached (e.g. camera hiccup), retry shortly.
      if (this.clients.size > 0) setTimeout(() => this.start(), 2000);
    });
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    // A raw MJPEG stream is just JPEG frames back-to-back. Each ends at the
    // End-Of-Image marker 0xFFD9 (which never appears in entropy-coded data
    // because those bytes are stuffed). Split on it and emit whole frames.
    let eoi;
    while ((eoi = this.buf.indexOf(EOI_MARKER)) !== -1) {
      const frame = this.buf.subarray(0, eoi + 2);
      this.buf = this.buf.subarray(eoi + 2);
      if (frame.length > 100) this._emit(frame);
    }
    // Guard against unbounded growth if something goes wrong.
    if (this.buf.length > 8 * 1024 * 1024) this.buf = Buffer.alloc(0);
  }

  _emit(frame) {
    this.latestFrame = frame;
    this.latestAt = Date.now();
    const head = Buffer.from(
      `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`
    );
    for (const res of this.clients) {
      try {
        res.write(head);
        res.write(frame);
        res.write('\r\n');
      } catch {
        this.clients.delete(res);
      }
    }
  }

  addClient(res) {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'Cache-Control': 'no-cache, no-store',
      Connection: 'close',
      Pragma: 'no-cache',
    });
    this.clients.add(res);
    res.on('close', () => this.removeClient(res));
    this.start();
  }

  removeClient(res) {
    this.clients.delete(res);
    if (this.clients.size === 0 && !this.idleTimer) {
      this.idleTimer = setTimeout(() => this.stop(), IDLE_MS);
    }
  }

  stop() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.proc && !this.proc.killed) this.proc.kill('SIGTERM');
    this.proc = null;
  }
}

class LiveManager {
  constructor() {
    this.streams = new Map(); // camId -> LiveStream
  }

  _get(cam) {
    if (!this.streams.has(cam.id)) this.streams.set(cam.id, new LiveStream(cam));
    const s = this.streams.get(cam.id);
    s.cam = cam; // pick up url changes
    return s;
  }

  attach(cam, res) {
    this._get(cam).addClient(res);
  }

  /** Grab a single JPEG. Reuses a running live frame; otherwise shoots one. */
  async snapshot(cam) {
    const s = this.streams.get(cam.id);
    if (s && s.latestFrame && Date.now() - s.latestAt < 5000) return s.latestFrame;

    return new Promise((resolve, reject) => {
      const args = [
        '-nostdin', '-loglevel', 'error',
        '-rtsp_transport', 'tcp', '-timeout', '10000000',
        '-i', cam.subUrl || cam.url,
        '-frames:v', '1', '-q:v', '6', '-vf', 'scale=-2:480',
        '-f', 'image2', 'pipe:1',
      ];
      const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = [];
      p.stdout.on('data', (c) => chunks.push(c));
      const timer = setTimeout(() => p.kill('SIGKILL'), 12000);
      p.on('exit', (code) => {
        clearTimeout(timer);
        const buf = Buffer.concat(chunks);
        if (buf.length > 100) resolve(buf);
        else reject(new Error(`snapshot failed (code ${code})`));
      });
      p.on('error', reject);
    });
  }

  stopAll() {
    for (const s of this.streams.values()) s.stop();
  }
}

module.exports = { LiveManager };
