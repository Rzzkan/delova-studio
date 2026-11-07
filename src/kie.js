import { config } from './config.js';
import { getKieKey } from './secrets.js';
import { detectMime } from './kenari.js';

// Klien kie.ai (penyedia CADANGAN bila kenari gagal). API-nya asinkron: createTask -> polling recordInfo -> unduh hasil.
// Catatan penting dari dokumentasi kie.ai:
//  - Kesalahan sering datang sebagai HTTP 200 dengan `code` di badan JSON (401, 402 kredit habis, 422, 429, 455 perawatan, 500).
//  - File hasil hanya disimpan 14 hari di kie, jadi selalu kita unduh sendiri.
//  - Harga dalam KREDIT (1 kredit ~ US$0,005). Tidak ada API daftar harga, jadi katalog di bawah + override di Konfigurasi.

export class KieError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'KieError';
    this.status = status;
    this.code = code;
  }
}

// Katalog bawaan (kredit per gambar, harga "mulai dari" di halaman harga kie.ai). ID lain bisa ditambah di Konfigurasi.
export const CATALOG = [
  { id: 'google/nano-banana', name: 'Nano Banana (teks → gambar)', credits: 4, kind: 'generate' },
  { id: 'gpt-image-2-text-to-image', name: 'GPT Image 2 (teks → gambar)', credits: 6, kind: 'generate' },
  { id: 'google/nano-banana-edit', name: 'Nano Banana Edit (edit gambar)', credits: 4, kind: 'edit' },
];
export const USD_PER_CREDIT = 0.005;

const CODE_MSG = {
  401: 'API key kie.ai ditolak (salah atau dicabut).',
  402: 'Kredit kie.ai habis. Top up di kie.ai.',
  404: 'Endpoint/model kie.ai tidak ditemukan.',
  422: 'Parameter ditolak kie.ai (cek ID model).',
  429: 'Terlalu banyak permintaan ke kie.ai (batas 20 per 10 detik).',
  455: 'kie.ai sedang perawatan.',
};

function headers(key = getKieKey()) {
  if (!key) throw new KieError('API key kie.ai belum diisi. Isi di Dashboard > Konfigurasi.', { code: 'no_api_key', status: 401 });
  return { Authorization: `Bearer ${key}` };
}

async function readJson(res) {
  const text = (await res.text()).trim();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { throw new KieError(`Respons kie.ai bukan JSON (HTTP ${res.status}): ${text.slice(0, 200)}`, { status: res.status }); }
  const code = Number(body.code ?? res.status);
  if (!res.ok || (body.code !== undefined && code !== 200) || body.success === false) {
    const msg = CODE_MSG[code] ? `${CODE_MSG[code]}${body.msg ? ` (${body.msg})` : ''}` : body.msg || `HTTP ${res.status}`;
    throw new KieError(msg, { status: code || res.status, code: code === 402 ? 'insufficient_credits' : String(code) });
  }
  return body;
}

const RATIOS = [['1:1', 1], ['2:3', 2 / 3], ['3:2', 3 / 2], ['3:4', 3 / 4], ['4:3', 4 / 3], ['4:5', 4 / 5], ['5:4', 5 / 4], ['9:16', 9 / 16], ['16:9', 16 / 9], ['21:9', 21 / 9]];
/** "1024x1536" -> rasio terdekat yang didukung kie ("2:3"). Tanpa ukuran -> "1:1". */
export function aspectOf(size) {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(String(size || ''));
  if (!m) return '1:1';
  const r = Number(m[1]) / Number(m[2]);
  return RATIOS.reduce((best, cur) => (Math.abs(cur[1] - r) < Math.abs(best[1] - r) ? cur : best))[0];
}

