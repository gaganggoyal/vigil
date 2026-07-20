<div align="center">

# 🛡️ Vigil

### Turn any old computer into a 24/7 security-camera recorder.

Vigil records your existing WiFi / RTSP CCTV cameras straight to a disk you already
own — local or a cheap external drive. No cloud, no subscription, and **no expensive
memory cards**. It's a full network video recorder (NVR) in **~1,500 lines of Node.js
with zero runtime dependencies.**

<br>

![Node](https://img.shields.io/badge/Node.js-18.15+-3c873a?logo=node.js&logoColor=white)
![Dependencies](https://img.shields.io/badge/runtime_dependencies-0-35d0a5)
![ffmpeg](https://img.shields.io/badge/powered_by-ffmpeg-007808?logo=ffmpeg&logoColor=white)
![Platform](https://img.shields.io/badge/platform-macOS_·_Linux_·_Windows-8a99ac)
![License](https://img.shields.io/badge/license-MIT-blue)

**[▶ Live demo & setup guide](https://claude.ai/code/artifact/5db3224a-fc36-49ca-bcdd-ce56e061bb99)**

</div>

---

## Why I built this

The AI boom drove memory-chip demand — and prices — sky-high. SD cards, NVR drives,
and cloud-camera subscriptions all got more expensive, for footage most people never
watch. Meanwhile almost everyone has an old laptop in a drawer, and almost every modern
WiFi camera already speaks **RTSP**.

Vigil bridges the two: it pulls the camera streams and writes them to hardware you
already own. The interesting engineering constraint was **"must run well on a
10-year-old dual-core"** — which shaped nearly every decision below.

## The core idea that makes it work on old hardware

A naive recorder decodes every frame and re-encodes it — pegging the CPU. Vigil instead
**stream-copies** the camera's already-compressed feed straight to disk:

```bash
ffmpeg -rtsp_transport tcp -i rtsp://camera \
       -c copy \                       # ← no decode, no re-encode: near-zero CPU
       -f segment -segment_time 600 \  # crash-safe 10-minute clips
       out_%Y-%m-%d_%H-%M-%S.mp4
```

Because ffmpeg never touches the pixels, a decade-old machine can record several
1080p cameras while sitting near idle. The only feature that spends real CPU is live
preview — and only while a browser tab is actually watching.

## Features

| | |
|---|---|
| 📼 **24/7 recording** | Continuous capture in crash-safe fragmented-MP4 segments (playable even after a power cut). |
| ♻️ **Self-recycling storage** | Records forever; auto-deletes the oldest footage when the disk fills, on rules you set. |
| 🔌 **Any disk** | Internal, USB stick, or external HDD — point it wherever you have space. |
| 👀 **Live view + snapshot wall** | On-demand MJPEG in a plain `<img>` — no browser plugin or JS video lib. |
| 🔎 **Network scan** | Finds ONVIF cameras via WS-Discovery and suggests their RTSP URLs. |
| 🔁 **Self-healing** | Auto-reconnects with exponential backoff when a camera or WiFi drops. |
| 🎞️ **Recordings browser** | Browse by day, seek in-browser (HTTP Range), download any clip. |
| 📊 **Storage dashboard** | Per-camera usage, free space, and "days of recording left". |
| 🪶 **Zero dependencies** | Just Node + ffmpeg. Nothing to `npm install`, nothing to break. |

## Architecture

```
 WiFi cameras ──RTSP──►  ┌──────────────────── Vigil (Node.js) ────────────────────┐
  (main + sub streams)   │  RecorderManager  ffmpeg -c copy → timestamped segments  │
                         │  StorageManager   fs.statfs poll + oldest-first purge     │──► your disk
  phone / browser ◄──────│  LiveManager      shared on-demand MJPEG, idles out       │   (local / USB)
                         │  http server      JSON API · static UI · Range video      │
                         │  ONVIF discovery  raw UDP WS-Discovery (dgram)             │
                         └──────────────────────────────────────────────────────────┘
```

Everything is a small, single-responsibility module — no framework, no build step:

| Module | Responsibility |
|---|---|
| [`server.js`](server.js) | Hand-rolled HTTP router: JSON API, static assets, and byte-range video streaming. |
| [`src/recorder.js`](src/recorder.js) | One ffmpeg process per camera; spawn, monitor, and auto-restart with backoff. |
| [`src/storage.js`](src/storage.js) | Disk-usage accounting and the retention/cleanup engine. |
| [`src/live.js`](src/live.js) | Shared MJPEG live streams + single-frame snapshots, refcounted and idle-stopped. |
| [`src/onvif.js`](src/onvif.js) | ONVIF WS-Discovery over UDP multicast, implemented from scratch. |
| [`src/config.js`](src/config.js) | Config load/merge/persist with sane defaults. |
| [`public/`](public/) | The dashboard — vanilla HTML/CSS/JS, no framework. |

## Notable engineering decisions

- **Zero runtime dependencies.** The whole server uses only Node built-ins
  (`http`, `child_process`, `dgram`, `fs`). No supply-chain surface, and it installs
  on an offline machine by copying a folder. Disk space comes from `fs.statfs`;
  ONVIF discovery is raw WS-Discovery over `dgram`; live view is parsed straight
  from ffmpeg's MJPEG output.
- **Crash-safe recordings.** Segments are written as fragmented MP4
  (`+frag_keyframe+empty_moov`), so a yanked power cord leaves the in-progress clip
  playable instead of a corrupt file with no `moov` atom.
- **Resilience by default.** Cheap cameras drop off WiFi constantly, so the recorder
  treats disconnects as normal: exponential backoff, capped at 30s, reset on the first
  healthy segment. Status is honest — `connecting → recording → reconnecting`.
- **CPU spent only when watched.** Live MJPEG streams are shared across all viewers of
  a camera and shut themselves off ~15s after the last viewer leaves. Recording stays
  stream-copied and near-idle regardless.
- **Security-minded.** Camera passwords are stored for connection but masked
  everywhere in the API/UI; all media paths are validated against traversal.

## Quick start

You need two things: **Node.js 18.15+** and **ffmpeg**. "Zero dependencies" means
Vigil pulls no npm packages — you still grab Vigil's own code once.

```bash
# 1. Get Vigil
git clone https://github.com/gaganggoyal/vigil.git
cd vigil
#   (no git? download the ZIP from the GitHub page → "Code" → "Download ZIP")

# 2. Install ffmpeg — the only external tool Vigil needs
#    macOS:   brew install ffmpeg
#    Ubuntu:  sudo apt install ffmpeg
#    Windows: winget install Gyan.FFmpeg

# 3. Run it — no npm install, no build step
node scripts/setup.js     # one-time: checks ffmpeg, creates config.json
npm start                 # → http://localhost:8080
```

Open the dashboard, click **➕ Add camera** (or **⌖ Scan** to auto-find cameras),
paste the RTSP address, and you're recording.

### Run it 24/7 (auto-start on boot)

| OS | Command |
|---|---|
| **macOS** | `bash scripts/install-macos.sh` (launchd) |
| **Linux** | `bash scripts/install-linux.sh` (systemd) |
| **Windows** | see [`scripts/windows-setup.md`](scripts/windows-setup.md) |

## Finding your camera's RTSP URL

Most cameras follow one of these patterns (`USER`, `PASS`, and the IP are yours):

| Brand | RTSP URL |
|---|---|
| TP-Link / Tapo | `rtsp://USER:PASS@IP:554/stream1` |
| Hikvision | `rtsp://USER:PASS@IP:554/Streaming/Channels/101` |
| Dahua / Amcrest | `rtsp://USER:PASS@IP:554/cam/realmonitor?channel=1&subtype=0` |
| Reolink | `rtsp://USER:PASS@IP:554/h264Preview_01_main` |

Or just hit **⌖ Scan** in the dashboard.

## Tech stack

**Node.js** (built-ins only) · **ffmpeg / ffprobe** · **vanilla JS/CSS** dashboard ·
**RTSP / ONVIF / HLS-free MJPEG** · **systemd / launchd / NSSM** service integration.

## Roadmap

- [ ] Motion-triggered recording + event timeline (ffmpeg `select`/scene detection)
- [ ] Optional on-the-fly HEVC→H.264 transcode for universal browser playback
- [ ] Basic auth / reverse-proxy guide for safe remote access
- [ ] Multi-day timeline scrubber across segments
- [ ] Push/email alerts on camera offline

## License

MIT — do whatever helps. Built to make old hardware useful again.
