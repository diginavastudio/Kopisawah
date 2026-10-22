# Kopi Sawah — review & peta pengembangan

Tanggal: 22 Oktober 2026 (WIB). Cakupan: seluruh isi repo (`app.py`, `static/`, `data/catalog.json`, `deploy/`, dokumen).

**Cara membaca:** setiap temuan ditandai *Fakta* (terlihat langsung di kode/data/dokumen), *Interpretasi*
(kesimpulan saya dari fakta), atau *Hipotesis* (belum terbukti). Status: ✅ sudah diperbaiki di perubahan ini,
⏳ butuh keputusan/aksi Anda, ❌ belum dikerjakan.

## 1. Temuan review

### Kritis

| # | Temuan | Jenis | Status |
|---|---|---|---|
| K1 | **Situs terbuka tanpa login dan boleh ubah data.** `PERUBAHAN.md` §7 & `deploy/nginx-writable-location.conf` meneruskan semua metode; repo-nya publik, jadi siapa pun bisa mengubah harga atau mencatat/mengacak transaksi bila tahu alamat. Pemeriksaan `Origin` bukan pengaman (klien non-browser bisa memalsukannya). | Fakta (kode+dokumen) | ✅ login PIN + peran. ⏳ **harus di-deploy** (lihat `deploy/README.md`); sebelum itu server hidup tetap terbuka *(kondisi server hidup tidak saya verifikasi)* |
| K2 | **`python3 app.py` tidak bisa menyimpan apa pun.** Tanpa `KOPI_SAWAH_WRITE_UNTIL`, semua tulis ditolak (403), padahal README menyuruh menjalankannya begitu saja. | Fakta | ✅ mekanisme jendela tulis dihapus |
| K3 | **Kasir belum layak jual:** tak ada kembalian, diskon (ditolak 409), pajak/layanan, tutup kasir, dan cara bayar berupa teks bebas ("Tunai"/"tunai"/"cash" terhitung berbeda di laporan). | Fakta | ✅ |

### Tinggi

| # | Temuan | Status |
|---|---|---|
| T1 | Cek stok per **baris** keranjang, bukan per menu. Dua baris menu sama dengan varian beda (3+3, stok 5) lolos cek lalu gagal dengan galat database mentah. | ✅ digabung per menu; ada tes |
| T2 | Pemeriksaan kunci idempoten dilakukan **sebelum** transaksi database → dua permintaan serentak bisa bertabrakan (409 samar). | ✅ dipindah ke dalam transaksi |
| T3 | Galat 500 membocorkan `str(exception)` ke klien. | ✅ pesan umum; rinci hanya di log server |
| T4 | `catalog.json` tak sinkron: Long Black & Ice Americano `price=null` di seed padahal di server hidup sudah Rp10.000/Rp15.000 (diubah manual). Instalasi baru kembali kosong. | ✅ seed diperbarui |
| T5 | Tidak ada pembatalan/koreksi transaksi; salah input = permanen dan stok tak kembali. | ✅ void khusus pemilik + alasan + stok kembali |
| T6 | Tidak ada cadangan dari aplikasi (cadangan manual di `/root`). | ✅ tombol unduh cadangan; ⏳ Anda perlu menjadwalkan rutinitasnya |
| T7 | Tidak ada jejak siapa melakukan apa (ubah harga, hitung stok, dll.). | ✅ log aktivitas |
| T8 | Semua berkas (termasuk foto 1,4 MB) dikirim `Cache-Control: no-store` → boros kuota di HP. | ✅ foto di-cache 7 hari, JS/CSS pakai ETag |
| T9 | Aplikasi tak mengirim header keamanan sendiri (CSP, nosniff, frame). Pencarian `LIKE` tak meng-escape `%`/`_`. | ✅ |

### Data & operasional (butuh keputusan Anda — **tidak saya ubah**)

