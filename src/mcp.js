import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from './config.js';
import * as kenari from './kenari.js';
import * as store from './store.js';
import * as service from './service.js';
import { ApprovalRequired } from './service.js';
import { signedUrl } from './share.js';
import * as settings from './settings.js';
import * as styles from './styles.js';

const baseUrl = () => config.publicUrl || `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
const text = (t) => ({ type: 'text', text: t });
const fail = (t) => ({ isError: true, content: [text(t)] });

async function result(res, returnImages) {
  const lines = res.images.map((e) => `- ${e.id} | ${e.file} | ${baseUrl()}/files/${encodeURIComponent(e.file)}`);
  const fb = res.fallbackFrom ? `PERHATIAN: model utama ${res.fallbackFrom} gagal, hasil dibuat dengan model cadangan ${res.modelUsed}. Alasan: ${res.failures.join(' | ')}\n` : '';
  const content = [text(`${fb}Selesai: ${res.images.length} gambar${res.images[0]?.brandName ? ` untuk brand ${res.images[0].brandName}${res.images[0].style ? ` (${res.images[0].style})` : ''}` : ''} dengan ${res.modelUsed}, biaya Rp${res.costIdr}.\n${lines.join('\n')}\nSemua gambar tersimpan di galeri: ${baseUrl()}`)];
  if (returnImages) {
    for (const e of res.images) {
      const buf = await store.readImageFile(e.file);
      content.push({ type: 'image', data: buf.toString('base64'), mimeType: e.mime });
    }
  }
  return { content };
}

function wrap(fn) {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      if (e instanceof ApprovalRequired) return fail(`${e.message}\nEstimasi: ${JSON.stringify(e.details)}`);
      return fail(`Gagal: ${e.message}`);
    }
  };
}

const common = {
  model: z.string().optional().describe(`ID model gambar. Kosong = model milik pillar (atau gaya dasar brand) bila diatur, kalau tidak default ${settings.getSync().defaultModel} (Dashboard > Konfigurasi). Lihat list_image_models.`),
  n: z.number().int().min(1).max(10).optional().describe('Jumlah gambar. Dibatasi pengaturan Dashboard (default 5). Aturan kantor: minta 5 untuk opsi konsep.'),
  size: z.string().optional().describe('Petunjuk ukuran, mis. 1024x1024, 1024x1280 (feed 4:5), 1024x1792 (story). Bukan jaminan.'),
  title: z.string().optional().describe('Judul singkat untuk nama file (YYYY-MM-DD_Role_Judul-Singkat_v1).'),
  role: z.string().optional().describe('Nama peran pembuat untuk nama file, default Kenzo.'),
  approved: z.boolean().optional().describe('Isi true HANYA setelah Owner (Aditya) menyetujui biaya yang melewati ambang.'),
  brand: z.string().optional().describe('Nama atau slug brand (lihat list_brands). WAJIB bila ada lebih dari satu brand. Menentukan Style Guide yang dipakai dan label di galeri.'),
  style: z.string().optional().describe('Nama Style Guide content pillar DALAM brand tsb (lihat list_style_guides), ditambahkan di atas gaya dasar brand. Pillar juga membawa model generate + cadangannya sendiri. Kosong = hanya gaya dasar.'),
  return_images: z.boolean().optional().describe('Kirim gambar langsung di respons (default true).'),
};

export function buildMcpServer() {
  const server = new McpServer({ name: 'teman-seller-studio', version: '0.1.0' });

  server.registerTool(
    'list_image_models',
    { description: 'Daftar model gambar kenari.id beserta harga per gambar (Rupiah).', inputSchema: {} },
    wrap(async () => {
      const models = await kenari.listImageModels({ force: true });
      return { content: [text(models.map((m) => `${m.id} | ${m.name} | ${m.pricePerImageIdr === null ? 'harga ?' : 'Rp' + m.pricePerImageIdr} | input: ${m.input.join('+')}`).join('\n'))] };
    }),
  );

  server.registerTool(
    'estimate_cost',
    { description: 'Hitung estimasi biaya + sisa budget harian sebelum generate. Tidak mengeluarkan uang.', inputSchema: { model: common.model, n: common.n } },
    wrap(async ({ model, n }) => ({ content: [text(JSON.stringify(await service.estimate({ model, n }), null, 2))] })),
  );

  server.registerTool(
    'generate_image',
    {
      description:
        'Generate gambar dari teks lewat kenari.id. Hasil disimpan di galeri Teman Seller Studio. Mengeluarkan uang: jika biaya melewati ambang, butuh persetujuan Owner (approved=true).',
      inputSchema: {
        prompt: z.string().min(3).describe('Deskripsi gambar.'),
        background: z.enum(['transparent', 'opaque', 'auto']).optional(),
        use_style_guide: z.boolean().optional().describe('Tambahkan Style Guide Teman Seller ke prompt (default true).'),
        ...common,
      },
    },
    wrap(async (a) =>
      result(
        await service.generateImages({ ...a, useStyle: a.use_style_guide ?? true, source: 'mcp' }),
        a.return_images ?? true,
      ),
    ),
  );

  server.registerTool(
    'edit_image',
    {
      description: 'Edit gambar (image-to-image). Sumber: source_id dari galeri, atau image_base64. Mengeluarkan uang, aturan approval sama dengan generate_image.',
      inputSchema: {
        prompt: z.string().min(3).describe('Perubahan yang diinginkan.'),
        source_id: z.string().optional().describe('ID gambar di galeri.'),
        image_base64: z.string().optional().describe('Gambar sumber base64 (PNG/JPEG/WebP) jika bukan dari galeri.'),
        quality: z.enum(['low', 'medium', 'high', 'auto']).optional(),
        ...common,
      },
    },
    wrap(async (a) => {
      let source;
      if (a.source_id) {
        const e = await store.getImage(a.source_id);
        if (!e) throw new Error(`source_id ${a.source_id} tidak ada di galeri`);
        source = { buffer: await store.readImageFile(e.file), mime: e.mime };
      } else if (a.image_base64) {
        const buffer = Buffer.from(a.image_base64.replace(/^data:[^,]+,/, ''), 'base64');
        source = { buffer, mime: kenari.detectMime(buffer) };
      } else throw new Error('Isi source_id atau image_base64');
      return result(await service.editImages({ ...a, sources: [source], source: 'mcp' }), a.return_images ?? true);
    }),
  );

  server.registerTool(
    'list_gallery',
    {
      description: 'Lihat gambar yang sudah dibuat (terbaru dulu). Bisa dicari lewat kata kunci dan disaring per brand.',
      inputSchema: { query: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), brand: z.string().optional().describe('Saring per brand (nama atau slug). Kosong = semua brand.') },
    },
    wrap(async ({ query, limit, brand }) => {
      const items = await service.gallery({ query, limit: limit ?? 20, brand });
      return { content: [text(items.length ? items.map((e) => `${e.id} | ${e.file} | ${e.brandName || e.brand || '-'} | ${e.model} | Rp${e.costIdr} | dihapus ${e.expiresAt.slice(0, 10)} | ${(e.prompt || '').slice(0, 80)}`).join('\n') : 'Galeri kosong.')] };
    }),
  );

  server.registerTool(
    'get_image',
    { description: 'Ambil satu gambar dari galeri berdasarkan id.', inputSchema: { id: z.string() } },
    wrap(async ({ id }) => {
      const e = await store.getImage(id);
      if (!e) throw new Error('id tidak ditemukan');
      const buf = await store.readImageFile(e.file);
      return { content: [text(`${e.file}\nPrompt: ${e.prompt}\nDihapus permanen: ${e.expiresAt}`), { type: 'image', data: buf.toString('base64'), mimeType: e.mime }] };
    }),
  );

  server.registerTool(
    'get_image_public_url',
    {
      description:
        'Buat tautan HTTPS publik sementara (bertanda tangan) untuk satu gambar di galeri, agar bisa diteruskan ke Social Hub: panggil tool Threads_Hub upload_media dengan source_url = url ini, lalu pakai URL hasilnya di media_urls pada create_post/create_ig_post. Hanya mengunggah ke media library; JANGAN menayangkan/approve tanpa persetujuan Owner. Gambar bersifat sementara (dihapus permanen setelah masa simpan).',
      inputSchema: { id: z.string(), ttl_minutes: z.number().int().min(1).max(1440).optional().describe('Masa berlaku tautan, default 60 menit.') },
    },
    wrap(async ({ id, ttl_minutes }) => {
      const e = await store.getImage(id);
      if (!e) throw new Error('id tidak ditemukan atau gambar sudah dihapus (masa simpan habis)');
      const s = await signedUrl(e, { ttlMinutes: ttl_minutes ?? 60 });
      return { content: [text(`source_url: ${s.url}\nTautan berlaku sampai: ${s.expiresAt}\nBerikutnya: Threads_Hub.upload_media(source_url=<url di atas>, brand=<wardrobe|kids|scarf|daily bila perlu>, filename="${e.file}")`)] };
    }),
  );

  // Brand + Style Guide tersimpan di database. Claude bisa mengelolanya langsung lewat MCP (tanpa browser).
  const ACTOR = 'claude (MCP)';
  const brandArg = z.string().optional().describe('Nama atau slug brand (lihat list_brands). WAJIB bila ada lebih dari satu brand.');
  const modelCfg = (x) => (x.model || x.fallbackModels.length ? ` | model: ${x.model || '(default)'}${x.fallbackModels.length ? ` + cadangan ${x.fallbackModels.join(', ')}` : ''}` : '');
  const styleLine = (x) => `${x.base ? '[DASAR] ' : ''}${x.name}${x.pillar ? ` | pilar: ${x.pillar}` : ''}${modelCfg(x)} | diubah ${x.updatedAt.slice(0, 16).replace('T', ' ')} UTC oleh ${x.updatedBy} | ${x.text.slice(0, 100)}${x.text.length > 100 ? '…' : ''}`;
  const brandBlock = (b) => {
    const all = styles.list(b.id);
    const gone = styles.deletedNames(b.id);
    return `== Brand: ${b.name}${b.default ? ' [DEFAULT]' : ''} (slug: ${b.slug}) ==\n${all.length ? all.map(styleLine).join('\n') : '(belum ada Style Guide)'}${gone.length ? `\nDihapus (bisa dipulihkan dengan restore_style_guide): ${gone.join(', ')}` : ''}`;
  };

  server.registerTool(
    'list_brands',
    { description: 'Daftar brand yang dilayani studio ini (tiap brand punya gaya dasar + content pillar sendiri). Pakai nama/slug-nya di parameter `brand`.', inputSchema: {} },
    wrap(async () => {
      const gone = styles.deletedBrandNames();
      return { content: [text(styles.listBrands().map((b) => `${b.default ? '[DEFAULT] ' : ''}${b.name} | slug: ${b.slug} | ${b.styleCount} style${b.note ? ` | ${b.note}` : ''}`).join('\n') + (gone.length ? `\nDihapus (bisa dipulihkan dengan restore_brand): ${gone.join(', ')}` : ''))] };
    }),
  );

  server.registerTool(
    'set_brand',
    {
      description: 'Tambah brand baru atau ubah brand yang ada (upsert berdasarkan nama/slug). `new_name` untuk ganti nama, `make_default=true` menjadikannya brand default. Brand baru dimulai kosong: isi gaya dasar + pillar lewat set_style_guide.',
      inputSchema: { name: z.string().max(60), new_name: z.string().max(60).optional(), note: z.string().max(500).optional(), make_default: z.boolean().optional() },
    },
    wrap(async ({ name, new_name, note, make_default }) => {
      const existing = styles.findBrand(name);
      const patch = { ...(note !== undefined ? { note } : {}), ...(make_default !== undefined ? { default: make_default } : {}) };
      const saved = existing ? styles.updateBrand(existing.id, { ...patch, ...(new_name ? { name: new_name } : {}) }, ACTOR) : styles.createBrand({ name, ...patch }, ACTOR);
      return { content: [text(`Brand "${saved.name}" (slug: ${saved.slug}) ${existing ? 'diperbarui' : 'dibuat'}${saved.default ? ' (default)' : ''}.`)] };
    }),
  );

  server.registerTool(
    'delete_brand',
    {
      description: 'Hapus satu brand beserta semua Style Guide-nya (hapus lunak: bisa dipulihkan dengan restore_brand; gambar di galeri tidak ikut terhapus). Brand default tidak bisa dihapus. Aturan kantor: penghapusan butuh persetujuan Owner, isi approved=true HANYA setelah Owner (Aditya) menyetujui.',
      inputSchema: { name: z.string(), approved: z.boolean().optional() },
    },
    wrap(async ({ name, approved }) => {
      const b = styles.findBrand(name);
      if (!b) throw new Error(`Brand "${name}" tidak ditemukan`);
      if (!approved) throw new Error(`Menghapus brand "${b.name}" (${b.styleCount} style) butuh persetujuan Owner (Aditya). Minta persetujuan, lalu ulangi dengan approved=true.`);
      styles.removeBrand(b.id, ACTOR);
      return { content: [text(`Brand "${b.name}" dihapus (lunak). Pulihkan dengan restore_brand.`)] };
    }),
  );

  server.registerTool(
    'restore_brand',
    { description: 'Pulihkan brand yang dihapus beserta Style Guide-nya.', inputSchema: { name: z.string() } },
    wrap(async ({ name }) => ({ content: [text(`Brand "${styles.restoreBrand(name, ACTOR).name}" dipulihkan.`)] })),
  );

  server.registerTool(
    'list_style_guides',
    { description: 'Daftar Style Guide visual (gaya dasar + gaya per content pillar, termasuk model generate tiap pillar). Tanpa `brand` dan ada banyak brand = tampilkan semua brand. Pakai nama pillar di parameter `style` pada generate_image/edit_image.', inputSchema: { brand: z.string().optional() } },
    wrap(async ({ brand }) => {
      const brands = brand ? [styles.resolveBrand(brand)] : styles.listBrands();
      return { content: [text(brands.map(brandBlock).join('\n\n'))] };
    }),
  );

  server.registerTool(
    'get_style_guide',
    { description: 'Baca isi lengkap satu Style Guide. Tanpa `name` = gaya dasar brand.', inputSchema: { name: z.string().optional(), brand: brandArg } },
    wrap(async ({ name, brand }) => {
      const b = styles.pickBrand(brand);
      const all = styles.list(b.id);
      const s = name ? styles.find(name, all) : styles.getBase(all);
      return { content: [text(s ? `Brand ${b.name} | ${s.name}${s.pillar ? ` (pilar: ${s.pillar})` : ''}${s.base ? ' [DASAR]' : ''}${modelCfg(s)}\n${s.text || '(kosong)'}` : name ? `Style "${name}" tidak ditemukan di brand ${b.name}.` : `(gaya dasar brand ${b.name} belum diisi)`)] };
    }),
  );

  server.registerTool(
    'set_style_guide',
    {
      description: 'Tambah atau ubah satu Style Guide (content pillar) di sebuah brand berdasarkan nama (upsert). Tersimpan di database dengan riwayat revisi, jadi bisa dikembalikan. Tanpa `name` = ubah gaya dasar brand. `base=true` menjadikannya gaya dasar brand (yang selalu dipakai). `model` + `fallback_models` mengatur model generate khusus pillar ini (kosongkan dengan string kosong / daftar kosong untuk kembali ke default). Perubahan gaya dasar memengaruhi semua gambar brand: pastikan sudah disetujui Owner.',
      inputSchema: {
        text: z.string().max(4000).optional(), name: z.string().max(60).optional(), pillar: z.string().max(60).optional(), base: z.boolean().optional(), brand: brandArg,
        model: z.string().max(80).optional().describe('ID model khusus pillar ini (lihat list_image_models). String kosong = pakai default.'),
        fallback_models: z.array(z.string().max(80)).max(5).optional().describe('Model cadangan berurutan khusus pillar ini; kosong = pakai cadangan global.'),
      },
    },
    wrap(async ({ text: t, name, pillar, base, brand, model, fallback_models }) => {
      const b = styles.pickBrand(brand);
      const all = styles.list(b.id);
      const existing = name ? styles.find(name, all) : styles.getBase(all);
      if (t === undefined && !existing) throw new Error('`text` wajib diisi untuk Style Guide baru');
      await service.assertModels([model, ...(fallback_models || [])]);
      const patch = { ...(t !== undefined ? { text: t } : {}), ...(pillar !== undefined ? { pillar } : {}), ...(base !== undefined ? { base } : {}), ...(model !== undefined ? { model } : {}), ...(fallback_models !== undefined ? { fallbackModels: fallback_models } : {}) };
      const saved = existing ? styles.update(existing.id, patch, ACTOR) : styles.create({ brand: b.id, name: name || 'Gaya dasar', ...patch, base: base ?? !name }, ACTOR);
      return { content: [text(`Style guide "${saved.name}" (brand ${b.name}) ${existing ? 'diperbarui' : 'dibuat'}${saved.base ? ' (gaya dasar)' : ''}${modelCfg(saved)}. Riwayat tersimpan; lihat style_guide_history.`)] };
    }),
  );

  server.registerTool(
    'delete_style_guide',
    {
      description: 'Hapus satu Style Guide (hapus lunak: masih bisa dipulihkan dengan restore_style_guide). Aturan kantor: penghapusan butuh persetujuan Owner, jadi isi approved=true HANYA setelah Owner (Aditya) menyetujui.',
      inputSchema: { name: z.string(), brand: brandArg, approved: z.boolean().optional() },
    },
    wrap(async ({ name, brand, approved }) => {
      const b = styles.pickBrand(brand);
      const s = styles.find(name, styles.list(b.id));
      if (!s) throw new Error(`Style "${name}" tidak ditemukan di brand ${b.name}`);
      if (!approved) throw new Error(`Menghapus "${s.name}" (brand ${b.name}) butuh persetujuan Owner (Aditya). Minta persetujuan, lalu ulangi dengan approved=true.`);
      styles.remove(s.id, ACTOR);
      return { content: [text(`Style "${s.name}" dihapus (lunak). Pulihkan dengan restore_style_guide.`)] };
    }),
  );

  server.registerTool(
    'style_guide_history',
    { description: 'Riwayat perubahan satu Style Guide (siapa, kapan, isi, model). Pakai revision id untuk restore_style_guide.', inputSchema: { name: z.string(), brand: brandArg, limit: z.number().int().min(1).max(50).optional() } },
    wrap(async ({ name, brand, limit }) => ({
      content: [text(styles.history(name, limit ?? 10, brand).map((r) => `rev ${r.id} | ${r.at.slice(0, 16).replace('T', ' ')} UTC | ${r.action} oleh ${r.actor} | ${r.name}${r.model ? ` | model: ${r.model}` : ''} | ${r.text.slice(0, 120)}${r.text.length > 120 ? '…' : ''}`).join('\n'))],
    })),
  );

  server.registerTool(
    'restore_style_guide',
    { description: 'Pulihkan Style Guide yang dihapus (isi name + brand), atau kembalikan isi ke revisi tertentu (isi revision_id dari style_guide_history).', inputSchema: { name: z.string().optional(), brand: brandArg, revision_id: z.number().int().optional() } },
    wrap(async ({ name, brand, revision_id }) => {
      if (name === undefined && revision_id === undefined) throw new Error('Isi name atau revision_id');
      const s = styles.restore({ ref: name, revisionId: revision_id, brand }, ACTOR);
      return { content: [text(`Style "${s.name}" dipulihkan.`)] };
    }),
  );

  return server;
}
