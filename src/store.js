import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

const imagesDir = () => join(config.dataDir, 'images');
const indexFile = () => join(config.dataDir, 'index.json');
const styleFile = () => join(config.dataDir, 'style.txt');

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

// Tanggal WIB (Asia/Jakarta) dalam format YYYY-MM-DD.
export function wibDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function slugify(text, max = 40) {
  return (
    String(text || 'Gambar')
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .split(/\s+/)
      .slice(0, 6)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join('-')
      .slice(0, max) || 'Gambar'
  );
}

// Serialisasi tulis index agar request paralel tidak saling menimpa.
let chain = Promise.resolve();
const locked = (fn) => (chain = chain.then(fn, fn));

async function readIndex() {
  if (!existsSync(indexFile())) return [];
  return JSON.parse(await readFile(indexFile(), 'utf8'));
}

async function writeIndex(entries) {
  const tmp = indexFile() + '.tmp';
  await writeFile(tmp, JSON.stringify(entries, null, 2));
  await rename(tmp, indexFile());
}

export async function init() {
  await mkdir(imagesDir(), { recursive: true });
}

/** Simpan satu batch gambar. Nama file: YYYY-MM-DD_Role_Judul-Singkat_v1_01.ext (aturan kantor, bagian 3). */
export function saveBatch({ images, meta }) {
  return locked(async () => {
    await init();
    const entries = await readIndex();
    const date = wibDate();
    const role = slugify(meta.role || 'Kenzo', 20);
    const title = slugify(meta.title || meta.prompt);
    const prefix = `${date}_${role}_${title}`;
    let version = 1;
    while (entries.some((e) => e.file.startsWith(`${prefix}_v${version}_`))) version++;
    const saved = [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const file = `${prefix}_v${version}_${String(i + 1).padStart(2, '0')}.${EXT[img.mime] || 'png'}`;
      await writeFile(join(imagesDir(), file), img.buffer);
      const entry = {
        id: randomUUID().slice(0, 8),
        file,
        mime: img.mime,
        createdAt: new Date().toISOString(),
        date,
        kind: meta.kind,
        model: meta.model,
        prompt: meta.prompt,
        finalPrompt: meta.finalPrompt,
        title: meta.title || null,
        size: meta.size || null,
        source: meta.source || 'web',
        // biaya dibagi rata per gambar; biaya batch dicatat di gambar pertama agar total tetap akurat
        costIdr: i === 0 ? meta.costIdr : 0,
        batch: `${prefix}_v${version}`,
      };
      entries.push(entry);
      saved.push(entry);
    }
    await writeIndex(entries);
    return saved;
  });
}

export async function listImages({ limit = 50, query } = {}) {
  let entries = (await readIndex()).reverse();
  if (query) {
    const q = query.toLowerCase();
    entries = entries.filter((e) => `${e.title} ${e.prompt} ${e.file}`.toLowerCase().includes(q));
  }
  return entries.slice(0, limit);
}

export async function getImage(id) {
  const e = (await readIndex()).find((x) => x.id === id);
  if (!e) return null;
  return e;
}

export function imagePath(file) {
  return join(imagesDir(), basename(file)); // basename mencegah path traversal
}

export async function readImageFile(file) {
  return readFile(imagePath(file));
}

export async function spentToday() {
  const today = wibDate();
  return (await readIndex()).filter((e) => e.date === today).reduce((s, e) => s + (e.costIdr || 0), 0);
}

export async function getStyle() {
  return existsSync(styleFile()) ? (await readFile(styleFile(), 'utf8')).trim() : '';
}

export async function setStyle(text) {
  await init();
  await writeFile(styleFile(), String(text || '').trim());
}

export async function countFiles() {
  return existsSync(imagesDir()) ? (await readdir(imagesDir())).length : 0;
}