| # | Temuan | Jenis |
|---|---|---|
| D1 | **Dobel penentuan suhu.** Cappucino, Moccacino, Chocolate masing-masing ada baris *Es* dan *Panas* dengan harga berbeda (mis. Cappucino Es Rp16.000 / Panas Rp20.000), **dan** kategori Kopi/Minuman juga punya pilihan "Suhu". Kasir bisa memilih "Cappucino Es" + Suhu "Panas" → harga & catatan saling bertentangan. Saran: satu menu + pilihan Suhu bertambah harga, atau lepas "Suhu" dari kategori itu. | Fakta |
| D2 | **Dobel tagih sambal.** Menu "Sambal Bawang/Terasi" (Add-on, Rp4.000) ada, dan varian "Sambal Tambahan" (+Rp4.000) juga ada untuk Makanan/Lauk/Paket/Camilan. Pilih salah satu cara. | Fakta |
| D3 | **Foto tidak cocok.** 15 menu memakai foto generik `snack`; 12 menu minuman memakai foto Es Teh Telang (termasuk Air Mineral & Es Batu); 10 menu nasi/mi memakai foto `paket-ayam`. Menu & Harga kini punya pemilih foto, tetapi foto yang benar harus Anda sediakan. | Fakta |
| D4 | **HPP kosong di 124 menu** → laba tidak bisa dihitung. Isi bertahap mulai menu terlaris (layar Menu & Harga). | Fakta |
| D5 | **Tidak ada menu yang stoknya terlacak.** Selama begitu, tidak ada pencegah oversell. | Fakta |
| D6 | **Pajak/layanan bawaan 0.** Riset Anda menyebut PB1 restoran umumnya 10%; **tarif & kewajiban untuk Klaten tidak saya verifikasi** — cek ke konsultan pajak/Bapenda sebelum diaktifkan. | Tidak terverifikasi |
| D7 | Repo **publik** berisi alamat server, path, dan nama pengguna sistem di `deploy/`. Bukan rahasia kredensial, tetapi memudahkan penyerang. Pertimbangkan repo privat. | Fakta → keputusan Anda |

### Keterbatasan yang diketahui (tidak dikerjakan)
- Satu laci/satu outlet. Tidak ada 2FA/pemulihan PIN (lupa PIN pemilik terakhir = reset lewat database oleh pengelola sistem).
- Pembayaran non-tunai **dicatat, tidak divalidasi** ke bank/QRIS. Kasir harus memastikan uang masuk.
- Laba kotor memakai HPP **manual per menu**, bukan resep bahan; tambahan varian (mis. Oat Milk) belum punya HPP.
- `ThreadingHTTPServer` + SQLite cukup untuk satu kafe; bukan untuk beban besar.

## 2. Tampilan — apa yang berubah dan kenapa

| Sebelum | Sesudah | Alasan |
|---|---|---|
| Tema gelap emas, 7 tab teknis ("Varian", "Riwayat") | Latar krem terang, header zaitun dari logo; tab: Beranda, Kasir, Pesanan, Laporan, Kelola, Kas (kasir hanya 3) | Kontras lebih baik di kafe terang; bahasa sehari-hari |
| Metode bayar diketik bebas | 5 tombol besar + uang diterima + kembalian + "Uang pas" | Hilangkan salah ketik, percepat |
| `prompt()` / `confirm()` browser | Lembar isian/konfirmasi satu gaya | Konsisten, aman di HP |
| Pilihan varian kecil di panel | Lembar besar, pilihan standar terpilih, qty di situ | Satu ketukan untuk kasus umum |
| Pesanan tetap di samping (juga di HP) | Di HP: bar bawah "Lihat pesanan" | Layar sempit |
| Tombol-tombol kecil (±26px) | Target sentuh ≥ 40–56 px, font 16px | Pengguna awam, jari basah |
| Layar Stok = tabel 124 baris dengan input | Daftar + lembar "hitung stok" per menu | Tidak salah isi baris |

Pengujian tampilan: Chromium headless (emulasi viewport 1280×800 dan 390×844). **Belum diuji di HP/tablet asli** dan belum dengan printer termal sungguhan.

## 3. Peta pengembangan vs patokan "wajib kasir kopi"

Daftar patokan berasal dari riset Anda terhadap 11 situs vendor (sebagian materi pemasaran).
**Saya tidak membuka ulang sumber-sumber itu**; saya memakainya apa adanya sebagai daftar kebutuhan.
Catatan Anda sendiri benar: butir yang berulang di banyak vendor lebih layak dianggap standar pasar
daripada klaim satu vendor.

