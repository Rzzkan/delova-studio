# Deploy ke VPS (studio.temanseller.com)

Perlu persetujuan Owner (sudah diberikan 2026-11-04 untuk subdomain ini). Dilakukan oleh Owner di VPS.

## 0. DNS
Buat record **A** `studio` -> `72.62.120.105` (IP yang sama dengan temanseller.com). Per 4 Nov 2026 pukul 23:45 WIB, `studio.temanseller.com` belum resolve dari sandbox Raka. Jika ada wildcard `*.temanseller.com`, langkah ini tidak perlu.

## 1. Cek port kosong
```bash
git clone https://github.com/Rzzkan/teman-seller-studio.git && cd teman-seller-studio
bash scripts/check-ports.sh 3400 3499
```
Pilih salah satu port dari bagian "Port kosong". Port 3300 sudah dipakai TemanSeller server. Skrip hanya membaca, tidak mengubah apa pun.

## 2. Isi .env
```bash
cp .env.example .env
nano .env     # KENARI_API_KEY=..., ACCESS_TOKEN=<acak panjang: openssl rand -hex 32>
```
`ACCESS_TOKEN` wajib: server menolak start di luar localhost tanpa token. Token sama dipakai untuk web UI dan Claude. Jangan taruh key di Drive atau repo.

## 3. Jalankan
```bash
HOST_PORT=3410 docker compose up -d --build     # ganti 3410 dengan port pilihan Anda
curl -s http://127.0.0.1:3410/healthz            # {"ok":true}
```
Data gambar ada di `./data` (otomatis dihapus permanen setelah 7 hari).

## 4. Reverse proxy + SSL
Nginx: salin `deploy/nginx.studio.temanseller.com.conf` ke `/etc/nginx/sites-available/`, ganti port, aktifkan, lalu `sudo certbot --nginx -d studio.temanseller.com`. Caddy: pakai `deploy/Caddyfile.snippet`. Timeout 360 detik penting karena generate gambar bisa lama.

## 5. Sambungkan Claude
```bash
claude mcp add --transport http teman-seller-studio https://studio.temanseller.com/mcp \
  --header "Authorization: Bearer <ACCESS_TOKEN>"
```
Tautan `/p/<id>.png?exp=..&sig=..` sengaja publik (bertanda tangan, berbatas waktu) agar Social Hub bisa mengambil gambar. Semua yang lain butuh token.

## Update
`git pull && HOST_PORT=3410 docker compose up -d --build`
