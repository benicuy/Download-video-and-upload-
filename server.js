'use strict';
/**
 * DownloadMaster backend
 *  - Menyajikan frontend (index.html, style.css, script.js)
 *  - Proxy download: mengambil file dari URL asal di sisi server lalu mengirimkannya ke browser
 *    sebagai attachment (sehingga tidak terkena larangan CORS browser)
 *  - Upload foto & video, disimpan ke disk + metadata di data/db.json
 *  Tanpa dependensi eksternal (hanya modul bawaan Node.js 18+).
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns/promises');
const net = require('net');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

// ---------- Konfigurasi (bisa diubah lewat environment variable) ----------
const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 1024;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 20000;   // batas menunggu header dari server asal
const MAX_REDIRECTS = 5;
// Hanya untuk pengujian lokal: izinkan proxy ke alamat private/localhost
const ALLOW_PRIVATE_TARGETS = process.env.ALLOW_PRIVATE_TARGETS === '1';
const USER_AGENT = 'Mozilla/5.0 (DownloadMaster proxy)';

const STATIC_FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/style.css': 'style.css',
  '/script.js': 'script.js',
};
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

// Tipe file yang boleh di-upload
const UPLOAD_TYPES = {
  'image/jpeg': { ext: 'jpg', kind: 'image' },
  'image/png': { ext: 'png', kind: 'image' },
  'image/gif': { ext: 'gif', kind: 'image' },
  'image/webp': { ext: 'webp', kind: 'image' },
  'image/heic': { ext: 'heic', kind: 'image' },
  'image/heif': { ext: 'heif', kind: 'image' },
  'video/mp4': { ext: 'mp4', kind: 'video' },
  'video/quicktime': { ext: 'mov', kind: 'video' },
  'video/webm': { ext: 'webm', kind: 'video' },
  'video/x-matroska': { ext: 'mkv', kind: 'video' },
  'video/x-msvideo': { ext: 'avi', kind: 'video' },
  'video/mpeg': { ext: 'mpg', kind: 'video' },
};
const EXT_TO_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', mpg: 'video/mpeg', mpeg: 'video/mpeg',
};
// Ekstensi untuk nama file saat download (jika URL tidak punya ekstensi)
const CONTENT_TYPE_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'application/pdf': 'pdf', 'application/zip': 'zip',
  'application/x-rar-compressed': 'rar', 'text/plain': 'txt', 'application/json': 'json',
};

// ---------- Blok alamat private (anti-SSRF) ----------
const blockList = new net.BlockList();
blockList.addSubnet('0.0.0.0', 8, 'ipv4');
blockList.addSubnet('10.0.0.0', 8, 'ipv4');
blockList.addSubnet('100.64.0.0', 10, 'ipv4');
blockList.addSubnet('127.0.0.0', 8, 'ipv4');
blockList.addSubnet('169.254.0.0', 16, 'ipv4');
blockList.addSubnet('172.16.0.0', 12, 'ipv4');
blockList.addSubnet('192.168.0.0', 16, 'ipv4');
blockList.addSubnet('224.0.0.0', 4, 'ipv4');
blockList.addSubnet('240.0.0.0', 4, 'ipv4');
blockList.addAddress('::', 'ipv6');
blockList.addAddress('::1', 'ipv6');
blockList.addSubnet('fc00::', 7, 'ipv6');
blockList.addSubnet('fe80::', 10, 'ipv6');
blockList.addSubnet('ff00::', 8, 'ipv6');

function isBlockedAddress(ip) {
  const family = net.isIP(ip);
  if (!family) return true;
  let addr = ip;
  let fam = family === 4 ? 'ipv4' : 'ipv6';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) { addr = mapped[1]; fam = 'ipv4'; }
  return blockList.check(addr, fam);
}

// ---------- Helper umum ----------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => { throw new HttpError(status, message); };

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sanitizeFileName(name) {
  return String(name || '')
    .replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g, '_')
    .trim()
    .slice(0, 200);
}

function encodeRFC5987(s) {
  return encodeURIComponent(s).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRFC5987(name)}`;
}

function kindFromMime(mime, name = '') {
  if (UPLOAD_TYPES[mime]) return UPLOAD_TYPES[mime].kind;
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'document';
  const ext = path.extname(name).slice(1).toLowerCase();
  if (EXT_TO_MIME[ext]) return kindFromMime(EXT_TO_MIME[ext]);
  return 'other';
}

// ---------- Database sederhana (JSON di disk) ----------
let db = { files: [], downloads: [] };
let saveChain = Promise.resolve();

async function loadDb() {
  try {
    db = JSON.parse(await fsp.readFile(DB_FILE, 'utf8'));
    db.files ||= [];
    db.downloads ||= [];
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// Penulisan dibuat berurutan dan atomik (tulis ke .tmp lalu rename)
function saveDb() {
  const run = saveChain.then(async () => {
    const tmp = DB_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(db, null, 2));
    await fsp.rename(tmp, DB_FILE);
  });
  saveChain = run.catch(() => {});
  return run;
}

// ---------- Akses ke server asal (dengan pengecekan keamanan) ----------
async function assertPublicUrl(u) {
  if (!['http:', 'https:'].includes(u.protocol)) {
    fail(400, 'Hanya URL http dan https yang didukung.');
  }
  if (ALLOW_PRIVATE_TARGETS) return;
  const hostname = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname)) fail(403, 'Alamat tujuan tidak diizinkan.');
    return;
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    fail(403, 'Alamat tujuan tidak diizinkan.');
  }
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    fail(502, 'Host tujuan tidak ditemukan (DNS gagal).');
  }
  if (addresses.some((a) => isBlockedAddress(a.address))) {
    fail(403, 'Alamat tujuan tidak diizinkan.');
  }
}

// Satu permintaan dengan batas waktu untuk header; body tetap boleh mengalir lama.
// Pembatalan dari browser (signal) tetap menghentikan body yang sedang dikirim.
async function requestOnce(target, { method, headers, signal }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONNECT_TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  try {
    return await fetch(target, {
      method,
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...headers },
      signal: ctrl.signal,
    });
  } catch (err) {
    const timedOut = ctrl.signal.aborted && !(signal && signal.aborted);
    fail(502, `Gagal menghubungi server asal (${timedOut ? 'waktu habis' : (err.cause?.code || err.message)}).`);
  } finally {
    clearTimeout(timer);
  }
}

// Ambil URL sambil mengikuti redirect (setiap tujuan dicek ulang)
async function fetchPublic(target, { method = 'GET', headers = {}, signal } = {}) {
  let current = new URL(target);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);

    let res = await requestOnce(current, { method, headers, signal });
    if (res.status === 401 || res.status === 403) {
      // Sebagian server (hotlink protection) hanya melayani jika ada Referer dari situsnya sendiri
      res.body?.cancel().catch(() => {});
      res = await requestOnce(current, { method, headers: { Referer: `${current.origin}/`, ...headers }, signal });
    }

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      res.body?.cancel().catch(() => {});
      current = new URL(location, current);
      continue;
    }
    return { res, finalUrl: current.href };
  }
  fail(508, 'Terlalu banyak pengalihan (redirect).');
}

// Link yang membuka halaman web (mis. halaman berbagi Google Drive/Dropbox) bukan file langsung
function assertNotWebPage(up) {
  const ct = upstreamContentType(up);
  if (ct === 'text/html' || ct === 'application/xhtml+xml') {
    up.body?.cancel().catch(() => {});
    fail(415, 'Link ini membuka halaman web (HTML), bukan file langsung. Gunakan direct link ke file video/foto (misalnya URL yang berakhiran .mp4 atau .jpg).');
  }
}

function deriveFileName(contentDispositionHeader, finalUrl, contentType) {
  let name = '';
  if (contentDispositionHeader) {
    const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(contentDispositionHeader);
    const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(contentDispositionHeader);
    if (star) {
      try { name = decodeURIComponent(star[2].trim()); } catch { /* abaikan */ }
    }
    if (!name && plain) name = plain[1].trim();
  }
  if (!name) {
    try {
      name = decodeURIComponent(path.posix.basename(new URL(finalUrl).pathname));
    } catch { name = ''; }
  }
  name = sanitizeFileName(name);
  if (!name || name === '.' || name === '..') name = 'download';
  if (!path.extname(name) && CONTENT_TYPE_EXT[contentType]) {
    name += '.' + CONTENT_TYPE_EXT[contentType];
  }
  return name;
}

