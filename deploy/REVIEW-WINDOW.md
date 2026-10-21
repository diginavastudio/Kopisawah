# STATUS AKSES — 23 Oktober 2026

Tulis dibuka (permintaan pemilik): pengarah web meneruskan semua metode, `KOPI_SAWAH_WRITE_UNTIL`
diset 2099-12-31, dan `kopi-sawah-review-lock.timer` dimatikan. Tidak ada login, jadi siapa pun yang
tahu alamat dapat mengubah data — hanya untuk uji coba. Untuk mengunci lagi secara manual:
`systemctl start kopi-sawah-review-lock.service` (memakai `index-review-readonly.html` + konfigurasi
nginx baca-saja). Belum ada batas waktu otomatis.

---

# Kopi Sawah — catatan jendela uji tim

## Batas waktu

Pemilik menyetujui uji tanpa login selama 7 hari. Waktu mulai/akhir yang berlaku harus tercatat dalam `KOPI_SAWAH_WRITE_UNTIL` pada `kopi-sawah.service` dan `OnCalendar` pada `kopi-sawah-review-lock.timer` (waktu UTC). Jangan membuka tulis sebelum kedua batas cocok dan timer aktif.

Pada akhir waktu tersebut, aplikasi menolak semua `POST`/`PUT` (tambah menu, hitung stok, transaksi, ubah menu) dan timer mengembalikan halaman serta pengarah web ke mode baca-saja. Pembacaan tetap tersedia. Jika pemilik meminta penutupan lebih awal, jalankan `systemctl start kopi-sawah-review-lock.service`.

## Data

Basis data uji tersimpan di `/var/lib/kopi-sawah/kopi-sawah.sqlite3`; data tetap tersimpan setelah layanan dimulai ulang dan tidak dihapus otomatis ketika jendela berakhir. Cadangan awal sebelum uji ada di `/var/backups/kopi-sawah/review-window-20261021T221239Z/`, termasuk salinan SQLite dengan izin `0600` dalam folder `0700`.

Tidak ada tombol hapus transaksi per baris pada beta ini. Perubahan menu dapat dikoreksi melalui layar; bila seluruh data uji perlu dibersihkan, pemilik harus meminta reset terpisah. Buat cadangan terbaru sebelum reset; pemulihan ke cadangan awal akan membuang semua perubahan setelah waktu cadangan.

## Batas akses dan penggunaan

Domain menggunakan HTTPS, tetapi selama jendela ini tidak memakai login. Domain dapat dijangkau dari internet; siapa pun yang mengetahui alamatnya dapat mencoba mengirim perubahan. Pemeriksaan asal permintaan bukan login dan tidak mencegah pengirim teknis membuat permintaan langsung.

Gunakan hanya data dummy. Jangan masukkan data pelanggan, transaksi, atau pembayaran nyata. Jendela 7 hari berakhir menjadi baca-saja; login tidak dipasang otomatis.
