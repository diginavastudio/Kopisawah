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


---

# Ronde 3 — 23 Oktober 2026: cetak struk & tutup kasir (X/Z)

## 11. Struk pesanan (cetak)
- Setelah pesanan disimpan, **struk langsung tampil** dalam panel dengan tombol **Cetak struk**
  (`window.print()`), lalu tinggal pilih printer *thermal* 58/80 mm dari dialog cetak.
- Isi struk: nama & telepon kedai, nomor pesanan, tanggal-jam **WIB**, nomor sesi, rincian per item
  berikut varian dan harga satuan, total, metode bayar, dan catatan "struk uji coba".
- **Cetak ulang** kapan saja dari tab **Riwayat** (tombol "Struk" pada tiap baris).
- CSS cetak (`@media print`) menyembunyikan seluruh antarmuka dan hanya mencetak kertas struk
  berlebar 72–82 mm, hitam-putih, tanpa latar gelap.
- API pendukung: `GET /api/sales/<id>` (satu transaksi lengkap dengan item & varian).

## 12. Tutup kasir: sesi, laporan X dan Z
- Tabel baru `cash_sessions` + kolom `sales.session_id`.
- **Buka kasir** dengan *kas awal* (uang di laci). Kalau ada pesanan disimpan tanpa membuka kasir,
  sesi dibuat otomatis dengan kas awal Rp0 dan diberi catatan "dibuka otomatis saat transaksi pertama".
- **Laporan X** (sementara, tidak menutup): jumlah transaksi, total penjualan, rincian per metode
  bayar, tunai/non-tunai, kas awal, dan **kas seharusnya** = kas awal + penjualan tunai.
- **Laporan Z** (menutup): isi *kas dihitung* (uang fisik) + catatan; sistem menghitung
  **selisih** = dihitung − seharusnya, menyimpan rekap ke sesi, lalu menampilkan Z yang bisa dicetak
  dalam format struk.
- **Riwayat sesi**: daftar sesi dengan waktu buka/tutup, transaksi, total, kas awal, seharusnya,
  dihitung, dan selisih (hijau bila 0, merah bila tidak). Tombol **Z** mencetak ulang laporan sesi lama.
- API: `GET /api/cash/current`, `POST /api/cash/open`, `POST /api/cash/close`,
  `GET /api/cash/sessions`, `GET /api/cash/sessions/<id>`.
- Diuji (staging, 13/13 skenario): sesi otomatis, tolak buka ganda, X benar, Z dengan selisih ±1.000,
  sesi kedua dengan kas awal 100.000, dan laporan harian tetap konsisten.

## 13. Catatan
- Struk mencetak label "struk uji coba · bukan bukti pembayaran" selama belum ada pajak/QRIS resmi.
- Belum ada: pajak/PB1, service charge, diskon, retur/void, dan login (login sengaja ditunda atas
  permintaan pemilik sampai desain web selesai).


---

# Ronde 4 — 23 Oktober 2026: alur GitHub → web

## 14. Apakah perubahan di GitHub langsung tampil di web?
**Tidak otomatis.** Web menyajikan berkas dari `/opt/kopi-sawah` di server; GitHub hanya salinan
riwayat. Tanpa langkah pemasangan, perubahan yang dibuat di GitHub **tidak** terlihat di situs.

Sekarang sudah tersedia skrip pemasangan:

```
/opt/kopi-sawah/deploy/tarik-dari-github.sh          # tarik + pasang
/opt/kopi-sawah/deploy/tarik-dari-github.sh --cek    # hanya periksa, tidak mengubah apa pun
```

Yang dilakukan skrip:
1. `git fetch` lalu bandingkan commit server vs `origin/main`; kalau sama → selesai (aman diulang).
2. Menolak memasang bila ada perubahan lokal yang belum di-commit di server (agar tidak tertimpa).
3. Menarik hanya dengan **fast-forward**; kalau riwayat bercabang → berhenti dan minta diselesaikan manual.
4. Memeriksa sintaks `app.py` (`py_compile`) dan JavaScript di `static/index.html` (`node --check`).
5. `systemctl restart kopi-sawah.service` lalu menunggu `/api/health` sehat (maks 20 detik).
6. Gagal di langkah mana pun → **rollback otomatis** ke commit sebelumnya dan layanan dijalankan ulang.
7. Menulis penanda versi `/var/lib/kopi-sawah/VERSION` (commit + waktu pasang) yang dibaca
   `/api/health` dan ditampilkan sebagai lencana **“versi …”** di kepala halaman.

## 15. Mode otomatis (opsional, belum diaktifkan)
Unit tersedia di `deploy/kopi-sawah-deploy.service` dan `deploy/kopi-sawah-deploy.timer`
(cek tiap 3 menit). Untuk mengaktifkan:

```
install -m0644 /opt/kopi-sawah/deploy/kopi-sawah-deploy.service /etc/systemd/system/
install -m0644 /opt/kopi-sawah/deploy/kopi-sawah-deploy.timer   /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now kopi-sawah-deploy.timer
journalctl -u kopi-sawah-deploy.service -n 20 --no-pager
```

Selama belum diaktifkan, perubahan dari GitHub dipasang **saat diminta** (jalankan skrip di atas).

## 16. Perilaku saat dua sisi berubah bersamaan
Kalau server dan GitHub sama-sama punya commit baru, `git push` dari server akan ditolak
(`fetch first`). Urutan yang benar:

```
cd /opt/kopi-sawah
git fetch origin && git rebase origin/main    # letakkan commit server di atas commit GitHub
git push
```

Kalau hanya ingin mengambil versi GitHub dan membuang perubahan lokal di server: `git reset --hard origin/main`
(hati-hati, perubahan lokal hilang).

## 17. Uji alur (dilakukan 23 Okt 2026)
- Commit dibuat dari salinan lain (meniru "menambah fitur di GitHub") → server belum berubah.
- `tarik-dari-github.sh` mendeteksi versi baru, menarik, memeriksa sintaks, restart, dan menulis penanda versi.
- `/api/health` melaporkan `version.commit = 1c1eb89` dan lencana versi tampil di kepala halaman.
- Uji kegagalan: skrip pernah menolak deploy karena `node --check` gagal (berkas sementara tanpa akhiran
  `.js`), lalu **rollback otomatis** berjalan dan situs tetap 200 — jalur pengaman terbukti bekerja.

---

# Ronde 4b — 23 Oktober 2026: mode otomatis DIAKTIFKAN

## 18. Setiap perubahan di GitHub langsung tayang (maksimal ±1 menit)
Timer `kopi-sawah-deploy.timer` sudah dipasang dan diaktifkan. Alurnya tiap **1 menit**:

```
git fetch origin main
  ├─ commit sama?            -> selesai (diam, tidak restart)
  ├─ server lebih baru?      -> dilewati (ada commit lokal belum didorong)
  ├─ versi ini pernah gagal? -> dilewati (kunci DEPLOY-HOLD)
  └─ ada versi baru          -> fast-forward -> cek py_compile + node --check
                                -> restart layanan -> tunggu /api/health sehat
                                -> tulis VERSION -> hapus DEPLOY-HOLD
```

Kalau ada langkah yang gagal, skrip **mengembalikan ke commit sebelumnya**, menjalankan ulang
layanan, dan menulis `/var/lib/kopi-sawah/DEPLOY-HOLD` supaya versi rusak itu **tidak dicoba
berulang-ulang** (tidak terjadi restart berkala). Setelah diperbaiki, cukup hapus berkas itu:

```
rm -f /var/lib/kopi-sawah/DEPLOY-HOLD
```

## 19. Memantau dan mematikan
```
systemctl list-timers kopi-sawah-deploy --no-pager          # kapan cek berikutnya
tail -f /var/log/kopi-sawah-deploy.log                      # riwayat pasang/gagal
journalctl -u kopi-sawah-deploy.service -n 30 --no-pager    # keluaran tiap percobaan
curl -s http://127.0.0.1:8791/api/health                    # versi yang sedang jalan

systemctl disable --now kopi-sawah-deploy.timer             # matikan mode otomatis
systemctl enable  --now kopi-sawah-deploy.timer             # hidupkan lagi
/opt/kopi-sawah/deploy/tarik-dari-github.sh                 # pasang manual kapan saja
```

