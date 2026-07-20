'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, maskUrl, nowIso } = require('./util');

/**
 * RecorderManager keeps one long-running ffmpeg process per enabled camera.
 *
 * The key design choice for old hardware: we record with "-c copy" (stream
 * copy). ffmpeg does NOT decode or re-encode the video — it just remuxes the
 * incoming packets straight to disk. That keeps CPU usage near zero, so even a
 * decade-old laptop can record many cameras at once.
 *
 * Files are written as fragmented MP4 in fixed-length segments. Fragmented MP4
 * stays playable even if the machine loses power mid-recording (no missing moov
 * atom), which matters for an always-on box that might just get unplugged.
 */
class RecorderManager {
  constructor(config) {
    this.config = config;
    this.procs = new Map(); // camId -> ChildProcess (only while a process is live)
    this.meta = new Map(); // camId -> { restarts, backoff, timer } (survives restarts)
    this.status = new Map(); // camId -> status object
    this.stopping = false;
  }

  camDir(camId) {
    return path.join(this.config.storageDir, camId);
  }

  metaFor(camId) {
    if (!this.meta.has(camId)) this.meta.set(camId, { restarts: 0, backoff: 1000, timer: null });
    return this.meta.get(camId);
  }

  getStatus(camId) {
    return (
      this.status.get(camId) || {
        state: 'stopped',
        since: null,
        restarts: 0,
        lastError: null,
        lastSegmentAt: null,
      }
    );
  }

  allStatus() {
    const out = {};
    for (const cam of this.config.cameras) out[cam.id] = this.getStatus(cam.id);
    return out;
  }

  setStatus(camId, patch) {
    this.status.set(camId, { ...this.getStatus(camId), ...patch });
  }

  buildArgs(cam) {
    const outPath = path.join(this.camDir(cam.id), '%Y-%m-%d_%H-%M-%S.mp4');
    const args = [
      '-nostdin',
      '-loglevel', 'warning',
      '-rtsp_transport', 'tcp', // TCP is far more reliable than UDP over WiFi
      '-timeout', '10000000', // 10s socket timeout (microseconds) -> triggers reconnect
      '-i', cam.url,
    ];

    if (this.config.recordAudio) args.push('-map', '0');
    else args.push('-map', '0:v:0');

    args.push(
      '-c', 'copy', // <- the magic: no re-encode, near-zero CPU
      '-f', 'segment',
      '-segment_time', String(this.config.segmentSeconds || 600),
      '-segment_atclocktime', '1', // align cuts to the wall clock
      '-reset_timestamps', '1',
      '-strftime', '1',
      '-segment_format', 'mp4',
      '-segment_format_options', 'movflags=+frag_keyframe+empty_moov+default_base_moof',
      outPath
    );
    return args;
  }

  findCam(camId) {
    return this.config.cameras.find((c) => c.id === camId);
  }

  isEnabled(camId) {
    const c = this.findCam(camId);
    return !!(c && c.enabled);
  }

  startCamera(cam) {
    if (!cam || !cam.enabled || !cam.url) return;
    if (this.procs.has(cam.id)) return; // already running

    fs.mkdirSync(this.camDir(cam.id), { recursive: true });

    const proc = spawn('ffmpeg', this.buildArgs(cam), { stdio: ['ignore', 'ignore', 'pipe'] });
    this.procs.set(cam.id, proc);
    // 'connecting' until ffmpeg actually opens the first segment file — only
    // then do we know the stream is really flowing.
    this.setStatus(cam.id, { state: 'connecting', since: nowIso(), lastError: null });
    console.log(`[rec] ${cam.name} (${cam.id}) connecting — ${maskUrl(cam.url)}`);

    let stderrTail = '';
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      stderrTail = (stderrTail + s).slice(-2000);
      if (/Opening '.*' for writing/.test(s)) {
        this.setStatus(cam.id, { state: 'recording', lastSegmentAt: nowIso() });
        // A successful segment write means the stream is healthy — reset backoff.
        this.metaFor(cam.id).backoff = 1000;
      }
    });

    proc.on('exit', (code, signal) => {
      this.procs.delete(cam.id);
      if (this.stopping || !this.isEnabled(cam.id)) {
        this.setStatus(cam.id, { state: 'stopped', since: nowIso() });
        return;
      }
      // Unexpected exit -> reconnect with exponential backoff. Cheap cameras
      // drop connections constantly (WiFi hiccups, nightly reboots); we just
      // keep coming back until they answer again.
      const m = this.metaFor(cam.id);
      m.restarts += 1;
      m.backoff = Math.min((m.backoff || 1000) * 2, 30000);
      const errLine = (stderrTail.trim().split('\n').pop() || '').slice(0, 200);
      this.setStatus(cam.id, {
        state: 'reconnecting',
        since: nowIso(),
        restarts: m.restarts,
        lastError: errLine || `ffmpeg exited (code ${code}, signal ${signal})`,
      });
      console.warn(`[rec] ${cam.name} dropped (${code || signal}); retry in ${m.backoff}ms`);
      m.timer = setTimeout(() => this.startCamera(this.findCam(cam.id)), m.backoff);
    });
  }

  stopCamera(camId) {
    const m = this.meta.get(camId);
    if (m && m.timer) {
      clearTimeout(m.timer);
      m.timer = null;
    }
    const proc = this.procs.get(camId);
    if (proc && !proc.killed) proc.kill('SIGTERM'); // lets the muxer finalize the fragment
    this.procs.delete(camId);
    this.setStatus(camId, { state: 'stopped', since: nowIso() });
  }

  startAll() {
    for (const cam of this.config.cameras) this.startCamera(cam);
  }

  async stopAll() {
    this.stopping = true;
    for (const id of [...this.procs.keys()]) this.stopCamera(id);
    for (const m of this.meta.values()) if (m.timer) clearTimeout(m.timer);
    await new Promise((r) => setTimeout(r, 800)); // let ffmpeg flush to disk
  }

  /** Re-sync running processes with the current config (after add/edit/remove). */
  reconcile() {
    const wanted = new Set(this.config.cameras.filter((c) => c.enabled).map((c) => c.id));
    for (const id of [...this.procs.keys()]) {
      if (!wanted.has(id)) this.stopCamera(id);
    }
    for (const cam of this.config.cameras) {
      if (cam.enabled && !this.procs.has(cam.id)) this.startCamera(cam);
    }
  }
}

module.exports = { RecorderManager };
