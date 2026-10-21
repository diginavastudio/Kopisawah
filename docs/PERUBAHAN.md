# Kopi Sawah — catatan pembenahan P0

Tanggal: 22 Oktober 2026 (WIB) · oleh: Ekko Agent
Cadangan sebelum perubahan: `/root/backup-kopi-sawah/` (app.py, index.html, berkas DB, unit systemd)

## 1. Zona waktu laporan (sebelumnya salah)
**Masalah:** laporan "hari ini" memakai tanggal **UTC**. Transaksi pukul 00:00–06:59 WIB
masuk hitungan hari sebelumnya, jadi omzet pagi hilang dari laporan hari ini.

**Perbaikan:**
- `KOPI_SAWAH_TZ` (bawaan `Asia/Jakarta`). Cap waktu kini disimpan dengan offset `+07:00`.
- Kolom baru `sales.business_date` = tanggal usaha menurut WIB, diisi saat transaksi dibuat.
  Laporan harian memakai kolom ini (cadangan: `substr(created_at,1,10)` untuk baris lama).
- `/api/health` dan `/api/reports/summary` mengirim `timezone`, `business_date`/`today`.
- Label layar: "Waktu UTC" -> "Waktu (WIB)".

## 2. Pengaman klik ganda (dobel transaksi)
**Masalah:** tidak ada kunci idempoten. Jaringan lambat + kasir klik dua kali = dua transaksi
dan dua potong stok.

**Perbaikan:**
- Klien membuat `request_id` (UUID) sekali per keranjang (`crypto.randomUUID`), tombol
  dinonaktifkan selama proses ("Menyimpan...").
- Server menyimpan `sales.request_id` dengan indeks unik parsial `idx_sales_request`.
- Permintaan ulang dengan kunci sama mengembalikan transaksi yang **sudah ada**
  (`200 {duplicate: true}`), bukan membuat baris baru.

## 3. Status stok terlacak (anti oversell)
**Masalah:** stok hanya dipotong bila `stock_on_hand` terisi, dan **124 dari 124 menu belum diisi**,
jadi sistem tidak mencegah oversell sama sekali.

**Perbaikan:**
- Kolom baru `products.stock_tracked` (0/1).
- Menyimpan hitungan stok (`POST /api/stock/count`) otomatis menandai menu **terlacak**.
- Transaksi: menu terlacak -> stok wajib ada dan cukup; menu belum dilacak -> tidak memotong stok
  tetapi diberi label jelas "Belum dilacak" di layar Stok dan Ringkasan.
- Tombol "Tanpa potong stok" untuk melepas pelacakan satu menu (`PUT /api/products/<id>` `stock_tracked:false`).
- Mode ketat: `KOPI_SAWAH_REQUIRE_STOCK=1` -> transaksi untuk menu **belum dilacak ditolak**
  (409). Nyalakan ini sebelum dipakai berjualan sungguhan:
  `systemctl edit kopi-sawah.service` -> `[Service]` `Environment=KOPI_SAWAH_REQUIRE_STOCK=1`, lalu restart.

## 4. Perbaikan kecil
- `api()` di peramban tidak lagi gagal "aneh" saat balasan bukan JSON; 403 dari nginx kini
  muncul sebagai "Penyimpanan sedang ditutup (pratinjau baca-saja)."
- Dua varian halaman (`deploy/index-review-write.html`, `deploy/index-review-readonly.html`)
  disamakan dengan halaman hidup, sehingga jendela uji tim tidak menurunkan versi fitur.
- Repo git lokal di `/opt/kopi-sawah` (baseline sebelum perubahan = commit `chore: baseline ...`).

## Yang TIDAK berubah (sengaja)
- Pagar baca-saja nginx (`limit_except GET HEAD`) tetap aktif: pengunjung publik tetap tidak bisa menyimpan.
- Kunci jendela tulis `KOPI_SAWAH_WRITE_UNTIL` tetap berlaku; tanpa nilai = semua tulis ditolak.
- Tanpa login, tanpa peran, tanpa pajak/diskon/cetak struk — itu masuk daftar P1/P2, bukan P0.

## Cara memeriksa
```
curl -s http://127.0.0.1:8791/api/health     # timezone, business_date, counts.untracked_stock
curl -s http://127.0.0.1:8791/api/reports/summary
systemctl status kopi-sawah.service --no-pager
git -C /opt/kopi-sawah log --oneline
```

## Mengembalikan (rollback)
```
systemctl stop kopi-sawah.service
cp <cadangan>/app.py /opt/kopi-sawah/app.py
cp <cadangan>/index.html /opt/kopi-sawah/static/index.html
cp <cadangan>/kopi-sawah.sqlite3 /var/lib/kopi-sawah/kopi-sawah.sqlite3
systemctl start kopi-sawah.service
```
Catatan: migrasi hanya **menambah** kolom (`business_date`, `request_id`, `stock_tracked`);
tidak menghapus atau mengubah data lama.