## 20. Versi yang ditampilkan
`/api/health` mengirim `version` yang dibaca **langsung dari `.git/HEAD`** (commit yang benar-benar
ada di disk) ditambah `deployed_at` dari berkas `/var/lib/kopi-sawah/VERSION`. Lencana di kepala
aplikasi menampilkan waktu pasang terakhir, mis. **“versi 22 Okt 2026, 07.19”**.

## 21. Uji mode otomatis (23 Okt 2026 00:19 UTC)
- Commit `91f9083` dibuat dari salinan repo lain (meniru "menambah fitur di GitHub") lalu didorong.
- **Tanpa perintah apa pun** di server, dalam ±1 menit: server berpindah `4683c47` → `91f9083`,
  layanan direstart, `/api/health` sehat, `VERSION` = `91f9083 2026-10-22T00:19:44Z`.
- Log: `ada versi baru: 4683c47 -> 91f9083` lalu `SUKSES terpasang: 91f9083 ...`.

## 22. Batasan yang perlu diingat
- Yang dipantau hanya branch **`main`**. Commit di branch lain tidak akan tayang.
- Repo bersifat publik: siapa pun boleh **membaca**, tetapi hanya pemilik repo dan kunci deploy di
  server ini yang bisa **mendorong** perubahan.
- Perubahan hanya **berkas** (kode, HTML, foto). Perubahan **basis data** tidak ikut lewat GitHub.
- Foto menu di-cache peramban 1 tahun; mengganti foto dengan nama berkas sama perlu *hard refresh*.
- Jendela tayang maksimal ±1 menit — bukan instan. Kalau butuh instan, perlu *webhook* (belum dipasang).

---

# Ronde 5 — 22 Oktober 2026: PR #1 digabung TANPA login

## 23. Apa yang digabung
PR #1 (`claude/dreamy-fermat-ubf6xm`) digabung ke `main` lewat cabang `tanpa-login`:
kasir bershift, pajak/PB1 + service charge + pembulatan, diskon (batas nominal/%, khusus pemilik),
HPP & laba kotor, VOID nota dengan alasan, audit log, ekspor CSV, tata letak baru
(`static/app.css` + `static/app.js` + kerangka `static/index.html`), serta `tests/` (API + cek peramban).

## 24. Login/PIN: kode ada, gerbang dimatikan (sesuai permintaan pemilik)
- Env baru di unit: **`KOPI_SAWAH_TANPA_LOGIN=1`**.
- Saat aktif, server menyiapkan satu akun otomatis **“Kasir” dengan peran `pemilik`**, lalu setiap
  permintaan tanpa cookie sesi dianggap dilakukan akun itu. Jadi semua fitur (termasuk diskon, void,
  laporan pemilik, kelola pengguna) terbuka **tanpa PIN dan tanpa kode penyiapan**.
- `/api/auth/status` mengirim `tanpa_login: true`; antarmuka menyembunyikan tombol **Keluar**.
- Alasan teknis akun dibuat sungguhan (bukan objek semu): tabel `shifts.user_id` punya kunci asing ke
  `users.id`, dan `audit_log` mencatat nama pelaku.

### Mengaktifkan login nanti (kalau desain sudah dinyatakan selesai)
```
systemctl edit kopi-sawah.service      # tambahkan: [Service] Environment=KOPI_SAWAH_TANPA_LOGIN=0
systemctl restart kopi-sawah.service
journalctl -u kopi-sawah -n 20 --no-pager | grep "KODE PENYETAPAN"
```
Lalu buka situs, masukkan kode penyiapan itu, buat akun pemilik (PIN 6–8 angka), dan tambah akun kasir
(PIN 4–8 angka) dari menu **Kelola → Pengguna**. Akun otomatis “Kasir” boleh dinonaktifkan setelahnya.
Tanpa mengubah env, gerbang login tetap terbuka.

## 25. Dampak ke basis data
Migrasi otomatis saat layanan pertama kali dijalankan: **+15 kolom** di `sales`
(`subtotal`, `discount_amount`, `discount_reason`, `service_amount`, `tax_amount`, `rounding_amount`,
`amount_paid`, `change_amount`, `order_type`, `table_no`, `user_id`, `shift_id`, `void_reason`,
`voided_by`, `voided_at`), kolom `cost`/`available` di `products`, `cost_snapshot` di `sale_items`,
serta tabel baru `users`, `sessions`, `shifts`, `settings`, `audit_log`.
Data lama aman: **124 menu tetap**, 0 transaksi. Cadangan sebelum migrasi:
`/root/backup-kopi-sawah/20261022-011345-sebelum-pr1/` (berkas DB + app.py + index.html + unit).

## 26. Catatan operasional
- Skrip auto-deploy tetap hidup di **`/usr/local/sbin/kopi-sawah-deploy.sh`** karena PR menghapus
  `deploy/` versi lama dari repo. Unit timer menunjuk ke jalur itu.
- Skrip pengunci darurat `deploy/lock-review-readonly.sh` sekarang hanya mengganti konfigurasi nginx
  (tidak lagi menukar halaman), jadi tetap berfungsi.
- Struk 58 mm tersedia: setelah pembayaran muncul panel "Pembayaran berhasil" dengan tombol
  **Cetak struk** dan **Tiket dapur**.
- Pembayaran tunai mencatat `amount_paid` dan `change_amount` (kembalian) — tidak lagi hanya label.

## 27. Uji setelah penggabungan (22 Okt 2026)
- Staging (port 18794, DB baru + salinan DB produksi): **13/13 lulus** — masuk otomatis sebagai pemilik,
  buka kasir, simpan pesanan, tolak duplikat, laporan, struk, tutup kasir (selisih 0), migrasi DB aman.
- API produksi: **5/5 lulus** — buka kasir, pesanan pertama tersimpan, kiriman ulang dikenali
  `duplicate: true`, hanya 1 transaksi tercatat, laporan bersih setelah data uji dihapus.
- Peramban (situs live): Beranda menyapa “Halo, Kasir”, tanpa layar login; kasir → varian → bayar tunai
  Rp20.000 untuk nota Rp18.000 → kembalian Rp2.000; struk tampil dengan nomor nota, waktu WIB, rincian
  varian; halaman Kas menampilkan laporan sementara (uang awal 200.000 + tunai 18.000 = 218.000) dan
  tutup kasir menghasilkan “Uang laci cocok ✓” dengan selisih 0.
- Data uji dibersihkan kembali: **0 transaksi, 0 shift, 124 menu**, satu akun `Kasir` (pemilik).


---

# Ronde 6 — 22 Oktober 2026: menu & foto dari PDF (commit eacd719) digabung

## 28. Isi penggabungan
Commit `eacd719` dari cabang PR digabung ke `main` **dengan mode tanpa login dipertahankan**:
- Katalog disamakan lagi dengan PDF menu (mis. `Oriental` → **Air Es**), foto menu **dipotong ulang dari PDF**
  dan nama berkas foto diperbaiki, logo baru, `data/menu_patch_v4.json`, `docs/FOTO-MENU.md`.
- Patch katalog dijalankan otomatis saat layanan start (`apply_menu_patch`, penanda `settings.menu_patch = 4`),
  jadi database yang sudah ada ikut berubah tanpa menghapus transaksi.
- Fitur baru: **varian per produk** (`product_groups` + `custom_modifiers`) — tiap menu bisa punya
  kelompok varian sendiri, bukan hanya per kategori.
- Konflik saat merge: `.gitignore`, `docs/PERUBAHAN.md`, `static/app.js`.
  Diselesaikan dengan: `.gitignore` digabung, changelog memakai versi kita (berkas ini),
  `app.js` memakai versi baru lalu **dua tambalan mode tanpa login dipasang ulang**
  (`state.tanpaLogin`, tombol Keluar disembunyikan).
- `app.py` tergabung otomatis dan **tambalan `KOPI_SAWAH_TANPA_LOGIN` tetap utuh** (13 kemunculan, `py_compile` OK).

## 29. Uji sebelum tayang
- Salinan DB produksi + DB kosong di port 18794: login mati (user “Kasir” peran pemilik, `tanpa_login: true`),
  katalog 124 menu dengan patch `Air Es`, penanda `menu_patch=4` tersimpan.
