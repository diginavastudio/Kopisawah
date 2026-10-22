#!/usr/bin/env bash
# DARURAT: kunci situs jadi baca-saja di tingkat nginx (menolak semua POST/PUT/DELETE, termasuk login).
# Tidak perlu untuk pemakaian normal — aplikasi sudah memakai login PIN dan peran.
set -euo pipefail
umask 077
conf_dir=/home/diginavastudio/conf/web/kopisawah.diginavastudio.com
readonly_conf=/opt/kopi-sawah/deploy/nginx-preview-location.conf
active_conf="$conf_dir/kopi-sawah-location.conf"
tmp_conf=$(/usr/bin/mktemp "$conf_dir/.kopi-sawah-location.XXXXXX")
cleanup() { /usr/bin/rm -f "$tmp_conf"; }
trap cleanup EXIT
/usr/bin/install -o root -g www-data -m 0640 "$readonly_conf" "$tmp_conf"
/usr/bin/mv -f "$tmp_conf" "$active_conf"
/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx
if /usr/bin/systemctl is-enabled --quiet kopi-sawah-review-lock.timer; then
    /usr/bin/systemctl disable --now kopi-sawah-review-lock.timer
fi
/usr/bin/logger -t kopi-sawah-review-lock "team review write window closed; read-only preview restored"
