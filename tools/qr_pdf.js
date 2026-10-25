/* Buat PDF kartu QR untuk SEMUA meja aktif di situs produksi (dibaca dari API, bukan dikarang).
 * Jalankan: NODE_PATH=/opt/node-tools/node_modules CHROME_PATH=/opt/chromium/chrome-linux64/chrome node tools/qr_pdf.js [keluaran.pdf]
 */
const { chromium } = require('playwright');
const path = require('node:path');

const BASE = process.env.KS_BASE || 'https://kopisawah.diginavastudio.com';
const KELUAR = process.argv[2] || '/root/.hermes/cache/scratch/kartu-qr-50-meja.pdf';
const CHROME = process.env.CHROME_PATH || undefined;

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const page = await browser.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof qrcode === 'function' && typeof state !== 'undefined', null, { timeout: 30000 });

    // Ambil meja + setelan dari API aplikasi, lalu bangun kartu memakai fungsi QR aplikasi sendiri.
    const data = await page.evaluate(async () => {
      const [t, st] = await Promise.all([fetch('/api/tables').then(r => r.json()), fetch('/api/settings').then(r => r.json())]);
      state.settings = st.settings;
      const aktif = t.items.filter(x => x.active);
      const kartu = aktif.map(x => ({
        label: x.label, url: tableURL(x), svg: qrSVG(tableURL(x)),
      }));
      return { base: publicBase(), kartu };
    });

    const html = `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>Kartu QR Meja</title>
<style>
  @page { size: A4; margin: 10mm; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; color: #1d2a20; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8mm; }
  .card { border: 1.5px dashed #9aa89b; border-radius: 6mm; padding: 5mm 4mm; text-align: center; break-inside: avoid; }
  .card img.logo { width: 16mm; height: 16mm; object-fit: contain; }
  .card h3 { margin: 1mm 0 2mm; font-size: 11pt; letter-spacing: .3px; }
  .qr svg { width: 52mm; height: 52mm; }
  .label { font-size: 17pt; font-weight: 800; margin: 1mm 0; }
  .card p { font-size: 8.5pt; margin: 1mm 0; line-height: 1.35; }
  .url { font-size: 6.5pt; color: #5a6b5c; word-break: break-all; }
</style></head><body>
<div class="grid">${data.kartu.map(k => `<div class="card">
  <img class="logo" src="${BASE}/static/images/logo-badge.png" alt="">
  <h3>Pesan dari meja</h3>
  <div class="qr">${k.svg}</div>
  <div class="label">${k.label}</div>
  <p>Scan QR dengan kamera HP,<br>pilih menu, lalu kirim pesanan.<br><b>Bayar di kasir.</b></p>
  <div class="url">${k.url}</div>
</div>`).join('')}</div>
</body></html>`;

    const cetak = await browser.newPage();
    await cetak.setContent(html, { waitUntil: 'load' });
    await cetak.pdf({ path: KELUAR, format: 'A4', printBackground: true, margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' } });
    console.log(JSON.stringify({ dasar: data.base, jumlah_meja: data.kartu.length, contoh_url: data.kartu[0].url, berkas: KELUAR }));
  } finally {
    await browser.close();
  }
})();