- Transaksi: `Americano` dengan varian per produk (`Suhu`, `Level Gula`, `Ukuran`) → Rp15.000, anti dobel `duplicate: true`,
  laporan menghitung 1 transaksi, detail struk lengkap, ekspor CSV 200.
- Catatan: percobaan pertama gagal karena pemanggil uji memakai varian **per kategori**; versi baru memakai
  **varian per produk** (`/api/modifiers` → `product_groups`).

---

# Ronde 7 — 22 Oktober 2026: commit `3e3ece3` (offline, dapur, QRIS, cadangan, perbaikan tampilan)

## 30. Isi
- **Perbaikan “tampilan tidak pas layar”** (CSS/JS) + audit ukuran layar (`tests/viewport_audit.js`).
- **Mode offline**: `static/sw.js` service worker — menyimpan *shell* tampilan (HTML/CSS/JS/logo) dengan strategi
  **jaringan dulu untuk kode** (jadi versi terbaru tetap dipakai saat online) dan **cache untuk gambar**;
  permintaan `/api/` **tidak pernah** disimpan.
- **Halaman pesan lewat QR meja**: `static/order.js` + `static/order.css` + `static/vendor/qrcode.js`.
- Tambahan alur dapur/QRIS/cadangan di `app.py` (+219 baris) dan `tests/browser_ronde5.js`.

## 31. Penggabungan
- Konflik: `docs/PERHATIAN`→ `docs/PERUBAHAN.md` dan `static/app.js`.
  Changelog memakai versi kita (berkas ini); `app.js` memakai versi baru lalu **dua tambalan mode tanpa login
  dipasang ulang** (`state.tanpaLogin`, tombol Keluar disembunyikan).
- `app.py` tergabung otomatis, **tambalan `KOPI_SAWAH_TANPA_LOGIN` tetap utuh** (13 kemunculan, `py_compile` OK).
- Alat deploy (`deploy/tarik-dari-github.sh`, unit `kopi-sawah-deploy.*`) **tetap ada** setelah merge
  (di cabang PR berkas itu tidak ada; salinan hidup ada di `/usr/local/sbin/kopi-sawah-deploy.sh`).

## 32. Uji sebelum tayang (port 18794)
Salinan DB live + DB kosong: **11/11 lulus** — tanpa login aktif, katalog 124 dengan patch PDF,
shift terpakai, transaksi Americano Rp15.000 dengan varian per produk, anti dobel `duplicate: true`,
laporan jalan, `sw.js` + `order.js` + `vendor/qrcode.js` tersedia (200), pemasangan DB baru 124 menu.


---

# Ronde 8 — 22 Oktober 2026: commit `93d3a52` (layout layar lebar, hub laporan, beranda, pelanggan)

## 33. Isi
- **Layout layar lebar** dirapikan + audit ukuran layar (`tests/viewport_audit.js`).
- **Hub laporan** (5 laporan) dan **beranda lengkap** (panduan, ringkasan, perhatian).
- **Data pelanggan** pada pesanan.
- Uji peramban baru: `tests/browser_ronde6.js`; `tests/test_api.py` bertambah.

## 34. Penggabungan
- Konflik hanya `docs/PERUBAHAN.md` → dipakai versi kita (berkas ini), catatan ronde 8 ditambahkan.
- `app.py` dan `static/app.js` tergabung otomatis; **tambalan mode tanpa login tetap utuh**
  (`TANPA_LOGIN` 13 kemunculan, `py_compile` OK; `state.tanpaLogin` + tombol Keluar bersyarat masih ada).
- Alat deploy (`deploy/tarik-dari-github.sh`, unit `kopi-sawah-deploy.*`) tetap ada di `main`.


---

# Ronde 9 — 23 Oktober 2026: panel Beranda disembunyikan (permintaan pemilik)

## 35. Perubahan
Di halaman **Beranda/Ringkasan**, dua panel berikut **tidak ditampilkan lagi**:
- **“Panduan mulai 4/7”** (checklist onboarding)
- **“Perlu perhatian”** (daftar saran/peringatan)

Caranya: `static/app.js` — dua variabel tata letak (`guide` dan `attention`) diisi string kosong
(alih-alih dirender). Tidak ada logika/penghitungan yang dihapus, jadi mudah dikembalikan.

Yang **tetap ada**: tombol **Bantuan** di kepala halaman, tombol **Semua laporan**, kartu statistik
(penjualan, laba kotor, item terjual, bulan ini, 7 hari), grafik 30 hari, jam ramai, cara bayar,
jenis pesanan, kategori/menu terlaris, dan **Operasional saat ini**.

## 36. Catatan penting saat merge berikutnya
Panel ini ada di kode cabang PR. Setiap kali menggabungkan versi baru dari cabang PR, tambalan ini
harus **dipasang ulang** (dua baris di `static/app.js`):
`const guide = '';` dan `const attention = '';`.


---

# Ronde 10 — 23 Oktober 2026: bisa dipasang di HP (PWA)

## 37. Yang ditambahkan
- **`static/manifest.webmanifest`**: nama “Kopi Sawah — Kasir”, `display: standalone`, `start_url /?sumber=pasang`,
  `theme_color #363a10`, `background_color #12150c`, 3 ikon (192 any, 512 any, 512 maskable) + 2 pintasan
  (Kasir, Pesanan Meja).
- **Ikon** dibuat dari logo toko: `icon-192.png`, `icon-512.png`, `icon-512-maskable.png` (latar tema,
  aman untuk ikon bulat), `apple-touch-icon.png` 180×180 untuk iOS.
- **`static/index.html`**: tautan manifest, apple-touch-icon, meta `apple-mobile-web-app-*`,
  dan tombol mengambang **“⬇ Pasang aplikasi”** (memakai `beforeinstallprompt`; di iPhone tombol berubah
  jadi petunjuk “Bagikan → Tambahkan ke Layar Utama”).
- **`app.py`**: rute `/manifest.webmanifest` (dan `/manifest.json`) dilayani dari akar dengan tipe
  `application/manifest+json`; sebelum ini jalur non-`/static/` ditolak 404.
- **`static/sw.js`**: cache shell ditambah manifest + ketiga ikon, supaya tampilan tetap bisa dibuka offline.

## 38. Hasil uji (langsung di situs publik)
- `/manifest.webmanifest` → **200 `application/manifest+json`** 1.383 B; manifest terbaca:
  `name “Kopi Sawah — Kasir”`, `display standalone`, `start_url /?sumber=pasang`.
- Ikon 192 / 512 / 512-maskable → **200 image/png**, ukuran sesuai.
- Service worker **terdaftar** (1 registrasi), situs **HTTPS** → syarat pemasangan Chrome terpenuhi.
- Halaman utama 200 dengan `<link rel=manifest>` dan meta iOS.

## 39. Catatan
- Aplikasi yang sudah dipasang membuka layar penuh (tanpa address bar) dan tetap memakai data server.
- Kalau logo toko diganti, ikon sebaiknya dibuat ulang — ikon disimpan sebagai berkas statis.
- **Insiden singkat:** saat menambal `index.html`, berkas sempat kosong ±2 menit karena skrip saya menulis
  langsung (truncate) sebelum gagal. Dipulihkan dari git (`git checkout -- static/index.html`), lalu
  seluruh penulisan berikutnya memakai pola tulis-berkas-sementara + `os.replace`.

# Ronde 11 — 23 Oktober 2026: biaya kemasan otomatis + ukuran tulisan papan dapur

## 40. Masukan kasir yang dikerjakan
1. **Biaya kemasan Rp1.000 untuk pesanan dibawa pulang** — kasir tidak perlu mengetik apa pun.
2. **Tulisan papan dapur & tiket dapur bisa diperbesar** (dan bisa diatur pemilik).

## 41. Biaya kemasan (packing)
- Pengaturan baru di **Kelola → Pengaturan → Biaya kemasan (bawa pulang)**:
  - `packing_fee` — nominal, bawaan **1000** (isi 0 = tidak dipakai).
  - `packing_fee_per` — **per pesanan** (bawaan) atau **per gelas / item**.
