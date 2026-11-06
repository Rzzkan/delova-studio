#!/usr/bin/env bash
# Cek port yang kosong di VPS sebelum deploy Delova Studio. Hanya membaca, tidak mengubah apa pun.
# Pakai: bash scripts/check-ports.sh            (rentang 3400-3499)
#        bash scripts/check-ports.sh 3400 3450
START="${1:-3400}"; END="${2:-3499}"

echo "== Port yang sedang LISTEN (host) =="
if command -v ss >/dev/null; then sudo -n ss -ltnp 2>/dev/null || ss -ltn; else netstat -ltn; fi

if command -v docker >/dev/null; then
  echo; echo "== Port yang dipublish container Docker =="
  docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null || echo "(docker ps gagal, coba pakai sudo)"
fi

used=$( { ss -ltn 2>/dev/null || netstat -ltn; } | awk 'NR>1{n=split($4,a,":"); print a[n]}' | sort -un)
if command -v docker >/dev/null; then
  used="$used
$(docker ps --format '{{.Ports}}' 2>/dev/null | grep -oE ':[0-9]+->' | tr -d ':>-' )"
fi

echo; echo "== Port kosong di rentang ${START}-${END} (10 pertama) =="
free=0
for p in $(seq "$START" "$END"); do
  if ! grep -qx "$p" <<<"$used"; then echo "$p"; free=$((free+1)); [ "$free" -ge 10 ] && break; fi
done
[ "$free" -eq 0 ] && echo "(tidak ada yang kosong, coba rentang lain)"
echo "Reverse proxy yang aktif:"; (ss -ltnp 2>/dev/null | grep -E ':(80|443)\b' | head -3) || true