async function createTask(model, input) {
  const res = await fetch(`${config.kieBaseUrl}/api/v1/jobs/createTask`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input }),
    signal: AbortSignal.timeout(30000),
  });
  const id = (await readJson(res)).data?.taskId;
  if (!id) throw new KieError('kie.ai tidak mengembalikan taskId');
  return id;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitTask(taskId) {
  const deadline = Date.now() + config.kieTimeoutMs;
  for (;;) {
    const res = await fetch(`${config.kieBaseUrl}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, { headers: headers(), signal: AbortSignal.timeout(30000) });
    const d = (await readJson(res)).data || {};
    if (d.state === 'success') {
      let urls = [];
      try { urls = JSON.parse(d.resultJson || '{}').resultUrls || []; } catch { /* ditangani di bawah */ }
      if (!urls.length) throw new KieError('kie.ai selesai tetapi tidak memberi URL gambar');
      return { urls, credits: typeof d.creditsConsumed === 'number' ? d.creditsConsumed : undefined };
    }
    if (d.state === 'fail') throw new KieError(d.failMsg || 'Tugas gagal di kie.ai', { code: d.failCode ? String(d.failCode) : 'task_failed', status: 502 });
    if (Date.now() > deadline) throw new KieError(`kie.ai tidak selesai dalam ${Math.round(config.kieTimeoutMs / 1000)} detik`, { code: 'timeout', status: 504 });
    await sleep(config.kiePollMs);
  }
}

async function download(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new KieError(`Gagal mengunduh hasil kie.ai (HTTP ${r.status})`, { status: 502 });
  const buffer = Buffer.from(await r.arrayBuffer());
  return { buffer, mime: detectMime(buffer) };
}

// Satu tugas kie = satu gambar; n gambar = n tugas paralel. Sebagian berhasil tetap dikembalikan (dan hanya yang berhasil dihitung kreditnya).
async function runMany(n, build, perImageCredits) {
  const results = await Promise.allSettled(Array.from({ length: n }, async () => {
    const t = await waitTask(await build());
    const images = await Promise.all(t.urls.slice(0, 1).map(download));
    return { image: images[0], credits: t.credits };
  }));
  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!ok.length) throw results[0].reason;
  const known = ok.every((o) => o.credits !== undefined);
  const credits = known ? ok.reduce((a, o) => a + o.credits, 0) : perImageCredits === null ? 0 : perImageCredits * ok.length;
  return { images: ok.map((o) => o.image), credits };
}

export function generate({ model, prompt, n = 1, size, perImageCredits = null }) {
  return runMany(n, () => createTask(model, { prompt, aspect_ratio: aspectOf(size), output_format: 'png' }), perImageCredits);
}

// kie hanya menerima URL publik untuk gambar sumber, jadi unggah dulu lewat API unggah file kie (hasil tersimpan 24 jam).
async function upload(img, i) {
  const ext = img.mime.split('/')[1] || 'png';
  const res = await fetch(`${config.kieUploadUrl}/api/file-base64-upload`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ base64Data: `data:${img.mime};base64,${img.buffer.toString('base64')}`, uploadPath: 'delova-studio', fileName: `source-${Date.now()}-${i}.${ext}` }),
    signal: AbortSignal.timeout(60000),
  });
  const url = (await readJson(res)).data?.downloadUrl;
  if (!url) throw new KieError('Unggah gambar sumber ke kie.ai gagal');
  return url;
}

export async function edit({ model, prompt, images, n = 1, perImageCredits = null }) {
  const urls = await Promise.all(images.slice(0, 5).map(upload));
  return runMany(n, () => createTask(model, { prompt, image_urls: urls, output_format: 'png' }), perImageCredits);
}

/** Saldo kredit kie.ai (bilangan bulat). */
export async function balance(key = getKieKey()) {
  const res = await fetch(`${config.kieBaseUrl}/api/v1/chat/credit`, { headers: headers(key), signal: AbortSignal.timeout(20000) });
  const c = (await readJson(res)).data;
  return typeof c === 'number' ? c : Number(c) || 0;
}

export async function checkKey(key = getKieKey()) {
  if (!key) return { state: 'none', message: 'API key kie.ai belum diisi.' };
  try {
    const credits = await balance(key);
    return { state: 'valid', credits, estimatedUsd: Math.round(credits * USD_PER_CREDIT * 100) / 100, message: 'Koneksi berhasil.' };
  } catch (e) {
    if (e instanceof KieError) return { state: e.status === 401 ? 'invalid' : 'error', message: e.message };
    return { state: 'error', message: `Tidak bisa menghubungi kie.ai: ${e.message}` };
  }
}
