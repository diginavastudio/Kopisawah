KOPI SAWAH — APLIKASI UJI LOKAL
Status: untuk uji dan pengembangan; belum aman untuk penjualan sungguhan.

MENJALANKAN
1. Ekstrak berkas paket ke satu folder.
2. Pastikan *Python 3* (bahasa pemrograman untuk menjalankan aplikasi) tersedia di komputer.
3. Buka terminal di folder aplikasi, lalu jalankan:
   python3 app.py
4. Buka http://127.0.0.1:8791 di Chrome atau Edge (peramban web).
5. Hentikan dengan Ctrl+C.

Saat pertama dijalankan, aplikasi membuat basis data *SQLite* (penyimpanan lokal dalam satu berkas) dan menyalin 124 entri menu draf dari data/catalog.json. Foto disimpan lokal di static/images.

YANG SUDAH BISA DIUJI
• Melihat dan mencari menu; menambah menu draf; mengisi harga manual.
• Long Black dan Ice Americano tetap tanpa harga sampai diisi. Kasir menolak menu yang harganya kosong.
• Mengisi hitungan stok nyata dan ambang pengingat; stok yang belum diperiksa tetap “Belum diatur”.
• Mencatat transaksi uji dengan metode pembayaran yang ditulis manual. Ini hanya catatan di aplikasi, bukan pembayaran yang diproses bank.
• Jika stok sudah dihitung, penjualan mengurangi stok dan tidak mengizinkan jumlah melebihi stok.
• Melihat riwayat transaksi dan ringkasan laporan.

LOKASI DATA UJI
Basis data dibuat otomatis sebagai data/kopi-sawah-dev.sqlite3. Simpanan ini ada di komputer yang menjalankan aplikasi. Menghapus berkas basis data akan menghapus seluruh data uji. Data awal katalog tetap ada di data/catalog.json.

BATAS KEAMANAN — WAJIB DIBACA
• Mode lokal ini tidak memiliki layar login; aplikasi hanya menerima koneksi dari komputer itu sendiri pada 127.0.0.1. Jangan ubah agar menerima koneksi dari jaringan luar.
• Untuk beta domain, aplikasi berjalan di balik HTTPS tanpa login selama 7 hari sesuai izin pemilik. Domain tetap dapat dijangkau dari internet; siapa pun yang mengetahui alamatnya dapat mencoba mengirim perubahan. Saat batas waktu tercapai, tulis dikunci dan halaman kembali baca-saja. Ini hanya untuk data dummy.
• Jangan gunakan satu akun/sandi bersama atau sandi sederhana. Script deploy/manage-team-access.sh meminta sandi tersembunyi di terminal; jangan kirim sandi lewat chat.
• Versi ini belum memiliki peran pemilik/kasir, jejak perubahan per transaksi, cadangan/pemulihan otomatis, pengelolaan retur, kedaluwarsa, piutang, penutupan kasir, diskon aktif, harga grosir, proses pembayaran nyata, atau zona waktu produksi.
• Jangan masukkan data pelanggan atau transaksi pelanggan sungguhan. Gunakan hanya angka uji dan menu draf.
• Harga katalog belum semuanya diverifikasi; jangan gunakan sebagai harga jual final.
• Pengecualian beta Kopi Sawah: domain dipasang melalui HTTPS untuk uji internal tanpa login selama tujuh hari sesuai izin pemilik; domain tetap dapat dijangkau dari internet. Setelah batas waktu, tulis dikunci otomatis dan mode baca-saja dipulihkan. Jangan gunakan data nyata; login dan pemakaian produksi dibahas terpisah dengan pemilik.

*API* (jalur pertukaran data antartampilan dan penyimpanan) pada beta ini tersedia melalui pengarah web dengan pemeriksaan asal permintaan dan batas waktu tulis. Pemeriksaan asal bukan pengganti login. Basis data uji tersimpan di komputer layanan; tidak ada layanan bank atau aplikasi kasir pihak lain yang dihubungkan.
