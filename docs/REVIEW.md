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
| D1 | ✅ *(Ronde 4)* **Dobel penentuan suhu.** Cappucino, Moccacino, Chocolate masing-masing ada baris *Es* dan *Panas* dengan harga berbeda (mis. Cappucino Es Rp16.000 / Panas Rp20.000), **dan** kategori Kopi/Minuman juga punya pilihan "Suhu". Kasir bisa memilih "Cappucino Es" + Suhu "Panas" → harga & catatan saling bertentangan. Sudah diselesaikan dengan pilihan **khusus per menu**: baris Es/Panas tetap dua menu (harga PDF berbeda) dan tidak lagi punya pilihan Suhu. | Fakta |
| D2 | **Dobel tagih sambal.** Menu "Sambal Bawang/Terasi" (Add-on, Rp4.000) ada, dan varian "Sambal Tambahan" (+Rp4.000) juga ada untuk Makanan/Lauk/Paket/Camilan. Pilih salah satu cara. | Fakta |
| D3 | ✅/⏳ *(Ronde 4)* **Foto tidak cocok.** 15 menu memakai foto generik `snack`; 12 menu minuman memakai foto Es Teh Telang (termasuk Air Mineral & Es Batu); 10 menu nasi/mi memakai foto `paket-ayam`. Akar masalahnya: nama berkas foto **tertukar** (`paket-ayam` ternyata foto nila, dst.). Semua foto dipotong ulang dari PDF Menu Baru; 38 menu kini berfoto yang cocok, 86 menu menampilkan logo sampai Anda mengunggah fotonya (`docs/FOTO-MENU.md`). | Fakta |
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
| 11 | Meja / QR self-order / status pesanan | ◐ | ✅ *(Ronde 4)* QR per meja, pesan dari HP, status menunggu→diproses→siap→disajikan, panggil pelayan/minta bill, bayar gabungan per meja. ❌ layar dapur (KDS) terpisah, pindah/gabung meja, split bill. |
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
| 18 tes API otomatis (`tests/test_api.py`): login/setup, peran, shift, hitungan pajak/diskon/pembulatan, stok gabungan, void, idempoten, laporan, CSV, cadangan, throttle PIN, header, **katalog Menu Baru, harga negatif (tanpa nasi), pilihan khusus & unggah foto, alur QR lengkap (pesan → terima → bayar), batas laju, ganti kode QR** | Lulus | **Tiruan** (DB sementara) |
| Alur layar di Chromium (`tests/browser_check.js`, 30+ pemeriksaan): kasir, bayar, struk, laporan, kas, **buat meja → QR terbaca pemindai independen (zxing-cpp) → pelanggan memesan lewat HP → kasir menerima/bayar meja → pelanggan melihat Selesai**, unggah foto, cetak QR, tampilan HP | Lulus, tanpa galat konsol | **Tiruan** |
| Migrasi database lama (skema v2 dan v3) → kode baru: transaksi lama utuh, ubahan harga pemilik dipertahankan, katalog ditambal; **rollback** (kode lama membuka DB baru): membaca & menjual | Lulus | **Tiruan** (DB dibuat dengan kode lama) |
| Server hidup `kopisawah.diginavastudio.com` | **Belum diuji** | — |
| Printer termal, **printer A4 untuk kartu QR**, HP/tablet fisik, **scan QR dengan kamera HP sungguhan**, jaringan putus-nyambung | **Belum diuji** | — |
| Beban/konkurensi nyata, uji penetrasi | **Belum diuji** | — |

## 5. Cocokkan Menu Baru (PDF) dengan katalog

Sumber: `Menu Baru Kopi Sawah.pdf` (15 halaman). Dibandingkan **manual dengan membaca tiap halaman** (teks PDF berupa kurva, tidak bisa diekstrak otomatis) — keyakinan tinggi untuk harga, sedang untuk teks deskripsi yang kecil.

