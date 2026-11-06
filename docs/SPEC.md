# SPEC: Teman Seller Studio v0.1

Penulis: Dito (Software Dev) · Koordinator: Raka · Pengguna utama: Kenzo (Illustrator), Bita, Alya · Tanggal: 2026-11-04

## Tujuan
Satu tempat untuk generate/edit gambar kebutuhan konten Teman Seller, bisa dipakai manual (web) dan oleh Claude (MCP), dengan kontrol biaya sesuai aturan kantor.

## Pembagian tim
| Karyawan | Tugas |
|---|---|
| Raka | Koordinasi, QC, laporan ke Owner |
| Dito | Arsitektur, kode, tes, repo |
| Kenzo | Penerima akhir; mengisi Style Guide dan Library Prompt setelah app jalan |
| Nara | Riset model gambar kenari.id (harga/kualitas) bila Owner minta benchmark |

## API kenari.id yang dipakai
- `POST /v1/images/generations` (JSON), `POST /v1/images/edits` (multipart), `GET /v1/models` (publik).
- Auth `Authorization: Bearer kn-...`. Timeout klien 5 menit. Respons bisa diawali spasi dan error bisa berstatus 200 (dicek di body).
- Gambar diminta `b64_json`; `url` berupa data URI juga didukung.

## Aturan bisnis
1. Tidak ada pengeluaran tanpa persetujuan: ambang per permintaan + batas harian keras.
2. Nama file `YYYY-MM-DD_Role_Judul-Singkat_vN_NN.ext`, versi naik otomatis untuk judul yang sama di hari yang sama.
3. Secret hanya di `.env` (di-gitignore). Tidak ada secret di repo/Drive.
4. Tidak deploy ke production tanpa Owner.
5. Retensi: gambar disimpan maksimal `RETENTION_DAYS` (7 hari) lalu dihapus permanen otomatis (kebijakan Owner, 2026-11-04). Tidak ada fitur pemulihan.
6. Login web memakai `ADMIN_USER`/`ADMIN_PASSWORD` (env); `/mcp` hanya menerima bearer `ACCESS_TOKEN`. Batas biaya bisa diubah Owner di dashboard, tidak lewat MCP.
7. Penerusan ke Social Hub hanya lewat tautan bertanda tangan (HMAC) berbatas waktu; menayangkan konten tetap butuh persetujuan Owner.

## Konfigurasi dari dashboard (menu Konfigurasi)
- API key kenari: disimpan di `data/secrets.json` (izin 0600, ikut volume), menang atas `KENARI_API_KEY` di `.env`, berlaku tanpa restart. Tidak pernah dikirim balik (hanya `kn-••••1234`). Hanya admin yang login di web yang boleh mengubah; bearer `ACCESS_TOKEN` (Claude) dan MCP tidak bisa.
- Key dicek gratis lewat `GET /v1/account/balance` sebelum disimpan. Key ditolak (401) tidak disimpan; key terbatas/bersama (403) tetap disimpan karena sah untuk generate.
- Model default: disimpan di `data/settings.json`, divalidasi terhadap daftar model gambar kenari, dipakai web dan Claude saat `model` tidak diisi.
- Model cadangan (maks 5, berurutan): dipakai otomatis jika model utama gagal. Tiap cadangan tetap lewat penjaga biaya; cadangan yang lebih mahal dari biaya yang disetujui dilewati. Key salah/dilarang (401/403) tidak memicu cadangan. Hasil melaporkan `modelUsed` dan `fallbackFrom`; Claude diberi peringatan di respons MCP.
- Log pemanggilan: `data/attempts.jsonl` (waktu, model, hasil, durasi, cadangan dari, pesan galat; tanpa prompt dan tanpa key), dipangkas otomatis, tampil di Konfigurasi dan `GET /api/logs`.

## Multi-brand, Style Guide, dan model per pillar
- **Brand**: satu studio melayani banyak brand (tabel `brands`: id, slug, nama, catatan, `is_default`, hapus lunak). Tepat satu brand default; tidak bisa dihapus atau dimatikan selain dengan menjadikan brand lain default. Brand default dibuat otomatis di database baru (`DEFAULT_BRAND_NAME`). Database lama dinaikkan otomatis: style lama menjadi milik brand default, indeks nama unik global diganti unik per brand.
- Tiap brand punya satu **gaya dasar** (selalu ditambahkan jika Style Guide aktif) + banyak gaya per content pillar/kebutuhan, dipilih saat generate (web: dropdown; MCP: parameter `style`). Nama pillar unik per brand (boleh sama di brand lain), maksimal 30 style per brand dan 20 brand. Disimpan di SQLite `data/studio.db` (`node:sqlite` bawaan Node >= 22.13) dengan riwayat revisi (siapa, kapan, isi, model).
- **Model per pillar**: tiap style punya `model` + `fallbackModels` (maks 5) opsional, divalidasi terhadap daftar model kenari saat disimpan. Urutan saat generate/edit: model eksplisit di permintaan > model pillar terpilih > model gaya dasar brand > default global. `useStyle=false` mematikan model pillar juga. Cadangan pillar (jika ada) menimpa cadangan global; tiap cadangan tetap lewat penjaga biaya (aturan 1). Hasil melaporkan `modelUsed` dan `fallbackFrom`.
- **Brand wajib disebut** bila ada lebih dari satu brand (generate, edit, dan semua perubahan Style Guide lewat API/MCP); jika tidak, ditolak sebelum memanggil kenari. Brand atau style yang tidak dikenal juga ditolak tanpa biaya. Style hanya dicari di dalam brand yang disebut.
- Prompt memakai nama brand: `Style guide <Brand> (dasar): ...` dan `Style guide pilar "<Pillar>" (<Brand>): ...`.
- Galeri: tiap gambar mencatat `brand` (slug) dan `brandName`; gambar lama tanpa brand dianggap milik brand default. Filter per brand di web, `GET /api/gallery?brand=` dan `list_gallery(brand)`. Nama file tidak berubah (aturan 2).
- Draf 7 pilar bawaan hanya tersedia untuk brand Teman Seller (tombol "Buat dari 7 Content Pillar"); brand lain membuat pillar sendiri.
- Claude mengelola semuanya lewat MCP tanpa browser: `list_brands`, `set_brand`, `delete_brand` (butuh `approved=true` setelah Owner setuju), `restore_brand`, `list_style_guides`, `get_style_guide`, `set_style_guide` (termasuk `model` dan `fallback_models`), `style_guide_history`, `restore_style_guide`, `delete_style_guide` (hapus lunak; butuh `approved=true`). Perubahan Claude tercatat sebagai "claude (MCP)".
- Model gratis (Rp0) tidak terhalang batas budget. Batas biaya tetap global (belum per brand).

## Di luar cakupan v0.1
OAuth connector Claude.ai, mask editor, antrean/penjadwalan, upload otomatis ke Drive.

## Pengujian
`npm test`: 29 tes dengan server kenari tiruan (auth, harga, penamaan, ambang, budget, error 200, edits multipart, MCP end-to-end, path traversal, tautan bertanda tangan, retensi dan sweep, login/cookie/CSRF/penguncian, batas harian-mingguan-bulanan, ledger, multi-brand, model per pillar, migrasi database lama). Belum diuji ke API kenari asli karena API key belum tersedia di sesi ini.
