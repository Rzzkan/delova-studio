import { readFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

// Banyak Style Guide: satu "gaya dasar" (selalu dipakai jika Style Guide aktif) + gaya per content pillar/kebutuhan
// yang dipilih saat generate. Disimpan di database SQLite (data/studio.db) lengkap dengan riwayat revisi.
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

// ---- Database SQLite (node:sqlite bawaan Node 22, tanpa dependensi). File: data/studio.db ----
let cached;
function db() {
  const path = join(config.dataDir, 'studio.db');
  if (cached?.path === path) return cached.db;
  mkdirSync(config.dataDir, { recursive: true });
  const d = new DatabaseSync(path);
  d.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS styles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, pillar TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '',
      base INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL DEFAULT 'web', deleted_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS styles_name_live ON styles (lower(name)) WHERE deleted_at IS NULL;
    CREATE TABLE IF NOT EXISTS style_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, style_id TEXT NOT NULL, name TEXT NOT NULL, pillar TEXT NOT NULL, text TEXT NOT NULL,
      base INTEGER NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rev_style ON style_revisions (style_id, id);
  `);
  cached = { path, db: d };
  migrate(d);
  return d;
}

// Sekali jalan: impor dari styles.json (versi sebelumnya) atau style.txt (versi paling awal) jika tabel masih kosong.
function migrate(d) {
  if (d.prepare('SELECT COUNT(*) AS n FROM styles').get().n > 0) return;
  let rows = [];
  const json = join(config.dataDir, 'styles.json');
  const legacy = join(config.dataDir, 'style.txt');
  try { rows = JSON.parse(readFileSync(json, 'utf8')).styles || []; } catch { /* tidak ada */ }
  if (!rows.length && existsSync(legacy)) {
    const text = readFileSync(legacy, 'utf8').trim();
    if (text) rows = [{ id: randomUUID(), name: 'Gaya dasar', pillar: '', text, base: true }];
  }
  for (const r of rows) {
    insert(d, { id: r.id || randomUUID(), name: r.name, pillar: r.pillar || '', text: r.text || '', base: r.base ? 1 : 0 }, 'import', 'migrasi', r.updatedAt);
  }
  if (rows.length && existsSync(json)) { try { renameSync(json, json + '.migrated'); } catch { /* abaikan */ } }
}

const now = () => new Date().toISOString();
const toStyle = (r) => ({ id: r.id, name: r.name, pillar: r.pillar, text: r.text, base: Boolean(r.base), updatedAt: r.updated_at, updatedBy: r.updated_by });

function snapshot(d, r, action, actor) {
  d.prepare('INSERT INTO style_revisions (style_id, name, pillar, text, base, action, actor, at) VALUES (?,?,?,?,?,?,?,?)')
    .run(r.id, r.name, r.pillar, r.text, r.base ? 1 : 0, action, actor, now());
}
function insert(d, r, action, actor, at) {
  d.prepare('INSERT INTO styles (id, name, pillar, text, base, updated_at, updated_by) VALUES (?,?,?,?,?,?,?)')
    .run(r.id, r.name, r.pillar, r.text, r.base ? 1 : 0, at || now(), actor);
  snapshot(d, r, action, actor);
}
function tx(fn) {
  const d = db();
  d.exec('BEGIN IMMEDIATE');
  try { const out = fn(d); d.exec('COMMIT'); return out; } catch (e) { d.exec('ROLLBACK'); throw e; }
}
const liveRow = (d, id) => d.prepare('SELECT * FROM styles WHERE id = ? AND deleted_at IS NULL').get(id);
const nameTaken = (d, name, exceptId) => Boolean(d.prepare('SELECT 1 FROM styles WHERE lower(name) = lower(?) AND deleted_at IS NULL AND id != ?').get(name, exceptId || ''));
const setOnlyBase = (d, id, actor) => {
  for (const o of d.prepare('SELECT * FROM styles WHERE base = 1 AND id != ? AND deleted_at IS NULL').all(id)) {
    d.prepare('UPDATE styles SET base = 0, updated_at = ?, updated_by = ? WHERE id = ?').run(now(), actor, o.id);
    snapshot(d, { ...o, base: 0 }, 'update', actor);
  }
};

export const list = () => db().prepare('SELECT * FROM styles WHERE deleted_at IS NULL ORDER BY base DESC, rowid').all().map(toStyle);
export function find(ref, styles = list()) {
  const r = String(ref ?? '').trim().toLowerCase();
  return r ? styles.find((x) => x.id === ref || x.name.toLowerCase() === r) : undefined;
}
export const getBase = (styles = list()) => styles.find((x) => x.base);

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

export function create(p, actor = 'web') {
  const c = clean(p);
  return tx((d) => {
    if (d.prepare('SELECT COUNT(*) AS n FROM styles WHERE deleted_at IS NULL').get().n >= MAX_STYLES) throw bad(`Maksimal ${MAX_STYLES} style`);
    if (nameTaken(d, c.name)) throw bad(`Style "${c.name}" sudah ada`);
    const r = { id: randomUUID(), name: c.name, pillar: c.pillar || '', text: c.text, base: c.base ? 1 : 0 };
    insert(d, r, 'create', actor);
    if (c.base) setOnlyBase(d, r.id, actor);
    return toStyle(liveRow(d, r.id));
  });
}

export function update(id, p, actor = 'web') {
  const c = clean(p, { partial: true });
  return tx((d) => {
    const cur = liveRow(d, id);
    if (!cur) throw bad('Style tidak ditemukan', 404);
    if (c.name !== undefined && nameTaken(d, c.name, id)) throw bad(`Style "${c.name}" sudah ada`);
    const next = { ...cur, ...('name' in c ? { name: c.name } : {}), ...('pillar' in c ? { pillar: c.pillar } : {}), ...('text' in c ? { text: c.text } : {}), base: 'base' in c ? (c.base ? 1 : 0) : cur.base };
    d.prepare('UPDATE styles SET name=?, pillar=?, text=?, base=?, updated_at=?, updated_by=? WHERE id=?').run(next.name, next.pillar, next.text, next.base, now(), actor, id);
    snapshot(d, next, 'update', actor);
    if (next.base) setOnlyBase(d, id, actor);
    return toStyle(liveRow(d, id));
  });
}

// Hapus lunak: baris tetap ada (deleted_at) beserta riwayatnya, bisa dipulihkan dengan restore().
export function remove(id, actor = 'web') {
  tx((d) => {
    const cur = liveRow(d, id);
    if (!cur) throw bad('Style tidak ditemukan', 404);
    d.prepare('UPDATE styles SET deleted_at = ?, base = 0, updated_at = ?, updated_by = ? WHERE id = ?').run(now(), now(), actor, id);
    snapshot(d, { ...cur, base: 0 }, 'delete', actor);
  });
}

// Pulihkan style yang dihapus (berdasarkan nama atau id), atau kembalikan isi ke revisi tertentu.
export function restore({ ref, revisionId }, actor = 'web') {
  return tx((d) => {
    if (revisionId !== undefined) {
      const rev = d.prepare('SELECT * FROM style_revisions WHERE id = ?').get(Number(revisionId));
      if (!rev) throw bad('Revisi tidak ditemukan', 404);
      const cur = d.prepare('SELECT * FROM styles WHERE id = ?').get(rev.style_id);
      if (!cur) throw bad('Style asal revisi tidak ada', 404);
      if (nameTaken(d, rev.name, cur.id)) throw bad(`Nama "${rev.name}" sekarang dipakai style lain`);
      d.prepare('UPDATE styles SET name=?, pillar=?, text=?, deleted_at=NULL, updated_at=?, updated_by=? WHERE id=?').run(rev.name, rev.pillar, rev.text, now(), actor, cur.id);
      snapshot(d, { ...cur, name: rev.name, pillar: rev.pillar, text: rev.text }, 'restore', actor);
      return toStyle(d.prepare('SELECT * FROM styles WHERE id = ?').get(cur.id));
    }
    const r = String(ref ?? '').trim().toLowerCase();
    const row = d.prepare('SELECT * FROM styles WHERE deleted_at IS NOT NULL AND (id = ? OR lower(name) = ?) ORDER BY deleted_at DESC LIMIT 1').get(String(ref ?? ''), r);
    if (!row) throw bad('Tidak ada style terhapus dengan nama itu', 404);
    if (nameTaken(d, row.name, row.id)) throw bad(`Sudah ada style aktif bernama "${row.name}"`);
    d.prepare('UPDATE styles SET deleted_at = NULL, updated_at = ?, updated_by = ? WHERE id = ?').run(now(), actor, row.id);
    snapshot(d, row, 'restore', actor);
    return toStyle(d.prepare('SELECT * FROM styles WHERE id = ?').get(row.id));
  });
}

export function history(ref, limit = 20) {
  const d = db();
  const r = String(ref ?? '').trim().toLowerCase();
  const row = d.prepare('SELECT id FROM styles WHERE id = ? OR lower(name) = ? ORDER BY deleted_at IS NULL DESC, updated_at DESC LIMIT 1').get(String(ref ?? ''), r);
  if (!row) throw bad(`Style "${ref}" tidak ditemukan`, 404);
  return d.prepare('SELECT id, name, pillar, text, base, action, actor, at FROM style_revisions WHERE style_id = ? ORDER BY id DESC LIMIT ?').all(row.id, Math.min(100, Math.max(1, limit)))
    .map((x) => ({ ...x, base: Boolean(x.base) }));
}

export const deletedNames = () => db().prepare('SELECT name FROM styles WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 20').all().map((x) => x.name);

// Tambah draf untuk 7 content pillar yang belum ada (tidak menimpa yang sudah ada).
export function seedPillars(actor = 'web') {
  const added = [];
  for (const [name, text] of PILLAR_DRAFTS) {
    try { create({ name, pillar: name, text }, actor); added.push(name); } catch (e) { if (!/sudah ada/.test(e.message)) throw e; }
  }
  return { added, styles: list() };
}

// Teks yang ditambahkan ke prompt: gaya dasar + gaya terpilih (jika ada).
export function compose(ref) {
  const styles = list();
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
