# Kopi Sawah — Kasir & Katalog (uji coba)

Aplikasi kasir web untuk **Kopi Sawah Klaten**: katalog menu, kasir dengan varian berbayar,
stok, riwayat, dan laporan harian. Dibangun sebagai satu proses Python (`http.server`) dengan
basis data SQLite, tanpa dependensi pihak ketiga, lalu diproksikan oleh nginx.

> **Status: uji coba internal.** Belum ada login/peran, belum ada pajak, diskon, cetak struk,
> atau tutup kasir. Jangan dipakai untuk transaksi pelanggan nyata sebelum pengaman itu dipasang.

## Fitur

- **Katalog 124 menu** (Makanan, Lauk, Minuman, Kopi, Wedangan, Camilan, Paket, Sayuran, Sup, Add-on)
  beserta harga dan foto.
- **Kasir dengan varian berbayar**: Suhu, Level Gula, Level Es, Ukuran (Large +Rp5.000),
  Extra Shot (+Rp5.000), Jenis Susu (Oat Milk +Rp5.000), Sambal Tambahan (+Rp4.000, maks 2).
  Kelompok varian dipasang **per kategori**, bukan per menu.
- **Pengaman transaksi**: kunci idempoten (`request_id`) sehingga klik ganda tidak membuat
  transaksi ganda; validasi stok untuk menu yang sudah dihitung.
- **Stok berbasis hitungan fisik**: menu yang sudah dihitung otomatis "terlacak" (dipotong saat
  terjual dan tidak boleh melebihi stok); menu lain diberi label "belum dilacak".
- **Laporan harian memakai WIB** (kolom `sales.business_date`), bukan UTC.
- **Manajemen varian** dari layar: tambah/ubah/hapus kelompok dan pilihan, atur per kategori.

## Struktur

```
app.py                     server + API (tanpa dependensi)
static/index.html          antarmuka (satu berkas, tema gelap-emas)
static/images/             foto menu, logo, kartu menu
data/catalog.json          katalog awal (benih 124 menu)
docs/PERUBAHAN.md          catatan perubahan & rollback
deploy/                    konfigurasi nginx, unit systemd, varian halaman, skrip uji
```

## Menjalankan lokal

```bash
python3 app.py                     # http://127.0.0.1:8791
```

Variabel lingkungan:

| Variabel | Arti |
|---|---|
| `KOPI_SAWAH_PORT` | port (bawaan `8791`) |
| `KOPI_SAWAH_DB` | lokasi berkas SQLite |
| `KOPI_SAWAH_TZ` | zona waktu laporan (bawaan `Asia/Jakarta`) |
| `KOPI_SAWAH_WRITE_UNTIL` | batas waktu tulis ISO-8601; kosong/terlewat = semua tulis ditolak |
| `KOPI_SAWAH_REQUIRE_STOCK` | `1` = semua menu wajib punya stok sebelum bisa dijual |
| `KOPI_SAWAH_REQUIRE_ORIGIN` | `1` = permintaan tulis harus berasal dari domain yang sama |

## API singkat

| Metode | Jalur | Guna |
|---|---|---|
| GET | `/api/health` | status, zona waktu, jumlah menu/transaksi |
| GET | `/api/products` | katalog (mendukung `?q=` dan `?category=`) |
| POST | `/api/products` | tambah menu |
| PUT | `/api/products/<id>` | ubah harga/nama/kategori/status lacak stok |
| GET | `/api/modifiers` | kelompok varian + penugasan per kategori |
| POST/PUT/DELETE | `/api/modifiers/groups`, `/api/modifiers/options` | kelola kelompok & pilihan |
| PUT | `/api/modifiers/category/<kategori>` | pasang kelompok ke kategori |
| GET | `/api/stock` · POST `/api/stock/count` | lihat & isi hitungan stok |
| POST | `/api/sales` | simpan pesanan (`items[].modifiers = [{id}]`) |
| GET | `/api/sales` · `/api/reports/summary` | riwayat & ringkasan laporan |

## Keamanan

- Proses hanya mendengar di `127.0.0.1`; hanya nginx yang meneruskan.
- Saat ini pengarah web **meneruskan semua metode** dan tanpa login, jadi **siapa pun yang tahu
  alamat dapat mengubah data**. Untuk mengunci lagi: `systemctl start kopi-sawah-review-lock.service`.
- Jangan menaruh kredensial di repo ini; berkas basis data dikecualikan lewat `.gitignore`.

## Riwayat perubahan

Lihat [`docs/PERUBAHAN.md`](docs/PERUBAHAN.md) — termasuk cara mengembalikan (rollback).
