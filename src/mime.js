'use strict';
// Content types for the files the bundled sites ship. Text types carry `charset=utf-8`, as
// Cloudflare Pages sends them. Unknown extensions fall back to application/octet-stream.

const TEXT = (type) => `${type}; charset=utf-8`;

const TYPES = {
  '.html': TEXT('text/html'),
  '.htm': TEXT('text/html'),
  '.css': TEXT('text/css'),
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.cjs': 'application/javascript',
  '.json': TEXT('application/json'),
  '.map': TEXT('application/json'),
  '.webmanifest': TEXT('application/manifest+json'),
  '.xml': TEXT('application/xml'),
  '.txt': TEXT('text/plain'),
  '.md': TEXT('text/markdown'),
  '.csv': TEXT('text/csv'),
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.pfb': 'application/x-font-type1',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.dat': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.onnx': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.weba': 'audio/webm',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.vtt': TEXT('text/vtt'),
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function contentType(filePath) {
  const dot = filePath.lastIndexOf('.');
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (dot <= slash) return 'application/octet-stream';
  return TYPES[filePath.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

module.exports = { contentType };
