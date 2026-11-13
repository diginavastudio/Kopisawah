#!/usr/bin/env node
const assert = require('node:assert/strict');
const path = require('node:path');

async function run() {
  const calls = [];
  global.window = {};
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/health')) return { ok: true, json: async () => ({ status: 'ok', printer: { connected: true, name: 'RPP02N' } }) };
    return { ok: true, json: async () => ({ status: 'printed', jobId: 'test-job' }) };
  };
  require(path.join(__dirname, '..', 'static', 'printer-bridge.js'));
  const bridge = global.window.KopiSawahPrinter;
  const sample = {
    sale: {
      id: 'KS-TEST-1', cashier: 'Kasir Uji', order_type: 'dine_in', table_no: 'Meja 1',
      customer_name: 'Pelanggan Uji', subtotal: 10000, packing_fee: 0, discount_amount: 0,
      service_amount: 0, tax_amount: 0, rounding_amount: 0, total_amount: 10000,
      amount_paid: 10000, change_amount: 0, payment_method: 'tunai', status: 'paid',
      items: [{ quantity: 1, name_snapshot: 'Kopi Uji', line_total: 10000 }],
    },
    settings: { outlet_name: 'Kopi Sawah', receipt_width: '58', receipt_footer: 'Terima kasih' },
    orderTypeLabel: 'Makan di tempat', paymentMethodLabel: 'Tunai', dateLabel: '03/11/2026 21.00',
  };

  const blocks = bridge.buildContent(sample);
  assert(blocks.some(x => x.type === 'row' && x.left === '1 × Kopi Uji' && x.right === '10.000'));
  assert(blocks.some(x => x.type === 'row' && x.left === 'TOTAL' && x.right === 'Rp10.000'));
  assert.equal(blocks.at(-1).type, 'feed');

  const result = await bridge.print(sample);
  assert.equal(result.status, 'printed');
  assert.equal(calls.length, 2);
  const payload = JSON.parse(calls[1].options.body);
  assert.equal(payload.printer, 'RPP02N');
  assert.equal(payload.paperWidth, 58);
  assert.equal(payload.cut, true);
  assert(payload.content.some(x => x.type === 'row' && x.left === 'TOTAL'));

  calls.length = 0;
  global.fetch = async url => {
    calls.push({ url });
    return { ok: true, json: async () => ({ status: 'ok', printer: { connected: false, problem: 'printer_not_selected' } }) };
  };
  await assert.rejects(bridge.print(sample), /Printer belum tersambung/);
  assert.equal(calls.length, 1, 'jangan kirim pekerjaan saat printer belum terhubung');

  calls.length = 0;
  global.fetch = async url => {
    calls.push({ url });
    return { ok: true, json: async () => ({ status: 'ok', printer: { connected: true, name: 'JiaYunTechnology' } }) };
  };
  await assert.rejects(bridge.print(sample), /bukan RPP02N/);
  assert.equal(calls.length, 1, 'jangan cetak ke perangkat yang salah');

  global.fetch = async () => { throw new TypeError('network unavailable'); };
  await assert.rejects(bridge.health(), /Cleanter belum terjangkau/);
  console.log('LULUS: format struk, ukuran 58 mm, cetak RPP02N, gagal jika printer tidak siap/salah, dan bridge tak tersedia.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
