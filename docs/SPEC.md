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
6. Penerusan ke Social Hub hanya lewat tautan bertanda tangan (HMAC) berbatas waktu; menayangkan konten tetap butuh persetujuan Owner.

## Di luar cakupan v0.1
OAuth connector Claude.ai, mask editor, antrean/penjadwalan, upload otomatis ke Drive.

## Pengujian
`npm test`: 11 tes dengan server kenari tiruan (auth, harga, penamaan, ambang, budget, error 200, edits multipart, MCP end-to-end, path traversal, tautan bertanda tangan, retensi dan sweep). Belum diuji ke API kenari asli karena API key belum tersedia di sesi ini.
