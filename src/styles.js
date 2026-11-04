import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

// Banyak Style Guide: satu "gaya dasar" (selalu dipakai jika Style Guide aktif) + gaya per content pillar/kebutuhan
// yang dipilih saat generate. Disimpan di data/styles.json. Berkas lama data/style.txt dimigrasi jadi gaya dasar.
const file = () => join(config.dataDir, 'styles.json');
const MAX_STYLES = 30, MAX_TEXT = 4000;

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// Draf arah visual per pilar (Content Pillar v1). Silakan ubah; disetujui Owner sebelum dipakai produksi.
export const PILLAR_DRAFTS = [
  ['Ngopi Dulu', 'Suasana hangat dan santai: meja kerja dengan secangkir kopi, cahaya lembut pagi atau malam, maskot orisinal Teman Seller bersandar santai. Palet oranye-krem lembut, banyak ruang kosong, tanpa teks di gambar.'],
  ['Satu Langkah Kecil', 'Ilustrasi edukasi yang bersih: satu objek utama yang menggambarkan satu langkah (anak tangga kecil, ceklis, panah), latar polos terang, garis tebal rapi, sisakan ruang kosong untuk teks slide. Tanpa teks di gambar.'],
  ['Kabar Pasar', 'Gaya editorial informatif dan tenang: ikon marketplace generik (tanpa logo atau merek asli), tumpukan paket, megafon, kalender. Palet biru-krem yang tegas, tata letak rapi. Tanpa teks dan tanpa angka di gambar.'],
  ['Hitung-hitungan Juragan', 'Kalkulator, koin, grafik batang sederhana, tag diskon generik, tertata rapi di grid. Palet hijau-krem, kontras jelas, garis tebal. Tanpa teks dan tanpa angka di gambar.'],
  ['Rapikan Tokomu', 'Etalase toko online yang rapi dan estetis: rak produk, foto produk berlatar bersih, suasana before-after yang tertata. Palet krem-terakota, pencahayaan lembut, komposisi bersih. Tanpa teks di gambar.'],
  ['Cerita dan Obrolan Juragan', 'Suasana komunitas yang hangat: beberapa karakter penjual kartun yang beragam sedang mengobrol, balon obrolan kosong, meriah tapi rapi. Palet oranye-krem dengan aksen cerah. Tanpa teks di gambar.'],
  ['Dari Meja Teman Seller', 'Maskot orisinal Teman Seller menunjuk layar alat yang sederhana dan generik, nuansa praktis dan ramah. Palet brand, latar bersih. Jangan menggambar fitur, harga, atau angka tertentu. Tanpa teks di gambar.'],
];

function read() {
  try {
    const d = JSON.parse(readFileSync(file(), 'utf8'));
    if (Array.isArray(d.styles)) return d.styles;
  } catch { /* belum ada */ }
  const legacy = join(config.dataDir, 'style.txt');
  if (existsSync(legacy)) {
    const text = readFileSync(legacy, 'utf8').trim();
    if (text) return [{ id: randomUUID(), name: 'Gaya dasar', pillar: '', text, base: true, updatedAt: new Date().toISOString() }];
  }
  return [];
}
function write(styles) {
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(file() + '.tmp', JSON.stringify({ styles }, null, 2));
  renameSync(file() + '.tmp', file());
  return styles;
}

export const list = () => read();
export function find(ref, styles = read()) {
  const r = String(ref ?? '').trim().toLowerCase();
  return r ? styles.find((s) => s.id === ref || s.name.toLowerCase() === r) : undefined;
}
export const getBase = (styles = read()) => styles.find((s) => s.base);

function clean(p, { partial = false } = {}) {
  const out = {};
  if (!partial || p.name !== undefined) {
    out.name = String(p.name ?? '').trim();
    if (!out.name || out.name.length > 60) throw bad('Nama style wajib diisi (maksimal 60 karakter)');
  }
  if (p.pillar !== undefined) {
    out.pillar = String(p.pillar).trim();
    if (out.pillar.length > 60) throw bad('Pilar maksimal 60 karakter');
  }
  if (!partial || p.text !== undefined) {
    out.text = String(p.text ?? '').trim();
    if (out.text.length > MAX_TEXT) throw bad(`Teks style maksimal ${MAX_TEXT} karakter`);
  }
  if (p.base !== undefined) out.base = Boolean(p.base);
  return out;
}
const dupName = (styles, name, exceptId) => styles.some((s) => s.id !== exceptId && s.name.toLowerCase() === name.toLowerCase());
function applyBase(styles, id) { styles.forEach((s) => { s.base = s.id === id; }); }

export function create(p) {
  const styles = read();
  if (styles.length >= MAX_STYLES) throw bad(`Maksimal ${MAX_STYLES} style`);
  const c = clean(p);
  if (dupName(styles, c.name)) throw bad(`Style "${c.name}" sudah ada`);
  const s = { id: randomUUID(), name: c.name, pillar: c.pillar || '', text: c.text, base: false, updatedAt: new Date().toISOString() };
  styles.push(s);
  if (c.base) applyBase(styles, s.id);
  write(styles);
  return styles.find((x) => x.id === s.id);
}

export function update(id, p) {
  const styles = read();
  const s = styles.find((x) => x.id === id);
  if (!s) throw bad('Style tidak ditemukan', 404);
  const c = clean(p, { partial: true });
  if (c.name !== undefined && dupName(styles, c.name, id)) throw bad(`Style "${c.name}" sudah ada`);
  const { base, ...rest } = c;
  Object.assign(s, rest, { updatedAt: new Date().toISOString() });
  if (base === true) applyBase(styles, id);
  else if (base === false) s.base = false;
  write(styles);
  return s;
}

export function remove(id) {
  const styles = read();
  if (!styles.some((x) => x.id === id)) throw bad('Style tidak ditemukan', 404);
  write(styles.filter((x) => x.id !== id));
}

// Tambah draf untuk 7 content pillar yang belum ada (tidak menimpa yang sudah ada).
export function seedPillars() {
  const styles = read();
  const added = [];
  for (const [name, text] of PILLAR_DRAFTS) {
    if (dupName(styles, name)) continue;
    const s = { id: randomUUID(), name, pillar: name, text, base: false, updatedAt: new Date().toISOString() };
    styles.push(s); added.push(s.name);
  }
  write(styles);
  return { added, styles };
}

// Teks yang ditambahkan ke prompt: gaya dasar + gaya terpilih (jika ada).
export function compose(ref) {
  const styles = read();
  const base = getBase(styles);
  let pick;
  if (ref) {
    pick = find(ref, styles);
    if (!pick) throw bad(`Style "${ref}" tidak ditemukan. Pakai list_style_guides untuk melihat daftar.`);
  }
  const parts = [];
  const used = [];
  if (base?.text) { parts.push(`Style guide Teman Seller (dasar): ${base.text}`); used.push(base.name); }
  if (pick && pick.id !== base?.id && pick.text) { parts.push(`Style guide pilar "${pick.name}": ${pick.text}`); used.push(pick.name); }
  return { text: parts.join('\n'), used };
}
