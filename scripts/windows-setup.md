# Running Vigil 24/7 on Windows

You want Vigil to start automatically and keep running even after reboots.
Two easy options — pick one.

## Option A — Startup shortcut (simplest)

1. Install [Node.js LTS](https://nodejs.org) and [ffmpeg](https://www.gyan.dev/ffmpeg/builds/)
   (or run `winget install OpenJS.NodeJS.LTS Gyan.FFmpeg` in PowerShell).
2. Create a file called **start-vigil.bat** in the Vigil folder:

   ```bat
   @echo off
   cd /d "%~dp0"
   node server.js
   ```

3. Press `Win + R`, type `shell:startup`, press Enter.
4. Right-drag **start-vigil.bat** into that Startup folder → *Create shortcuts here*.

Vigil now launches every time you sign in. Open http://localhost:8080.

## Option B — Windows Service with NSSM (survives sign-out / true background)

1. Download **NSSM** from https://nssm.cc and unzip it.
2. In an **Administrator** PowerShell, from the nssm folder:

   ```powershell
   .\nssm.exe install Vigil "C:\Program Files\nodejs\node.exe" "C:\path\to\vigil\server.js"
   .\nssm.exe set Vigil AppDirectory "C:\path\to\vigil"
   .\nssm.exe set Vigil AppStdout "C:\path\to\vigil\vigil.log"
   .\nssm.exe set Vigil AppStderr "C:\path\to\vigil\vigil.log"
   .\nssm.exe start Vigil
   ```

Manage it later with `nssm.exe restart Vigil` / `nssm.exe stop Vigil`, or
in *services.msc*.

## Keep the laptop awake with the lid closed

Control Panel → Power Options → *Choose what closing the lid does* → set
**"When I close the lid: Do nothing"** (on "Plugged in"). Also set the display
and sleep timers to *Never* while plugged in.

## Let other devices on your WiFi reach the dashboard

The first time you start it, Windows Firewall may ask — click **Allow**. Then
visit `http://<this-pc-ip>:8080` from your phone (find the IP with `ipconfig`).
