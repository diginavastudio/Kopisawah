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


---

# Ronde 2 — 22/23 Oktober 2026

## 4. Varian & tambahan berbayar (modifier)
Sebelumnya varian hanya satu kolom teks bebas, tidak bisa menambah harga. Sekarang:

- Tabel baru: `modifier_groups`, `modifiers`, `category_modifier_groups`, `sale_item_modifiers`,
  plus kolom `sale_items.modifiers_summary`.
- Benih awal 7 kelompok / 16 pilihan: **Suhu** (Es/Panas), **Level Gula**, **Level Es**, **Ukuran**
  (Large +Rp5.000), **Extra Shot** (+Rp5.000), **Jenis Susu** (Oat Milk +Rp5.000), **Sambal Tambahan**
  (Bawang/Terasi +Rp4.000, maks 2).
- Penugasan **per kategori** (bukan per menu) supaya tidak perlu klik satu-satu:
  Kopi = Suhu+Gula+Es+Ukuran+Extra Shot+Susu · Minuman = Suhu+Gula+Es+Ukuran · Wedangan = Suhu+Gula ·
  Makanan/Lauk/Paket/Camilan = Sambal.
- API: `GET /api/modifiers`, `POST /api/modifiers/groups`, `POST /api/modifiers/options`,
  `PUT /api/modifiers/group/<id>`, `PUT /api/modifiers/option/<id>`,
  `PUT /api/modifiers/category/<kategori>`, `DELETE /api/modifiers/group|option/<id>` (menonaktifkan).
- Transaksi: `items[].modifiers = [{id}]`. Server memvalidasi kelompok wajib/maksimal, menolak varian
  yang bukan milik kategori, menambah harga, dan menyimpan salinan nama varian pada nota
  (`unit_price` sudah termasuk tambahan).
- Layar: kartu menu menampilkan jumlah pilihan varian; ketuk → panel pilihan (radio untuk wajib satu,
  centang untuk maksimal banyak) dengan harga berjalan; keranjang mengelompokkan baris menurut
  gabungan menu+varian, jadi "Kopi Es Large" dan "Kopi Panas Regular" jadi dua baris.

## 5. Desain & aset dari kartu menu lampiran
- Palet diambil dari kartu menu: hijau zaitun gelap `#12150c`–`#272d1b` dengan aksen emas `#e9d27a`
  dan krem `#f4efdc`. Tema gelap-emas dipakai di seluruh aplikasi (sebelumnya hijau-krem terang).
- Logo: potongan wordmark "KOPI SAWAH · KLATEN" dari halaman 15 PDF (`static/images/logo-kopi-sawah.png`
  dan versi transparan `logo-kopi-sawah-transparan.png`) — dipakai di kepala halaman dan favicon.
- Foto menu: foto asli dari dalam PDF (bukan foto stok) untuk Ayam, Jangan Ndeso, Udang, Cumi,
  Sop Sawah, empat Paket, Coffee/V60, dan Es Telang. Halaman 2 dipakai sebagai gambar kartu menu di
  Ringkasan (`static/images/kartu-menu.jpg`). Foto lain tetap memakai foto lama karena PDF tidak
  menyediakan foto per menu.
- Halaman ditulis ulang: 7 tab (Ringkasan, Kasir, Menu & Harga, Stok, Riwayat, Laporan, Varian),
  kartu menu bergambar, panel pesanan lengket, tabel rapi, dan tanggal ditampilkan dalam WIB.

## 6. Harga yang tadinya kosong
- Long Black (id 121) = **Rp10.000**
- Ice Americano (id 122) = **Rp15.000**
- Penanda teks "Harga perlu konfirmasi" pada kedua menu dihapus.

## 7. Akses tulis dibuka (permintaan pemilik)
- Pengarah web diganti ke `deploy/nginx-writable-location.conf`: **semua metode** diteruskan ke aplikasi
  (bukan hanya GET/HEAD). Pagar asal permintaan (`KOPI_SAWAH_REQUIRE_ORIGIN=1`) tetap aktif.
