#!/usr/bin/env bash
# Tarik perubahan dari GitHub (diginavastudio/Kopisawah) lalu pasang di server.
# Dilengkapi pemeriksaan sintaks, uji kesehatan layanan, dan rollback otomatis.
#
# Pemakaian:
#   deploy/tarik-dari-github.sh          # tarik + pasang
#   deploy/tarik-dari-github.sh --cek    # hanya periksa, tidak mengubah apa pun
#
# Aman dijalankan berkali-kali: kalau tidak ada commit baru, langsung selesai.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

REPO=/opt/kopi-sawah
SERVICE=kopi-sawah.service
HEALTH=http://127.0.0.1:8791/api/health
LOG=/var/log/kopi-sawah-deploy.log
MODE="${1:-pasang}"

log(){ printf '%s | %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG" >&2; }

cd "$REPO"

sebelum=$(git rev-parse HEAD)
git fetch -q origin main
tujuan=$(git rev-parse origin/main)

if [ "$sebelum" = "$tujuan" ]; then
  log "tidak ada commit baru (HEAD ${sebelum:0:7}) — web sudah versi terbaru"
  exit 0
fi

# server lebih baru dari GitHub (ada commit lokal yang belum didorong) -> diamkan
di_belakang=$(git rev-list --count "$tujuan..$sebelum")
di_depan=$(git rev-list --count "$sebelum..$tujuan")
if [ "$di_depan" -eq 0 ] && [ "$di_belakang" -gt 0 ]; then
  log "server lebih baru dari GitHub (${di_belakang} commit lokal belum didorong) — dilewati"
  exit 0
fi

HOLD=/var/lib/kopi-sawah/DEPLOY-HOLD
if [ -f "$HOLD" ] && [ "$(head -n1 "$HOLD")" = "$tujuan" ]; then
  log "versi ${tujuan:0:7} sebelumnya gagal dipasang — dilewati (hapus $HOLD setelah diperbaiki)"
  exit 7
fi

log "ada versi baru: ${sebelum:0:7} -> ${tujuan:0:7}"
git log --oneline "$sebelum..$tujuan" | sed 's/^/    /' | tee -a "$LOG" >&2

if [ -n "$(git status --porcelain)" ]; then
  log "DITOLAK: ada perubahan lokal di server yang belum di-commit. Rapikan dulu (commit atau git checkout)."
  exit 2
fi

if [ "$MODE" = "--cek" ]; then
  log "--cek: perubahan tersedia tetapi TIDAK dipasang"
  exit 0
fi

# 1. tarik perubahan (hanya fast-forward, supaya riwayat tidak kacau)
if ! git merge -q --ff-only "$tujuan"; then
  git reset -q --hard "$sebelum"
  log "DITOLAK: riwayat bercabang (server dan GitHub sama-sama berubah). Selesaikan manual."
  exit 3
fi

# 2. periksa sintaks Python
if ! /usr/bin/python3 -m py_compile "$REPO/app.py"; then
  log "GAGAL: app.py tidak lolos pemeriksaan sintaks — dikembalikan ke ${sebelum:0:7}"
  git reset -q --hard "$sebelum"
  printf '%s %s\n' "$tujuan" "$(date -u +%FT%TZ)" > "$HOLD"
  exit 4
fi

# 3. periksa sintaks JavaScript di index.html (kalau node tersedia)
if command -v node >/dev/null 2>&1 && [ -f "$REPO/static/index.html" ]; then
  tmp_js=$(mktemp /tmp/kopi-js-XXXXXX.js)
  sed -n '/^<script>$/,/^<\/script>$/p' "$REPO/static/index.html" | sed '1d;$d' > "$tmp_js"
  if [ -s "$tmp_js" ] && ! node --check "$tmp_js" >/dev/null 2>&1; then
    rm -f "$tmp_js"
    log "GAGAL: JavaScript di index.html rusak — dikembalikan ke ${sebelum:0:7}"
    git reset -q --hard "$sebelum"
    printf '%s %s\n' "$tujuan" "$(date -u +%FT%TZ)" > "$HOLD"
    exit 5
  fi
  rm -f "$tmp_js"
fi

# 4. pasang: restart layanan lalu uji kesehatan
systemctl restart "$SERVICE"
sehat=0
for _ in $(seq 1 20); do
  if curl -fsS -m 2 "$HEALTH" >/dev/null 2>&1; then sehat=1; break; fi
  sleep 1
done

if [ "$sehat" != 1 ]; then
  log "GAGAL: layanan tidak sehat setelah dipasang — dikembalikan ke ${sebelum:0:7}"
  git reset -q --hard "$sebelum"
  printf '%s %s\n' "$tujuan" "$(date -u +%FT%TZ)" > "$HOLD"
  systemctl restart "$SERVICE"
  sleep 2
  if curl -fsS -m 2 "$HEALTH" >/dev/null 2>&1; then
    log "rollback berhasil, web kembali ke versi lama"
  else
    log "PERHATIAN: rollback dipasang tetapi layanan masih tidak sehat — periksa journalctl -u $SERVICE"
  fi
  exit 6
fi

rm -f /var/lib/kopi-sawah/DEPLOY-HOLD

# 5. tulis penanda versi (dibaca aplikasi lewat /api/health)
printf '%s %s\n' "$(git rev-parse --short HEAD)" "$(date -u +%FT%TZ)" > /var/lib/kopi-sawah/VERSION
chown kopi-sawah:kopi-sawah /var/lib/kopi-sawah/VERSION 2>/dev/null || true
chmod 0644 /var/lib/kopi-sawah/VERSION 2>/dev/null || true

log "SUKSES terpasang: $(git log --oneline -1)"
