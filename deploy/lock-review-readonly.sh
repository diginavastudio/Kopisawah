#!/usr/bin/env bash
set -euo pipefail
umask 077
conf_dir=/home/diginavastudio/conf/web/kopisawah.diginavastudio.com
static_dir=/opt/kopi-sawah/static
readonly_conf=/opt/kopi-sawah/deploy/nginx-preview-location.conf
readonly_index=/opt/kopi-sawah/deploy/index-review-readonly.html
active_conf="$conf_dir/kopi-sawah-location.conf"
active_index="$static_dir/index.html"
tmp_conf=$(/usr/bin/mktemp "$conf_dir/.kopi-sawah-location.XXXXXX")
tmp_index=$(/usr/bin/mktemp "$static_dir/.index.html.XXXXXX")
cleanup() { /usr/bin/rm -f "$tmp_conf" "$tmp_index"; }
trap cleanup EXIT
/usr/bin/install -o root -g www-data -m 0640 "$readonly_conf" "$tmp_conf"
/usr/bin/install -o root -g root -m 0644 "$readonly_index" "$tmp_index"
/usr/bin/mv -f "$tmp_conf" "$active_conf"
/usr/bin/mv -f "$tmp_index" "$active_index"
/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx
if /usr/bin/systemctl is-enabled --quiet kopi-sawah-review-lock.timer; then
    /usr/bin/systemctl disable --now kopi-sawah-review-lock.timer
fi
/usr/bin/logger -t kopi-sawah-review-lock "team review write window closed; read-only preview restored"
