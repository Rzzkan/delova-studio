import { readFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

// Banyak brand. Tiap brand punya satu "gaya dasar" (selalu dipakai jika Style Guide aktif) + banyak gaya per content pillar
// yang dipilih saat generate. Tiap gaya (pillar) boleh punya model generate sendiri + model cadangan sendiri.
// Disimpan di database SQLite (data/studio.db) lengkap dengan riwayat revisi.
const MAX_STYLES = 30, MAX_BRANDS = 20, MAX_TEXT = 4000, MAX_FALLBACKS = 5;

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const now = () => new Date().toISOString();

// Draf arah visual per pilar, per brand (kunci = slug brand). Silakan ubah; disetujui Owner sebelum dipakai produksi.
const PILLAR_DRAFTS = {
  'teman-seller': [
    ['Ngopi Dulu', 'Suasana hangat dan santai: meja kerja dengan secangkir kopi, cahaya lembut pagi atau malam, maskot orisinal Teman Seller bersandar santai. Palet oranye-krem lembut, banyak ruang kosong, tanpa teks di gambar.'],
    ['Satu Langkah Kecil', 'Ilustrasi edukasi yang bersih: satu objek utama yang menggambarkan satu langkah (anak tangga kecil, ceklis, panah), latar polos terang, garis tebal rapi, sisakan ruang kosong untuk teks slide. Tanpa teks di gambar.'],
    ['Kabar Pasar', 'Gaya editorial informatif dan tenang: ikon marketplace generik (tanpa logo atau merek asli), tumpukan paket, megafon, kalender. Palet biru-krem yang tegas, tata letak rapi. Tanpa teks dan tanpa angka di gambar.'],
    ['Hitung-hitungan Juragan', 'Kalkulator, koin, grafik batang sederhana, tag diskon generik, tertata rapi di grid. Palet hijau-krem, kontras jelas, garis tebal. Tanpa teks dan tanpa angka di gambar.'],
    ['Rapikan Tokomu', 'Etalase toko online yang rapi dan estetis: rak produk, foto produk berlatar bersih, suasana before-after yang tertata. Palet krem-terakota, pencahayaan lembut, komposisi bersih. Tanpa teks di gambar.'],
    ['Cerita dan Obrolan Juragan', 'Suasana komunitas yang hangat: beberapa karakter penjual kartun yang beragam sedang mengobrol, balon obrolan kosong, meriah tapi rapi. Palet oranye-krem dengan aksen cerah. Tanpa teks di gambar.'],
    ['Dari Meja Teman Seller', 'Maskot orisinal Teman Seller menunjuk layar alat yang sederhana dan generik, nuansa praktis dan ramah. Palet brand, latar bersih. Jangan menggambar fitur, harga, atau angka tertentu. Tanpa teks di gambar.'],
  ],
};
export const pillarDraftNames = (brandSlug) => (PILLAR_DRAFTS[brandSlug] || []).map(([n]) => n);

export function slugOf(name) {
  return String(name || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'brand';
}

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
    CREATE TABLE IF NOT EXISTS brands (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      is_default INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL DEFAULT 'web', deleted_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS brands_slug_live ON brands (slug) WHERE deleted_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS brands_name_live ON brands (lower(name)) WHERE deleted_at IS NULL;
    CREATE TABLE IF NOT EXISTS styles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, pillar TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '',
      base INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL DEFAULT 'web', deleted_at TEXT,
      brand_id TEXT, model TEXT NOT NULL DEFAULT '', fallback_models TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS style_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, style_id TEXT NOT NULL, name TEXT NOT NULL, pillar TEXT NOT NULL, text TEXT NOT NULL,
      base INTEGER NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '', fallback_models TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS rev_style ON style_revisions (style_id, id);
  `);
  const brandId = bootstrap(d);
  migrateLegacy(d, brandId);
  cached = { path, db: d };
  return d;
}

// Naik versi skema untuk database lama (sebelum multi-brand / model per pillar) dan pastikan ada brand default.
function bootstrap(d) {
  const has = (table, col) => Boolean(d.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(col));
  if (!has('styles', 'brand_id')) d.exec('ALTER TABLE styles ADD COLUMN brand_id TEXT');
  if (!has('styles', 'model')) d.exec("ALTER TABLE styles ADD COLUMN model TEXT NOT NULL DEFAULT ''");
  if (!has('styles', 'fallback_models')) d.exec("ALTER TABLE styles ADD COLUMN fallback_models TEXT NOT NULL DEFAULT '[]'");
  if (!has('style_revisions', 'model')) d.exec("ALTER TABLE style_revisions ADD COLUMN model TEXT NOT NULL DEFAULT ''");
  if (!has('style_revisions', 'fallback_models')) d.exec("ALTER TABLE style_revisions ADD COLUMN fallback_models TEXT NOT NULL DEFAULT '[]'");
  d.exec('DROP INDEX IF EXISTS styles_name_live'); // dulu nama unik global, sekarang unik per brand

  let def = d.prepare('SELECT id FROM brands WHERE is_default = 1 AND deleted_at IS NULL').get();
  if (!def) {
    const first = d.prepare('SELECT id FROM brands WHERE deleted_at IS NULL ORDER BY rowid LIMIT 1').get();
    if (first) {
      d.prepare('UPDATE brands SET is_default = 1 WHERE id = ?').run(first.id);
      def = first;
    } else {
      const id = randomUUID(), name = config.defaultBrandName;
      d.prepare('INSERT INTO brands (id, slug, name, note, is_default, updated_at, updated_by) VALUES (?,?,?,?,1,?,?)').run(id, slugOf(name), name, '', now(), 'sistem');
      def = { id };
    }
  }
  d.prepare('UPDATE styles SET brand_id = ? WHERE brand_id IS NULL').run(def.id); // style lama menjadi milik brand default
  d.exec('CREATE UNIQUE INDEX IF NOT EXISTS styles_brand_name_live ON styles (brand_id, lower(name)) WHERE deleted_at IS NULL');
  return def.id;
}

// Sekali jalan: impor dari styles.json (versi sebelumnya) atau style.txt (versi paling awal) jika tabel masih kosong.
function migrateLegacy(d, brandId) {
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
    insert(d, { id: r.id || randomUUID(), brand_id: brandId, name: r.name, pillar: r.pillar || '', text: r.text || '', base: r.base ? 1 : 0, model: '', fallback_models: '[]' }, 'import', 'migrasi', r.updatedAt);
  }
  if (rows.length && existsSync(json)) { try { renameSync(json, json + '.migrated'); } catch { /* abaikan */ } }
}

function tx(fn) {
  const d = db();
  d.exec('BEGIN IMMEDIATE');
  try { const out = fn(d); d.exec('COMMIT'); return out; } catch (e) { d.exec('ROLLBACK'); throw e; }
}

// =============================== BRAND ===============================
const toBrand = (r) => ({ id: r.id, slug: r.slug, name: r.name, note: r.note, default: Boolean(r.is_default), styleCount: r.n, updatedAt: r.updated_at, updatedBy: r.updated_by });
const BRAND_SQL = 'SELECT b.*, (SELECT COUNT(*) FROM styles s WHERE s.brand_id = b.id AND s.deleted_at IS NULL) AS n FROM brands b';

export const listBrands = () => db().prepare(`${BRAND_SQL} WHERE b.deleted_at IS NULL ORDER BY b.is_default DESC, b.rowid`).all().map(toBrand);
export const defaultBrand = () => listBrands().find((b) => b.default);
export const brandCount = () => db().prepare('SELECT COUNT(*) AS n FROM brands WHERE deleted_at IS NULL').get().n;
export const deletedBrandNames = () => db().prepare('SELECT name FROM brands WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 20').all().map((x) => x.name);

function brandRow(d, ref, deleted = false) {
  const s = String(ref ?? '').trim();
  if (!s) return undefined;
  const l = s.toLowerCase();
  return d.prepare(`${BRAND_SQL} WHERE b.deleted_at IS ${deleted ? 'NOT ' : ''}NULL AND (b.id = ? OR b.slug = ? OR lower(b.name) = ?) ORDER BY b.deleted_at DESC LIMIT 1`).get(s, l, l);
}
export function findBrand(ref) {
  const r = brandRow(db(), ref);
  return r ? toBrand(r) : undefined;
}
/** Kosong = brand default. Brand tak dikenal = galat dengan daftar brand yang ada. */
export function resolveBrand(ref) {
  const d = db();
  if (!String(ref ?? '').trim()) return toBrand(d.prepare(`${BRAND_SQL} WHERE b.is_default = 1 AND b.deleted_at IS NULL`).get());
  const r = brandRow(d, ref);
  if (!r) throw bad(`Brand "${ref}" tidak ditemukan. Brand yang ada: ${listBrands().map((b) => b.name).join(', ')}`);
  return toBrand(r);
}
/** Untuk operasi tulis/generate: jika ada lebih dari satu brand, brand wajib disebut (mencegah salah brand diam-diam). */
export function pickBrand(ref) {
  if (String(ref ?? '').trim()) return resolveBrand(ref);
  const all = listBrands();
  if (all.length > 1) throw bad(`Ada ${all.length} brand (${all.map((b) => b.name).join(', ')}). Sebutkan brand yang dimaksud (parameter brand).`);
  return all[0] ?? resolveBrand();
}

function cleanBrand(p, { partial = false } = {}) {
  const out = {};
  if (!partial || p.name !== undefined) {
    out.name = String(p.name ?? '').trim();
    if (!out.name || out.name.length > 60) throw bad('Nama brand wajib diisi (maksimal 60 karakter)');
  }
  if (p.note !== undefined) {
    out.note = String(p.note).trim();
    if (out.note.length > 500) throw bad('Catatan brand maksimal 500 karakter');
  }
  if (p.default !== undefined) out.default = Boolean(p.default);
  return out;
}
const brandNameTaken = (d, name, exceptId) => Boolean(d.prepare('SELECT 1 FROM brands WHERE lower(name) = lower(?) AND deleted_at IS NULL AND id != ?').get(name, exceptId || ''));
function uniqueSlug(d, name) {
  const base = slugOf(name);
  for (let i = 1; ; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    if (!d.prepare('SELECT 1 FROM brands WHERE slug = ?').get(slug)) return slug; // termasuk brand terhapus, supaya pemulihan tidak bentrok
  }
}
function setOnlyDefault(d, id, actor) {
  d.prepare('UPDATE brands SET is_default = 0, updated_at = ?, updated_by = ? WHERE is_default = 1 AND id != ?').run(now(), actor, id);
  d.prepare('UPDATE brands SET is_default = 1, updated_at = ?, updated_by = ? WHERE id = ?').run(now(), actor, id);
}

export function createBrand(p, actor = 'web') {
  const c = cleanBrand(p);
  return tx((d) => {
    if (d.prepare('SELECT COUNT(*) AS n FROM brands WHERE deleted_at IS NULL').get().n >= MAX_BRANDS) throw bad(`Maksimal ${MAX_BRANDS} brand`);
    if (brandNameTaken(d, c.name)) throw bad(`Brand "${c.name}" sudah ada`);
    const id = randomUUID();
    d.prepare('INSERT INTO brands (id, slug, name, note, is_default, updated_at, updated_by) VALUES (?,?,?,?,0,?,?)').run(id, uniqueSlug(d, c.name), c.name, c.note || '', now(), actor);
    if (c.default) setOnlyDefault(d, id, actor);
    return toBrand(d.prepare(`${BRAND_SQL} WHERE b.id = ?`).get(id));
  });
}
export function updateBrand(ref, p, actor = 'web') {
  const c = cleanBrand(p, { partial: true });
  return tx((d) => {
    const cur = brandRow(d, ref);
    if (!cur) throw bad('Brand tidak ditemukan', 404);
    if (c.name !== undefined && brandNameTaken(d, c.name, cur.id)) throw bad(`Brand "${c.name}" sudah ada`);
    if (c.default === false && cur.is_default) throw bad('Brand default tidak bisa dimatikan. Jadikan brand lain sebagai default.');
    d.prepare('UPDATE brands SET name = ?, note = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(c.name ?? cur.name, c.note ?? cur.note, now(), actor, cur.id);
    if (c.default) setOnlyDefault(d, cur.id, actor);
    return toBrand(d.prepare(`${BRAND_SQL} WHERE b.id = ?`).get(cur.id));
  });
}
// Hapus lunak: brand + semua style-nya disembunyikan dan bisa dipulihkan dengan restoreBrand().
export function removeBrand(ref, actor = 'web') {
  return tx((d) => {
    const cur = brandRow(d, ref);
    if (!cur) throw bad('Brand tidak ditemukan', 404);
    if (cur.is_default) throw bad('Brand default tidak bisa dihapus. Jadikan brand lain sebagai default dulu.');
    d.prepare('UPDATE brands SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(now(), now(), actor, cur.id);
    return toBrand(cur);
  });
}
export function restoreBrand(ref, actor = 'web') {
  return tx((d) => {
    const row = brandRow(d, ref, true);
    if (!row) throw bad('Tidak ada brand terhapus dengan nama itu', 404);
    if (brandNameTaken(d, row.name, row.id)) throw bad(`Sudah ada brand aktif bernama "${row.name}"`);
    d.prepare('UPDATE brands SET deleted_at = NULL, updated_at = ?, updated_by = ? WHERE id = ?').run(now(), actor, row.id);
    return toBrand(d.prepare(`${BRAND_SQL} WHERE b.id = ?`).get(row.id));
  });
}

// =============================== STYLE / PILLAR ===============================
const parseModels = (s) => { try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; } };
const toStyle = (r) => ({
  id: r.id, brandId: r.brand_id, name: r.name, pillar: r.pillar, text: r.text, base: Boolean(r.base),
  model: r.model || '', fallbackModels: parseModels(r.fallback_models), updatedAt: r.updated_at, updatedBy: r.updated_by,
});

function snapshot(d, r, action, actor) {
  d.prepare('INSERT INTO style_revisions (style_id, name, pillar, text, base, action, actor, at, model, fallback_models) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(r.id, r.name, r.pillar, r.text, r.base ? 1 : 0, action, actor, now(), r.model || '', r.fallback_models || '[]');
}
function insert(d, r, action, actor, at) {
  d.prepare('INSERT INTO styles (id, brand_id, name, pillar, text, base, model, fallback_models, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(r.id, r.brand_id, r.name, r.pillar, r.text, r.base ? 1 : 0, r.model || '', r.fallback_models || '[]', at || now(), actor);
  snapshot(d, r, action, actor);
}
// Style hanya dianggap hidup jika brand-nya juga hidup.
const liveRow = (d, id) => d.prepare('SELECT s.* FROM styles s JOIN brands b ON b.id = s.brand_id AND b.deleted_at IS NULL WHERE s.id = ? AND s.deleted_at IS NULL').get(id);
const nameTaken = (d, brandId, name, exceptId) => Boolean(d.prepare('SELECT 1 FROM styles WHERE brand_id = ? AND lower(name) = lower(?) AND deleted_at IS NULL AND id != ?').get(brandId, name, exceptId || ''));
const setOnlyBase = (d, brandId, id, actor) => {
  for (const o of d.prepare('SELECT * FROM styles WHERE brand_id = ? AND base = 1 AND id != ? AND deleted_at IS NULL').all(brandId, id)) {
    d.prepare('UPDATE styles SET base = 0, updated_at = ?, updated_by = ? WHERE id = ?').run(now(), actor, o.id);
    snapshot(d, { ...o, base: 0 }, 'update', actor);
  }
};

/** Daftar style satu brand (kosong = brand default). Gaya dasar di urutan pertama. */
export const list = (brandRef) => {
  const b = resolveBrand(brandRef);
  return db().prepare('SELECT * FROM styles WHERE brand_id = ? AND deleted_at IS NULL ORDER BY base DESC, rowid').all(b.id).map(toStyle);
};
export function find(ref, styles) {
  const r = String(ref ?? '').trim().toLowerCase();
  return r ? styles.find((x) => x.id === ref || x.name.toLowerCase() === r) : undefined;
}
export const getBase = (styles) => styles.find((x) => x.base);

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
  if (p.model !== undefined) {
    out.model = String(p.model ?? '').trim();
    if (out.model.length > 80) throw bad('ID model maksimal 80 karakter');
  }
  if (p.fallbackModels !== undefined) {
    if (!Array.isArray(p.fallbackModels)) throw bad('fallbackModels harus berupa daftar');
    const ids = [...new Set(p.fallbackModels.map((x) => String(x).trim()).filter(Boolean))];
    if (ids.length > MAX_FALLBACKS) throw bad(`Model cadangan maksimal ${MAX_FALLBACKS}`);
    if (ids.some((x) => x.length > 80)) throw bad('ID model maksimal 80 karakter');
    out.fallbackModels = ids;
  }
  return out;
}

export function create(p, actor = 'web') {
  const c = clean(p);
  const brand = pickBrand(p.brand);
  return tx((d) => {
    if (d.prepare('SELECT COUNT(*) AS n FROM styles WHERE brand_id = ? AND deleted_at IS NULL').get(brand.id).n >= MAX_STYLES) throw bad(`Maksimal ${MAX_STYLES} style per brand`);
    if (nameTaken(d, brand.id, c.name)) throw bad(`Style "${c.name}" sudah ada di brand ${brand.name}`);
    const r = { id: randomUUID(), brand_id: brand.id, name: c.name, pillar: c.pillar || '', text: c.text, base: c.base ? 1 : 0, model: c.model || '', fallback_models: JSON.stringify(c.fallbackModels || []) };
    insert(d, r, 'create', actor);
    if (c.base) setOnlyBase(d, brand.id, r.id, actor);
    return toStyle(liveRow(d, r.id));
  });
}

export function update(id, p, actor = 'web') {
  const c = clean(p, { partial: true });
  return tx((d) => {
    const cur = liveRow(d, id);
    if (!cur) throw bad('Style tidak ditemukan', 404);
    if (c.name !== undefined && nameTaken(d, cur.brand_id, c.name, id)) throw bad(`Style "${c.name}" sudah ada di brand ini`);
    const next = {
      ...cur,
      ...('name' in c ? { name: c.name } : {}), ...('pillar' in c ? { pillar: c.pillar } : {}), ...('text' in c ? { text: c.text } : {}),
      ...('model' in c ? { model: c.model } : {}), ...('fallbackModels' in c ? { fallback_models: JSON.stringify(c.fallbackModels) } : {}),
      base: 'base' in c ? (c.base ? 1 : 0) : cur.base,
    };
    d.prepare('UPDATE styles SET name=?, pillar=?, text=?, base=?, model=?, fallback_models=?, updated_at=?, updated_by=? WHERE id=?')
      .run(next.name, next.pillar, next.text, next.base, next.model, next.fallback_models, now(), actor, id);
    snapshot(d, next, 'update', actor);
    if (next.base) setOnlyBase(d, cur.brand_id, id, actor);
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

// Pulihkan style yang dihapus (berdasarkan nama atau id, di satu brand), atau kembalikan isi ke revisi tertentu.
export function restore({ ref, revisionId, brand }, actor = 'web') {
  const target = revisionId === undefined ? pickBrand(brand) : null;
  return tx((d) => {
    if (revisionId !== undefined) {
      const rev = d.prepare('SELECT * FROM style_revisions WHERE id = ?').get(Number(revisionId));
      if (!rev) throw bad('Revisi tidak ditemukan', 404);
      const cur = d.prepare('SELECT * FROM styles WHERE id = ?').get(rev.style_id);
      if (!cur) throw bad('Style asal revisi tidak ada', 404);
      if (!d.prepare('SELECT 1 FROM brands WHERE id = ? AND deleted_at IS NULL').get(cur.brand_id)) throw bad('Brand style ini sudah dihapus. Pulihkan brand-nya dulu.');
      if (nameTaken(d, cur.brand_id, rev.name, cur.id)) throw bad(`Nama "${rev.name}" sekarang dipakai style lain`);
      d.prepare('UPDATE styles SET name=?, pillar=?, text=?, model=?, fallback_models=?, deleted_at=NULL, updated_at=?, updated_by=? WHERE id=?')
        .run(rev.name, rev.pillar, rev.text, rev.model, rev.fallback_models, now(), actor, cur.id);
      snapshot(d, { ...cur, name: rev.name, pillar: rev.pillar, text: rev.text, model: rev.model, fallback_models: rev.fallback_models }, 'restore', actor);
      return toStyle(d.prepare('SELECT * FROM styles WHERE id = ?').get(cur.id));
    }
    const r = String(ref ?? '').trim().toLowerCase();
    const row = d.prepare('SELECT * FROM styles WHERE brand_id = ? AND deleted_at IS NOT NULL AND (id = ? OR lower(name) = ?) ORDER BY deleted_at DESC LIMIT 1').get(target.id, String(ref ?? ''), r);
    if (!row) throw bad(`Tidak ada style terhapus dengan nama itu di brand ${target.name}`, 404);
    if (nameTaken(d, row.brand_id, row.name, row.id)) throw bad(`Sudah ada style aktif bernama "${row.name}"`);
    d.prepare('UPDATE styles SET deleted_at = NULL, updated_at = ?, updated_by = ? WHERE id = ?').run(now(), actor, row.id);
    snapshot(d, row, 'restore', actor);
    return toStyle(d.prepare('SELECT * FROM styles WHERE id = ?').get(row.id));
  });
}

export function history(ref, limit = 20, brand) {
  const b = pickBrand(brand);
  const d = db();
  const r = String(ref ?? '').trim().toLowerCase();
  const row = d.prepare('SELECT id FROM styles WHERE brand_id = ? AND (id = ? OR lower(name) = ?) ORDER BY deleted_at IS NULL DESC, updated_at DESC LIMIT 1').get(b.id, String(ref ?? ''), r);
  if (!row) throw bad(`Style "${ref}" tidak ditemukan di brand ${b.name}`, 404);
  return d.prepare('SELECT id, name, pillar, text, base, model, fallback_models, action, actor, at FROM style_revisions WHERE style_id = ? ORDER BY id DESC LIMIT ?').all(row.id, Math.min(100, Math.max(1, limit)))
    .map((x) => ({ ...x, base: Boolean(x.base), fallbackModels: parseModels(x.fallback_models) }));
}

export const deletedNames = (brandRef) => {
  const b = resolveBrand(brandRef);
  return db().prepare('SELECT name FROM styles WHERE brand_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 20').all(b.id).map((x) => x.name);
};

// Tambah draf pilar bawaan untuk brand ini (jika ada) yang belum ada. Tidak menimpa yang sudah ada.
export function seedPillars(actor = 'web', brandRef) {
  const brand = pickBrand(brandRef);
  const drafts = PILLAR_DRAFTS[brand.slug];
  if (!drafts) throw bad(`Brand ${brand.name} belum punya draf pilar bawaan. Buat pilar sendiri lewat "+ Style baru".`);
  const added = [];
  for (const [name, text] of drafts) {
    try { create({ brand: brand.id, name, pillar: name, text }, actor); added.push(name); } catch (e) { if (!/sudah ada/.test(e.message)) throw e; }
  }
  return { added, styles: list(brand.id) };
}

/**
 * Teks yang ditambahkan ke prompt (gaya dasar brand + gaya pillar terpilih) dan konfigurasi model-nya.
 * Model: pillar terpilih > gaya dasar brand > (kosong = pakai default global).
 */
export function compose(brandRef, styleRef) {
  const brand = pickBrand(brandRef);
  const all = list(brand.id);
  const base = getBase(all);
  let pick;
  if (styleRef) {
    pick = find(styleRef, all);
    if (!pick) throw bad(`Style "${styleRef}" tidak ditemukan di brand ${brand.name}. Pakai list_style_guides untuk melihat daftar.`);
  }
  const parts = [];
  const used = [];
  if (base?.text) { parts.push(`Style guide ${brand.name} (dasar): ${base.text}`); used.push(base.name); }
  if (pick && pick.id !== base?.id && pick.text) { parts.push(`Style guide pilar "${pick.name}" (${brand.name}): ${pick.text}`); used.push(pick.name); }
  const src = [pick, base].find((x) => x?.model) || null;
  const fbSrc = [pick, base].find((x) => x?.fallbackModels.length) || null;
  return {
    text: parts.join('\n'), used, brand,
    model: src?.model || '', modelFrom: src?.name || null,
    fallbackModels: fbSrc?.fallbackModels || [],
  };
}