| Hasil | Detail |
|---|---|
| Harga | Seluruh harga di PDF **cocok** dengan katalog (termasuk Cappucino/Moccacino 16K/20K, Chocolate 15K/17K, Gurame 59K, Paket 25–35K). |
| Entri salah | **“Oriental” Rp1.000 (Add-on)** bukan menu: itu judul halaman sampul bagian Makan. PDF memuat **Air Es 1K**. Diganti nama jadi **Air Es** (ini tafsiran saya; keyakinan tinggi). |
| Tidak ada di daftar harga PDF | **Long Black** (Rp10.000) dan **Ice Americano** (Rp15.000) hanya muncul sebagai keterangan foto. Americano (ICE/HOT) 15K sudah mencakup Ice Americano → kemungkinan dobel. **Tidak saya hapus**; putuskan sendiri. |
| Pilihan yang tadinya hanya teks | Goreng/Godog (Capcay, Paklay), Goreng/Bakar (Sosis, Pisang), Temanggung/Merapi (Kopi Tubruk), Putih/Coklat (Wedang Susu), Nasi/Frenchfries (Chicken Katsu), Teh Panas/Es (4 Paket) → kini pilihan sungguhan yang tercatat di nota dan tiket dapur. |
| **Tanpa nasi −Rp4.000** | PDF hal. 5 mencantumkan “TANPA NASI - 4k” di bawah daftar Udang/Cumi. Saya **menafsirkan** berlaku untuk 8 menu udang & cumi. ⏳ Mohon konfirmasi. Untuk itu tambahan harga kini boleh negatif. |
| “Frenchfresh” | PDF menulis *Frenchfresh*; saya anggap *French fries* (pilihan “Frenchfries”). ⏳ Konfirmasi ejaan/maksudnya. |
| ⭐ Favorit | 8 menu bertanda bintang di PDF (Nasi Goreng Kopi Sawah, Bakmi Goreng/Godog, Kwetiau Goreng, Ayam Goreng/Bakar, Ayam Kampung Goreng/Bakar) → tampil paling atas dengan ⭐. |
| Deskripsi | 50 menu diisi dari teks PDF (sebagian kecil saya rapikan ejaannya). Teks kecil di foto gurame hanya sebagian terbaca; deskripsinya saya tulis ulang sependek mungkin, **mohon dibaca ulang**. |
| Foto | Foto tiap hidangan dipotong dari gambar tersemat di PDF. **Hanya foto yang jelas milik menu itu yang dipasang** (38 menu). Foto berlabel *Ayam Lada Hitam* tidak dipasang ke menu mana pun karena tidak ada menu bernama itu (kemungkinan Chicken Karage/Katsu Saos Lada Hitam). Foto Es Teh Telang & Es Lemon Telang satu gambar yang sama (di PDF keduanya tampil bersama). Resolusi sumber rendah (beberapa potongan hanya ±250–400 px lebar). |
| Pilihan minuman (tebakan saya) | Aturan varian untuk teh/jus/soda (gula, es, ukuran) adalah **tebakan** karena PDF tidak merincinya. Koreksi di Kelola → Menu & Harga → (ketuk menu) → Pilihan tambahan. |
| Sambal ganda (D2) | Masih ada: “Sambal Terasi/Bawang” sebagai menu Add-on (sesuai PDF) **dan** varian “Sambal Tambahan”. Pilih satu. |

## 6. Pesan lewat QR meja — rancangan & batas

**Alur:** pemilik membuat meja → tiap meja punya kode acak (64 bit) di QR `…/m/<kode>` → pelanggan scan, pilih menu (foto, deskripsi, pilihan wajib harus dipilih), kirim → pesanan *menunggu konfirmasi* di tab **Meja** (berbunyi) → kasir **Terima** → *Siap* → *Disajikan* → **Bayar meja** (semua pesanan meja jadi satu transaksi, harga = harga saat dipesan) → pelanggan melihat *Selesai*.

**Keputusan desain (dan alasannya)**
- **Bayar di kasir**, bukan di HP: tidak ada kontrak payment gateway yang saya tahu; tunai tetap terbanyak di kafe. Pembayaran online = langkah berikutnya (butuh keputusan bisnis).
- **Kasir harus menerima** sebelum dapur memproses: QR yang difoto orang luar tidak bisa membuat dapur memasak pesanan palsu tanpa dilihat manusia.
- **Harga selalu dihitung ulang di server**; harga dari klien diabaikan (ada tesnya).
- Polling tiap 5–6 detik (bukan WebSocket): lebih sederhana dan tahan di jaringan kafe; tunda ≤ 6 detik.

