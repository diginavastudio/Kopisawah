# Memasang / memperbarui di server

Server memakai Hestia + nginx; aplikasi jalan sebagai layanan systemd `kopi-sawah` di `127.0.0.1:8791`.

## Berkas

| Berkas | Fungsi |
|---|---|
| `kopi-sawah.service` | unit systemd (berjalan sebagai pengguna `kopi-sawah`, hardening aktif) |
| `kopi-sawah.tpl` / `.stpl` | templat vhost Hestia (HTTP / HTTPS) |
| `nginx-writable-location.conf` | **dipakai**: teruskan semua metode ke aplikasi (keamanan ada di aplikasi) |
| `nginx-preview-location.conf` + `lock-review-readonly.sh` | **darurat**: kunci situs baca-saja di nginx (login ikut terblokir) |
| `nginx-auth-location.conf`, `manage-team-access.sh` | opsional: lapisan sandi nginx (Basic Auth) di depan aplikasi |

## Memperbarui kode (langkah berurutan)

1. **Cadangkan database dulu.** Di server:
   `cp /var/lib/kopi-sawah/kopi-sawah.sqlite3 /root/backup-kopi-sawah/$(date +%Y%m%d-%H%M)-sebelum-update.sqlite3`
   (atau, kalau sudah ada akun pemilik: Kelola → Pengaturan → *Unduh cadangan data*).
2. Tarik kode: `cd /opt/kopi-sawah && git pull`.
3. Mulai ulang: `systemctl restart kopi-sawah.service`.
   Seharusnya: `systemctl status kopi-sawah --no-pager` menampilkan `active (running)`.
4. Migrasi skema berjalan otomatis saat start. Hanya menambah tabel/kolom (satu pengecualian: tabel `modifiers` dibangun ulang tanpa larangan harga negatif; isinya disalin utuh). **Patch katalog Menu Baru** hanya mengisi deskripsi/favorit yang masih kosong, mengganti foto bawaan lama, mengubah nama “Oriental” → “Air Es”, dan memasang pilihan khusus menu; **harga dan ubahan pemilik tidak ditimpa**.

## Penyiapan pertama setelah update ini (belum ada akun)

1. Lihat kode penyiapan: `journalctl -u kopi-sawah -n 30 --no-pager | grep "KODE PENYIAPAN"`
   Seharusnya muncul baris `PENYIAPAN AWAL: ... KODE PENYIAPAN: 12345678` (angka berbeda).
2. Buka `https://kopisawah.diginavastudio.com` → layar **Selamat datang** → isi nama, PIN 6–8 angka, ulangi PIN, dan kode itu.
   **Lakukan sendiri secepatnya** — siapa pun yang punya kode bisa membuat akun pemilik. Kode berubah tiap layanan dimulai ulang.
3. Masuk → **Kelola → Tim** → tambahkan kasir (PIN 4–8 angka, tiap orang berbeda).
4. **Kelola → Pengaturan**: isi nama toko/alamat/pesan struk; biarkan pajak & layanan 0 sampai sudah diverifikasi.
5. Di **Kelola → Pengaturan** unduh cadangan pertama dan simpan di luar server.

Setelah ada akun pemilik, kode penyiapan tidak berlaku lagi.

## Pesan lewat QR meja (setelah akun pemilik ada)

1. **Kelola → Meja & QR → Tambah banyak meja** (mis. awalan “Meja”, mulai 1, jumlah 10).
2. Periksa baris *Alamat yang dipakai di QR*: harus alamat publik toko (`https://kopisawah.diginavastudio.com`). Bila Anda membuka aplikasi lewat alamat lain, isi **Pengaturan → Alamat situs untuk QR meja**.
3. Ketuk satu meja → **Lihat QR** → scan dengan HP Anda sendiri. Seharusnya terbuka halaman menu dengan tulisan “Anda duduk di Meja 1”. Coba pesan satu item, lalu cek tab **Meja** di kasir.
4. **Cetak semua QR** (A4, 4 kartu per lembar) → laminasi → tempel di meja.
5. Pastikan tab **Meja** terbuka di perangkat kasir selama buka toko (pesanan berbunyi; ketuk layar sekali setelah membuka halaman agar suara aktif).

Yang perlu diketahui:
- **Pelanggan tidak login.** Pesanan masuk berstatus *menunggu konfirmasi* dan baru diproses setelah kasir menekan **Terima**. Pembayaran tetap di kasir.
- Batas laju memakai alamat IP dari header `X-Real-IP`. `deploy/nginx-writable-location.conf` sudah mengirimnya — **jangan dihapus**, atau semua pelanggan dianggap satu perangkat.
- Bila foto QR sebuah meja tersebar/disalahgunakan: **Ubah / ganti kode** pada meja itu, lalu cetak ulang.
- Foto menu yang diunggah disimpan di `/var/lib/kopi-sawah/uploads/` (di luar kode) dan ikut dalam cadangan `.zip`.

## Pemeriksaan cepat

```
curl -s http://127.0.0.1:8791/api/health        # {"ok": true, "timezone": ..., "business_date": ...}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8791/api/products   # harus 401 (butuh login)
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:8791/api/public/menu?t=salah'  # harus 404 (kode meja tidak dikenal)
```

## Rollback

Kembalikan kode (`git checkout <commit-sebelumnya>`) dan, bila perlu, database dari cadangan langkah 1:
`systemctl stop kopi-sawah && cp <cadangan>.sqlite3 /var/lib/kopi-sawah/kopi-sawah.sqlite3 && systemctl start kopi-sawah`.
Kode lama bisa membuka database baru (diuji pada data tiruan: membaca produk & penjualan, dan masih bisa menjual), tetapi tidak mengenal meja/pesanan QR, dan pilihan menu mengikuti kategori lagi. Kalau ragu, pulihkan database dari cadangan langkah 1 (transaksi setelah update ikut hilang).
