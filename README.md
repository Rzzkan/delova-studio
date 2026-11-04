# Teman Seller Studio

Aplikasi web + MCP server untuk generate dan edit gambar kebutuhan **Kantor AI Teman Seller** lewat API [kenari.id](https://kenari.id) (kompatibel OpenAI Images). Dipakai Kenzo (Illustrator) dan tim lewat Claude (MCP) atau langsung di browser.

## Fitur
- **Web UI**: Generate, Edit gambar, Galeri, Style Guide.
- **MCP server** (Streamable HTTP di `/mcp` dan mode stdio): `generate_image`, `edit_image`, `list_image_models`, `estimate_cost`, `list_gallery`, `get_image`, `get_style_guide`, `set_style_guide`.
- Nama file otomatis sesuai aturan kantor: `YYYY-MM-DD_Kenzo_Judul-Singkat_v1_01.png`.
- **Penjaga biaya** (aturan kantor bagian 6, pengeluaran uang butuh persetujuan Owner):
  - `DAILY_BUDGET_IDR`: batas keras harian (WIB), tidak bisa dilewati walau `approved=true`.
  - `APPROVAL_THRESHOLD_IDR`: biaya per permintaan di atas ambang ini butuh `approved=true` (diisi hanya setelah Owner setuju).
  - Gagal dari kenari (termasuk error berstatus 200) tidak dicatat sebagai biaya.
- Style Guide visual (`data/style.txt`) otomatis ditambahkan ke prompt.

## Mulai cepat
Butuh Node.js 20.12+.

```bash
npm install
cp .env.example .env     # isi KENARI_API_KEY (dari dashboard kenari.id)
npm start                # http://127.0.0.1:3400
npm test
```

Windows PowerShell: `copy .env.example .env`.

`.env` dan folder `data/` tidak pernah masuk git. Jangan simpan API key di Drive atau repo.

## Hubungkan ke Claude (MCP)
**Claude Code (HTTP)**, server harus sedang berjalan:
```bash
claude mcp add --transport http teman-seller-studio http://127.0.0.1:3400/mcp \
  --header "Authorization: Bearer <ACCESS_TOKEN>"
```
(Header hanya perlu jika `ACCESS_TOKEN` diisi.)

**Claude Desktop (stdio)**, tambahkan di `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "teman-seller-studio": {
      "command": "node",
      "args": ["C:\\Users\\Aditya Nur Riskan N\\Documents\\Teman Seller\\teman-seller-studio\\src\\stdio.js"]
    }
  }
}
```
Mode stdio membaca `.env` di folder proyek, jadi key tidak ditaruh di config Claude.

**Claude.ai (custom connector)** butuh URL publik HTTPS (mis. di VPS di belakang reverse proxy). Catatan: connector remote Claude.ai memakai OAuth, sedangkan app ini memakai bearer token statis. Untuk Claude.ai perlu lapisan OAuth tambahan (belum ada, lihat Rencana).

## Model dan harga (per 4 Nov 2026)
`gpt-image-2` Rp125 (default), `nano-banana` Rp150, `qwen-image-3.0-pro` Rp150, model `agnes-image-*:free` gratis, dan lainnya. Harga selalu diambil langsung dari `GET /v1/models`, jadi tab Generate menampilkan angka terbaru.

## Deploy (butuh persetujuan Owner)
Di VPS: set `HOST=0.0.0.0`, `ACCESS_TOKEN` yang kuat, `PUBLIC_URL`, jalankan di belakang HTTPS reverse proxy. Server menolak start jika `HOST` bukan localhost dan `ACCESS_TOKEN` kosong.

## Struktur
```
src/config.js   konfigurasi .env
src/kenari.js   klien API kenari.id (generations, edits, models)
src/service.js  estimasi biaya + penjaga budget/approval
src/store.js    simpan gambar + index + style guide
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
