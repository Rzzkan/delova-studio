import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { detectMime } from './kenari.js';

// Ambil gambar referensi dari URL. Server membuka URL atas permintaan pengguna/Claude, jadi dijaga dari SSRF:
// hanya http(s), host yang menuju alamat privat/loopback/link-local ditolak (juga setelah redirect), ukuran dan waktu dibatasi.
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export function isPrivateIp(ip) {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
    return v === '::1' || v === '::' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

async function assertPublic(u) {
  if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error('URL gambar harus http atau https'), { status: 400 });
  if (process.env.ALLOW_PRIVATE_URLS === '1') return; // hanya untuk pengujian
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw Object.assign(new Error(`Host ${host} tidak ditemukan`), { status: 400 });
  if (addrs.some((a) => isPrivateIp(a.address))) throw Object.assign(new Error('URL mengarah ke alamat internal, ditolak'), { status: 400 });
}

export async function fetchImage(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { throw Object.assign(new Error('URL gambar tidak valid'), { status: 400 }); }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(u);
    const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'DelovaStudio/1.0', Accept: 'image/*' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { u = new URL(res.headers.get('location'), u); continue; }
    if (!res.ok) throw Object.assign(new Error(`Gagal mengambil gambar dari URL (HTTP ${res.status})`), { status: 400 });
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_BYTES) throw Object.assign(new Error('Gambar dari URL terlalu besar (maks 12 MB)'), { status: 400 });
    const chunks = []; let total = 0;
    for await (const c of res.body) { total += c.length; if (total > MAX_BYTES) throw Object.assign(new Error('Gambar dari URL terlalu besar (maks 12 MB)'), { status: 400 }); chunks.push(c); }
    const buffer = Buffer.concat(chunks);
    const mime = detectMime(buffer);
    const looksImage = (buffer[0] === 0x89 && buffer[1] === 0x50) || (buffer[0] === 0xff && buffer[1] === 0xd8) || buffer.toString('ascii', 8, 12) === 'WEBP';
    if (!looksImage) throw Object.assign(new Error('URL itu bukan gambar PNG/JPEG/WebP'), { status: 400 });
    return { buffer, mime };
  }
  throw Object.assign(new Error('Terlalu banyak redirect'), { status: 400 });
}
