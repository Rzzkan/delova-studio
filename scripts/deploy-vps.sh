#!/usr/bin/env bash
# Deploy Studio ke VPS dan sambungkan ke Caddy (Docker). Aman dijalankan ulang.
# Contoh instance Delova di VPS yang sudah punya teman-seller-studio:
#   APP=delova-studio DOMAIN=studio.delova.id HOST_PORT=3410 bash scripts/deploy-vps.sh
# Yang disentuh: folder ini (.env, docker-compose.override.yml), container teman-seller-studio,
# dan Caddyfile milik Caddy (dibackup dulu, divalidasi, otomatis dikembalikan jika gagal).
set -euo pipefail
DOMAIN="${DOMAIN:-studio.temanseller.com}"
HOST_PORT="${HOST_PORT:-3400}"
CADDY="${CADDY:-delova-caddy-1}"
APP="${APP:-teman-seller-studio}"   # nama container; wajib beda per instance di satu VPS
export APP_NAME="$APP"
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\033[31mGAGAL: %s\033[0m\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "docker tidak ditemukan"
docker inspect "$CADDY" >/dev/null 2>&1 || die "container Caddy '$CADDY' tidak ada (cek: docker ps)"
if ss -ltn | awk '{print $4}' | grep -q ":${HOST_PORT}\$" && ! docker ps --format '{{.Names}}' | grep -qx "$APP"; then
  die "port ${HOST_PORT} dipakai proses lain. Jalankan ulang dengan: HOST_PORT=3401 bash scripts/deploy-vps.sh"
fi

say "1/5 File .env"
NEWTOK=""
setenv() { # setenv NAMA NILAI : ubah/tambah baris di .env tanpa mengubah baris lain
  if grep -q "^$1=" .env; then V="$2" N="$1" awk 'BEGIN{FS=OFS="="} $1==ENVIRON["N"]{print $1, ENVIRON["V"]; next} {print}' .env > .env.tmp && cat .env.tmp > .env && rm -f .env.tmp
  else printf '%s=%s\n' "$1" "$2" >> .env; fi
}
[ -f .env ] || { cp .env.example .env; echo ".env dibuat dari .env.example"; }
chmod 600 .env
if ! grep -qE '^ACCESS_TOKEN=.+' .env; then   # wajib: server menolak start tanpa ini
  NEWTOK="$(openssl rand -hex 32)"; setenv ACCESS_TOKEN "$NEWTOK"; echo "ACCESS_TOKEN dibuat"
fi
NEWMCP=""
if ! grep -qE '^MCP_PATH_SECRET=.{24,}' .env; then   # URL konektor Claude
  NEWMCP="$(openssl rand -hex 24)"; setenv MCP_PATH_SECRET "$NEWMCP"; echo "MCP_PATH_SECRET dibuat"
fi
NEWPASS=""
grep -qE '^ADMIN_USER=.+' .env || setenv ADMIN_USER admin
if ! grep -qE '^ADMIN_PASSWORD=.{8,}' .env; then   # login web: wajib, minimal 8 karakter
  NEWPASS="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)"; setenv ADMIN_PASSWORD "$NEWPASS"; echo "ADMIN_PASSWORD dibuat"
fi
if ! grep -qE '^KENARI_API_KEY=kn-[^ ]{8,}' .env || grep -q 'isi-dari-dashboard' .env; then
  read -rsp "Tempel KENARI_API_KEY (tidak tampil di layar), lalu Enter: " KEY; echo
  [ -n "$KEY" ] || die "API key kosong"
  setenv KENARI_API_KEY "$KEY"; echo "KENARI_API_KEY disimpan"
fi

say "2/5 DNS ${DOMAIN}"
IP="$(getent hosts "$DOMAIN" | awk '{print $1; exit}' || true)"
[ -n "$IP" ] || die "DNS ${DOMAIN} belum ada. Buat record A 'studio' ke IP VPS ini, tunggu beberapa menit, lalu jalankan ulang skrip ini."
echo "${DOMAIN} -> ${IP}"

say "3/5 Network Caddy"
nets() { docker inspect "$1" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' 2>/dev/null | sed '/^$/d'; }
CNETS="$(nets "$CADDY")"
NET=""
for n in $CNETS; do
  if nets delova-threads-hub | grep -qx "$n"; then NET="$n"; break; fi
done
[ -n "$NET" ] || NET="$(echo "$CNETS" | head -1)"
[ -n "$NET" ] || die "network Caddy tidak terdeteksi"
echo "Memakai network: ${NET}"
cat > docker-compose.override.yml <<YML
services:
  studio:
    networks: [default, caddy_net]
networks:
  caddy_net:
    external: true
    name: ${NET}
YML

say "4/5 Menjalankan container"
export PUBLIC_URL="https://${DOMAIN}"
HOST_PORT="$HOST_PORT" docker compose up -d --build
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:${HOST_PORT}/healthz" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS "http://127.0.0.1:${HOST_PORT}/healthz" >/dev/null || { docker logs --tail 30 "$APP"; die "aplikasi tidak sehat (log di atas)"; }
echo "Aplikasi sehat di 127.0.0.1:${HOST_PORT}"
docker exec "$CADDY" wget -qO- "http://${APP}:3000/healthz" >/dev/null 2>&1 \
  && echo "Caddy bisa menjangkau ${APP}:3000" \
  || echo "Peringatan: tes jangkauan dari Caddy gagal/tidak tersedia (wget). Lanjut, hasil akhir dicek di langkah 5."

say "5/5 Caddy"
mounts() { docker inspect "$CADDY" --format '{{range .Mounts}}{{.Source}}|{{.Destination}}{{"\n"}}{{end}}'; }
CF_IN=""; CF_HOST=""
while IFS='|' read -r src dst; do
  case "$dst" in */Caddyfile) CF_IN="$dst"; CF_HOST="$src"; break ;; esac
done < <(mounts)
if [ -z "$CF_HOST" ]; then
  while IFS='|' read -r src dst; do
    if [ -n "$src" ] && [ -f "$src/Caddyfile" ]; then CF_IN="$dst/Caddyfile"; CF_HOST="$src/Caddyfile"; break; fi
  done < <(mounts)
fi
[ -n "$CF_HOST" ] && [ -f "$CF_HOST" ] || die "Caddyfile tidak ketemu di mount ${CADDY}. Kirim output: docker inspect ${CADDY} --format '{{json .Mounts}}'"
echo "Caddyfile: ${CF_HOST}"

if grep -qF "$DOMAIN" "$CF_HOST"; then
  echo "${DOMAIN} sudah ada di Caddyfile, dilewati."
else
  BAK="${CF_HOST}.bak-$(date +%Y%m%d-%H%M%S)"
  cp -p "$CF_HOST" "$BAK"
  echo "Backup: ${BAK}"
  {
    printf '\n'
    cat <<BLOCK
${DOMAIN} {
	request_body {
		max_size 40MB
	}
	reverse_proxy ${APP}:3000 {
		flush_interval -1
		transport http {
			response_header_timeout 360s
		}
	}
}
BLOCK
  } >> "$CF_HOST"
  if ! docker exec "$CADDY" caddy validate --config "$CF_IN" --adapter caddyfile; then
    cat "$BAK" > "$CF_HOST"; die "Caddyfile tidak valid, sudah dikembalikan ke semula. Tidak ada yang di-reload."
  fi
  if ! docker exec "$CADDY" caddy reload --config "$CF_IN" --adapter caddyfile; then
    cat "$BAK" > "$CF_HOST"; die "reload Caddy gagal, Caddyfile dikembalikan ke semula."
  fi
  echo "Caddy di-reload."
fi

say "Cek https://${DOMAIN} (sertifikat bisa butuh sampai 1 menit)"
OK=""
for _ in $(seq 1 12); do
  if curl -fsS "https://${DOMAIN}/healthz" 2>/dev/null | grep -q '"ok":true'; then OK=1; break; fi
  sleep 5
done
if [ -n "$OK" ]; then printf '\033[32mBERHASIL: https://%s/healthz OK\033[0m\n' "$DOMAIN"; else echo "Belum merespons. Cek: docker logs --tail 50 ${CADDY}"; fi

if [ -n "$NEWTOK" ] || [ -n "$NEWPASS" ]; then
  echo; echo "SIMPAN DI PASSWORD MANAGER (hanya ditampilkan sekali):"
  if [ -n "$NEWPASS" ]; then echo "  Login web : https://${DOMAIN}/login   user=$(grep '^ADMIN_USER=' .env | cut -d= -f2-)   password=${NEWPASS}"; fi
  if [ -n "$NEWTOK" ]; then echo "  ACCESS_TOKEN (Claude/MCP): ${NEWTOK}"; fi
fi
MCP_SECRET="$(grep '^MCP_PATH_SECRET=' .env | cut -d= -f2-)"
echo; echo "URL konektor Claude (Settings > Connectors > Add custom connector):"
echo "  https://${DOMAIN}/mcp/${MCP_SECRET}"
echo "  (URL yang sama tersedia di dashboard: menu Koneksi MCP)"
echo; echo "Atau lewat Claude Code (terminal):"
echo "claude mcp add --transport http teman-seller-studio https://${DOMAIN}/mcp --header \"Authorization: Bearer <ACCESS_TOKEN>\""
