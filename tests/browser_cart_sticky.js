/* Uji daftar kasir panjang: 30 baris sintetis, area daftar bergulir, pembayaran tetap tampak.
 * DB SEMENTARA — tidak menyentuh data toko.
 * Jalankan: NODE_PATH=/opt/node-tools/node_modules CHROME_PATH=/opt/chromium/chrome-linux64/chrome node tests/browser_cart_sticky.js
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
  const port = await free(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-cart-sticky-'));
  const proc = spawn('python3', [path.join(__dirname, '..', 'app.py')], {
    env: { ...process.env, KOPI_SAWAH_PORT: String(port), KOPI_SAWAH_DB: path.join(tmp, 't.sqlite3'), KOPI_SAWAH_SETUP_CODE: '12345678' },
    stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch { } await new Promise(r => setTimeout(r, 100)); }
  let browser;
  const checks = [];
  const check = (name, pass, detail = '') => checks.push({ name, pass, detail });
  try {
    browser = await chromium.launch({ executablePath: CHROME, args: ['--mute-audio'] });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'id-ID', isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/audio|Media/i.test(m.text())) errors.push(m.text()); });
    await page.goto(base);
    await page.waitForSelector('#f');
    await page.fill('[name=name]', 'Digi');
    await page.fill('[name=pin]', '482916');
    await page.fill('[name=pin2]', '482916');
    await page.fill('[name=code]', '12345678');
    await page.click('#f button[type=submit]');
    await page.waitForSelector('.top');
    await page.click('#tabs button[data-view=kasir]');
    await page.waitForSelector('#openCash');
    await page.fill('#openCash', '100000');
    await page.click('[data-act=openShift]');
    await page.waitForSelector('#grid .tile');

    const fixture = await page.evaluate(async () => {
      const products = (await (await fetch('/api/products')).json()).items;
      const p = products.find(x => x.name === 'Air Es') || products.find(x => x.available);
      if (!p) throw new Error('Tidak ada menu fixture untuk uji keranjang');
      const rows = Array.from({ length: 30 }, (_, i) => {
        const opts = [{ id: `uji-${i + 1}`, name: `Contoh ${String(i + 1).padStart(2, '0')}`, group: 'Uji', delta: 0 }];
        return { key: p.id + '|' + opts.map(o => o.id).sort().join(','), pid: p.id, opts, qty: 1 };
      });
      localStorage.setItem('ks_cart_v2', JSON.stringify(rows));
      return { count: rows.length, pid: p.id };
    });
    if (fixture.count !== 30) throw new Error('Fixture tidak berisi 30 baris');
    await page.reload();
    await page.waitForSelector('.mobile-bar [data-act=openCart]:not([disabled])');
    await page.click('.mobile-bar [data-act=openCart]');
    await page.waitForSelector('.sheet .cart-lines .cl');
    const before = await page.evaluate(() => {
      const sheet = document.querySelector('.sheet');
      const list = sheet.querySelector('.cart-lines');
      const footer = sheet.querySelector('.sheet-f');
      const pay = footer?.querySelector('[data-act=checkout]');
      const rect = el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
      return { rows: list.querySelectorAll('.cl').length, listScroll: list.scrollHeight, listClient: list.clientHeight,
        footer: !!footer, button: !!pay, footerRect: footer && rect(footer), buttonRect: pay && rect(pay),
        viewport: innerWidth, docWidth: document.documentElement.scrollWidth };
    });
    const shots = '/root/.hermes/cache/scratch/kopi-sawah-cart-sticky';
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, 'mobile-before.png') });
    const mobileStructurePass = before.rows === 30 && before.listScroll > before.listClient && before.footer && before.button && before.docWidth === before.viewport;
    check('ponsel: daftar 30 baris bergulir dan footer bayar tetap terlihat', mobileStructurePass, JSON.stringify(before));

    let mobileAfter = null;
    if (before.listScroll > before.listClient && before.button) {
      mobileAfter = await page.evaluate(() => {
        const sheet = document.querySelector('.sheet'), list = sheet.querySelector('.cart-lines');
        list.scrollTop = list.scrollHeight;
        const footer = sheet.querySelector('.sheet-f'), pay = footer.querySelector('[data-act=checkout]');
        const rect = el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
        return { scrollTop: list.scrollTop, footerRect: rect(footer), buttonRect: rect(pay), visible: pay.getBoundingClientRect().top >= 0 && pay.getBoundingClientRect().bottom <= innerHeight };
      });
      await page.screenshot({ path: path.join(shots, 'mobile-after-scroll.png') });
      check('ponsel: tombol Bayar tidak bergerak saat daftar digulir ke bawah', mobileAfter.scrollTop > 0 && mobileAfter.visible && Math.abs(before.footerRect.top - mobileAfter.footerRect.top) < 1 && Math.abs(before.buttonRect.bottom - mobileAfter.buttonRect.bottom) < 1, JSON.stringify(mobileAfter));
    }

    if (before.button) {
      const lastKey = await page.evaluate(() => document.querySelector('.sheet .cart-lines .cl:last-child [data-act=qty][data-d="1"]')?.dataset.key);
      await page.click(`.sheet .cart-lines .cl [data-act=qty][data-d="1"][data-key="${lastKey}"]`);
      const afterQty = await page.evaluate(() => {
        const sheet = document.querySelector('.sheet'), list = sheet.querySelector('.cart-lines'), footer = sheet.querySelector('.sheet-f');
        return { scrollTop: list.scrollTop, total: footer.textContent, buttonVisible: (() => { const r = footer.querySelector('[data-act=checkout]').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })() };
      });
      check('ponsel: ubah jumlah saat di bawah mempertahankan posisi gulir dan bayar', afterQty.scrollTop > 0 && afterQty.buttonVisible && /Bayar/.test(afterQty.total), JSON.stringify(afterQty));
      await page.click('.sheet .sheet-f [data-act=checkout]');
      await page.waitForSelector('.sheet[aria-label="Pembayaran"]');
      const checkout = await page.evaluate(() => {
        const sheet = document.querySelector('.sheet[aria-label="Pembayaran"]');
        const button = sheet?.querySelector('#coPayBtn');
        return { opened: !!sheet, buttonText: button?.textContent, amountShown: /Rp31\.000/.test(sheet?.textContent || '') };
      });
      check('ponsel: tombol Bayar membuka pembayaran dengan total yang sama', checkout.opened && checkout.amountShown && /Rp31\.000/.test(checkout.buttonText || ''), JSON.stringify(checkout));
    }

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload();
    await page.waitForSelector('#cartSide .cart-lines .cl');
    const desktop = await page.evaluate(() => {
      const cart = document.querySelector('#cartSide'), list = cart.querySelector('.cart-lines'), pay = cart.querySelector('[data-act=checkout]');
      const y = pay.getBoundingClientRect().bottom;
      list.scrollTop = list.scrollHeight;
      return { rows: list.querySelectorAll('.cl').length, listScroll: list.scrollHeight, listClient: list.clientHeight,
        scrollTop: list.scrollTop, payVisible: pay.getBoundingClientRect().top >= 0 && pay.getBoundingClientRect().bottom <= innerHeight,
        payBottomBefore: y, payBottomAfter: pay.getBoundingClientRect().bottom, viewport: innerWidth, docWidth: document.documentElement.scrollWidth };
    });
    await page.screenshot({ path: path.join(shots, 'desktop.png') });
    check('desktop: daftar keranjang bergulir tanpa menyembunyikan tombol Bayar', desktop.rows === 30 && desktop.listScroll > desktop.listClient && desktop.scrollTop > 0 && desktop.payVisible && Math.abs(desktop.payBottomBefore - desktop.payBottomAfter) < 1 && desktop.docWidth === desktop.viewport, JSON.stringify(desktop));

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { const rows = JSON.parse(localStorage.getItem('ks_cart_v2') || '[]'); localStorage.setItem('ks_cart_v2', JSON.stringify(rows.slice(0, 1))); });
    await page.reload();
    await page.waitForSelector('.mobile-bar [data-act=openCart]:not([disabled])');
    await page.click('.mobile-bar [data-act=openCart]');
    await page.waitForSelector('.sheet .cart-lines .cl');
    const shortCart = await page.evaluate(() => {
      const list = document.querySelector('.sheet .cart-lines'), row = list.querySelector('.cl');
      const pay = document.querySelector('.sheet-f [data-act=checkout]'), r = pay.getBoundingClientRect();
      const listRect = list.getBoundingClientRect(), rowRect = row.getBoundingClientRect();
      return { rows: list.querySelectorAll('.cl').length, listHeight: list.clientHeight, rowHeight: rowRect.height,
        rowVisible: rowRect.top >= listRect.top && rowRect.bottom <= listRect.bottom,
        payVisible: r.top >= 0 && r.bottom <= innerHeight, viewport: innerWidth, documentWidth: document.documentElement.scrollWidth };
    });
    check('keranjang satu baris tetap terlihat bersama tombol Bayar', shortCart.rows === 1 && shortCart.rowHeight > 0 && shortCart.rowVisible && shortCart.payVisible && shortCart.documentWidth === shortCart.viewport, JSON.stringify(shortCart));

    check('tidak ada galat JavaScript', errors.length === 0, errors.join(' | '));
    await context.close();
  } finally {
    if (browser) await browser.close();
    proc.kill('SIGTERM');
    await new Promise(r => { const timer = setTimeout(r, 1500); proc.once('exit', () => { clearTimeout(timer); r(); }); });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  for (const c of checks) console.log(`${c.pass ? 'LULUS' : 'GAGAL'} — ${c.name}${c.detail ? ' :: ' + c.detail : ''}`);
  console.log(`\n${checks.filter(c => c.pass).length}/${checks.length} lulus`);
  if (checks.some(c => !c.pass)) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