- Perilaku:
  - Muncul **otomatis** saat kasir memilih jenis pesanan **Bawa pulang**; hilang lagi bila kembali ke
    **Makan di sini**. Tidak ada kolom tambahan yang harus diisi kasir (sesuai aturan “isian seminimal mungkin”).
  - Perhitungan di server: `packing_amount()` → hanya untuk `take_away`; pesanan QR meja selalu `dine_in`
    sehingga tidak kena biaya kemasan.
  - Urutan hitung: **subtotal + kemasan − diskon → biaya layanan → pajak → pembulatan**.
  - Tersimpan di kolom baru `sales.packing_fee` (migrasi otomatis `ensure_column`).
- Tampil di: ringkasan pembayaran kasir (“Biaya kemasan Rp1.000”), struk (baris `Kemasan`),
  laporan rentang (kunci `packing`, ikut `net_sales`), dan periode beranda (`packing`).
- Validasi server: nominal 0–100.000 bulat; satuan hanya `order`/`item`; skala dapur hanya 1 / 1.25 / 1.5 / 1.75.

## 42. Ukuran tulisan papan dapur
- Pengaturan baru `kds_scale` di **Kelola → Pengaturan → Papan dapur & tiket**:
  **Normal (1)**, **Besar (1.25, bawaan)**, **Lebih besar (1.5)**, **Sangat besar (1.75)**.
- Diterapkan oleh `kdsScale()` pada:
  - kartu papan dapur: nama meja 22 px → **28 px**, item 20 px → **25 px** (saat skala 1.25);
  - tiket dapur yang dicetak: nomor 22 → 28 px, jenis/item 16 → 20 px, pilihan 13 → 16 px.
- Angka lain pada skala berbeda: 1 → 22/20, 1.5 → 33/30, 1.75 → 39/35.

## 43. Berkas yang diubah
- `app.py` (+55 baris): `SETTING_DEFAULTS` (3 kunci baru), `ensure_column sales.packing_fee`,
  `packing_amount()`, `compute_totals(..., packing)`, validasi `PUT /api/settings`,
  `POST /api/sales` (hitung + simpan), agregat laporan (`/api/reports/range`, `period_stats`).
- `static/app.js`: `kdsScale()`, `calcTotals(..., packing)`, `sumRows`, `packFee()` di `checkoutSheet()`,
  baris `Kemasan` di `receiptHTML()`, skala di `orderCard()` & `ticketHTML()`, 2 kartu pengaturan,
  `SET_GROUPS` + peta `saveBox` (`pack` → `e4`, `dapur` → `e5`), baris kemasan di Rincian laporan.

## 44. Hasil uji
- **Uji staging port 18794 dengan salinan DB: 20/20 lulus** — bawa pulang +1000, makan di sini 0,
  kirim ulang tidak dobel, per gelas 3×1000, fee 0 = tidak ada biaya, 3 validasi menolak nilai salah,
  laporan `packing=4000` dan `net_sales` konsisten, rute & isi `app.js` benar.
- **Uji di situs publik:** pilih *Bawa pulang* di layar Pembayaran → ringkasan berubah
  `Subtotal Rp10.000 | Biaya kemasan Rp1.000 | Total Rp11.000`, tombol jadi **Bayar · Rp11.000**;
  struk memuat baris `Kemasan`; skala 1/1.25/1.5/1.75 menghasilkan 22/20, 28/25, 33/30, 39/35 px.
- Tidak ada transaksi uji yang tersimpan di server produksi (sheet ditutup sebelum bayar).

## 45. Catatan insiden (lagi)
- Pukul ±20:37 UTC sistem berkas **root kembali berstatus read-only** (kejadian kedua setelah 22:35 UTC),
  `errors_count=0`, tanpa pesan `EXT4-fs error`/`Remounting filesystem read-only` di dmesg — penyebabnya
  tidak tercatat. Pemulihan: `mount -o remount,rw /` lalu uji tulis. Berkas aplikasi **tidak rusak**
  (tambalan gagal di tahap tulis dan diulang setelah mount normal). Perlu dipantau: kejadian berulang
  menandakan masalah I/O host, bukan kode aplikasi.

## 46. Pengumuman suara untuk pesanan QR & panggilan meja (25 Oktober 2026)

**Permintaan pemilik:** selain bel, kasir mengumumkan dengan suara manusia, mis.
"Ada pesanan baru dari Meja tujuh". Bel yang lama tetap dipakai. Suara terpilih: **Gemini
(Kore)** — tetapi kuota gratis Gemini TTS hanya **10 permintaan/hari per model** dan sudah
habis saat pengerjaan, jadi untuk sementara dipasang klip suara **Gadis** (edge-tts) yang
sudah lolos uji. Penggantian ke Kore dijadwalkan otomatis (lihat bagian 47).

**Yang berubah**
- `static/audio/` (**baru**) — 14 klip mp3, 48 kbps mono 24 kHz, total **155 KB**:
  `kepala_pesan`, `ekor_panggil`, `ekor_bill`, `tes`, dan `meja_1` … `meja_10`
  ("Meja satu" … "Meja sepuluh"). Semua klip dinormalkan ke **−18 dB** dan diberi
  *highpass* 110 Hz + *kompresor* + penguat kejelasan 3 kHz supaya tidak menonjol saat disambung.
- `static/app.js` — modul pengumuman: `voiceSeq()`, `putarKlip()`, `antreSuara()`,
  `suaraDariServer()`, `hangatkanSuara()`.
  · Bel lama (`beep()`) **tidak diubah**; suara menyusul 420 ms setelah bel.
  · Urutan klip: pesan = `kepala_pesan`+`meja_N`; panggil = `meja_N`+`ekor_panggil`;
    bill = `meja_N`+`ekor_bill`; tes = `tes`.
  · Antrean maksimal **3** pengumuman (yang terlama dilepas), pengumuman sama tidak diulang,
    meja di luar 1–10 hanya berbunyi bel. Klip gagal diunduh → dilewati, bel tetap berbunyi.
  · `soundToggle` memutar klip `tes` saat suara dinyalakan dan menghangatkan cache klip.
- `static/sw.js` — `VER` menjadi `ks-shell-v2`; klip suara masuk `SHELL` (tersedia offline)
  dan dilayani *cache-first* seperti gambar.
- `tests/browser_suara.js` (**baru**) — 9 pemeriksaan.

**Hasil uji**
- `python3 -m unittest discover -s tests` → **21/21 lulus**.
- `node tests/browser_suara.js` → **9/9 lulus** (14 klip HTTP 200; urutan klip pesan/panggil/bill;
  meja 11 tanpa klip; dobel tidak diulang; antrean ≤ 3; suara mati tidak memutar; tanpa galat JS).
- Pemutaran audio di uji diganti tiruan — Chromium tanpa perangkat suara menggantung bila
  memutar audio sungguhan. Berkas klip tetap diambil sungguhan (fetch) pada uji pertama.

**Cara kembali (rollback)**
- `git checkout -- static/app.js static/sw.js` lalu `git clean -fd static/audio tests/browser_suara.js`.
- Tidak ada perubahan database, tidak ada restart layanan (berkas statis dibaca dari disk tiap permintaan).

## 47. Menunggu: penggantian klip ke suara Gemini Kore
- Skrip: `/root/.hermes/scripts/kopi-suara-gemini.sh` + `bundel_sekali.py` (folder kerja
  `/root/.hermes/cache/scratch/kopi-voice/`).
- Cara kerja: **satu** permintaan TTS berisi 14 kalimat → dipotong di jeda senyap → 14 klip.
  Satu permintaan dipilih supaya nada suara antar klip tidak bergeser dan kuota tidak habis.
- Terjadwal sekali: **26 Oktober 2026 08:00 UTC (15:00 WIB)**, hasil dilaporkan ke Telegram pemilik.
  Bila kuota masih habis, skrip berhenti dan **tidak menyentuh klip yang sudah ada**.

## 48. Suara pengumuman diganti ke Grok (xAI) — 25 Oktober 2026

**Alasan:** kuota gratis Gemini TTS habis (10 permintaan/hari/model). Pemilik meminta memakai Grok.
Endpoint `POST https://api.x.ai/v1/tts` (`{"text","voice","language":"id"}`) tersedia lewat OAuth xAI
yang sudah terpasang di mesin ini; token OAuth-nya **kedaluwarsa** dan disegarkan lalu disimpan kembali
ke `/root/.hermes/auth.json` (berlaku ±6 jam, diperbarui otomatis oleh Hermes).

