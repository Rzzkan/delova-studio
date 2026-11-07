import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

// Rahasia yang diatur dari dashboard disimpan di data/secrets.json (izin 0600, ikut volume Docker).
// Nilainya tidak pernah dikirim balik ke browser/Claude; hanya bentuk tersamarkan (kn-••••1234).
// Dibaca sinkron per pemakaian: berkas kecil, dan perubahan langsung berlaku tanpa restart.
const file = () => join(config.dataDir, 'secrets.json');
export const KEY_RE = /^kn-[A-Za-z0-9_-]{8,200}$/;

function read() {
  try { return JSON.parse(readFileSync(file(), 'utf8')); } catch { return {}; }
}
function write(obj) {
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(file() + '.tmp', JSON.stringify(obj, null, 2), { mode: 0o600 });
  renameSync(file() + '.tmp', file());
}

export const KIE_KEY_RE = /^[A-Za-z0-9_-]{16,200}$/;
export const mask = (k) => (k ? `${k.slice(0, 3)}••••${k.slice(-4)}` : '');

// Key dari dashboard menang atas KENARI_API_KEY di .env.
export function getApiKey() {
  return read().kenariApiKey || config.kenariApiKey;
}

export function keyInfo() {
  const saved = read().kenariApiKey;
  const key = saved || config.kenariApiKey;
  return { hasKey: Boolean(key), source: saved ? 'dashboard' : key ? 'env' : 'none', masked: mask(key) };
}

export function setApiKey(key) {
  if (!KEY_RE.test(key || '')) {
    const err = new Error('Format API key tidak valid. Key kenari diawali "kn-" tanpa spasi.');
    err.status = 400;
    throw err;
  }
  write({ ...read(), kenariApiKey: key, updatedAt: new Date().toISOString() });
}

export function clearApiKey() {
  const { kenariApiKey, ...rest } = read(); // eslint-disable-line no-unused-vars
  write(rest);
}

// ---- kie.ai (penyedia cadangan) ----
export function getKieKey() {
  return read().kieApiKey || config.kieApiKey;
}
export function kieKeyInfo() {
  const saved = read().kieApiKey;
  const key = saved || config.kieApiKey;
  return { hasKey: Boolean(key), source: saved ? 'dashboard' : key ? 'env' : 'none', masked: mask(key) };
}
export function setKieKey(key) {
  if (!KIE_KEY_RE.test(key || '')) {
    const err = new Error('Format API key kie.ai tidak valid (16-200 karakter huruf/angka, tanpa spasi).');
    err.status = 400;
    throw err;
  }
  write({ ...read(), kieApiKey: key, updatedAt: new Date().toISOString() });
}
export function clearKieKey() {
  const { kieApiKey, ...rest } = read(); // eslint-disable-line no-unused-vars
  write(rest);
}
