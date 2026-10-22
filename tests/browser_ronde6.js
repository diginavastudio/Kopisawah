/* Uji layar fitur Ronde 6 di Chromium sungguhan (DB sementara, data TIRUAN):
 * Beranda lengkap, hub Laporan (5 laporan), pelanggan, nama pelanggan di kasir, layout layar lebar.
 * Jalankan: NODE_PATH=/opt/node-tools/node_modules node tests/browser_ronde6.js [folder-screenshot]
 */
const { chromium, request } = require('playwright');
const { spawn } = require('node:child_process');
const net = require('node:net'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'ks-r6-'));
fs.mkdirSync(shots, { recursive: true });
const free = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

(async () => {
  const port = await free(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-db-'));
  const proc = spawn('python3', [path.join(__dirname, '..', 'app.py')], { env: { ...process.env, KOPI_SAWAH_PORT: String(port), KOPI_SAWAH_DB: path.join(tmp, 't.sqlite3'), KOPI_SAWAH_SETUP_CODE: '12345678' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch { } await new Promise(r => setTimeout(r, 100)); }
  const browser = await chromium.launch();
  const results = [], errors = [];
  const ok = (name, cond, extra = '') => results.push([cond ? 'LULUS' : 'GAGAL', name, extra]);
  const post = (p, body, ip = '10.5.0.1') => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Real-IP': ip }, body: JSON.stringify(body) }).then(r => r.json());
  try {
    const api = await request.newContext({ baseURL: base, extraHTTPHeaders: { Origin: base } });
    await api.post('/api/auth/setup', { data: { name: 'Digi', pin: '482916', setup_code: '12345678' } });
    await api.post('/api/shifts/open', { data: { opening_cash: 100000 } });
    const prods = (await (await api.get('/api/products')).json()).items;
    const plan = [['Bu Sari', 'qris'], ['Bu Sari', 'qris'], ['Pak Budi', 'transfer'], ['', 'qris'], ['Pak Budi', 'qris']];
    for (const p of prods) {   // menu dengan pilihan wajib ditolak server; lewati sampai 5 penjualan berhasil
      if (!plan.length) break;
      const [who, method] = plan[0];
      const r = await api.post('/api/sales', { data: { items: [{ product_id: p.id, quantity: 2, modifiers: [] }], payment_method: method, customer_name: who, request_id: 'r6-' + p.id + Math.random().toString(16).slice(2) } });
      if (r.ok()) plan.shift();
    }
    const state = await api.storageState();
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, storageState: state, locale: 'id-ID' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/i.test(m.text())) errors.push('console: ' + m.text()); });
    const shot = n => page.screenshot({ path: path.join(shots, n + '.png') });
    const txt = async sel => (await page.textContent(sel)) || '';
    await page.goto(base); await page.waitForSelector('.top');

    // ---- 1. layout lebar: konten mengisi layar 1920 px (tidak longgar)
    await page.waitForSelector('.stats'); await shot('60-beranda-1920');
    const w = await page.evaluate(() => ({ main: document.querySelector('main').getBoundingClientRect().width, inner: innerWidth, scroll: document.documentElement.scrollWidth }));
    ok('layar 1920: konten ≥ 90% lebar layar', w.main / w.inner >= 0.9, JSON.stringify(w));
    ok('layar 1920: tanpa geser samping', w.scroll <= w.inner, JSON.stringify(w));

    // ---- 2. Beranda lengkap
    const home = await txt('#main');
    for (const t of ['Penjualan 30 hari terakhir', 'Jam ramai hari ini', 'Cara bayar hari ini', 'Jenis pesanan hari ini', 'Kategori terlaris bulan ini', 'Menu terlaris hari ini', 'Operasional saat ini']) ok('Beranda memuat: ' + t, home.includes(t));
    await page.click('[data-act=homeDays][data-d="7"]'); await page.waitForTimeout(300);
    ok('Beranda: grafik 7 hari', (await txt('#main')).includes('Penjualan 7 hari terakhir'));
    await shot('61-beranda-30hari');

    // ---- 3. Hub laporan & 5 laporan
    await page.click('#tabs [data-view=laporan]'); await page.waitForSelector('[data-act=repOpen]'); await shot('62-laporan-hub');
    ok('hub memuat 5 laporan', (await page.$$('[data-act=repOpen]')).length === 5);
    for (const [k, t] of [['sales', 'Transaksi Penjualan'], ['monthly', 'Omzet Per Bulan'], ['top', 'Produk Terlaris'], ['sold', 'Produk Terjual'], ['cust', 'Transaksi Pelanggan']]) {
      await page.click(`[data-act=repOpen][data-r=${k}]`); await page.waitForTimeout(500);
      const m = await txt('#main'); ok('laporan terbuka: ' + t, m.includes(t));
      await shot('63-laporan-' + k);
      const sw = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth); ok('laporan ' + k + ' tanpa geser samping', sw);
      if (k === 'cust') {
        ok('pelanggan: Bu Sari & Pak Budi tampil', m.includes('Bu Sari') && m.includes('Pak Budi'));
        await page.click('[data-act=custOpen] >> nth=0'); await page.waitForSelector('.sheet'); await shot('64-pelanggan-rinci');
        ok('rincian pelanggan memuat transaksi', (await txt('.sheet')).includes('KS'));
        await page.click('.sheet [data-close]');
        await page.click('[data-act=custAdd]'); await page.waitForSelector('#theForm'); await page.fill('[name=name]', 'Mbak Ayu'); await page.fill('[name=phone]', '081234567890'); await page.click('[data-submit]');
        await page.waitForSelector('.toast'); await page.waitForTimeout(500);
        ok('pelanggan baru tersimpan & tampil di daftar belum belanja', (await txt('#main')).includes('Mbak Ayu'));
      }
      await page.click('[data-act=repBack]'); await page.waitForSelector('[data-act=repOpen]');
    }

    // ---- 4. nama pelanggan di kasir & struk
    await page.click('#tabs [data-view=kasir]'); await page.waitForSelector('.tile');
    await page.click('.tile >> nth=0'); await page.waitForSelector('.sheet [data-add]').catch(() => { }); if (await page.$('.sheet [data-add]')) await page.click('.sheet [data-add]');
    await page.waitForSelector('#cartSide .cl'); await page.click('#cartSide [data-act=checkout]'); await page.waitForSelector('#coCust');
    await page.fill('#coCust', 'Bu Sari'); await page.click('#coPay [data-m=qris]'); await shot('65-checkout-nama');
    await page.click('#coPayBtn'); await page.waitForSelector('.receipt');
    ok('struk memuat nama pelanggan', (await txt('.receipt')).includes('Pelanggan: Bu Sari'));
    await shot('66-struk-nama'); await page.click('[data-done]');
    const after = await (await api.get('/api/sales')).json();
    ok('transaksi baru tercatat atas nama Bu Sari', after.items[0].customer_name === 'Bu Sari', after.items[0].customer_name);
  } catch (e) { results.push(['GAGAL', 'skrip berhenti: ' + e.message.split('\n')[0], '']); }
  finally { await browser.close(); proc.kill('SIGTERM'); }
  results.forEach(r => console.log(r.join(' | ')));
  console.log('Galat konsol/halaman:', errors.length ? errors : 'tidak ada');
  console.log('Screenshot:', shots);
  process.exitCode = results.some(r => r[0] === 'GAGAL') || errors.length ? 1 : 0;
})();