**Suara terpilih:** `ara` (perempuan, hangat). Suara lain tersedia: `eve`, `sal` (perempuan/netral),
`leo` (laki-laki) — ganti dengan `XAI_VOICE=<nama> python3 bundel_sekali.py xai` lalu `RAW_DIR=mentah python3 pasang_klip.py`.

**Cara membuat:** **satu** permintaan TTS berisi 14 kalimat (17,98 detik) → dipotong di jeda senyap
(`bundel_sekali.py xai`, ambang −35 dB berhasil tepat 14 potongan) → normalisasi −18 dB → mp3 48 kbps mono 24 kHz.
Total bundel **105 KB** (sebelumnya 155 KB dengan suara Gadis).

**Hasil uji:** uji API 21/21 lulus; uji layar `tests/browser_suara.js` 9/9 lulus.
Konsistensi nada antar klip: F0 median 198–216 Hz (satu permintaan = satu warna suara).

**Cadangan klip lama:** `/root/backup-kopi-sawah/audio-gadis-20261025/` (14 berkas).
**Tugas Gemini ditunda:** cron `ef82d6e13d21` di-*pause*, tidak akan menimpa suara Grok tanpa izin.

## 49. Siap 50 meja, tombol Aktif per meja, perbandingan suara perempuan (25 Oktober 2026)

**Permintaan pemilik:** (a) perbandingan suara perempuan, (b) rencana 50 meja, (c) tombol **Aktif**
di layar *Meja & QR* — saat diaktifkan meja terbuka untuk pelanggan.

**(a) Perbandingan suara** — berkas `perbandingan-suara-perempuan.mp3` (folder kerja Digi):
Grok `ara` (terpasang), Grok `eve`, Gadis (edge), Gemini `Kore`, Grok `sal` (laki-laki),
Gemini `Leda`. Semua mengucapkan kalimat yang sama.

**(b) 50 meja**
- 54 klip suara: `meja_1` … `meja_50` + 4 kalimat, satu permintaan Grok (`bundel_xai50.py`),
  dipotong di jeda senyap (54/54 tepat), total **450 KB**.
- `app.js`: batas nomor meja **1–50** (di luar itu cukup bel). `sw.js`: 54 klip masuk cache offline.
- Meja di database masih **10**; menambah sampai 50 lewat **Kelola → Meja & QR → + Tambah banyak meja**
  (awalan `Meja`, mulai `11`, jumlah `40`).

**(c) Tombol Aktif / Tutup per meja**
- Setiap baris meja kini punya dua tombol: **▶ Aktifkan** (meja nonaktif) dan **⏸ Tutup** (meja aktif),
  plus tombol **QR**. Ada baris "Meja terbuka: X dari Y".
- Menutup meja memakai konfirmasi dan menyebut jumlah pesanan yang masih berjalan di meja itu.
- Backend **tidak diubah** — `PUT /api/tables/<id>` dan gerbang `active=1` sudah ada; jadi tidak perlu
  restart layanan. Pelanggan yang memindai QR meja tertutup mendapat pesan "QR ini tidak dikenali,
  minta bantuan pelayan" (meski begitu lebih tepat bila nanti dibedakan "meja sedang ditutup" —
  perlu ubah `app.py`, artinya perlu restart; menunggu izin pemilik).

**Hasil uji**
- Uji API: **22/22 lulus** (termasuk `test_22` baru: meja aktif → menu pelanggan 200; ditutup → 404;
  diaktifkan lagi → 200; kasir ditolak 403; jejak audit `ubah_meja` tercatat).
- `tests/browser_meja_aktif.js` (**baru**): **12/12 lulus** (tombol tampil, konfirmasi muncul,
  status server berubah, label & hitungan ikut berubah, menu pelanggan 404 lalu 200).
- `tests/browser_suara.js`: **9/9 lulus** dengan 54 klip.

## 50. 40 meja baru (Meja 11–50) + suara diganti ke Grok `una` (25 Oktober 2026)

**(a) Meja 11–50 dibuat** lewat API aplikasi sendiri (`POST /api/tables {"prefix":"Meja","start":11,"count":40}`),
jadi tercatat di audit (`tambah_meja`, 18:00 WIB, oleh pengguna `Kasir` karena login dimatikan).
- Cadangan DB sebelum perubahan: `/root/backup-kopi-sawah/kopi-sawah-20261025-1100.sqlite3`.
- Hasil: **50 meja**, semuanya aktif, nomor 1–50 **tanpa celah**.
- Diperiksa: QR `Meja 11` dan `Meja 50` → `/m/<token>` **HTTP 200**, `/api/public/menu?t=…` **HTTP 200**.

**(b) Suara diganti ke Grok `una`** — paling dekat dengan Gemini Kore (nada dasar 193 Hz vs Kore 189 Hz).
54 klip dibuat dari satu permintaan + dipotong (54/54), total **475 KB**. `tests/browser_suara.js` **9/9 lulus**.
Klip `ara` disimpan di folder kerja `mentah50_ara/` bila ingin dikembalikan.

**Suara yang tersedia di Grok (diuji satu per satu):** `ara`, `eve`, `sal`, `leo`, `rex`, `una`, `luna`.
Nama lain (`sol`, `nova`, `iria`, `zoe`, `aria`, `mia`, `kai`) **tidak ada** (HTTP 404 "Voice not found").

## 51. Suara Gemini Kore untuk 50 meja + PDF kartu QR (25 Oktober 2026)

**(a) Suara Kore terpasang.** Kuota Gemini ternyata sudah tersedia lebih awal; `bundel_gemini50.py`
berhasil pada percobaan pertama:
- **Satu** permintaan TTS berisi **54 kalimat** (1.040 karakter), audio hasilnya dipotong di jeda
  senyap dengan ambang −35 dB → **54/54 potongan tepat** (tidak perlu mode cadangan dua permintaan).
- Pemeriksaan kewajaran: potongan pertama 1,25 s dan terpanjang 2,29 s — tidak ada instruksi gaya
  yang ikut terbaca.
- Terpasang **54 klip, 545 KB** (diolah sama: −18 dB, mp3 48 kbps mono). Uji layar suara **9/9 lulus**,
  uji API **22/22 lulus**.
- Model `gemini-2.5-flash-preview-tts`, voice `Kore`. Skrip: `bundel_gemini50.py` (folder kerja Digi)
  + `/root/.hermes/scripts/kopi-suara-gemini.sh` (aman: kalau gagal, klip lama tidak disentuh —
  sudah diuji dengan paksa gagal).
- Tugas cron Gemini (`ef82d6e13d21`) **dihapus** karena tujuannya sudah tercapai lebih awal.

**(b) PDF kartu QR 50 meja.** Alat baru `tools/qr_pdf.js` membuka situs produksi, membaca daftar meja
dari `/api/tables`, membuat QR memakai fungsi QR aplikasi sendiri (`qrSVG`), lalu mencetak **A4,
2×3 kartu per halaman, 9 halaman** (50 kartu). Berkas contoh: `kartu-qr-50-meja.pdf` (2,0 MB) —
diperiksa visual: tiap kartu memuat logo, judul, QR utuh, nama meja, petunjuk, dan URL.
Jalankan ulang: `NODE_PATH=/opt/node-tools/node_modules CHROME_PATH=/opt/chromium/chrome-linux64/chrome node tools/qr_pdf.js <keluaran.pdf>`.

## 52. Perbaikan "kata awal terpotong / tidak jelas" pada pengumuman suara (25 Oktober 2026)

**Keluhan pemilik:** saat ada pesanan baru, panggil pelayan, dan minta bill, kata pertama terpotong
dan tidak jelas.

**Penyebab yang ditemukan (bukan dugaan):**
1. **Klip terlalu banyak hening di depan.** Saat memotong audio panjang, batas potong diambil di
   tengah jeda, sehingga tiap klip membawa **0,5–0,8 detik hening** di awal. Pada `kepala_pesan`
   bahkan ada ~0,64 detik desis/nafas level rendah sebelum kata "Ada". Terdengar seperti kata pertama
   hilang, lalu suara muncul tiba-tiba.
