'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/**
 * StorageManager reports disk usage and enforces retention.
 *
 * Retention is the whole point of "never buy an SD card again": we record
 * forever and, when the disk gets close to full, we delete the OLDEST clips to
 * make room. The user picks the rules (keep N GB free, cap usage %, or keep at
 * most N days). This runs on a timer.
 */
class StorageManager {
  constructor(config) {
    this.config = config;
    this.lastRun = null;
    this.lastDeleted = 0;
  }

  /** Free/total bytes for the volume that holds the storage directory. */
  async diskSpace() {
    try {
      const s = await fsp.statfs(this.config.storageDir);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize; // space available to a non-root user
      return { total, free, used: total - free };
    } catch (e) {
      return { total: 0, free: 0, used: 0, error: e.message };
    }
  }

  /** List every recording file for a camera, newest first. */
  async listCameraFiles(camId) {
    const dir = path.join(this.config.storageDir, camId);
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      return [];
    }
    const files = [];
    for (const name of names) {
      if (!name.endsWith('.mp4') || name.startsWith('.')) continue;
      try {
        const st = await fsp.stat(path.join(dir, name));
        files.push({
          camId,
          name,
          size: st.size,
          mtime: st.mtimeMs,
          day: name.slice(0, 10), // YYYY-MM-DD from the filename
        });
      } catch {
        /* file vanished mid-scan; ignore */
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    return files;
  }

  /** Per-camera totals + overall usage for the dashboard. */
  async usageSummary(cameras) {
    const perCamera = {};
    let recordingsBytes = 0;
    let oldest = Infinity;
    let newest = 0;
    let fileCount = 0;

    for (const cam of cameras) {
      const files = await this.listCameraFiles(cam.id);
      let bytes = 0;
      for (const f of files) {
        bytes += f.size;
        if (f.mtime < oldest) oldest = f.mtime;
        if (f.mtime > newest) newest = f.mtime;
      }
      fileCount += files.length;
      recordingsBytes += bytes;
      perCamera[cam.id] = {
        bytes,
        files: files.length,
        oldest: files.length ? files[files.length - 1].mtime : null,
        newest: files.length ? files[0].mtime : null,
      };
    }

    const disk = await this.diskSpace();
    // Rough estimate: how many more days can we record at the current rate?
    let estDaysLeft = null;
    if (recordingsBytes > 0 && newest > oldest) {
      const spanDays = (newest - oldest) / 86400000 || 1;
      const bytesPerDay = recordingsBytes / spanDays;
      if (bytesPerDay > 0) estDaysLeft = disk.free / bytesPerDay;
    }

    return {
      disk,
      recordingsBytes,
      fileCount,
      oldest: oldest === Infinity ? null : oldest,
      newest: newest || null,
      estDaysLeft,
      perCamera,
    };
  }

  /**
   * Delete oldest clips until we satisfy the retention policy.
   * Returns the number of files deleted.
   */
  async enforceRetention(cameras) {
    this.lastRun = Date.now();
    const r = this.config.retention || {};
    let deleted = 0;

    // Gather all files across all cameras, oldest first.
    let all = [];
    for (const cam of cameras) {
      const files = await this.listCameraFiles(cam.id);
      all = all.concat(files);
    }
    all.sort((a, b) => a.mtime - b.mtime); // oldest first

    // 1) Age-based cap (optional).
    if (r.maxDays && r.maxDays > 0) {
      const cutoff = Date.now() - r.maxDays * 86400000;
      for (const f of all) {
        if (f.mtime < cutoff) {
          if (await this._unlink(f)) deleted++;
        }
      }
      all = all.filter((f) => f.mtime >= cutoff);
    }

    // 2) Space-based cap: keep deleting the oldest until we're under the limits.
    const minFreeBytes = (r.minFreeGB || 0) * 1024 ** 3;
    let idx = 0;
    // Guard against an infinite loop; re-check disk after each delete batch.
    while (idx < all.length) {
      const disk = await this.diskSpace();
      const usagePct = disk.total ? ((disk.total - disk.free) / disk.total) * 100 : 0;
      const needSpace = minFreeBytes && disk.free < minFreeBytes;
      const overPct = r.maxUsagePercent && usagePct > r.maxUsagePercent;
      if (!needSpace && !overPct) break;

      // Delete a small batch, then re-measure (statfs is the source of truth).
      const batch = all.slice(idx, idx + 5);
      if (batch.length === 0) break;
      for (const f of batch) {
        if (await this._unlink(f)) deleted++;
      }
      idx += batch.length;
    }

    this.lastDeleted = deleted;
    if (deleted) console.log(`[storage] retention removed ${deleted} old clip(s)`);
    return deleted;
  }

  async _unlink(f) {
    try {
      await fsp.unlink(path.join(this.config.storageDir, f.camId, f.name));
      return true;
    } catch {
      return false;
    }
  }

  ensureStorageWritable() {
    fs.mkdirSync(this.config.storageDir, { recursive: true });
    const probe = path.join(this.config.storageDir, '.vigil-write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  }
}

module.exports = { StorageManager };
