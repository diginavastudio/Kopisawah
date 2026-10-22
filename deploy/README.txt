KOPI SAWAH — PENYIAPAN AKSES WEB

SASARAN YANG DISETUJUI
• Host web: kopisawah.diginavastudio.com
• Pengelola Hestia: diginavastudio
• Alamat komputer saat pemeriksaan: 167.104.102.165
• Penggunaan awal: pratinjau beta baca-saja; halaman tanpa akun dapat dilihat oleh siapa pun yang mengetahui alamat.

STATUS
Layanan uji non-root aktif. Catatan DNS A menunjuk ke 167.104.102.165. Sertifikat HTTPS telah terbit dan pengalihan HTTP ke HTTPS aktif. Pratinjau tanpa akun sudah tersedia dalam mode baca-saja.

PENGAMAN PRATINJAU
• Halaman dapat dibuka tanpa akun setelah HTTPS aktif, tetapi jalur web hanya menerima GET/HEAD (permintaan melihat halaman); semua metode lain ditolak oleh pengarah web.
• Aplikasi tetap terikat ke 127.0.0.1:8791 dan tidak dapat diakses langsung dari jaringan.
• Gerbang akun individual tetap disimpan sebagai pilihan nanti; belum ada akun yang dibuat.
• API perubahan tetap memerlukan asal permintaan yang cocok. Ini pengaman tambahan, bukan pengganti pembatasan metode baca-saja.
• Berkas nginx-auth-location.conf adalah cadangan gerbang akun lama, bukan konfigurasi yang sedang dipakai pada pratinjau.
• Halaman menyembunyikan aksi simpan pada nama domain pratinjau; pembatasan utama tetap pada Nginx.

BATAS PEMAKAIAN
• Jika gerbang akun individual diaktifkan nanti, semua akun memberi hak yang sama; belum ada pembagian hak pemilik/kasir atau catatan perubahan transaksi per orang.
• Jangan masukkan transaksi/pelanggan nyata sampai pemilik menyetujui penggunaan nyata, cadangan/pemulihan diuji, aturan usaha dan harga katalog ditinjau, serta kebutuhan laporan diselesaikan.
• Jangan membuka port aplikasi 8791 ke jaringan; hanya Nginx yang boleh meneruskan ke alamat lokal.
• HTTPS publik hanya membuka pratinjau baca-saja; jangan hapus pembatas metode atau catat transaksi nyata tanpa persetujuan dan pengaman tambahan.



