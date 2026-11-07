# Delova Studio

Aplikasi web + MCP server untuk generate dan edit gambar kebutuhan **Kantor AI Delova** lewat API [kenari.id](https://kenari.id) (kompatibel OpenAI Images). Dipakai Kenzo (Illustrator) dan tim lewat Claude (MCP) atau langsung di browser.

## Fitur
- **Multi-brand**: satu studio melayani banyak brand. Tiap brand punya **gaya dasar** dan banyak **content pillar** dengan style berbeda, dan tiap pillar bisa punya **model generate + model cadangan sendiri**. Galeri bisa disaring per brand.
- **Web UI** bergaya admin dashboard (Tailwind CSS, palet ala TailAdmin, mode gelap, responsif): Dashboard, Generate, Edit gambar, Galeri (grid gambar + nama file + salin URL, detail di lightbox), Batas Biaya, Style Guide, Koneksi MCP.
- **Login web**: halaman `/login` dengan `ADMIN_USER` dan `ADMIN_PASSWORD` dari `.env` (ganti password = semua sesi lama otomatis keluar). Cookie HttpOnly, SameSite=Lax, 5 kali gagal = terkunci 15 menit per IP. Claude (MCP) memakai `ACCESS_TOKEN` terpisah (bearer), cookie login tidak berlaku di `/mcp`.
- **Batas biaya di dashboard** (menu Batas Biaya): harian, mingguan (mulai Senin), bulanan, ambang persetujuan Owner, dan maksimal gambar per permintaan. Nilai awal dari `.env`, perubahan disimpan di `data/settings.json`. Claude tidak punya tool untuk mengubah batas ini. Buku biaya (`data/ledger.jsonl`) tetap ada walau gambar sudah dihapus retensi.
- **MCP server** (Streamable HTTP di `/mcp` dan mode stdio): `generate_image`, `edit_image`, `list_image_models`, `estimate_cost`, `list_gallery`, `get_image`, `get_image_public_url`, brand (`list_brands`, `set_brand`, `delete_brand`, `restore_brand`) dan Style Guide per brand (`list_style_guides`, `get_style_guide`, `set_style_guide`, `style_guide_history`, `restore_style_guide`, `delete_style_guide`).
- Nama file otomatis sesuai aturan kantor: `YYYY-MM-DD_Kenzo_Judul-Singkat_v1_01.png`.
- **Penjaga biaya** (aturan kantor bagian 6, pengeluaran uang butuh persetujuan Owner):
  - Batas harian/mingguan/bulanan (WIB) adalah batas keras, tidak bisa dilewati walau `approved=true`. Atur di web (Batas Biaya) atau nilai awalnya lewat `DAILY_BUDGET_IDR`, `WEEKLY_BUDGET_IDR`, `MONTHLY_BUDGET_IDR`.
  - `APPROVAL_THRESHOLD_IDR`: biaya per permintaan di atas ambang ini butuh `approved=true` (diisi hanya setelah Owner setuju).
  - Gagal dari kenari (termasuk error berstatus 200) tidak dicatat sebagai biaya.
- **Gambar bersifat sementara**: dihapus permanen otomatis setelah `RETENTION_DAYS` (default 7 hari). Penyapu berjalan saat server start dan tiap jam; gambar kedaluwarsa langsung disembunyikan dari galeri dan MCP. Hanya jejak audit (id, nama file, waktu) yang tersisa di `data/deleted.log`. Kebijakan ini ditetapkan Owner; unduh gambar yang masih dipakai sebelum waktunya.
- **Teruskan ke Social Hub (threads.delova.id)**: tool `get_image_public_url` membuat tautan HTTPS bertanda tangan dan berbatas waktu (maks 24 jam, tidak pernah melewati masa simpan gambar). Claude lalu memanggil `upload_media(source_url=...)` milik Threads_Hub, dan memakai URL hasilnya di `create_post`/`create_ig_post`. Ini hanya mengunggah ke media library hub: tayang/approve tetap butuh persetujuan Owner.
- Style Guide brand (gaya dasar + pillar terpilih) otomatis ditambahkan ke prompt, disimpan di `data/studio.db`.

## Multi-brand, content pillar, dan model per pillar
```
Brand (mis. Delova Kids)
 ├─ Gaya dasar      → selalu dipakai untuk brand ini (+ model default brand, opsional)
 ├─ Pillar "Hari Raya"   → gaya sendiri + model & cadangan sendiri
 └─ Pillar "Studio Foto" → gaya sendiri + model & cadangan sendiri
```
- **Brand**: kelola di Dashboard > Style Guide (+ Brand baru / Ubah brand) atau lewat Claude (`set_brand`). Brand default dibuat otomatis (`DEFAULT_BRAND_NAME`, awalnya "Teman Seller"); data lama dari versi sebelum multi-brand otomatis menjadi milik brand ini. Brand default tidak bisa dihapus. Hapus brand = hapus lunak, bisa dipulihkan (`restore_brand`).
- **Pillar**: nama boleh sama di brand berbeda. Satu gaya dasar per brand.
- **Urutan model** saat generate/edit: model yang dipilih manual > model pillar terpilih > model gaya dasar brand > default global (Dashboard > Konfigurasi). Di web, pilihan "Otomatis" pada Model mengikuti aturan ini. Model cadangan pillar menimpa cadangan global; semua cadangan tetap lewat penjaga biaya yang sama.
- **Aman dari salah brand**: bila ada lebih dari satu brand, Generate/Edit lewat API/MCP dan semua perubahan Style Guide wajib menyebut `brand`; kalau tidak, ditolak sebelum memanggil kenari.
- Galeri mencatat brand + pillar tiap gambar dan bisa disaring per brand (`GET /api/gallery?brand=`, `list_gallery(brand=)`). Gambar lama masuk brand default.
- API: `GET/POST /api/brands`, `PUT/DELETE /api/brands/:id`, `GET /api/styles?brand=`, `POST /api/styles` (`brand`, `model`, `fallbackModels`), `POST /api/generate` & `/api/edit` (`brand`, `style`).

## Mulai cepat
Butuh Node.js 22.13+ (database memakai node:sqlite bawaan).

```bash
npm install
cp .env.example .env     # isi KENARI_API_KEY (dari dashboard kenari.id); atau isi nanti di web: menu Konfigurasi
npm start                # http://127.0.0.1:3400
npm test
```

Windows PowerShell: `copy .env.example .env`.

Mengubah tampilan: edit `public/*.html|js`, lalu `npm run build:css` (Tailwind CLI; `public/tailwind.css` hasil build ikut di-commit, jadi `npm start` tidak butuh build).

`.env` dan folder `data/` tidak pernah masuk git. Jangan simpan API key di Drive atau repo.

## Hubungkan ke Claude (MCP)
**Cara termudah, konektor Claude (claude.ai / aplikasi desktop):** Settings, Connectors, *Add custom connector*, tempel URL `https://<domain>/mcp/<MCP_PATH_SECRET>` (juga tampil di dashboard, menu Koneksi MCP). Isi `MCP_PATH_SECRET` di `.env` dengan `openssl rand -hex 24`; skrip `deploy-vps.sh` membuatnya otomatis. URL ini hanya membuka MCP (bukan web/API) dan bersifat rahasia karena ikut tercatat di log Caddy; ganti nilainya untuk mencabut akses.

**Claude Code (HTTP)**, server harus sedang berjalan:
```bash
claude mcp add --transport http delova-studio http://127.0.0.1:3400/mcp \
  --header "Authorization: Bearer <ACCESS_TOKEN>"
```
(Header hanya perlu jika `ACCESS_TOKEN` diisi.)

**Claude Desktop (stdio)**, tambahkan di `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "delova-studio": {
      "command": "node",
      "args": ["C:\\Users\\Aditya Nur Riskan N\\Documents\\Delova Wardrobe\\delova-studio\\src\\stdio.js"]
    }
  }
}
```
Mode stdio membaca `.env` di folder proyek, jadi key tidak ditaruh di config Claude.

**Claude.ai (custom connector)** butuh URL publik HTTPS (mis. di VPS di belakang reverse proxy). Catatan: connector remote Claude.ai memakai OAuth, sedangkan app ini memakai bearer token statis. Untuk Claude.ai perlu lapisan OAuth tambahan (belum ada, lihat Rencana).

## Model dan harga (per 4 Nov 2026)
`gpt-image-2` Rp125 (default), `nano-banana` Rp150, `qwen-image-3.0-pro` Rp150, model `agnes-image-*:free` gratis, dan lainnya. Harga selalu diambil langsung dari `GET /v1/models`, jadi tab Generate menampilkan angka terbaru.

## Alur Claude: Studio -> Social Hub
1. `generate_image` (atau `list_gallery`) untuk mendapat `id` gambar. Claude juga bisa melihat gambarnya lewat `get_image`.
2. `get_image_public_url(id)` mengembalikan `source_url`.
3. Threads_Hub `upload_media(source_url, brand?)` mengembalikan URL media hub.
4. Threads_Hub `create_post`/`create_ig_post` memakai URL itu sebagai draft untuk persetujuan Owner.

Syarat: server Hub harus bisa mengakses Studio lewat HTTPS publik, jadi `PUBLIC_URL` wajib diisi dan Studio harus ter-deploy (lihat bagian berikut). Di `localhost` langkah 2 menolak dengan pesan jelas.

## Deploy (butuh persetujuan Owner)
Panduan lengkap: `docs/DEPLOY.md` (Docker Compose, `scripts/check-ports.sh`, contoh Nginx/Caddy untuk `studio.delova.id`).

Di VPS: set `HOST=0.0.0.0`, `ACCESS_TOKEN` yang kuat, `PUBLIC_URL`, jalankan di belakang HTTPS reverse proxy. Server menolak start jika `HOST` bukan localhost dan `ACCESS_TOKEN` kosong.

## Struktur
```
src/config.js   konfigurasi .env
src/kenari.js   klien API kenari.id (generations, edits, models)
src/service.js  estimasi biaya + penjaga budget/approval
src/store.js    simpan gambar + index (+ brand tiap gambar)
src/styles.js   database SQLite: brand, gaya dasar + pillar, model per pillar, riwayat
src/mcp.js      definisi tool MCP
src/server.js   web + REST + /mcp
src/stdio.js    MCP via stdio
public/         web UI
test/           tes otomatis dengan mock kenari
docs/SPEC.md    spesifikasi
```

## Rencana
1. OAuth untuk connector Claude.ai.
2. Template prompt per format (feed 4:5, story, carousel, thumbnail) dari Library Prompt Kenzo.
3. Mask editor di tab Edit.

## Cadangan kie.ai

Jika kenari tidak jalan (gangguan, key bermasalah, semua model cadangan gagal), server otomatis membuat gambar lewat **kie.ai**.

- Isi API key kie.ai di **Konfigurasi** (atau `KIE_API_KEY`), pilih model default teks→gambar dan edit, lalu aktifkan cadangan.
- Harga dalam **kredit** (1 kredit ≈ US$0,005 ≈ Rp80; nilai rupiah bisa diubah). Katalog bawaan hanya model terverifikasi; model lain ditambah dengan ID + harga kredit.
- Kontrol kredit di **Batas Biaya**: batas harian/mingguan/bulanan (kredit), ambang persetujuan Owner, saldo minimum. Rupiah setara kredit ikut budget rupiah gabungan.
- Cadangan otomatis tidak jalan bila butuh persetujuan; Owner menyetujui dengan `provider="kie"` + `approved=true`.
- MCP untuk Claude: `kie_status`, `list_kie_models`, parameter `provider` (`auto`|`kie`|`kenari`) di `generate_image`/`edit_image`/`estimate_cost`.
- Edit gambar via kie: sumber diunggah dulu ke penyimpanan sementara kie (24 jam); mask tidak didukung.

### Memilih model kie.ai

kie.ai tidak punya API daftar model, jadi daftar diambil dari dokumentasi resminya: klik **Ambil daftar model dari kie.ai** di Konfigurasi (atau tool MCP `sync_kie_models`). Hasilnya (±60 model: Nano Banana, Seedream, Flux, GPT Image, Qwen, dll.) tersimpan di `data/kie-models.json`, lengkap dengan nama kolom input tiap model. Pilih model default teks→gambar dan edit dari daftar itu. Dokumentasi tidak memuat harga, jadi isi harga kredit model yang dipilih (klik modelnya di daftar); model tanpa harga selalu butuh persetujuan Owner.
