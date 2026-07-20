'use strict';

const fs = require('fs');
const path = require('path');
const { slugify } = require('./util');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

const DEFAULTS = {
  port: 8080,
  host: '0.0.0.0',
  storageDir: path.join(__dirname, '..', 'recordings'),
  segmentSeconds: 600, // 10 minute files
  retention: {
    minFreeGB: 5, // always keep at least this much free
    maxUsagePercent: 90, // never let the disk go above this
    maxDays: 0, // 0 = disabled; otherwise delete footage older than N days
  },
  recordAudio: true,
  cameras: [],
};

let cache = null;

function deepMerge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const key of Object.keys(override || {})) {
    const v = override[key];
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof base[key] === 'object') {
      out[key] = deepMerge(base[key], v);
    } else {
      out[key] = v;
    }
  }
  return out;
}

function load() {
  if (cache) return cache;
  let fileData = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      fileData = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
      throw new Error(`config.json is not valid JSON: ${e.message}`);
    }
  }
  cache = deepMerge(DEFAULTS, fileData);
  // Resolve storageDir to an absolute path relative to the project root.
  if (!path.isAbsolute(cache.storageDir)) {
    cache.storageDir = path.resolve(__dirname, '..', cache.storageDir);
  }
  cache.cameras = (cache.cameras || []).map(normalizeCamera);
  return cache;
}

function normalizeCamera(cam) {
  const id = cam.id || slugify(cam.name || cam.url);
  return {
    id,
    name: cam.name || id,
    url: cam.url || '',
    subUrl: cam.subUrl || '', // low-res stream used for live view / snapshots (optional)
    enabled: cam.enabled !== false,
  };
}

function save(next) {
  cache = deepMerge(DEFAULTS, next);
  if (!path.isAbsolute(cache.storageDir)) {
    cache.storageDir = path.resolve(__dirname, '..', cache.storageDir);
  }
  cache.cameras = (cache.cameras || []).map(normalizeCamera);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(stripForDisk(cache), null, 2));
  return cache;
}

// Store storageDir as given (may be absolute) but keep it human-editable.
function stripForDisk(cfg) {
  return {
    port: cfg.port,
    host: cfg.host,
    storageDir: cfg.storageDir,
    segmentSeconds: cfg.segmentSeconds,
    retention: cfg.retention,
    recordAudio: cfg.recordAudio,
    cameras: cfg.cameras.map((c) => ({
      id: c.id,
      name: c.name,
      url: c.url,
      subUrl: c.subUrl,
      enabled: c.enabled,
    })),
  };
}

/** Mutate + persist. `mutator(cfg)` edits the config in place. */
function update(mutator) {
  const cfg = load();
  mutator(cfg);
  return save(cfg);
}

module.exports = { load, save, update, CONFIG_PATH, DEFAULTS };