**Pengaman:** kode meja acak; maksimal 5 pesanan menunggu per meja; 8 pesanan/10 menit per perangkat dan 15/10 menit per meja; maksimal 20 porsi per menu, 30 baris, Rp3 juta per pesanan; kirim ulang tidak membuat pesanan ganda; pelanggan hanya bisa membatalkan pesanan yang masih menunggu; panggilan pelayan dibatasi 1/menit; pemilik bisa **ganti kode QR** dan menonaktifkan meja; semua isian pelanggan di-escape saat tampil/cetak.

**Risiko yang tersisa (jujur):** (1) orang yang memotret QR bisa mengirim pesanan iseng dari luar kafe — dibatasi, tapi kasir tetap harus memilah; (2) batas laju bergantung pada header `X-Real-IP` dari nginx; (3) pelanggan di jaringan seluler yang buruk mungkin gagal kirim (tampil pesan, bisa coba lagi, tidak ganda); (4) stok dicek saat memesan dan saat membayar, bukan “dikunci” di antaranya; (5) belum ada layar dapur terpisah: kasir/barista memakai tab Meja dan tiket cetak manual.

## 7. Fitur penting berikutnya (hasil review ulang)

Diurutkan menurut dampak ke operasional & uang. “Ada di riset Anda” = butir 1–14 di bagian 3.

| Prioritas | Fitur | Kenapa penting | Perkiraan |
|---|---|---|---|
| **P1 — sebelum QR dipakai ramai** | **Uji lapangan**: scan dengan HP asli, cetak kartu QR, latih kasir 1 jam, jalankan 1 hari paralel dengan cara lama | Semua pengujian sejauh ini di data tiruan | 1 hari |
| P1 | **Cadangan otomatis terjadwal** + uji pemulihan | Sekarang cadangan manual; kehilangan 1 hari transaksi = kerugian nyata | ½ hari |
| P1 | **Foto 86 menu** (daftar prioritas di `docs/FOTO-MENU.md`) | Menu tanpa foto kurang laku di layar pelanggan *(hipotesis, belum terukur)* | operasional |
| P1 | **Mode offline kasir** (antrean lokal + kirim ulang) | Internet kafe sering putus; sekarang kasir berhenti total | 2–3 hari |
| P2 | **Layar dapur/bar (KDS)** + cetak tiket otomatis saat diterima | Sekarang tiket dicetak manual; pesanan bisa terlambat diproses | 2 hari + printer |
| P2 | **QRIS di meja** (statis: tampilkan QRIS toko di halaman status, kasir cek mutasi; dinamis: lewat penyedia pembayaran) | Pelanggan tak perlu antre bayar. Biaya/ketentuan penyedia **tidak terverifikasi** | 1 hari (statis) / ± 1 minggu (dinamis) |
| P2 | **Resep/BOM + stok bahan + otomatis “habis”** | Laba sebenarnya & hilangkan tandai-habis manual (butir 2–4) | 3–5 hari + data resep |
| P2 | **Level pedas** untuk makanan (tidak/sedang/pedas) | Masakan Indonesia; sekarang lewat catatan bebas. Bisa ditambah tanpa kode di Kelola → Pilihan Tambahan | menit |
| P3 | Status meja (kosong/terisi), **pindah & gabung meja**, **split bill** | Umum di kafe ramai; butir 6 | 2 hari |
| P3 | **Reservasi** (PDF mencantumkan nomor reservasi) | Saat ini lewat WhatsApp | 2 hari |
| P3 | **Loyalti/pelanggan** (nomor HP, poin/stamp) | Butuh persetujuan data pribadi pelanggan | 3 hari |
| P3 | Bahasa Inggris di halaman pesan | Bila ada turis | 1 hari |
| P3 | Notifikasi push/WhatsApp ke pemilik (void besar, selisih kas) | Pengawasan jarak jauh | 1–2 hari |
| Lanjutan | Multi-outlet, pesanan online (GoFood/GrabFood) | Butir 13; butuh API mitra | besar |

Rekomendasi: **jangan menambah fitur sebelum P1 selesai** — fitur terbesar yang belum teruji adalah alur QR di lapangan, dan itu hanya bisa dibuktikan dengan pemakaian nyata.