| # | Patokan | Status sekarang | Catatan / langkah berikut |
|---|---|---|---|
| 1 | Modifier berbayar (ukuran, suhu, gula, es, susu, shot, sirup, topping) | ✅ ada | Rapikan data (D1, D2). Tambah "sirup/topping" lewat Kelola → Pilihan Tambahan (tanpa kode). |
| 2 | Resep / BOM (potong bahan per gelas) | ❌ | **Prioritas tinggi berikutnya.** Dasar HPP akurat & stok bahan. Perlu tabel bahan, resep per menu, aturan modifier (Oat Milk menggantikan susu UHT). Pekerjaan besar: ± beberapa hari, dan Anda perlu menyiapkan data resep. |
| 3 | Stok bahan + ambang + stocktake + waste | ◐ | Ada: stok **per menu**, ambang, hitung fisik. Belum: stok per bahan, pencatatan waste. Bergantung #2. |
| 4 | HPP & margin per menu | ◐ | Ada: HPP manual per menu, margin di Menu & Harga dan laporan, dengan label cakupan HPP. Belum: HPP dari resep. |
| 5 | Pajak, service, pembulatan, diskon/voucher | ◐ | Ada semua kecuali **voucher berkode**. Bawaan 0 (lihat D6). |
| 6 | Pembayaran nyata (tunai, QRIS, kartu, e-wallet, split bill) | ◐ | Tunai + kembalian ✅. Non-tunai hanya **dicatat**. Split bill ❌. QRIS dinamis/otomatis butuh penyedia (kontrak, biaya) → keputusan bisnis. |
| 7 | Kasir bershift (kas awal, tutup kasir, selisih) | ✅ | Versi sederhana (satu laci, X/Z digabung). |
| 8 | Akun + peran + PIN + jejak | ✅ | Peran: Pemilik/Kasir. Belum: peran Barista, PIN-override pemilik untuk diskon/void di tempat. |
| 9 | Loyalti (poin, stamp, tier) | ❌ | Perlu data pelanggan (nomor HP) → pertimbangkan aturan privasi data pribadi. |
| 10 | Cetak struk thermal + tiket barista | ◐ | Via cetak browser 58/80 mm ✅. Belum cetak langsung ESC/POS/Bluetooth; **belum dicoba dengan printer asli**. |
| 11 | Meja / QR self-order / status pesanan | ◐ | Jenis pesanan + nomor meja ✅. QR self-order, status diproses→siap, layar dapur (KDS) ❌. |
| 12 | Laporan per jam, terlaris, laba-rugi, per metode bayar | ◐ | Semua ✅ kecuali **laba-rugi penuh** (butuh biaya operasional: sewa, gaji, dll.). Ada ekspor CSV untuk akuntan. |
| 13 | Multi-outlet & pesanan online (GoFood/GrabFood) | ❌ | Satu outlet. Integrasi online butuh akses API mitra; kemungkinan input manual dulu. |
| 14 | Mode offline | ◐ | Keranjang bertahan saat halaman dimuat ulang; kunci idempoten mencegah dobel saat ulang kirim. **Belum** bisa menjual saat internet putus (butuh service worker + antrean lokal). |

**Urutan yang saya sarankan** (alasan: dampak ke profit & risiko operasional):
1. Deploy + penyiapan akun + latih kasir (tanpa ini semua fitur lain tak berguna).
2. Rapikan data D1–D5 (cepat, besar dampaknya ke kebenaran laporan).
3. Mode offline (#14) — internet kafe sering putus; tanpa ini kasir berhenti.
4. Resep/BOM (#2, #3, #4) — dasar laba yang sebenarnya.
5. Status pesanan/KDS (#11) bila ada barista terpisah; lalu split bill & voucher; loyalti & multi-outlet terakhir.

## 4. Yang sudah dan belum diuji

| Pengujian | Hasil | Jenis data |
|---|---|---|
| 11 tes API otomatis (`tests/test_api.py`): login/setup, peran, shift, hitungan pajak/diskon/pembulatan, stok gabungan, void, idempoten, laporan, CSV, cadangan, throttle PIN, header | Lulus | **Tiruan** (DB sementara) |
| Alur layar di Chromium (`tests/browser_check.js`): setup → buka kasir → jual dengan varian → bayar tunai → struk → laporan → kas → tampilan HP | Lulus, tanpa galat konsol | **Tiruan** |
| Migrasi database lama (skema sebelum perubahan) → kode baru: transaksi lama tetap muncul di laporan | Lulus | **Tiruan** (DB dibuat dengan kode lama) |
| Server hidup `kopisawah.diginavastudio.com` | **Belum diuji** | — |
| Printer termal, HP/tablet fisik, jaringan putus-nyambung | **Belum diuji** | — |
| Beban/konkurensi nyata, uji penetrasi | **Belum diuji** | — |
