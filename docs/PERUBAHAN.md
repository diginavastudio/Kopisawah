

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
