#!/usr/bin/env node
'use strict';

// One-time setup helper: creates config.json from the example if it's missing,
// and checks that ffmpeg is installed. Safe to run repeatedly.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const cfgPath = path.join(root, 'config.json');
const examplePath = path.join(root, 'config.example.json');

console.log('Vigil setup\n');

// 1) ffmpeg check
try {
  const out = execFileSync('ffmpeg', ['-version']).toString().split('\n')[0];
  console.log('  ✓ ' + out);
} catch {
  console.log('  ✗ ffmpeg not found. Install it first:');
  console.log('      macOS:   brew install ffmpeg');
  console.log('      Ubuntu:  sudo apt install ffmpeg');
  console.log('      Windows: winget install Gyan.FFmpeg');
}

// 2) config.json
if (fs.existsSync(cfgPath)) {
  console.log('  ✓ config.json already exists');
} else {
  const example = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
  example.cameras = []; // start with no cameras; add them in the dashboard
  fs.writeFileSync(cfgPath, JSON.stringify(example, null, 2));
  console.log('  ✓ created config.json (edit it, or add cameras in the dashboard)');
}

console.log('\nNext:  npm start   →   open http://localhost:8080\n');
