/**
 * Generate simple PWA icons (192x192 and 512x512) as SVG-based PNGs.
 * Uses a minimal approach: create SVG, convert to PNG via sharp or canvas.
 * Since we may not have sharp/canvas, we'll create SVG files that browsers can use.
 */
const fs = require("fs");
const path = require("path");

function generateSVG(size) {
  const phoneW = size * 0.32;
  const phoneH = size * 0.52;
  const phoneX = (size - phoneW) / 2;
  const phoneY = (size - phoneH) / 2;
  const phoneR = size * 0.03;
  const screenInset = size * 0.02;
  const notchW = phoneW * 0.35;
  const notchH = size * 0.02;
  const notchX = phoneX + (phoneW - notchW) / 2;
  const notchY = phoneY + screenInset + size * 0.01;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1a2a22"/>
      <stop offset="100%" stop-color="#0a0a0a"/>
    </linearGradient>
    <linearGradient id="screen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#bfd5ca"/>
      <stop offset="50%" stop-color="#aecabd"/>
      <stop offset="100%" stop-color="#cfdfd6"/>
    </linearGradient>
    <linearGradient id="glow" x1="0.5" y1="0" x2="0.5" y2="1">
      <stop offset="0%" stop-color="#aecabd" stop-opacity="0.4"/>
      <stop offset="100%" stop-color="#aecabd" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <!-- Background -->
  <rect width="${size}" height="${size}" rx="${size * 0.18}" fill="url(#bg)"/>
  <!-- Glow -->
  <ellipse cx="${size / 2}" cy="${size * 0.35}" rx="${size * 0.35}" ry="${size * 0.25}" fill="url(#glow)"/>
  <!-- Phone body -->
  <rect x="${phoneX}" y="${phoneY}" width="${phoneW}" height="${phoneH}" rx="${phoneR}" fill="#222" stroke="#555" stroke-width="${size * 0.004}"/>
  <!-- Screen -->
  <rect x="${phoneX + screenInset}" y="${phoneY + screenInset}" width="${phoneW - screenInset * 2}" height="${phoneH - screenInset * 2}" rx="${phoneR * 0.7}" fill="url(#screen)"/>
  <!-- Notch / Dynamic Island -->
  <rect x="${notchX}" y="${notchY}" width="${notchW}" height="${notchH}" rx="${notchH / 2}" fill="#222"/>
  <!-- AI sparkle dots -->
  <circle cx="${size * 0.3}" cy="${size * 0.25}" r="${size * 0.008}" fill="#aecabd" opacity="0.7"/>
  <circle cx="${size * 0.72}" cy="${size * 0.3}" r="${size * 0.006}" fill="#aecabd" opacity="0.5"/>
  <circle cx="${size * 0.25}" cy="${size * 0.72}" r="${size * 0.007}" fill="#aecabd" opacity="0.6"/>
  <circle cx="${size * 0.75}" cy="${size * 0.7}" r="${size * 0.009}" fill="#aecabd" opacity="0.5"/>
  <circle cx="${size * 0.5}" cy="${size * 0.82}" r="${size * 0.006}" fill="#aecabd" opacity="0.4"/>
</svg>`;
}

const publicDir = path.join(__dirname, "..", "public");

fs.writeFileSync(path.join(publicDir, "icon-192.svg"), generateSVG(192));
fs.writeFileSync(path.join(publicDir, "icon-512.svg"), generateSVG(512));

console.log("✅ Generated icon-192.svg and icon-512.svg in public/");
