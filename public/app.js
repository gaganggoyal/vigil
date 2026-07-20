'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const json = () => ({ 'Content-Type': 'application/json' });
const api = (p, opts) => fetch(p, opts).then(async (r) => {
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || r.statusText);
  return j;
});

let STATE = { cameras: [], status: {}, usage: null, settings: {} };
let editingId = null;
const snapTimers = new Map();

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

// ---------------------------------------------------------------------------
// State + render
// ---------------------------------------------------------------------------
async function refresh() {
  try {
    STATE = await api('/api/state');
    renderStorageBar();
    renderCameras();
    if ($('#view-storage').classList.contains('active')) renderStorage();
    if ($('#view-settings').classList.contains('active')) fillSettings();
  } catch (e) {
    $('#statusPill').textContent = '● offline';
    $('#statusPill').className = 'pill pill-warn';
  }
}

function renderStorageBar() {
  const u = STATE.usage;
  if (!u) return;
  const pct = u.disk.total ? Math.min(100, (u.disk.used / u.disk.total) * 100) : 0;
  $('#diskFill').style.width = pct.toFixed(1) + '%';
  $('#diskText').textContent = `${u.diskHuman.free} free · ${u.recordingsHuman} recorded`;
  const anyRec = Object.values(STATE.status).some((s) => s.state === 'recording');
  const pill = $('#statusPill');
  pill.textContent = anyRec ? '● recording' : (STATE.cameras.length ? '● idle' : '● no cameras');
  pill.className = 'pill ' + (anyRec ? 'pill-live' : 'pill-warn');
}

function statusInfo(id) {
  const s = STATE.status[id] || { state: 'stopped' };
  if (s.state === 'recording') return { cls: 'rec', label: 'REC' };
  if (s.state === 'connecting') return { cls: 'recon', label: 'CONNECTING' };
  if (s.state === 'reconnecting') return { cls: 'recon', label: 'RECONNECTING' };
  return { cls: 'off', label: 'OFF' };
}

