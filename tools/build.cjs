#!/usr/bin/env node
// Builds everything from src/fister-vr.js:
//   docs/index.html               the Quest setup page (GitHub Pages serves the docs/ folder)
//   dist/fister-vr.user.js        Tampermonkey / Violentmonkey userscript for PC browsers
//   dist/fister-vr.bookmarklet.txt bookmarklet with default settings
//   dist/fisterVr.js              copy for the Steam launcher patch (see steam/README.md)
// Usage: node tools/build.cjs
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const write = (p, text) => {
  fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
  fs.writeFileSync(path.join(root, p), text);
  console.log('wrote', p, '(' + Buffer.byteLength(text) + ' bytes)');
};

const source = read('src/fister-vr.js');
const version = (source.match(/@version\s+([\d.]+)/) || [])[1] || 'dev';

// Bookmarklets can't carry comments safely across lines; drop full-line comments and indentation.
// (The source has no multi-line strings, so this is safe.)
const body = source.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//')).join('\n');
new Function(body); // syntax check

write('dist/fister-vr.user.js', source);
write('dist/fisterVr.js', source);
write('dist/fister-vr.bookmarklet.txt', 'javascript:' + encodeURIComponent(body + '\nvoid 0;'));

// Setup page: embed the layer as a safe JS string literal and wrap the template into a full HTML document.
const literal = JSON.stringify(body)
  .replace(/</g, '\\u003c')
  .split(String.fromCharCode(0x2028)).join('\\u2028')
  .split(String.fromCharCode(0x2029)).join('\\u2029');
const template = read('site/page-template.html').replace('__LAYER_SOURCE__', () => literal).split('__VERSION__').join(version);
const split = template.indexOf('</style>') + '</style>'.length;
const html = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
  + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
  + '<meta name="description" content="Unofficial WebXR mod: play fister.fun in a Quest headset from the Quest Browser.">\n'
  + template.slice(0, split) + '\n</head>\n<body>\n' + template.slice(split).trim() + '\n</body>\n</html>\n';
write('docs/index.html', html);
console.log('Fister VR', version, 'built.');
