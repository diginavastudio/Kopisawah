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
