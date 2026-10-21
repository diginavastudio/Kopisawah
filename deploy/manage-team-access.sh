#!/usr/bin/env bash
set -euo pipefail

AUTH_FILE="${KOPI_SAWAH_AUTH_FILE:-/home/diginavastudio/conf/web/kopisawah.diginavastudio.com/kopi-sawah-users.htpasswd}"
ACTION="${1:-}"
USERNAME="${2:-}"

if [[ "$EUID" -ne 0 ]]; then
  printf 'Jalankan melalui sudo agar berkas akses terlindungi.\n' >&2
  exit 1
fi
if ! command -v htpasswd >/dev/null 2>&1; then
  printf 'Perintah htpasswd tidak ditemukan.\n' >&2
  exit 1
fi

case "$ACTION" in
  add)
    if [[ ! "$USERNAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$ ]]; then
      printf 'Nama akun harus 3–32 karakter: huruf, angka, titik, garis bawah, atau minus.\n' >&2
      exit 2
    fi
    if ! getent group www-data >/dev/null; then
      printf 'Grup www-data tidak ditemukan; berkas akses tidak dibuat.\n' >&2
      exit 1
    fi
    umask 027
    if [[ ! -e "$AUTH_FILE" ]]; then
      parent="$(dirname "$AUTH_FILE")"
      if [[ ! -d "$parent" ]]; then
        printf 'Folder konfigurasi domain Hestia belum ada; buat domain lebih dulu.\n' >&2
        exit 1
      fi
      temp_file="$(mktemp "${AUTH_FILE}.new.XXXXXX")"
      chmod 0640 "$temp_file"
      chown root:www-data "$temp_file"
      if htpasswd -B -c "$temp_file" "$USERNAME"; then
        mv "$temp_file" "$AUTH_FILE"
      else
        rm -f "$temp_file"
        exit 1
      fi
    else
      htpasswd -B "$AUTH_FILE" "$USERNAME"
    fi
    chown root:www-data "$AUTH_FILE"
    chmod 0640 "$AUTH_FILE"
    printf 'Akun %s siap. Sandi tidak ditampilkan atau disimpan sebagai teks biasa.\n' "$USERNAME"
    ;;
  remove)
    if [[ ! -f "$AUTH_FILE" ]]; then
      printf 'Berkas akun belum ada.\n' >&2
      exit 1
    fi
    if [[ ! "$USERNAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$ ]]; then
      printf 'Nama akun tidak valid.\n' >&2
      exit 2
    fi
    count="$(awk -F: 'NF > 1 {n++} END {print n+0}' "$AUTH_FILE")"
    if [[ "$count" -le 1 ]]; then
      printf 'Akun terakhir tidak boleh dihapus; tambahkan akun pengganti lebih dulu.\n' >&2
      exit 1
    fi
    htpasswd -D "$AUTH_FILE" "$USERNAME"
    chown root:www-data "$AUTH_FILE"
    chmod 0640 "$AUTH_FILE"
    printf 'Akun %s dihapus.\n' "$USERNAME"
    ;;
  list)
    if [[ ! -f "$AUTH_FILE" ]]; then
      printf 'Belum ada akun.\n'
      exit 0
    fi
    cut -d: -f1 "$AUTH_FILE"
    ;;
  *)
    printf 'Pakai: %s add|remove|list [nama-akun]\n' "$0" >&2
    printf 'Saat add, htpasswd meminta sandi secara tersembunyi; jangan kirim sandi lewat chat.\n' >&2
    exit 2
    ;;
esac