function renderCameras() {
  const grid = $('#cameraGrid');
  const empty = $('#emptyState');
  if (!STATE.cameras.length) {
    grid.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  // Only rebuild cards when the set of cameras changes, so refreshing snapshots
  // isn't interrupted. We diff by id list.
  const ids = STATE.cameras.map((c) => c.id).join(',');
  if (grid.dataset.ids !== ids) {
    grid.dataset.ids = ids;
    for (const t of snapTimers.values()) clearInterval(t);
    snapTimers.clear();
    grid.innerHTML = '';
    for (const cam of STATE.cameras) grid.appendChild(cardFor(cam));
  }
  // Update badges + meta live.
  for (const cam of STATE.cameras) {
    const card = grid.querySelector(`[data-cam="${cam.id}"]`);
    if (!card) continue;
    const info = statusInfo(cam.id);
    card.querySelector('.cam-badge').innerHTML = `<span class="dot ${info.cls}"></span>${info.label}`;
    const meta = STATE.usage?.perCamera?.[cam.id];
    card.querySelector('.cam-meta').textContent = meta ? `${meta.files} clips` : '';
  }
}

function cardFor(cam) {
  const el = document.createElement('div');
  el.className = 'cam-card';
  el.dataset.cam = cam.id;
  el.innerHTML = `
    <div class="cam-thumb">
      <img alt="${escapeHtml(cam.name)}" hidden />
      <div class="thumb-fallback">Connecting…</div>
      <div class="cam-badge"><span class="dot off"></span>…</div>
      <div class="cam-play"><span>▶</span></div>
    </div>
    <div class="cam-foot">
      <div><div class="cam-name">${escapeHtml(cam.name)}</div><div class="cam-meta"></div></div>
      <button class="icon-btn cam-edit" title="Edit">✎</button>
    </div>`;
  const img = el.querySelector('img');
  const fb = el.querySelector('.thumb-fallback');
  const loadSnap = () => { img.src = `/api/cameras/${cam.id}/snapshot?t=${Date.now()}`; };
  img.onerror = () => { img.hidden = true; fb.hidden = false; };
  img.onload = () => { img.hidden = false; fb.hidden = true; };
  loadSnap();
  snapTimers.set(cam.id, setInterval(loadSnap, 15000));

  el.querySelector('.cam-thumb').onclick = () => openViewer(cam);
  el.querySelector('.cam-edit').onclick = (e) => { e.stopPropagation(); openEdit(cam); };
  return el;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------------------------------------------------------------------------
// Live viewer (MJPEG in an <img>)
// ---------------------------------------------------------------------------
function openViewer(cam) {
  $('#viewerCaption').textContent = cam.name + ' · live';
  $('#viewerImg').src = `/api/cameras/${cam.id}/live`;
  $('#viewer').hidden = false;
}
function closeViewer() {
  $('#viewerImg').src = ''; // dropping the request lets the ffmpeg stream idle out
  $('#viewer').hidden = true;
}

// ---------------------------------------------------------------------------
// Storage view
// ---------------------------------------------------------------------------
function renderStorage() {
  const u = STATE.usage;
  if (!u) return;
  const pct = u.disk.total ? (u.disk.used / u.disk.total) * 100 : 0;
  const est = u.estDaysLeft != null && isFinite(u.estDaysLeft) ? Math.round(u.estDaysLeft) + ' days' : '—';
  $('#storageCards').innerHTML = `
    ${stat('Disk free', u.diskHuman.free)}
    ${stat('Footage stored', u.recordingsHuman, `${u.fileCount} clips`)}
    ${stat('Disk in use', pct.toFixed(0) + '%', `of ${u.diskHuman.total}`)}
    ${stat('Est. recording left', est, 'at current rate')}`;

  const rows = STATE.cameras.map((c) => {
    const m = u.perCamera[c.id] || { bytes: 0, files: 0 };
    const share = u.recordingsBytes ? (m.bytes / u.recordingsBytes) * 100 : 0;
    return `<div class="usage-row">
      <div>${escapeHtml(c.name)}</div>
      <div>${human(m.bytes)}</div>
      <div>${m.files} clips</div>
      <div class="usage-bar"><i style="width:${share}%"></i></div>
    </div>`;
  }).join('');
  $('#usageTable').innerHTML = `<div class="usage-row"><div>Camera</div><div>Size</div><div>Clips</div><div>Share</div></div>${rows}`;
}
const stat = (k, v, sub = '') => `<div class="stat"><div class="k">${k}</div><div class="v">${v} ${sub ? `<small>${sub}</small>` : ''}</div></div>`;
function human(b) {
  if (!isFinite(b)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

// ---------------------------------------------------------------------------
// Recordings view
// ---------------------------------------------------------------------------
async function initRecordings() {
  const sel = $('#recCam');
  const keep = sel.value;
  sel.innerHTML = STATE.cameras.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  if (STATE.cameras.length) await loadDays();
  else $('#recList').innerHTML = '<div class="hint">Add a camera first.</div>';
}
async function loadDays() {
  const id = $('#recCam').value;
  if (!id) return;
  const { days } = await api(`/api/cameras/${id}/recordings`);
  $('#recDay').innerHTML = days.length ? days.map((d) => `<option>${d}</option>`).join('') : '<option>—</option>';
  await loadClips();
}
async function loadClips() {
  const id = $('#recCam').value;
  const day = $('#recDay').value;
  if (!id || !day || day === '—') { $('#recList').innerHTML = '<div class="hint">No recordings yet.</div>'; return; }
  const { files } = await api(`/api/cameras/${id}/recordings?day=${encodeURIComponent(day)}`);
  if (!files.length) { $('#recList').innerHTML = '<div class="hint">No clips this day.</div>'; return; }
  $('#recList').innerHTML = files.map((f) =>
    `<div class="rec-item" data-name="${f.name}"><span>${f.time}</span><span class="sz">${f.sizeHuman}</span></div>`).join('');
  $$('#recList .rec-item').forEach((it) => it.onclick = () => playClip(id, it.dataset.name, it));
}
function playClip(id, name, el) {
  $$('#recList .rec-item').forEach((x) => x.classList.remove('active'));
  el.classList.add('active');
  const p = $('#player');
  p.src = `/media/${id}/${name}`;
  p.play().catch(() => {});
  $('#recCaption').textContent = `${name.slice(11, 19).replace(/-/g, ':')} · ${name.slice(0, 10)}`;
  const dl = $('#btnDownload');
  dl.href = `/download/${id}/${name}`;
  dl.hidden = false;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function fillSettings() {
  const s = STATE.settings;
  $('#setStorage').value = s.storageDir || '';
  $('#setSegment').value = s.segmentSeconds || 600;
  $('#setAudio').checked = !!s.recordAudio;
  $('#setMinFree').value = s.retention?.minFreeGB ?? 5;
  $('#setMaxPct').value = s.retention?.maxUsagePercent ?? 90;
  $('#setMaxDays').value = s.retention?.maxDays ?? 0;
}
async function saveSettings() {
  const body = {
    storageDir: $('#setStorage').value.trim(),
    segmentSeconds: +$('#setSegment').value,
    recordAudio: $('#setAudio').checked,
    retention: {
      minFreeGB: +$('#setMinFree').value,
      maxUsagePercent: +$('#setMaxPct').value,
      maxDays: +$('#setMaxDays').value,
    },
  };
  try {
    const r = await api('/api/settings', { method: 'PUT', headers: json(), body: JSON.stringify(body) });
    $('#savedNote').textContent = '✓ Saved' + (r.portChanged ? ' (port change applies on next restart)' : '');
    setTimeout(() => ($('#savedNote').textContent = ''), 4000);
    refresh();
  } catch (e) { toast(e.message, 'bad'); }
}

// ---------------------------------------------------------------------------
// Add / edit camera modal
// ---------------------------------------------------------------------------
function openAdd() {
  editingId = null;
  $('#modalTitle').textContent = 'Add camera';
  $('#camName').value = ''; $('#camUrl').value = ''; $('#camSub').value = '';
  $('#testResult').textContent = '';
  $('#btnDelete').hidden = true;
  $('#modal').hidden = false;
  $('#camName').focus();
}
function openEdit(cam) {
  editingId = cam.id;
  $('#modalTitle').textContent = 'Edit camera';
  $('#camName').value = cam.name;
  $('#camUrl').value = cam.url;   // masked; leaving it unchanged keeps the stored password
  $('#camSub').value = cam.subUrl;
  $('#testResult').textContent = '';
  $('#btnDelete').hidden = false;
  $('#modal').hidden = false;
}
function closeModal() { $('#modal').hidden = true; }

async function saveCam() {
  const body = { name: $('#camName').value, url: $('#camUrl').value, subUrl: $('#camSub').value };
  if (!body.url) return toast('An RTSP address is required', 'bad');
  try {
    if (editingId) await api(`/api/cameras/${editingId}`, { method: 'PUT', headers: json(), body: JSON.stringify(body) });
    else await api('/api/cameras', { method: 'POST', headers: json(), body: JSON.stringify(body) });
    closeModal();
    toast(editingId ? 'Camera updated' : 'Camera added — recording started', 'good');
    refresh();
  } catch (e) { toast(e.message, 'bad'); }
}
async function testCam() {
  const btn = $('#btnTest'); const out = $('#testResult');
  out.className = 'test-result'; out.textContent = 'Testing…';
  btn.disabled = true;
  try {
    // When editing, target the saved camera so a masked url resolves to the real
    // one. When adding, any id works — the server just tests the url we send.
    const id = editingId || '__new__';
    const r = await api(`/api/cameras/${id}/test`, { method: 'POST', headers: json(), body: JSON.stringify({ url: $('#camUrl').value }) });
    if (r.ok) { out.className = 'test-result ok'; out.textContent = `✓ Connected · ${r.codec || '?'} ${r.width || ''}×${r.height || ''}`; }
    else { out.className = 'test-result bad'; out.textContent = '✗ ' + (r.error || 'failed'); }
  } catch (e) { out.className = 'test-result bad'; out.textContent = '✗ ' + e.message; }
  btn.disabled = false;
}
async function deleteCam() {
  if (!editingId) return;
  if (!confirm('Remove this camera? Recorded footage stays on disk.')) return;
  try {
    await api(`/api/cameras/${editingId}`, { method: 'DELETE' });
    const t = snapTimers.get(editingId); if (t) clearInterval(t);
    closeModal(); toast('Camera removed', 'good'); refresh();
  } catch (e) { toast(e.message, 'bad'); }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------
async function discover() {
  $('#discoverModal').hidden = false;
  $('#discoverBody').innerHTML = '<div class="scanning">Scanning your network for cameras…<br><small>(this takes a few seconds)</small></div>';
  try {
    const { devices } = await api('/api/discover');
    if (!devices.length) {
      $('#discoverBody').innerHTML = '<div class="scanning">No ONVIF cameras responded.<br><small>You can still add a camera manually with its RTSP address.</small></div>';
      return;
    }
    $('#discoverBody').innerHTML = devices.map((d) => `
      <div class="disc-item">
        <div class="ip">📷 ${d.ip}</div>
        <div class="hint">Pick a stream format to try, then set the user/password:</div>
        <div class="disc-sug">${d.suggestions.map((s) =>
          `<button class="disc-chip" data-url="${encodeURIComponent(s.url)}">${s.label}</button>`).join('')}</div>
      </div>`).join('');
    $$('.disc-chip').forEach((c) => c.onclick = () => {
      $('#discoverModal').hidden = true;
      openAdd();
      $('#camUrl').value = decodeURIComponent(c.dataset.url);
      $('#camName').focus();
    });
  } catch (e) {
    $('#discoverBody').innerHTML = `<div class="scanning">Scan failed: ${e.message}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------
$$('.tab').forEach((tab) => tab.onclick = () => {
  $$('.tab').forEach((t) => t.classList.remove('active'));
  $$('.view').forEach((v) => v.classList.remove('active'));
  tab.classList.add('active');
  $('#view-' + tab.dataset.tab).classList.add('active');
  if (tab.dataset.tab === 'storage') renderStorage();
  if (tab.dataset.tab === 'settings') fillSettings();
  if (tab.dataset.tab === 'recordings') initRecordings();
});

$('#btnAdd').onclick = openAdd;
$('#btnDiscover').onclick = discover;
$('#modalClose').onclick = $('#btnCancel').onclick = closeModal;
$('#btnSaveCam').onclick = saveCam;
$('#btnTest').onclick = testCam;
$('#btnDelete').onclick = deleteCam;
$('#discoverClose').onclick = () => ($('#discoverModal').hidden = true);
$('#viewerClose').onclick = closeViewer;
$('#viewer').onclick = (e) => { if (e.target.id === 'viewer') closeViewer(); };
$('#btnSaveSettings').onclick = saveSettings;
$('#recCam').onchange = loadDays;
$('#recDay').onchange = loadClips;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeViewer(); closeModal(); $('#discoverModal').hidden = true; } });

refresh();
setInterval(refresh, 5000);
