/* Uji layar metode pemesanan (Buat Pesanan / Piutang / Gabungkan Pesanan) di Chromium sungguhan.
 * DB SEMENTARA — tidak menyentuh data toko.
 * Yang diuji: kartu metode muncul di layar Pembayaran, Buat Pesanan membuat tagihan (bukan nota),
 * tagihan tampil di tab Tagihan, pelunasan menghasilkan satu nota, dan tidak ada galat JS.
 * Jalankan: NODE_PATH=/opt/node-tools/node_modules CHROME_PATH=/opt/chromium/chrome-linux64/chrome node tests/browser_tagihan.js
 */
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const free = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const CHROME = process.env.CHROME_PATH || undefined;

(async () => {
  const port = await free(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-tagihan-'));
  const proc = spawn('python3', [path.join(__dirname, '..', 'app.py')], {
    env: { ...process.env, KOPI_SAWAH_PORT: String(port), KOPI_SAWAH_DB: path.join(tmp, 't.sqlite3'), KOPI_SAWAH_SETUP_CODE: '12345678' },
    stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch { } await new Promise(r => setTimeout(r, 100)); }
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--mute-audio'] });
  const hasil = [], galat = [];
  const ok = (nama, lulus, extra = '') => hasil.push([lulus ? 'LULUS' : 'GAGAL', nama, extra]);
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'id-ID' });
    const page = await ctx.newPage();
    page.on('pageerror', e => galat.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/audio|Media/i.test(m.text())) galat.push('console: ' + m.text()); });

    await page.goto(base);
    await page.waitForSelector('#f');
    await page.fill('[name=name]', 'Digi'); await page.fill('[name=pin]', '482916'); await page.fill('[name=pin2]', '482916'); await page.fill('[name=code]', '12345678');
    await page.click('#f button[type=submit]');
    await page.waitForSelector('.top');

    // buka kasir
    await page.click('#tabs button[data-view=kasir]');
    await page.waitForSelector('#openCash');
    await page.fill('#openCash', '100000');
    await page.click('[data-act=openShift]');
    await page.waitForSelector('#grid .tile');

    // tambah menu tanpa pilihan wajib
    await page.fill('#q', 'Air Es');
    await page.click('#grid .tile');
    await page.waitForSelector('[data-act=checkout]:not([disabled])');
    await page.click('[data-act=checkout]');
    await page.waitForSelector('.sheet');

    // kartu metode pemesanan tampil
    const kartu = await page.$$eval('#coOM .om', els => els.map(e => e.textContent.trim()));
    ok('4 kartu metode pemesanan tampil di layar Pembayaran', kartu.length === 4, JSON.stringify(kartu));

    // Buat Pesanan -> tagihan, bukan nota
    await page.click('#coOM [data-om=pesanan]');
    const labelTombol = await page.textContent('#coPayBtn');
    ok('tombol berubah menjadi "Buat pesanan"', /Buat pesanan/.test(labelTombol), labelTombol);
    await page.click('#coPayBtn');
    await page.waitForFunction(() => [...document.querySelectorAll('.sheet-h h3')].some(h => /Pesanan disimpan/.test(h.textContent)), null, { timeout: 10000 }).catch(() => { });
    const judul = await page.evaluate(() => [...document.querySelectorAll('.sheet-h h3')].map(h => h.textContent).join(' | '));
    ok('tagihan tersimpan dan layar tagihan terbuka', /Pesanan disimpan/.test(judul), judul);
    const adaTanda = await page.$('.receipt');
    ok('tagihan bisa dicetak (struk tagihan tampil)', !!adaTanda);

    // Edit jumlah dan catatan dapur sebelum tagihan dilunasi.
    const awal = await page.evaluate(async () => (await (await fetch('/api/bills?status=open')).json()).items[0]);
    const setupDuaBaris = await page.evaluate(async id => {
      const products = (await (await fetch('/api/products')).json()).items;
      const udang = products.find(p => p.name === 'Udang Krispy');
      if (!udang) throw new Error('Menu Udang Krispy tidak ditemukan');
      const response = await fetch(`/api/bills/${id}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ product_id: udang.id, quantity: 1, modifiers: [{ id: 'nasi-1' }] }] }) });
      return { status: response.status, body: await response.json() };
    }, awal.id);
    if (setupDuaBaris.status !== 200) throw new Error('Tidak bisa menyiapkan dua baris uji: ' + JSON.stringify(setupDuaBaris.body));
    const billSebelumEdit = await page.evaluate(async id => (await (await fetch('/api/bills/' + id)).json()).item, awal.id);
    const barisAirPesanan = billSebelumEdit.items.find(i => i.name_snapshot === 'Air Es');
    const barisUdang = billSebelumEdit.items.find(i => i.name_snapshot === 'Udang Krispy');
    if (!barisAirPesanan || !barisUdang) throw new Error('Tagihan uji tidak memiliki dua menu berbeda');
    await page.click('.sheet-f [data-edit]');
    await page.waitForSelector('.sheet-h h3:text-matches("Edit pesanan", "i")');
    const ukur = () => page.evaluate(() => ({
      viewport: innerWidth, client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
      sheet: Math.round(document.querySelector('.sheet').getBoundingClientRect().width),
      sheetClient: document.querySelector('.sheet').clientWidth, sheetScroll: document.querySelector('.sheet').scrollWidth
    }));
    const buktiDir = '/root/.hermes/cache/scratch/kopi-sawah-edit-review';
    fs.mkdirSync(buktiDir, { recursive: true });
    await page.waitForTimeout(3200); // biarkan toast setelah simpan hilang agar bukti layar bersih
    const desktop = await ukur();
    await page.screenshot({ path: path.join(buktiDir, 'desktop.png'), fullPage: true });
    ok('editor tidak meluber pada desktop 1280px', desktop.scroll <= desktop.client && desktop.sheetScroll <= desktop.sheetClient, JSON.stringify(desktop));
    await page.setViewportSize({ width: 390, height: 844 });
    const ponsel = await ukur();
    const catatanPesanan = page.locator('[data-bill-note]');
    await page.evaluate(() => { const body = document.querySelector('.sheet-b'); body.scrollTop = body.scrollHeight; });
    await catatanPesanan.scrollIntoViewIfNeeded();
    const jangkauanCatatan = await page.evaluate(() => {
      const box = document.querySelector('[data-bill-note]').getBoundingClientRect();
      const footer = document.querySelector('.sheet-f').getBoundingClientRect();
      return { visible: box.top >= 0 && box.bottom <= footer.top, top: box.top, bottom: box.bottom, footerTop: footer.top };
    });
    ok('catatan seluruh pesanan bisa dijangkau di ponsel', jangkauanCatatan.visible, JSON.stringify(jangkauanCatatan));
    await page.screenshot({ path: path.join(buktiDir, 'mobile.png'), fullPage: true });
    ok('editor tidak meluber pada ponsel 390px', ponsel.scroll <= ponsel.client && ponsel.sheetScroll <= ponsel.sheetClient, JSON.stringify(ponsel));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.click(`[data-remove="${barisAirPesanan.id}"]`);
    await page.fill(`[data-qty="${barisUdang.id}"]`, '2');
    await page.locator(`[data-qty="${barisUdang.id}"]`).press('Tab');
    await page.fill(`[data-note="${barisUdang.id}"]`, 'Kurangi pedas');
    await page.fill('[data-bill-note]', 'Catatan meja');
    await page.click('[data-save]');
    await page.waitForFunction(async (id) => {
      const b = await (await fetch('/api/bills/' + id)).json();
      return b.item?.items?.length === 1 && b.item.items[0]?.name_snapshot === 'Udang Krispy' &&
        b.item.items[0]?.quantity === 2 && b.item.items[0]?.note === 'Kurangi pedas' && b.item?.note === 'Catatan meja';
    }, awal.id, { timeout: 10000 });
    const sesudahEdit = await page.evaluate(async id => (await (await fetch('/api/bills/' + id)).json()).item,
      awal.id);
    ok('editor menghapus item dan menyimpan catatan item serta pesanan',
       sesudahEdit.items.length === 1 && sesudahEdit.items[0].name_snapshot === 'Udang Krispy' &&
       sesudahEdit.items[0].quantity === 2 && sesudahEdit.items[0].note === 'Kurangi pedas' && sesudahEdit.note === 'Catatan meja',
       `qty=${sesudahEdit.items[0].quantity}, total=${sesudahEdit.total_amount}`);

    const sisa = await page.evaluate(async () => (await (await fetch('/api/bills?status=open')).json()).items.length);
    ok('tagihan muncul di daftar tagihan terbuka', sisa === 1, 'jumlah=' + sisa);

    await page.click('.sheet-h [data-close]');

    // tab Tagihan
    await page.click('#tabs button[data-view=tagihan]');
    await page.waitForSelector('#main [data-pay]');
    const teksTab = await page.textContent('#main');
    ok('tab Tagihan menampilkan tagihan dan nilainya', /Tagihan terbuka/.test(teksTab) && /Rp/.test(teksTab));

    // bayar tagihan -> satu nota lunas
    await page.click('#main [data-pay]');
    await page.waitForSelector('#bpPay');
    await page.click('#bpPay [data-m=qris]');
    await page.waitForSelector('#bpBtn:not([disabled])');
    await page.click('#bpBtn');
    await page.waitForFunction(() => [...document.querySelectorAll('.sheet-h h3')].some(h => /Pembayaran berhasil/.test(h.textContent)), null, { timeout: 10000 }).catch(() => { });
    const judul2 = await page.evaluate(() => [...document.querySelectorAll('.sheet-h h3')].map(h => h.textContent).join(' | '));
    ok('pelunasan tagihan menghasilkan nota lunas', /Pembayaran berhasil/.test(judul2), judul2);
    const nota = await page.textContent('.receipt');
    ok('nota memuat menu dari tagihan', /Udang Krispy/.test(nota));

    const sesudah = await page.evaluate(async () => {
      const b = await (await fetch('/api/bills?status=open')).json();
      const s = await (await fetch('/api/sales?date=all')).json();
      return { terbuka: b.items.length, nota: s.items.filter(x => x.status === 'paid').length };
    });
    ok('tagihan hilang dari daftar terbuka setelah lunas', sesudah.terbuka === 0, 'terbuka=' + sesudah.terbuka);
    ok('nota lunas tercatat di daftar penjualan', sesudah.nota === 1, 'nota=' + sesudah.nota);

    // ---- skenario 2: pelanggan pesan lagi -> Gabungkan Pesanan ----
    await page.click('.sheet-f [data-done]').catch(() => { });
    await page.click('#tabs button[data-view=kasir]');
    await page.waitForSelector('#grid .tile');
    const tambahAirEs = async (qty) => {
      await page.fill('#q', 'Air Es');
      await page.click('#grid .tile');
      for (let i = 1; i < qty; i++) await page.click('.cart-lines .step button[data-d="1"]');
    };
    await tambahAirEs(1);
    await page.click('[data-act=checkout]');
    await page.click('#coOM [data-om=pesanan]');
    await page.click('#coPayBtn');
    await page.waitForFunction(() => [...document.querySelectorAll('.sheet-h h3')].some(h => /Pesanan disimpan/.test(h.textContent)), null, { timeout: 10000 });
    await page.click('.sheet-h [data-close]');

    await tambahAirEs(2);
    await page.click('[data-act=checkout]');
    await page.click('#coOM [data-om=gabung]');
    await page.waitForSelector('#coBillList [data-bill]');
    await page.click('#coBillList [data-bill]');
    const labelGabung = await page.textContent('#coPayBtn');
    ok('tombol gabungkan aktif setelah tagihan dipilih', /Gabungkan/.test(labelGabung), labelGabung);
    await page.click('#coPayBtn');
    await page.waitForFunction(() => [...document.querySelectorAll('.sheet-h h3')].some(h => /Pesanan disimpan/.test(h.textContent)), null, { timeout: 10000 }).catch(() => { });
    const gabungInfo = await page.evaluate(async () => {
      const d = await (await fetch('/api/bills?status=open')).json();
      const b = d.items[0];
      return b ? { id: b.id, baris: b.items.length, qty: b.item_count, total: b.total_amount } : null;
    });
    ok('pesanan kedua masuk ke tagihan yang sama (satu tagihan, dua baris)',
       !!gabungInfo && gabungInfo.baris === 2 && gabungInfo.qty === 3, JSON.stringify(gabungInfo));
    await page.click('.sheet-h [data-close]');

    await page.click('#tabs button[data-view=tagihan]');
    await page.waitForSelector('#main [data-pay]');
    await page.click('#main [data-pay]');
    await page.waitForSelector('#bpPay');
    await page.click('#bpPay [data-m=tunai]');
    await page.fill('#bpPaid', '10000');
    await page.click('#bpBtn');
    await page.waitForFunction(() => [...document.querySelectorAll('.sheet-h h3')].some(h => /Pembayaran berhasil/.test(h.textContent)), null, { timeout: 10000 }).catch(() => { });
    const notaGabung = await page.evaluate(() => [...document.querySelectorAll('.receipt')].map(r => r.textContent).join(' | '));
    const barisAir = (notaGabung.match(/Air Es/g) || []).length;
    ok('satu nota memuat semua pesanan yang digabung', barisAir >= 2 && /Rp3\.000/.test(notaGabung), 'baris Air Es=' + barisAir);

    // ---- skenario 3: pemilik menghapus transaksi dari layar ----
    await page.click('.sheet-f [data-done]').catch(() => { });
    await page.click('#tabs button[data-view=pesanan]');
    await page.waitForSelector('#main .item');
    const jumlahAwal = await page.evaluate(async () => (await (await fetch('/api/sales?date=all')).json()).items.length);
    await page.click('#main .item');
    await page.waitForSelector('[data-del]');
    await page.click('[data-del]');
    await page.waitForSelector('#f_reason');
    await page.fill('#f_reason', 'uji hapus dari layar');
    await page.click('[data-submit]');
    await page.waitForFunction(async (n) => (await (await fetch('/api/sales?date=all')).json()).items.length === n - 1, jumlahAwal, { timeout: 10000 }).catch(() => { });
    const jumlahAkhir = await page.evaluate(async () => (await (await fetch('/api/sales?date=all')).json()).items.length);
    ok('pemilik bisa menghapus transaksi dari layar', jumlahAkhir === jumlahAwal - 1, `${jumlahAwal} → ${jumlahAkhir}`);
  } catch (e) {
    galat.push('exception: ' + e.message);
  } finally {
    await browser.close(); proc.kill();
    for (const [st, nama, extra] of hasil) console.log(`${st} — ${nama}${extra ? ' :: ' + extra : ''}`);
    if (galat.length) { console.log('GALAT JS:'); galat.forEach(g => console.log(' - ' + g)); }
    const gagal = hasil.filter(h => h[0] !== 'LULUS').length;
    console.log(`\n${hasil.length - gagal}/${hasil.length} lulus, ${galat.length} galat JS`);
    process.exit(gagal || galat.length ? 1 : 0);
  }
})();
