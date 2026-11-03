#!/usr/bin/env node
// serve.mjs — a zero-dependency static server for site/.
// Behaves roughly like GitHub Pages: directory → index.html, "/dir" → 301 "/dir/",
// unknown paths → 404.html with a 404 status. No caching, no magic, no npm install.
//
//   node scripts/serve.mjs            → http://localhost:4173
//   PORT=8080 node scripts/serve.mjs  → http://localhost:8080
//   HOST=0.0.0.0 node scripts/serve.mjs  (to test from your phone on the same Wi-Fi)

import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../site/', import.meta.url)));
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
};

// Extensionless files GitHub Pages serves as plain text (CNAME, .nojekyll).
const typeOf = (file) => MIME[extname(file).toLowerCase()] || 'text/plain; charset=utf-8';

async function fileAt(p) {
  try {
    const s = await stat(p);
    return s.isFile() ? s : s.isDirectory() ? 'dir' : null;
  } catch {
    return null;
  }
}

function send(req, res, status, file, size) {
  res.writeHead(status, {
    'Content-Type': typeOf(file),
    'Content-Length': size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

async function notFound(req, res) {
  const page = join(ROOT, '404.html');
  const s = await fileAt(page);
  if (s && s !== 'dir') return send(req, res, 404, page, s.size);
  const body = '404 — point not on curve\n';
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(req.method === 'HEAD' ? undefined : body);
}

const server = createServer(async (req, res) => {
  const started = performance.now();
  res.on('finish', () => {
    const ms = (performance.now() - started).toFixed(1);
    const tint = res.statusCode >= 400 ? '\x1b[35m' : res.statusCode >= 300 ? '\x1b[33m' : '\x1b[36m';
    console.log(`${tint}${res.statusCode}\x1b[0m ${req.method} ${req.url} \x1b[2m${ms}ms\x1b[0m`);
  });

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('405 — this plane is read-only\n');
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('400 — that URL is not a real number\n');
  }
  if (pathname.includes('\0')) return notFound(req, res);

  // Resolve inside ROOT only; anything that escapes is simply not on the curve.
  const target = normalize(join(ROOT, pathname));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) return notFound(req, res);

  const s = await fileAt(target);
  if (s === 'dir') {
    if (!pathname.endsWith('/')) {
      const q = req.url.indexOf('?');
      res.writeHead(301, { Location: pathname + '/' + (q >= 0 ? req.url.slice(q) : '') });
      return res.end();
    }
    const index = join(target, 'index.html');
    const si = await fileAt(index);
    if (si && si !== 'dir') return send(req, res, 200, index, si.size);
    return notFound(req, res);
  }
  if (s) return send(req, res, 200, target, s.size);

  // GitHub Pages also resolves "/about" → "/about.html".
  if (!extname(target)) {
    const html = target + '.html';
    const sh = await fileAt(html);
    if (sh && sh !== 'dir') return send(req, res, 200, html, sh.size);
  }
  return notFound(req, res);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is taken. Try: PORT=${PORT + 1} node scripts/serve.mjs`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, async () => {
  const shown = ['0.0.0.0', '::', '127.0.0.1', '::1'].includes(HOST) ? 'localhost' : HOST;
  const hasIndex = (await fileAt(join(ROOT, 'index.html'))) !== null;
  console.log(`\n  \x1b[36m●\x1b[0m codected is plotting at \x1b[1mhttp://${shown}:${PORT}/\x1b[0m`);
  console.log(`  \x1b[2mserving ${ROOT}${hasIndex ? '' : ' (no index.html yet — everything is a 404, which is very on-brand)'}\x1b[0m`);
  console.log(`  \x1b[2mCtrl+C to stop\x1b[0m\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