- `KOPI_SAWAH_WRITE_UNTIL=2099-12-31T00:00:00Z` → jendela tulis tanpa batas waktu sampai login dipasang.
- Timer pengunci otomatis `kopi-sawah-review-lock.timer` **dimatikan** (`systemctl disable --now`),
  supaya tidak mengembalikan halaman ke baca-saja. Skrip pengunci tetap ada bila ingin dikunci manual:
  `systemctl start kopi-sawah-review-lock.service`.
- `KOPI_SAWAH_REQUIRE_STOCK=0` untuk masa uji: menu yang **belum dihitung stoknya** tetap bisa dijual
  (stok tidak dipotong). Begitu stok sebuah menu dihitung, menu itu otomatis terlacak dan dijaga
  (tidak boleh melebihi stok). Untuk mewajibkan semua menu berstok, ubah ke `1` lalu restart.

### Konsekuensi yang harus disadari
Situs kini **dapat diubah siapa pun yang tahu alamatnya** (tanpa login). Jangan masukkan data
pelanggan/penjualan nyata sampai login dan peran dipasang.

## 8. Data uji dibersihkan
Transaksi dan gerak stok hasil uji internal dihapus kembali: `sales` = 0, `sale_items` = 0,
`stock_movements` = 0, `products` = 124, `stock_tracked` = 0. Hitungan stok Es Teh yang dipakai uji
dikembalikan ke "belum dilacak".

## 9. Cara memeriksa cepat
```
curl -s http://127.0.0.1:8791/api/health          # timezone, require_stock, counts
curl -s http://127.0.0.1:8791/api/modifiers       # kelompok varian + penugasan kategori
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://kopisawah.diginavastudio.com/api/sales \
  -H 'Content-Type: application/json' -H 'Origin: https://kopisawah.diginavastudio.com' -d '{}'
git -C /opt/kopi-sawah log --oneline
```

## 10. Rollback ronde 2
```
cp <cadangan>/kopi-sawah-location.conf /home/diginavastudio/conf/web/kopisawah.diginavastudio.com/kopi-sawah-location.conf
cp <cadangan>/kopi-sawah.service /etc/systemd/system/kopi-sawah.service
cp <cadangan>/index.html /opt/kopi-sawah/static/index.html
systemctl daemon-reload && nginx -t && systemctl reload nginx && systemctl restart kopi-sawah.service
```
Cadangan ronde 2: `/root/backup-kopi-sawah/20261021-232903-akses/` (konfigurasi nginx + unit systemd).
Migrasi hanya menambah tabel/kolom; data lama tidak diubah.


---

# Simpanan kode di GitHub (23 Oktober 2026)

- Repo: **https://github.com/diginavastudio/Kopisawah** (publik, branch `main`).
- Riwayat lokal di server = riwayat di GitHub (HEAD `1ee7eb4` saat pertama didorong).
- Remote: `origin` → ambil/fetch via HTTPS publik, dorong/push via SSH berkunci.
- Kunci: `/root/.ssh/id_ed25519_github_kopisawah` + alias `Host github-kopisawah` di `/root/.ssh/config`
  (Deploy key "ekko-server" dengan hak tulis). Kunci privat **tidak** pernah masuk repo.
- Cara mendorong perubahan berikutnya:

```
cd /opt/kopi-sawah
git add -A && git commit -m 'pesan perubahan'
git push
```

- Berkas basis data (`data/*.sqlite3`) dan `__pycache__` dikecualikan lewat `.gitignore`.
- Repo bersifat publik: berisi kode, aset menu, dan konfigurasi deploy tanpa sandi. Untuk menyembunyikan,
  ubah visibility repo ke Private di GitHub, atau minta `deploy/` dikeluarkan dari repo.