2. **Pemutaran per berkas lewat elemen `<audio>`.** MP3 punya *encoder delay* ±25–50 ms dan setiap
   ganti berkas browser menyiapkan ulang pemutar — awal berkas berikutnya bisa terpotong.

**Perbaikan:**
- Potongan ulang berbasis hitungan sampel: awal kata dideteksi pada **puncak ≥6%** (bukan 1,2% yang
  ikut menangkap desis), lalu disisakan **100 ms** sebelum kata dan **120 ms** hening penutup.
  Fade-in 30 ms, fade-out 40 ms. **Kepala_pesan: kata pertama kini mulai 120 ms** (sebelumnya 788 ms);
  klip lain 100–120 ms.
- Encode **80 kbps 44,1 kHz mono** (sebelumnya 48 kbps 24 kHz) — konsonan lebih jelas.
- `static/app.js`: pemutaran tidak lagi memakai `<audio>`, tetapi **Web Audio**
  (`fetch → decodeAudioData → AudioBufferSourceNode`) dengan cache di memori. Sambungan klip jadi
  sampel-akurat, tanpa *encoder delay*, dengan jeda 200 ms antar klip. Klip yang gagal diunduh
  dilewati (bel tetap berbunyi) dan tidak disimpan di cache supaya bisa dicoba lagi.

**Hasil:** 54 klip, **667 KB**; uji API **22/22**, uji layar suara **9/9**.
Berkas contoh sebelum/sesudah ada di folder kerja Digi (`demo-suara-kore-diperbaiki.mp3`).

## 53. Cetak Bluetooth RPP02N dari tablet Android (3 November 2026)

- Menambahkan tombol **Cetak Bluetooth RPP02N** pada struk baru dan nota lama, serta kartu
  **Printer Bluetooth RPP02N** di Kelola → Pengaturan.
- Integrasi memakai Cleanter Android di `http://localhost:9100`: aplikasi memeriksa status printer
  saat kasir menekan tombol (tidak melakukan permintaan otomatis saat halaman dibuka), lalu mengirim
  isi nota ESC/POS ke printer bernama RPP02N. Header CSP hanya menambahkan izin koneksi ke alamat
  loopback itu; tombol **Cetak dialog** tetap tersedia sebagai cadangan.
- Setup tablet: pasangkan RPP02N di Bluetooth Android, pasang Cleanter, pilih RPP02N di Cleanter,
  izinkan akses lokal pada permintaan Chrome bila muncul, lalu gunakan **Cek koneksi RPP02N**.
- Berkas baru: `static/printer-bridge.js`, `tests/test_printer_bridge.js`. Service worker dinaikkan ke
  `ks-shell-v4` agar modul bridge baru ikut cache aplikasi.
- Batas: jalur ini untuk Android + Bluetooth Classic/SPP + ESC/POS; tidak membuktikan BLE, iOS,
  Windows, atau semua printer. Uji unit hanya memakai bridge tiruan; **belum ada uji cetak fisik**.
- Cadangan sebelum ubahan: `/srv/backup-ubah/20261103-142504` (enam berkas yang sudah ada).

## 54. Metode pemesanan: Piutang, Buat Pesanan, Gabungkan Pesanan (4 November 2026)

**Permintaan pemilik:** di layar Pembayaran ditambahkan pilihan metode pemesanan seperti aplikasi kasir lain —
Bayar Langsung, Piutang, Buat Pesanan, Gabungkan Pesanan — diletakkan di bagian bawah layar.
Gabungkan Pesanan dipakai saat pelanggan sudah memesan dan belum membayar, lalu menambah pesanan:
semua pesanan masuk ke satu tagihan dan satu nota.

**Keputusan rancangan:** tagihan yang belum dibayar **tidak** ditulis ke tabel `sales`, tetapi ke tabel baru
`open_bills` + `open_bill_items`. Alasannya: seluruh laporan yang ada menghitung `sales` dengan saringan
`status != 'void'`, sehingga baris "belum dibayar" di `sales` akan langsung menambah omzet. Dengan tabel
terpisah, omzet hanya bertambah saat tagihan dilunasi (satu baris `sales` baru), dan laporan lama tidak diubah.

**Perubahan:**
- Skema: `open_bills` (jenis `pesanan`/`piutang`, status `open`/`paid`/`void`, nomor `TG…`, pemilik kasir/shift,
  request_id unik) dan `open_bill_items` (salinan nama/harga/pilihan saat dipesan).
- Rute baru: `GET /api/bills`, `GET /api/bills/<id>`, `POST /api/bills/<id>/items` (gabung),
  `POST /api/bills/<id>/settle` (lunasi → satu nota), `POST /api/bills/<id>/kind` (tukar pesanan ↔ piutang),
  `POST /api/bills/<id>/void` (pemilik).
- `POST /api/sales` menerima `order_method`: `langsung` (bawaan, perilaku lama), `pesanan`, `piutang`.
  Kunci idempoten `request_id` berlaku untuk tagihan juga.
- Stok dikurangi sekali saat tagihan dibuat/digabung, dikembalikan saat tagihan dibatalkan; pelunasan tidak
  memotong stok dua kali.
- Tampilan: kartu metode di bawah "Cara bayar", tab **Tagihan** (badge jumlah), layar bayar tagihan, cetak tagihan.
  `app.css` menambah `.om-grid/.om`; service worker dinaikkan ke `ks-shell-v5`.
- Laporan: `/api/reports/summary` menambah `open_bills` (jumlah/nilai per jenis). Laporan kas menampilkan
  peringatan bila shift ditutup dengan tagihan terbuka.

**Uji:** `python3 -m unittest discover -s tests -v` → **23/23 lulus** (termasuk `test_23` baru: tagihan tidak
menambah omzet, gabung dua pesanan, satu nota saat lunas, piutang, batal oleh pemilik, kasir ditolak).
Uji layar baru `tests/browser_tagihan.js` → **13/13 lulus**, 0 galat JS (Chromium, DB sementara).
Belum diuji: perangkat kasir sungguhan (Android/tablet), cetak fisik tagihan, dan tagihan yang melewati tutup kasir.

**Cadangan sebelum ubahan:** `/root/backup-kopi-sawah/20261104-2345/kopi-sawah.sqlite3` dan
`/srv/backup-ubah/20261104-2345/kode-sebelum-metode-pemesanan.tar.gz`.
**Cara kembali:** hentikan layanan, pulihkan `app.py` + `static/app.js` + `static/app.css` + `static/sw.js`
dari arsip di atas, lalu `systemctl restart kopi-sawah`. Tabel `open_bills` boleh dibiarkan (tidak dipakai kode lama).

## 55. Login pemilik/kasir aktif + pemilik bisa menghapus transaksi (5 November 2026)

**Permintaan pemilik:** halaman login untuk pemilik dan kasir, siap dipakai uji coba langsung; semua transaksi
lama dihapus; pemilik/admin bisa menghapus transaksi.

**Perubahan:**
- `/etc/systemd/system/kopi-sawah.service`: `KOPI_SAWAH_TANPA_LOGIN=1` → `0`, lalu `daemon-reload` + restart.
  Alur login yang sudah ada di kode kini dipakai: layar **Selamat datang** (buat akun pemilik + PIN sendiri)
  → layar **Masuk** (ketuk nama → PIN). Kasir ditambahkan pemilik lewat Kelola → Tim → Tambah anggota.
- Pesan startup di `main()` kini `flush=True`; sebelumnya KODE PENYIAPAN tertahan buffer sehingga tidak muncul
  di `journalctl` saat mode login dipakai.
- Rute baru `DELETE /api/sales/<id>` (khusus pemilik): hapus permanen, alasan wajib, stok dikembalikan,
  pesanan meja terkait kembali `served`, tagihan yang notanya dihapus kembali `open`, jejak `hapus_transaksi`
  di `audit_log`. Tombol **Hapus permanen** ada di detail nota (hanya pemilik).
- Data uji dikosongkan: **13 nota lunas Rp761.000**, 3 nota batal, 2 tagihan, 9 pesanan QR, 5 shift, dan
  1 akun otomatis "Kasir". Menu (124), meja (50), pengaturan, dan `audit_log` dipertahankan.

