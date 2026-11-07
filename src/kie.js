import { config } from './config.js';
import { getKieKey } from './secrets.js';
import { detectMime } from './kenari.js';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

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

// ---------- daftar model kie.ai ----------
// kie.ai TIDAK punya API daftar model. Daftar diambil dari dokumentasi resminya (docs.kie.ai/llms.txt + halaman tiap model),
// lalu disimpan di data/kie-models.json. Harga kredit tidak ada di dokumentasi, jadi diisi manual (katalog/Konfigurasi).
const modelsFile = () => join(config.dataDir, 'kie-models.json');
export function syncedModels() {
  try { return JSON.parse(readFileSync(modelsFile(), 'utf8')); } catch { return { fetchedAt: null, models: [] }; }
}
const SKIP = /(upscale|remove-background|segment-map|layer-decomposition)/;

/** Baca satu halaman docs model: ID model + nama kolom input (gambar sumber, rasio, format keluaran). */
export function parsePage(md) {
  const id = /\n {16}model:\s*\n {18}default:\s*(\S+)/.exec(md)?.[1] || /\n {12}example:\s*\n {14}model:\s*(\S+)/.exec(md)?.[1];
  if (!id) return null;
  const block = /\n {12}example:\s*\n {14}model:[^\n]*\n(?: {14}callBackUrl:[^\n]*\n)? {14}input:\n([\s\S]*?)\n {6}responses:/.exec(md)?.[1] || '';
  const keys = [...block.matchAll(/^ {16}([A-Za-z_]+):[ \t]*(.*)$/gm)];
  const names = keys.map((k) => k[1]);
  const img = keys.find((k) => /^(image_urls|input_urls|image_url|image_input|images|image)$/.test(k[1]));
  const after = img ? block.slice(block.indexOf(img[0]) + img[0].length) : '';
  return {
    id,
    imageField: img?.[1] || null,
    imageArray: img ? img[2].trim().startsWith('[') || /^\s*\n {18}- /.test(after) : null,
    sizeField: names.includes('aspect_ratio') ? 'aspect_ratio' : names.find((n) => /^(image_size|size|resolution)$/.test(n)) || null,
    outputFormat: names.includes('output_format'),
  };
}

/** Ambil ulang daftar model gambar dari dokumentasi kie.ai dan simpan. */
export async function syncModels() {
  const res = await fetch(`${config.kieDocsUrl}/llms.txt`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new KieError(`Gagal membaca daftar model kie.ai (HTTP ${res.status})`, { status: 502 });
  const txt = await res.text();
  const rows = [...txt.matchAll(/^- Image\s+Models > ([^\[]+?)\s*\[([^\]]+)\]\((\S+?\.md)\)/gm)]
    .filter((m) => !m[3].includes('/cn/') && !SKIP.test(m[3]) && /\/market\//.test(m[3]))
    .map((m) => ({ group: m[1].trim(), title: m[2].trim(), url: m[3] }));
  const out = [], seen = new Set();
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < rows.length) {
      const r = rows[next++];
      try {
        const pr = await fetch(r.url, { signal: AbortSignal.timeout(20000) });
        if (!pr.ok) continue;
        const p = parsePage(await pr.text());
        if (!p || seen.has(p.id)) continue;
        seen.add(p.id);
        out.push({ ...p, name: r.title, group: r.group, kind: /(edit|image-to-image|remix)/.test(`${p.id} ${r.url}`) ? 'edit' : 'generate' });
      } catch { /* halaman yang gagal dilewati */ }
    }
  }));
  if (!out.length) throw new KieError('Tidak ada model yang terbaca dari dokumentasi kie.ai (format berubah?)', { status: 502 });
  out.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  const data = { fetchedAt: new Date().toISOString(), models: out };
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(modelsFile() + '.tmp', JSON.stringify(data, null, 2));
  renameSync(modelsFile() + '.tmp', modelsFile());
  return data;
}

// Susun input sesuai skema model (kalau sudah disinkronkan); model tanpa skema memakai bentuk umum nano-banana.
function buildInput(model, { prompt, size, urls }) {
  const m = syncedModels().models.find((x) => x.id === model);
  const input = { prompt };
  if (urls ? m?.sizeField === 'aspect_ratio' && size : !m || m.sizeField === 'aspect_ratio') input.aspect_ratio = aspectOf(size);
  if (!m || m.outputFormat) input.output_format = 'png';
  if (urls) input[m?.imageField || 'image_urls'] = m?.imageArray === false ? urls[0] : urls;
  return input;
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
  return runMany(n, () => createTask(model, buildInput(model, { prompt, size })), perImageCredits);
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

export async function edit({ model, prompt, images, n = 1, size, perImageCredits = null }) {
  const urls = await Promise.all(images.slice(0, 5).map(upload));
  return runMany(n, () => createTask(model, buildInput(model, { prompt, size, urls })), perImageCredits);
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
