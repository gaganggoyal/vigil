'use strict';

const { execFile, spawn } = require('child_process');

/** Format a byte count as a human-readable string (e.g. "4.2 GB"). */
function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Turn an arbitrary label into a filesystem/id-safe slug. */
function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || `cam-${Date.now().toString(36)}`;
}

/**
 * Run a command and resolve with { code, stdout, stderr }.
 * Never rejects on a non-zero exit — the caller decides what that means.
 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
        stdout: stdout ? stdout.toString() : '',
        stderr: stderr ? stderr.toString() : '',
        error: err || null,
      });
    });
  });
}

/** Check that ffmpeg (and ffprobe) are on PATH. Returns { ok, version }. */
async function checkFfmpeg() {
  const res = await run('ffmpeg', ['-version']);
  if (res.code !== 0) return { ok: false, version: null };
  const line = res.stdout.split('\n')[0] || '';
  const m = line.match(/ffmpeg version (\S+)/);
  return { ok: true, version: m ? m[1] : line.trim() };
}

/** Mask credentials in an RTSP url so we never log or return the password. */
function maskUrl(url) {
  return String(url || '').replace(/(rtsp:\/\/[^:/@]+:)[^@]*(@)/i, '$1••••$2');
}

const nowIso = () => new Date().toISOString();

module.exports = { humanBytes, slugify, run, checkFfmpeg, maskUrl, nowIso, spawn };
