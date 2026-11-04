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

## Style Guide jamak
- Satu **gaya dasar** (selalu ditambahkan jika Style Guide aktif) + banyak gaya per content pillar/kebutuhan, dipilih saat generate (web: dropdown; MCP: parameter `style`). Disimpan di `data/styles.json`; `data/style.txt` lama dimigrasi otomatis jadi gaya dasar.
- Tombol "Buat dari 7 Content Pillar" menambah draf arah visual untuk 7 pilar (tidak menimpa yang ada). Draf perlu disetujui Owner.
- MCP: `list_style_guides`, `get_style_guide(name?)`, `set_style_guide(name?, text, pillar?)` (tambah/ubah saja). Hapus hanya lewat dashboard.
- Model gratis (Rp0) tidak terhalang batas budget.

## Di luar cakupan v0.1
OAuth connector Claude.ai, mask editor, antrean/penjadwalan, upload otomatis ke Drive.

## Pengujian
`npm test`: 17 tes dengan server kenari tiruan (auth, harga, penamaan, ambang, budget, error 200, edits multipart, MCP end-to-end, path traversal, tautan bertanda tangan, retensi dan sweep, login/cookie/CSRF/penguncian, batas harian-mingguan-bulanan, ledger). Belum diuji ke API kenari asli karena API key belum tersedia di sesi ini.