function readTargetParam(url) {
  const raw = url.searchParams.get('url');
  if (!raw) fail(400, 'Parameter url wajib diisi.');
  try {
    return new URL(raw);
  } catch {
    fail(400, 'URL tidak valid.');
  }
}

function upstreamContentType(res) {
  return (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
}

// GET /api/info?url=...  -> metadata (nama, ukuran, tipe) tanpa mengunduh seluruh file
async function handleInfo(req, res, url) {
  const target = readTargetParam(url);
  const { res: up, finalUrl } = await fetchPublic(target, { headers: { Range: 'bytes=0-0' } });
  let size = null;
  let acceptsRanges = false;
  if (up.status === 206) {
    const m = /\/(\d+)$/.exec(up.headers.get('content-range') || '');
    if (m) size = Number(m[1]);
    acceptsRanges = true;
  } else if (up.ok) {
    const len = up.headers.get('content-length');
    size = len ? Number(len) : null;
    acceptsRanges = /bytes/i.test(up.headers.get('accept-ranges') || '');
  } else {
    up.body?.cancel().catch(() => {});
    fail(502, `Server asal merespons HTTP ${up.status}.`);
  }
  assertNotWebPage(up);
  const contentType = upstreamContentType(up);
  up.body?.cancel().catch(() => {});

  const fileName = deriveFileName(up.headers.get('content-disposition'), finalUrl, contentType);
  sendJson(res, 200, {
    url: target.href,
    finalUrl,
    fileName,
    size,
    contentType,
    kind: kindFromMime(contentType, fileName),
    acceptsRanges,
  });
}

// GET /api/download?url=...  -> stream file dari server asal ke browser sebagai attachment
async function handleDownload(req, res, url) {
  const target = readTargetParam(url);
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ac.abort(); // browser membatalkan -> hentikan unduhan dari server asal
  });

  const { res: up, finalUrl } = await fetchPublic(target, { signal: ac.signal });
  if (!up.ok) {
    up.body?.cancel().catch(() => {});
    fail(502, `Server asal merespons HTTP ${up.status}.`);
  }
  assertNotWebPage(up);

  const contentType = upstreamContentType(up);
  const fileName = deriveFileName(up.headers.get('content-disposition'), finalUrl, contentType);
  const headers = {
    'Content-Type': contentType,
    'Content-Disposition': contentDisposition(fileName),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  const len = up.headers.get('content-length');
  if (len) headers['Content-Length'] = len;

  const entry = {
    id: crypto.randomUUID(),
    sourceUrl: target.href,
    finalUrl,
    fileName,
    contentType,
    size: len ? Number(len) : null,
    bytes: 0,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };
  db.downloads.unshift(entry);

  res.writeHead(200, headers);
  const src = Readable.fromWeb(up.body);
  src.on('data', (chunk) => { entry.bytes += chunk.length; });
  try {
    await pipeline(src, res);
    entry.status = 'completed';
  } catch (err) {
    entry.status = ac.signal.aborted ? 'cancelled' : 'failed';
    entry.error = err.message;
  } finally {
    entry.finishedAt = new Date().toISOString();
    await saveDb().catch((e) => console.error('Gagal menyimpan riwayat download:', e));
  }
}

