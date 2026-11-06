# Deploy ke VPS (studio.delova.id)

Perlu persetujuan Owner. Dilakukan oleh Owner di VPS.

## 0. DNS
Buat record **A** `studio` untuk `delova.id` ke IP VPS (sama dengan `threads.delova.id`). Jika ada wildcard `*.delova.id`, langkah ini tidak perlu.

## 1. Cek port kosong
```bash
git clone https://github.com/Rzzkan/delova-studio.git && cd delova-studio
bash scripts/check-ports.sh 3400 3499
```
Pilih salah satu port dari bagian "Port kosong". Skrip hanya membaca, tidak mengubah apa pun.

## 2. Isi .env
```bash
cp .env.example .env
nano .env     # KENARI_API_KEY=..., ACCESS_TOKEN=<acak panjang: openssl rand -hex 32>
```
`ACCESS_TOKEN` (untuk Claude/MCP) dan `ADMIN_PASSWORD` (login web, minimal 8 karakter) wajib: server menolak start di luar localhost tanpa keduanya. `scripts/deploy-vps.sh` membuatnya otomatis dan mencetak sekali. Jangan taruh key di Drive atau repo.

## 3. Jalankan
```bash
HOST_PORT=3410 docker compose up -d --build     # ganti 3410 dengan port pilihan Anda
curl -s http://127.0.0.1:3410/healthz            # {"ok":true}
```
Data gambar ada di `./data` (otomatis dihapus permanen setelah 7 hari).

## 4. Reverse proxy + SSL
Nginx: salin `deploy/nginx.studio.delova.id.conf` ke `/etc/nginx/sites-available/`, ganti port, aktifkan, lalu `sudo certbot --nginx -d studio.delova.id`. Caddy: pakai `deploy/Caddyfile.snippet`. Timeout 360 detik penting karena generate gambar bisa lama.

## 5. Sambungkan Claude
Paling mudah: Settings > Connectors > Add custom connector, tempel `https://studio.delova.id/mcp/<MCP_PATH_SECRET>` (dicetak skrip deploy, juga ada di dashboard > Koneksi MCP). Alternatif lewat terminal:
```bash
claude mcp add --transport http delova-studio https://studio.delova.id/mcp \
  --header "Authorization: Bearer <ACCESS_TOKEN>"
```
Tautan `/p/<id>.png?exp=..&sig=..` sengaja publik (bertanda tangan, berbatas waktu) agar Social Hub bisa mengambil gambar. Semua yang lain butuh token.

## Update
`git pull && HOST_PORT=3410 docker compose up -d --build`
