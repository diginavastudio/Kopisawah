# Kopi Sawah — Kasir & Katalog

Aplikasi kasir web untuk **Kopi Sawah Klaten**. Satu proses Python (`http.server`) + SQLite, **tanpa
dependensi pihak ketiga**, diproksikan nginx (HTTPS). Tampilan terang, tombol besar, Bahasa Indonesia,
dibuat untuk pengguna awam (HP, tablet, atau laptop).

> **Status: siap uji coba terbatas, belum "terbukti di lapangan".** Semua pengujian sejauh ini memakai
> data tiruan di database sementara. Lihat [`docs/REVIEW.md`](docs/REVIEW.md) untuk apa yang sudah
> dan belum teruji, serta daftar kekurangan yang diketahui.

## Fitur

| Area | Isi |
|---|---|
| **Akun & peran** | Pemilik & Kasir, masuk dengan PIN (di-hash PBKDF2), batas percobaan salah, sesi 12 jam, riwayat aktivitas |
| **Pesan lewat QR meja** | Tiap meja punya QR. Pelanggan scan → pilih menu (foto, deskripsi, pilihan) → kirim; kasir menerima (berbunyi), menandai siap/disajikan, lalu menerima bayar sekali untuk seluruh pesanan meja. Ada tombol *Panggil pelayan* / *Minta bill* |
| **Kasir** | Cari/filter menu, varian berbayar (ukuran, gula, es, susu, extra shot, sambal), keranjang yang bertahan saat halaman dimuat ulang, jenis pesanan (makan di sini/bawa pulang), nomor meja, catatan |
| **Pembayaran** | Tunai (uang diterima + kembalian + tombol uang pas), QRIS, kartu, e-wallet, transfer *(non-tunai hanya dicatat, belum terintegrasi payment gateway)* |
| **Harga** | Diskon (% atau Rp, wajib alasan, batas untuk kasir diatur pemilik), biaya layanan, pajak, pembulatan — semua bawaan **0** |
| **Kas bershift** | Buka kasir (uang awal) → tutup kasir (hitung uang, selisih, laporan tutup kasir yang bisa dicetak) |
| **Struk & tiket** | Struk 58/80 mm dan tiket dapur lewat cetak browser |
| **Pembatalan** | Pemilik dapat membatalkan transaksi (alasan wajib), stok dikembalikan |
| **Stok** | Hitungan fisik per menu, otomatis berkurang & tidak boleh minus, tanda "habis" cepat dari kasir |
| **Laporan** | Penjualan bersih, per cara bayar, jam ramai, per hari, menu terlaris, laba kotor perkiraan (dari HPP), unduh CSV |
| **Menu** | 124 menu sesuai *Menu Baru* (PDF): foto hasil potongan dari PDF, deskripsi, ⭐ favorit, pilihan khusus per menu (mis. *Tanpa nasi −Rp4.000*), unggah foto sendiri dari HP |
| **Offline** | Kasir tetap bisa dibuka & menjual saat internet putus; penjualan terkirim otomatis saat tersambung (pesanan QR butuh internet) |
| **Dapur & meja** | Papan dapur, pindah/gabung meja, bayar sebagian per pesanan, QRIS toko (statis) di HP pelanggan, level pedas |
| **Data** | Cadangan otomatis harian + unduh manual `.zip` (database + foto) dari Pengaturan |

## Menjalankan lokal

```bash
python3 app.py                     # http://127.0.0.1:8791
```

Saat pertama dijalankan, terminal menampilkan **KODE PENYIAPAN** (8 angka). Buka alamat di atas →
isi nama, PIN pemilik (6–8 angka), dan kode itu → akun pemilik dibuat. Setelah itu pemilik menambah
kasir di **Kelola → Tim**.

Uji otomatis (memakai database sementara):

```bash
python3 -m unittest discover -s tests -v                          # API (20 tes)
NODE_PATH=/opt/node-tools/node_modules node tests/browser_check.js    # alur layar di Chromium
NODE_PATH=/opt/node-tools/node_modules node tests/browser_ronde5.js    # offline, papan dapur, QRIS, foto
NODE_PATH=/opt/node-tools/node_modules node tests/viewport_audit.js    # "pas layar": 12 ukuran layar
```

### Variabel lingkungan

| Variabel | Arti |
|---|---|
| `KOPI_SAWAH_PORT` | port (bawaan `8791`) |
| `KOPI_SAWAH_DB` | lokasi berkas SQLite |
| `KOPI_SAWAH_TZ` | zona waktu laporan (bawaan `Asia/Jakarta`) |
| `KOPI_SAWAH_SETUP_CODE` | kode penyiapan tetap (bawaan: acak tiap start, dicetak ke log) |
| `KOPI_SAWAH_REQUIRE_ORIGIN` | `1` = permintaan tulis wajib membawa `Origin` yang sama dengan host (dipakai di server) |
| `KOPI_SAWAH_REQUIRE_STOCK` | `1` = menu yang stoknya belum dihitung tidak bisa dijual |

`KOPI_SAWAH_WRITE_UNTIL` (jendela tulis) **sudah dihapus**; nilainya diabaikan.

## Struktur

```
app.py                  server + API + migrasi skema
static/index.html       kerangka halaman
static/app.css          tampilan
static/app.js           antarmuka kasir/pemilik (tanpa pustaka luar)
static/order.html|.js|.css   halaman pesan pelanggan (/m/<kode meja>)
static/sw.js            service worker (aplikasi kasir tetap terbuka saat offline)
static/vendor/qrcode.js pembuat QR (qrcode-generator 2.0.4, MIT)
static/images/          foto menu & logo
data/catalog.json       katalog awal (124 menu)
tests/                  uji API dan uji layar
deploy/                 nginx, systemd, panduan pasang (deploy/README.md)
tools/crop_menu_photos.py   memotong foto menu dari PDF (alat pengembang)
docs/REVIEW.md          review, temuan, dan peta pengembangan
docs/PERUBAHAN.md       catatan perubahan & rollback
```

## Keamanan (ringkas)

- Semua `/api/*` selain `health` & login butuh sesi; yang sensitif (harga, stok, laporan, tim, cadangan, batal) hanya pemilik.
- Cookie sesi `HttpOnly; SameSite=Strict` (+`Secure` di HTTPS), CSP ketat, tanpa skrip/handler inline.
- Proses hanya mendengar di `127.0.0.1`; hanya nginx yang boleh meneruskan.
- Repo ini **publik**: jangan simpan sandi, berkas database, atau cadangan di sini (`.gitignore` sudah mengecualikan `*.sqlite3`).
- Halaman pelanggan (`/m/<kode>`) dan API `/api/public/*` memang **tanpa login**: hanya menu, pesan, batal-saat-menunggu, dan panggil pelayan. Pelanggan tidak bisa melihat stok/HPP/transaksi; pesanan baru berstatus *menunggu konfirmasi* sampai kasir menerima; ada batas laju per perangkat dan per meja; kode QR bisa diganti pemilik.
- Batasan: belum ada 2FA, PIN pemulihan, atau pembatasan per perangkat. Lihat `docs/REVIEW.md`.
