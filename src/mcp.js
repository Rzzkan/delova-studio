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
  const content = [text(`${fb}Selesai: ${res.images.length} gambar dengan ${res.modelUsed}, biaya Rp${res.costIdr}.\n${lines.join('\n')}\nSemua gambar tersimpan di galeri: ${baseUrl()}`)];
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
  model: z.string().optional().describe(`ID model gambar. Default ${settings.getSync().defaultModel} (diatur Owner di Dashboard > Konfigurasi). Lihat list_image_models.`),
  n: z.number().int().min(1).max(10).optional().describe('Jumlah gambar. Dibatasi pengaturan Dashboard (default 5). Aturan kantor: minta 5 untuk opsi konsep.'),
  size: z.string().optional().describe('Petunjuk ukuran, mis. 1024x1024, 1024x1280 (feed 4:5), 1024x1792 (story). Bukan jaminan.'),
  title: z.string().optional().describe('Judul singkat untuk nama file (YYYY-MM-DD_Role_Judul-Singkat_v1).'),
  role: z.string().optional().describe('Nama peran pembuat untuk nama file, default Kenzo.'),
  approved: z.boolean().optional().describe('Isi true HANYA setelah Owner (Aditya) menyetujui biaya yang melewati ambang.'),
  style: z.string().optional().describe('Nama Style Guide per content pillar (lihat list_style_guides), ditambahkan di atas gaya dasar. Kosong = hanya gaya dasar.'),
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
      description: 'Lihat gambar yang sudah dibuat (terbaru dulu). Bisa dicari lewat kata kunci.',
      inputSchema: { query: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
    },
    wrap(async ({ query, limit }) => {
      const items = await store.listImages({ query, limit: limit ?? 20 });
      return { content: [text(items.length ? items.map((e) => `${e.id} | ${e.file} | ${e.model} | Rp${e.costIdr} | dihapus ${e.expiresAt.slice(0, 10)} | ${(e.prompt || '').slice(0, 80)}`).join('\n') : 'Galeri kosong.')] };
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

  server.registerTool(
    'list_style_guides',
    { description: 'Daftar Style Guide visual (gaya dasar + gaya per content pillar). Pakai namanya di parameter `style` pada generate_image/edit_image.', inputSchema: {} },
    wrap(async () => {
      const all = styles.list();
      return { content: [text(all.length ? all.map((x) => `${x.base ? '[DASAR] ' : ''}${x.name}${x.pillar ? ` | pilar: ${x.pillar}` : ''} | ${x.text.slice(0, 100)}${x.text.length > 100 ? '…' : ''}`).join('\n') : 'Belum ada Style Guide. Owner dapat membuatnya di Dashboard > Style Guide.')] };
    }),
  );

  server.registerTool(
    'get_style_guide',
    { description: 'Baca isi lengkap satu Style Guide. Tanpa `name` = gaya dasar.', inputSchema: { name: z.string().optional() } },
    wrap(async ({ name }) => {
      const all = styles.list();
      const s = name ? styles.find(name, all) : styles.getBase(all);
      return { content: [text(s ? `${s.name}${s.pillar ? ` (pilar: ${s.pillar})` : ''}\n${s.text || '(kosong)'}` : name ? `Style "${name}" tidak ditemukan.` : '(gaya dasar belum diisi)')] };
    }),
  );

  server.registerTool(
    'set_style_guide',
    {
      description: 'Tambah atau ubah satu Style Guide berdasarkan nama (biasanya oleh Kenzo, disetujui Owner). Tidak bisa menghapus (hanya Owner di dashboard). Tanpa `name` = ubah gaya dasar.',
      inputSchema: { text: z.string().max(4000), name: z.string().max(60).optional(), pillar: z.string().max(60).optional() },
    },
    wrap(async ({ text: t, name, pillar }) => {
      const all = styles.list();
      const existing = name ? styles.find(name, all) : styles.getBase(all);
      if (existing) styles.update(existing.id, { text: t, ...(pillar !== undefined ? { pillar } : {}) });
      else styles.create({ name: name || 'Gaya dasar', text: t, pillar, base: !name });
      return { content: [text(`Style guide "${existing?.name || name || 'Gaya dasar'}" disimpan.`)] };
    }),
  );

  return server;
}