// ---------- Upload foto & video ----------
function resolveUploadType(mime, name) {
  if (UPLOAD_TYPES[mime]) return { ...UPLOAD_TYPES[mime], mime };
  const extMime = EXT_TO_MIME[path.extname(name).slice(1).toLowerCase()];
  if (extMime && UPLOAD_TYPES[extMime]) return { ...UPLOAD_TYPES[extMime], mime: extMime };
  return null;
}

function serializeFile(r) {
  return {
    id: r.id,
    name: r.name,
    mimeType: r.mimeType,
    kind: r.kind,
    size: r.size,
    sha256: r.sha256,
    uploadedAt: r.uploadedAt,
    url: `/api/files/${r.id}/content`,
    downloadUrl: `/api/files/${r.id}/content?download=1`,
  };
}

// POST /api/upload   body = isi file mentah
//   header: Content-Type (tipe file), X-File-Name (nama file, URL-encoded)
async function handleUpload(req, res) {
  let rawName = req.headers['x-file-name'] || '';
  try { rawName = decodeURIComponent(rawName); } catch { /* biarkan apa adanya */ }
  const name = sanitizeFileName(rawName) || 'upload';
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();

  const info = resolveUploadType(mime, name);
  if (!info) {
    req.resume();
    fail(415, 'Format tidak didukung. Foto: JPG, PNG, GIF, WEBP, HEIC. Video: MP4, MOV, WEBM, MKV, AVI.');
  }

  const declared = Number(req.headers['content-length']) || 0;
  if (declared > MAX_UPLOAD_BYTES) {
    req.resume();
    fail(413, `Ukuran file melebihi batas ${MAX_UPLOAD_MB} MB.`);
  }

  const id = crypto.randomUUID();
  const storedName = `${id}.${info.ext}`;
  const filePath = path.join(UPLOAD_DIR, storedName);
  const hash = crypto.createHash('sha256');
  let size = 0;

  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        return cb(new HttpError(413, `Ukuran file melebihi batas ${MAX_UPLOAD_MB} MB.`));
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });

  try {
    await pipeline(req, limiter, fs.createWriteStream(filePath, { flags: 'wx' }));
  } catch (err) {
    await fsp.rm(filePath, { force: true });
    if (err instanceof HttpError) throw err;
    fail(400, `Upload gagal: ${err.message}`);
  }

  if (size === 0) {
    await fsp.rm(filePath, { force: true });
    fail(400, 'File kosong.');
  }

  const record = {
    id,
    name,
    storedName,
    mimeType: info.mime,
    kind: info.kind,
    size,
    sha256: hash.digest('hex'),
    uploadedAt: new Date().toISOString(),
  };
  db.files.unshift(record);
  await saveDb();
  sendJson(res, 201, serializeFile(record));
}

