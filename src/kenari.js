import { config } from './config.js';

export class KenariError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'KenariError';
    this.status = status;
    this.code = code;
  }
}

function authHeaders() {
  if (!config.kenariApiKey) throw new KenariError('KENARI_API_KEY belum diisi di .env', { code: 'no_api_key' });
  return { Authorization: `Bearer ${config.kenariApiKey}` };
}

// Server kenari bisa mengirim spasi (keepalive) sebelum JSON, dan error bisa datang dengan status 200.
async function readJson(res) {
  const text = (await res.text()).trim();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new KenariError(`Respons bukan JSON (HTTP ${res.status}): ${text.slice(0, 200)}`, { status: res.status });
  }
  const err = body.error;
  if (!res.ok || err) {
    const msg = typeof err === 'string' ? err : err?.message || `HTTP ${res.status}`;
    throw new KenariError(msg, { status: res.status, code: err?.code });
  }
  return body;
}

export function detectMime(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'image/png';
}

async function toBuffer(item) {
  if (item.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item.url?.startsWith('data:')) return Buffer.from(item.url.slice(item.url.indexOf(',') + 1), 'base64');
  if (item.url) {
    const r = await fetch(item.url, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new KenariError(`Gagal mengunduh gambar (HTTP ${r.status})`);
    return Buffer.from(await r.arrayBuffer());
  }
  throw new KenariError('Item gambar kosong dari kenari');
}

async function parseImages(body) {
  const data = body.data || [];
  if (!data.length) throw new KenariError('Kenari tidak mengembalikan gambar');
  return Promise.all(
    data.map(async (item) => {
      const buffer = await toBuffer(item);
      return { buffer, mime: detectMime(buffer), revisedPrompt: item.revised_prompt };
    }),
  );
}

export async function generate({ model, prompt, n = 1, size, background }) {
  const payload = { model, prompt, n, response_format: 'b64_json' };
  if (size) payload.size = size;
  if (background) payload.background = background;
  const res = await fetch(`${config.kenariBaseUrl}/images/generations`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  return parseImages(await readJson(res));
}

export async function edit({ model, prompt, images, mask, n = 1, size, quality }) {
  const form = new FormData();
  form.set('model', model);
  form.set('prompt', prompt);
  form.set('n', String(n));
  form.set('response_format', 'b64_json');
  if (size) form.set('size', size);
  if (quality) form.set('quality', quality);
  images.forEach((img, i) => form.append('image', new Blob([img.buffer], { type: img.mime }), `source-${i}.${img.mime.split('/')[1]}`));
  if (mask) form.set('mask', new Blob([mask.buffer], { type: 'image/png' }), 'mask.png');
  const res = await fetch(`${config.kenariBaseUrl}/images/edits`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  return parseImages(await readJson(res));
}

let modelCache = { at: 0, models: [] };

// Harga di /v1/models berupa micro-IDR (1.000.000 = Rp1). Hanya model dengan endpoint "images".
export async function listImageModels({ force = false } = {}) {
  if (!force && Date.now() - modelCache.at < 10 * 60 * 1000 && modelCache.models.length) return modelCache.models;
  const res = await fetch(`${config.kenariBaseUrl}/models`, { signal: AbortSignal.timeout(30000) });
  const body = await readJson(res);
  const models = (body.data || [])
    .filter((m) => Array.isArray(m.endpoints) && m.endpoints.includes('images'))
    .map((m) => ({ id: m.id, name: m.name || m.id, pricePerImageIdr: extractPrice(m), input: m.modalities?.input || [] }));
  modelCache = { at: Date.now(), models };
  return models;
}

function extractPrice(m) {
  if (m.pricing?.free) return 0;
  const line = (m.pricing_lines || []).find((l) => l.unit === 'image' && l.endpoint === 'images');
  if (line && typeof line.micro_idr === 'number') return line.micro_idr / 1_000_000;
  return null; // harga tidak diketahui -> diperlakukan butuh persetujuan
}
