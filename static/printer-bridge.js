/* Kopi Sawah → Cleanter Android local bridge for Bluetooth Classic ESC/POS. */
(function (root) {
  'use strict';
  const BASE = 'http://localhost:9100';
  const PRINTER = 'RPP02N';

  async function responseJson(response) {
    return response.json().catch(() => ({}));
  }

  async function health() {
    let response;
    try {
      response = await fetch(`${BASE}/health`, {
        headers: { Accept: 'application/json' },
      });
    } catch {
      throw new Error('Cleanter belum terjangkau. Pastikan aplikasi POS dan Cleanter dibuka di tablet Android yang sama, pilih RPP02N di Cleanter, lalu pilih Izinkan jika Chrome meminta akses ke aplikasi dan layanan lain di perangkat.');
    }
    const data = await responseJson(response);
    if (!response.ok || data.status !== 'ok') {
      throw new Error('Cleanter belum siap. Buka aplikasinya di tablet Android.');
    }
    return data;
  }

  function printerReady(data) {
    const p = data && data.printer;
    if (!p || p.connected !== true) {
      const help = {
        bluetooth_permission_missing: 'Izinkan akses Bluetooth untuk Cleanter.',
        bluetooth_disabled: 'Nyalakan Bluetooth Android.',
        printer_not_connected: 'Pilih RPP02N sebagai printer di Cleanter.',
        printer_not_paired: 'Pasangkan ulang RPP02N di pengaturan Bluetooth Android.',
        printer_unreachable: 'Periksa daya, jarak, dan kertas RPP02N.',
      };
      throw new Error(help[p && p.problem] || 'Printer belum tersambung. Buka Cleanter dan pilih RPP02N.');
    }
    const name = String(p.name || '').trim();
    if (!name.toUpperCase().includes(PRINTER)) {
      throw new Error(`Printer aktif adalah “${name || 'tanpa nama'}”, bukan RPP02N. Pilih RPP02N di Cleanter.`);
    }
    return p;
  }

  const text = (value, extra = {}) => ({ type: 'text', text: String(value ?? ''), ...extra });
  const row = (left, right, extra = {}) => ({ type: 'row', left: String(left ?? ''), right: String(right ?? ''), ...extra });
  const amount = value => new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 }).format(Number(value) || 0);

  function buildContent({ sale, settings = {}, orderTypeLabel = '', paymentMethodLabel = '', dateLabel = '' }) {
    if (!sale || !Array.isArray(sale.items)) throw new Error('Data nota tidak lengkap.');
    const content = [text(settings.outlet_name || 'Kopi Sawah', { align: 'center', bold: true, size: 'large' })];
    if (settings.outlet_address) content.push(text(settings.outlet_address, { align: 'center' }));
    content.push({ type: 'divider' });
    content.push(row('No', sale.id || '-'));
    if (dateLabel) content.push(text(dateLabel));
    content.push(row('Kasir', sale.cashier || '-'));
    if (orderTypeLabel || sale.table_no) content.push(text(`${orderTypeLabel}${sale.table_no ? ` · ${sale.table_no}` : ''}`));
    if (sale.customer_name) content.push(row('Pelanggan', sale.customer_name));
    content.push({ type: 'divider' });
    for (const item of sale.items) {
      content.push(row(`${item.quantity} × ${item.name_snapshot || ''}`, amount(item.line_total)));
      if (item.modifiers_summary) content.push(text(`  ${item.modifiers_summary}`));
    }
    content.push({ type: 'divider' });
    content.push(row('Subtotal', amount(sale.subtotal)));
    if (sale.packing_fee) content.push(row('Kemasan', amount(sale.packing_fee)));
    if (sale.discount_amount) content.push(row('Diskon', `-${amount(sale.discount_amount)}`));
    if (sale.service_amount) content.push(row('Layanan', amount(sale.service_amount)));
    if (sale.tax_amount) content.push(row('Pajak', amount(sale.tax_amount)));
    if (sale.rounding_amount) content.push(row('Pembulatan', amount(sale.rounding_amount)));
    content.push(row('TOTAL', `Rp${amount(sale.total_amount)}`, { bold: true }));
    if (paymentMethodLabel) content.push(row(paymentMethodLabel, amount(sale.amount_paid)));
    if (sale.payment_method === 'tunai') content.push(row('Kembali', amount(sale.change_amount)));
    if (sale.status === 'void') content.push(text('** NOTA DIBATALKAN **', { align: 'center', bold: true }));
    if (settings.receipt_footer) content.push(text(settings.receipt_footer, { align: 'center' }));
    if (settings.outlet_contact) content.push(text(settings.outlet_contact, { align: 'center' }));
    content.push({ type: 'feed', lines: 3 });
    return content;
  }

  async function print({ sale, settings = {}, orderTypeLabel = '', paymentMethodLabel = '', dateLabel = '' }) {
    printerReady(await health());
    let response;
    try {
      response = await fetch(`${BASE}/print`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          printer: PRINTER,
          paperWidth: Number(settings.receipt_width) === 80 ? 80 : 58,
          cut: true,
          content: buildContent({ sale, settings, orderTypeLabel, paymentMethodLabel, dateLabel }),
        }),
      });
    } catch {
      throw new Error('Perintah cetak tidak sampai ke Cleanter. Pastikan izin akses lokal diberikan dan printer tetap menyala.');
    }
    const data = await responseJson(response);
    if (!response.ok || data.status !== 'printed') {
      throw new Error(data.fix || data.detail || data.message || 'Cleanter gagal mencetak nota.');
    }
    return data;
  }

  root.KopiSawahPrinter = { health, print, buildContent };
})(window);