// GET /api/files?kind=image|video
function handleListFiles(req, res, url) {
  const kind = url.searchParams.get('kind');
  const items = db.files
    .filter((f) => !kind || f.kind === kind)
    .map(serializeFile);
  sendJson(res, 200, { total: items.length, items });
}

// GET /api/files/:id/content  (?download=1 untuk attachment)
async function handleFileContent(req, res, id, url) {
  const rec = db.files.find((f) => f.id === id);
  if (!rec) fail(404, 'File tidak ditemukan.');

  const filePath = path.join(UPLOAD_DIR, rec.storedName);
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    fail(404, 'File tidak ditemukan di penyimpanan.');
  }
  const total = stat.size;

  let start = 0;
  let end = total - 1;
  let status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] || m[2])) {
      if (m[1] === '') {
        start = Math.max(total - Number(m[2]), 0);
      } else {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
      }
      if (start > end || start >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        res.end();
        return;
      }
      status = 206;
    }
  }

  const download = url.searchParams.get('download') === '1';
  const headers = {
    'Content-Type': rec.mimeType,
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': download ? contentDisposition(rec.name) : 'inline',
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  await pipeline(fs.createReadStream(filePath, { start, end }), res);
}

// DELETE /api/files/:id
async function handleDeleteFile(req, res, id) {
  const idx = db.files.findIndex((f) => f.id === id);
  if (idx === -1) fail(404, 'File tidak ditemukan.');
  const [rec] = db.files.splice(idx, 1);
  await fsp.rm(path.join(UPLOAD_DIR, rec.storedName), { force: true });
  await saveDb();
  sendJson(res, 200, { deleted: true, id });
}

// GET /api/downloads?limit=50
function handleListDownloads(req, res, url) {
  const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 1000);
  sendJson(res, 200, { total: db.downloads.length, items: db.downloads.slice(0, limit) });
}

// ---------- Router ----------
async function handleApi(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/health' && m === 'GET') return sendJson(res, 200, { ok: true });
  if (p === '/api/info' && m === 'GET') return handleInfo(req, res, url);
  if (p === '/api/download' && m === 'GET') return handleDownload(req, res, url);
  if (p === '/api/upload' && m === 'POST') return handleUpload(req, res);
  if (p === '/api/files' && m === 'GET') return handleListFiles(req, res, url);
  if (p === '/api/downloads' && m === 'GET') return handleListDownloads(req, res, url);

  const fileMatch = /^\/api\/files\/([0-9a-f-]{36})(\/content)?$/i.exec(p);
  if (fileMatch) {
    const id = fileMatch[1];
    if (fileMatch[2] && (m === 'GET' || m === 'HEAD')) return handleFileContent(req, res, id, url);
    if (!fileMatch[2] && m === 'DELETE') return handleDeleteFile(req, res, id);
  }

  fail(404, 'Endpoint tidak ditemukan.');
}

async function serveStatic(req, res, pathname) {
  const rel = STATIC_FILES[pathname];
  if (!rel) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  const body = await fsp.readFile(path.join(ROOT, rel));
  res.writeHead(200, {
    'Content-Type': STATIC_TYPES[path.extname(rel)],
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'Method tidak diizinkan.');
    await serveStatic(req, res, url.pathname);
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendJson(res, err instanceof HttpError ? err.status : 500,
      { error: err instanceof HttpError ? err.message : 'Terjadi kesalahan di server.' });
  }
});
server.requestTimeout = 0;  // upload file besar tidak boleh terputus oleh timeout default

async function main() {
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  await loadDb();
  server.listen(PORT, () => {
    console.log(`DownloadMaster berjalan di http://localhost:${PORT}`);
    console.log(`Data tersimpan di: ${DATA_DIR}`);
  });
}

main().catch((err) => {
  console.error('Gagal menjalankan server:', err);
  process.exit(1);
});