**Cadangan sebelum penghapusan:** `/root/backup-kopi-sawah/20261105-0015/` (salinan DB + `ekspor-transaksi.json`),
unit lama `/srv/backup-ubah/20261105-0015/kopi-sawah.service.bak`.
**Cara kembali:** `systemctl stop kopi-sawah`; salin DB cadangan ke `/var/lib/kopi-sawah/kopi-sawah.sqlite3`;
kembalikan unit lama (TANPA_LOGIN=1); `systemctl daemon-reload && systemctl start kopi-sawah`.

**Uji:** API **24/24 lulus** (termasuk `test_24`: kasir 403, alasan wajib, hapus kedua kali 404, omzet berkurang,
audit tercatat, tagihan kembali terbuka). Uji layar **14/14 lulus**, 0 galat JS (termasuk hapus transaksi dari layar).
**Belum diuji:** login pada perangkat kasir sungguhan (HP/tablet) dan PIN yang dibuat pemilik.

## 56. Penyiapan awal tanpa kode penyiapan (5 November 2026)

**Permintaan pemilik:** hilangkan kolom KODE PENYIAPAN pada layar penyiapan.

**Perubahan:**
- Unit systemd: `KOPI_SAWAH_SETUP_TANPA_KODE=1`. `r_auth_setup` melewati pemeriksaan kode bila aktif;
  `/api/auth/status` mengirim `setup_tanpa_kode`; layar penyiapan menyembunyikan kolom kode dan menampilkan
  peringatan bahwa siapa pun yang membuka halaman bisa membuat akun pemilik.
- Log startup mencetak "kode penyiapan DIMATIKAN" alih-alih kode.

**Risiko yang harus disebut:** selama belum ada akun, siapa pun yang membuka situs bisa mendaftarkan diri
sebagai pemilik. Setelah akun pemilik dibuat, pendaftaran ditutup otomatis (409). Bila database pernah
dikosongkan lagi, matikan dulu flag ini (`=0`) atau siapkan akun sebelum situs dibuka.

**Uji:** `SetupTanpaKodeTest` (server terpisah, DB sementara): status melaporkan `setup_tanpa_kode`, setup tanpa
kode → 201, pendaftaran kedua → 409. Total suite **25/25 lulus**.
**Cadangan unit:** `/srv/backup-ubah/20261105-0015/kopi-sawah.service.sebelum-tanpa-kode`.

## 57. Tiket dapur dipisah per stasiun: MAKANAN / MINUMAN / CAMILAN (5 November 2026)

**Permintaan pemilik:** dapur terbagi tiga (makanan, minuman, camilan); tiket dapur harus punya batas jelas
antara ketiga kategori itu.

**Perubahan:**
- `ticketHTML()` di `static/app.js` mengelompokkan item menjadi **MAKANAN**, **MINUMAN**, **CAMILAN**.
  Tiap kelompok diberi judul tebal dengan garis putus-putus di atas dan bawah (`.receipt .station` di `app.css`).
  Kelompok yang tidak berisi item tidak dicetak.
- Pemetaan kategori → stasiun: `Kopi`/`Minuman`/`Wedangan` → MINUMAN; `Camilan` → CAMILAN;
  `Makanan`/`Lauk`/`Paket`/`Sup`/`Sayuran` → MAKANAN; `Add-on` → MINUMAN bila nama memuat kata "es"/"air"
  (mis. Air Es, Es Batu), selain itu MAKANAN (nasi, sambal, telur).
- Service worker dinaikkan ke `ks-shell-v6` agar perangkat memuat ulang berkas tampilan.

**Uji:** uji layar baru `tests/browser_tiket_dapur.js` → **6/6 lulus** (urutan tiga stasiun, Nasi Goreng di MAKANAN,
Air Es di MINUMAN, Bakwan di CAMILAN, tidak dobel, nota minuman saja hanya mencetak satu stasiun).
Seluruh suite API tetap **25/25 lulus**.
**Batas:** tombol **Cetak Bluetooth RPP02N** masih mencetak nota pelanggan, bukan tiket dapur — tiket dapur dicetak
lewat tombol **Tiket dapur** (dialog cetak). Belum diuji pada printer fisik.

## 58. Saran draf keterangan & deskripsi menu + Lauk tanpa nasi (5 November 2026)

**Permintaan pemilik:** setiap kolom isian keterangan di formulir menu diberi saran AI; kategori **Lauk**
adalah lauk saja — semua menunya **tanpa nasi**.

**Perubahan:**
- Tabel baru `product_saran` (saran `short` + `description` per menu, `sumber`, `dibuat_at`), dibuat di
  `init_db` dan diisi oleh `tools/saran-menu.py`.
- Rute baru `GET /api/products/<id>/saran` (khusus pemilik; 403 untuk kasir, 404 untuk menu tak dikenal).
- Formulir menu: di bawah kolom **Keterangan singkat** dan **Deskripsi** muncul kotak `✨ Saran: …` dengan
  tombol **Pakai** yang mengisi kolom (tidak menyimpan otomatis — pemilik tetap memeriksa lalu menyimpan).
- Data: **123 saran** untuk seluruh menu aktif; **102 deskripsi** baru untuk menu yang belum punya;
  **29 deskripsi Lauk diperbaiki** karena menyebut nasi ("plus nasi", "bersama nasi putih", "pilih nasi atau
  frenchfries"). Sekarang 0 deskripsi Lauk yang menyebut nasi. Saran keterangan untuk Lauk: "Tanpa nasi".
- Service worker `ks-shell-v7`.

**Sifat saran:** draf ditulis Digi (AI) dan disimpan di database, bukan panggilan AI saat tombol diklik —
jadi tetap bekerja tanpa internet dan tidak mengirim data menu ke layanan luar. Menu yang ditambahkan
kemudian belum punya draf sampai `tools/saran-menu.py` diisi entri baru.

**Uji:** suite API **26/26 lulus** (termasuk `test_25`: endpoint hanya pemilik, 404 untuk menu tak dikenal).
Uji layar `tests/browser_saran.js` **5/5 lulus**: dua kotak saran muncul, saran Lauk "Tanpa nasi",
deskripsi Lauk tanpa kata nasi, tombol Pakai mengisi kolom. Deskripsi baru juga terbaca di halaman
pelanggan (`/api/public/menu?t=…`).

**Cadangan sebelum ubahan data:** `/root/backup-kopi-sawah/20261105-0045/kopi-sawah.sqlite3`.
**Cara kembali:** salin cadangan itu ke `/var/lib/kopi-sawah/kopi-sawah.sqlite3` lalu restart layanan;
tabel `product_saran` boleh dibiarkan.

## 59. Reservasi meja + pre-order dari rumah, tautan pendek /r (5 November 2026)

**Permintaan pemilik:** terapkan rancangan reservasi meja + pre-order, dan buat tautan pendek khusus reservasi.

**Yang dibangun:**
- Tabel `reservations` + `reservation_items`. Status: `baru`, `ubah`, `disetujui`, `ditolak`, `datang`,
  `selesai`, `batal`. Nomor `RSV-YYMMDD-###`, token acak untuk halaman status pelanggan.
- Halaman publik **/reservasi** (tanpa login): tanggal, jam, jumlah orang, nama, HP, catatan, dan pre-order
  menu (boleh dikosongkan). Jam tersedia mengikuti pengaturan; H-1 dan batas jam diberlakukan di server.
- Tab **Reservasi** di kasir (badge jumlah yang menunggu): Setujui, Tawar jam, Tolak, Tamu datang, Selesai,
  Batalkan, DP, dan Tiket. Menawar jam lain mengubah status jadi `ubah`; pelanggan menerima/menolak dari
  halaman statusnya.
- Tiket dapur reservasi memakai pengelompokan stasiun (MAKANAN/MINUMAN/CAMILAN); tombol Tiket mencetak dan
  menandai `printed_at`. Pengingat cetak masih manual (belum mencetak otomatis).
- Pengaturan (khusus pemilik) lewat tombol **Atur** di tab Reservasi: aktif, jam mulai/akhir, interval, H-,
  batas jam pesan, toleransi, DP, maksimal orang, menit pengingat tiket, info pembayaran.
- Tautan: **/r** (302 ke /reservasi) di domain sendiri. bit.ly tidak dipakai karena perlu akun/token; sebagai
  jalan pintas dibuat tautan pihak ketiga `is.gd/kopisawah` dan `tinyurl.com/kopisawah` yang menunjuk halaman sama.
- Reservasi **tidak** menambah omzet (disimpan di tabel sendiri, bukan `sales`).

**Uji:** suite API **27/27 lulus** (`test_26_reservasi_meja_dan_preorder`: kirim, idempoten, setujui, tawar jam
lalu pelanggan menerima, tolak, datang/selesai, jam tak valid ditolak, omzet tidak berubah). Uji layar
`tests/browser_reservasi.js` **6/6 lulus**: /r membuka halaman, reservasi terkirim, status menunggu, kasir
melihat & menyetujui, pelanggan melihat "Disetujui".

**Batas:** belum ada kuota otomatis, pembayaran online, atau pengingat otomatis; tautan pihak ketiga tidak
bisa diubah/dihapus tanpa akun di layanan itu.

## 60. Reservasi: tersimpan di perangkat, status memperbarui sendiri, tombol WhatsApp (5 November 2026)

**Keluhan pemilik:** pelanggan yang keluar dari tautan lalu membukanya lagi kembali ke formulir kosong; status
baru terlihat setelah di-refresh.

**Perbaikan:**
- Token reservasi disimpan di perangkat (localStorage, 5 terakhir). Membuka `/reservasi` tanpa `?t=` kini
  menampilkan reservasi tersimpan; `?baru=1` memaksa formulir baru (tombol "Buat reservasi baru").
- Halaman status memperbarui sendiri setiap 20 detik selama status masih `baru`, `ubah`, atau `disetujui` —
  pelanggan tidak perlu me-refresh.
- Pengaturan baru `reservasi_wa` (nomor WhatsApp kasir/pemilik, dinormalkan ke 62…). Tombol
  **Kirim ke WhatsApp kasir** di halaman pelanggan (pesan berisi kode, tanggal, jam, jumlah orang) dan tombol
  **WA** di daftar reservasi kasir (pesan siap tulis menyesuaikan status: baru/disetujui/tawar jam/ditolak/datang/batal).
  Keduanya membuka WhatsApp dengan pesan terisi — **bukan** pengiriman otomatis.
- Nomor awal diisi `6285117259677` (nomor reservasi outlet yang sudah dipakai di pengaturan); bisa diubah di
  Reservasi → Atur.
- Service worker `ks-shell-v10`.

**Uji:** API **27/27 lulus** (nomor WA dinormalkan 08→62). Uji layar `tests/browser_reservasi.js` **8/8 lulus**,
termasuk "buka tautan lagi menampilkan reservasi tersimpan" dan tombol WA menunjuk nomor yang benar.

**Batas:** pesan tidak terkirim otomatis; pelanggan/kasir menekan tombol lalu mengirim dari WhatsApp masing-masing.
Pengiriman otomatis butuh layanan WhatsApp API tersendiri (biaya dan risiko nomor) — keputusan pemilik.

## 61. Reservasi tiga langkah: data → pesanan → reservasi (5 November 2026)

**Permintaan pemilik:** halaman pertama reservasi dibuat lebih menarik dan mudah; setelah terisi lanjut ke
halaman ke-2 (pesanan), halaman ke-3 berisi reservasi. Hapus kalimat pengantar. Tanggal mulai hari ini.
Jam terisi otomatis 11:00, atau +1 jam dari jam sekarang bila sudah lewat. Jumlah orang tanpa batas
(rapat/hajatan). Kolom lain tetap.

**Perubahan:**
- `reservasi.js` ditulis ulang menjadi wizard tiga langkah dengan penanda **1 Data · 2 Pesanan · 3 Reservasi**.
  Data disimpan di memori antar langkah; tombol "Ubah data"/"Ubah pesanan" untuk kembali.
- Kalimat "Pilih tanggal dan jam datang…" dihapus dari halaman.
- Tanggal: `reservasi_hari_min` bawaan **0** (hari ini boleh). `GET /api/public/reservasi/info` mengirim
  `jam_min_hari_ini` = slot pertama ≥ sekarang+60 menit; bila tidak ada slot tersisa, `tanggal_min` otomatis besok.
  Server menolak jam hari ini yang kurang dari sekarang+60 menit.
- Jumlah orang: `reservasi_max_orang` bawaan **0 = tanpa batas** (batas teknis 1000). Kolom tidak lagi memasang
  `max` bila tanpa batas.
- Langkah 3 menampilkan ringkasan (tanggal, jam, orang, nama, WA, catatan, pesanan, perkiraan total) sebelum kirim.

**Uji:** suite API **27/27 lulus** (uji jam hari ini memakai `jam_min_hari_ini`, tanggal "tawar jam" memakai besok
agar tidak bergantung jam berjalan). Uji layar `tests/browser_reservasi.js` **9/9 lulus** (termasuk langkah 1→2→3
dan ringkasan). Di situs hidup: tanggal awal 2026-11-05 (hari ini), jam awal 11:00, tanpa batas orang, langkah 2
menampilkan 123 menu.

## 62. Teks halaman reservasi dirapikan (5 November 2026)

**Permintaan pemilik:**
- Langkah 1: hapus "Rombongan besar (rapat, hajatan) tulis jumlah sebenarnya." dan catatan DP.
- Langkah 3: hapus catatan DP dan "Kasir akan mengonfirmasi. Kalau jam itu penuh, kasir menawarkan jam lain lewat WhatsApp."
- Halaman status: tambah "Pembayaran bisa di kasir, transfer DP atau QRIS. Konfirmasi pembayaran lewat WhatsApp".

**Perubahan:**
- `static/reservasi.js`: kedua catatan di langkah 1 dan dua catatan di langkah 3 dihapus. Halaman status menampilkan
  info pembayaran dari pengaturan `reservasi_info_bayar` (hanya untuk status baru/ubah/disetujui/datang).
- Teks bawaan `reservasi_info_bayar` diganti menjadi kalimat di atas; bisa diubah di Reservasi → Atur.

**Uji:** uji layar `tests/browser_reservasi.js` **12/12 lulus** (memastikan catatan lama tidak muncul dan info
pembayaran tampil di halaman status); suite API **27/27 lulus**. Di situs hidup: langkah 1 dan 3 bersih dari
catatan lama, `info_bayar` memuat kalimat baru.

## 63. Biaya kemasan hanya makanan + tutup kasir menghitung QRIS/transfer (5 November 2026)

**Permintaan pemilik:** biaya kemasan (bawa pulang) hanya untuk makanan; minuman tidak dikenai. Tutup kasir
harus memperhitungkan uang tunai di laci **dan** penerimaan QRIS/transfer.

**Biaya kemasan:**
- `app.py` memakai `FOOD_CATS = {Makanan, Lauk, Camilan, Paket, Sayuran, Sup}`. Hanya item berkategori itu yang
  dihitung; minuman (Kopi, Minuman, Wedangan) dan Add-on (mis. air es) tidak dikenai.
- `packing_amount()` menerima pasangan (kategori, jumlah); mode "Per pesanan" menagih sekali bila ada makanan,
  mode "Per item makanan" mengalikan hanya jumlah makanan. Pratinjau di layar bayar memakai aturan yang sama.
- Teks pengaturan diperbarui: "Minuman tidak dikenai biaya kemasan", pilihan "Per item makanan".

**Tutup kasir:**
- Kolom baru di `shifts`: `expected_noncash`, `counted_noncash`, `difference_noncash`.
- `POST /api/shifts/close` menerima `counted_noncash` (bila kosong dianggap sama dengan seharusnya).
- Layar Kas: kolom "QRIS/transfer diterima (Rp)" terisi otomatis dari penjualan non-tunai, selisih laci dan
  selisih QRIS ditampilkan terpisah; laporan sementara, struk tutup kasir, dan riwayat kas menampilkan keduanya.

**Uji:** suite API **28/28 lulus** (termasuk `test_08b_kemasan_hanya_makanan` dan tutup kasir dengan non-tunai);
`tests/browser_ronde6.js` lulus termasuk pemeriksaan kolom QRIS/transfer dan selisih laci.
