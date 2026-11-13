'use strict';
/* Halaman reservasi meja + pre-order (pelanggan, tanpa login). Tiga langkah: data → pesanan → reservasi. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('id-ID');
const rp = n => (n < 0 ? '−Rp' : 'Rp') + nf.format(Math.abs(n));
const signed = n => (n > 0 ? '+' : '−') + rp(Math.abs(n));
const TOKEN = new URLSearchParams(location.search).get('t') || '';
const MULAI_BARU = new URLSearchParams(location.search).get('baru') === '1';
const LS_KEY = 'ks_resv_tokens';
const getTokens = () => { try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; } };
const saveToken = t => { try { const list = getTokens().filter(x => x.token !== t); list.unshift({ token: t, at: Date.now() }); localStorage.setItem(LS_KEY, JSON.stringify(list.slice(0, 5))); } catch { /* abaikan */ } };
const removeToken = t => { try { localStorage.setItem(LS_KEY, JSON.stringify(getTokens().filter(x => x.token !== t))); } catch { /* abaikan */ } };
const waLink = (num, text) => { let n = String(num || '').replace(/\D/g, ''); if (n.startsWith('0')) n = '62' + n.slice(1); return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : ''; };
const st = { info: null, items: [], cat: 'Semua', q: '', cart: [], busy: false, reqId: null, token: '', poll: null, step: 1, form: null };
const prod = id => st.items.find(p => p.id === id);
const imgSrc = k => !k || k === 'none' ? '' : k.startsWith('up-') ? `/media/${k}.jpg` : `/static/images/${k}.jpg`;
const photo = k => k && k !== 'none' ? `<img class="ph" src="${imgSrc(k)}" alt="" loading="lazy">` : `<div class="ph none"><img src="/static/images/logo-badge.png" alt=""></div>`;
const todayStr = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const fmtTanggal = v => { try { return new Date(v + 'T00:00:00+07:00').toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); } catch { return v; } };

async function api(path, body) {
  let r;
  try {
    r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch { throw Object.assign(new Error('Tidak bisa terhubung. Periksa internet lalu coba lagi.'), { network: true }); }
  const raw = await r.text();
  let d = {};
  try { d = raw ? JSON.parse(raw) : {}; } catch { /* bukan JSON */ }
  if (!r.ok) throw Object.assign(new Error(d.error || `Permintaan gagal (${r.status}).`), { status: r.status });
  return d;
}
let toastT;
function toast(m, kind = '') {
  $('.toast')?.remove();
  const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = m; t.setAttribute('role', 'status');
  document.body.appendChild(t); clearTimeout(toastT); toastT = setTimeout(() => t.remove(), 3200);
}
function openSheet(title, body, footer, onMount) {
  closeSheet();
  const scrim = document.createElement('div'); scrim.className = 'scrim';
  scrim.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="sheet-h"><h3></h3><button class="x" aria-label="Tutup">×</button></div><div class="sheet-b"></div><div class="sheet-f"></div></div>`;
  scrim.querySelector('h3').textContent = title;
  scrim.querySelector('.sheet-b').innerHTML = body;
  scrim.querySelector('.sheet-f').innerHTML = footer || '';
  scrim.querySelector('.x').onclick = closeSheet;
  scrim.addEventListener('click', e => { if (e.target === scrim) closeSheet(); });
  document.body.appendChild(scrim);
  st.sheet = { el: scrim };
  onMount && onMount(scrim);
  return scrim;
}
function closeSheet() { if (st.sheet) { st.sheet.el.remove(); st.sheet = null; } }

const cartKey = (pid, opts) => pid + '|' + opts.map(o => o.id).sort().join(',');
const unit = l => (prod(l.pid)?.price || 0) + l.opts.reduce((s, o) => s + o.delta, 0);
const subtotal = () => st.cart.reduce((s, l) => s + unit(l) * l.qty, 0);
const count = () => st.cart.reduce((s, l) => s + l.qty, 0);
const optLabel = opts => { const seen = {}; opts.forEach(o => { seen[o.name] = (seen[o.name] || 0) + 1; }); return opts.map(o => seen[o.name] > 1 ? `${o.group} ${o.name}` : o.name).join(' · '); };
function add(p, opts, qty) {
  const key = cartKey(p.id, opts), ex = st.cart.find(l => l.key === key);
  if (ex) ex.qty = Math.min(50, ex.qty + qty); else st.cart.push({ key, pid: p.id, opts, qty });
  st.reqId = null; drawBar();
}

/* ---------- langkah 1: data reservasi ---------- */
const stepsBar = () => `<div class="steps">${[['1', 'Data'], ['2', 'Pesanan'], ['3', 'Reservasi']]
  .map(([n, l]) => `<div class="stepi ${st.step === +n ? 'on' : ''} ${st.step > +n ? 'done' : ''}"><span>${st.step > +n ? '✓' : n}</span>${l}</div>`).join('<i></i>')}</div>`;
function jamOptions(tanggal) {
  const info = st.info || {};
  if (tanggal === todayStr()) {
    if (!info.jam_min_hari_ini) return [];
    return (info.jam || []).filter(j => j >= info.jam_min_hari_ini);
  }
  return (info.jam || []).slice();
}
async function formView() {
  const info = await api('/api/public/reservasi/info');
  st.info = info; st.items = info.items || [];
  $('#outlet').textContent = info.settings?.outlet_name || 'Kopi Sawah';
  if (!info.aktif) {
    $('#app').innerHTML = `<div class="card"><h2>Reservasi sedang ditutup</h2><p class="muted">Sementara ini reservasi lewat halaman ini belum dibuka. Silakan hubungi kami lewat WhatsApp${info.settings?.outlet_contact ? ' (' + esc(info.settings.outlet_contact) + ')' : ''}.</p></div>`;
    return;
  }
  if (!st.form) {
    const tgl = info.tanggal_min;
    st.form = { tanggal: tgl, jam: jamOptions(tgl)[0] || '', orang: 2, nama: '', hp: '', catatan: '' };
  }
  st.step = 1;
  render();
}
function render() {
  if (st.step === 1) renderStep1();
  else if (st.step === 2) renderStep2();
  else renderStep3();
  window.scrollTo(0, 0);
}
function renderStep1() {
  const f = st.form, info = st.info, opts = jamOptions(f.tanggal);
  if (!opts.includes(f.jam)) f.jam = opts[0] || '';
  $('#app').innerHTML = `
    <div class="card">
      ${stepsBar()}
      <h2>Data reservasi</h2>
      <div class="row2">
        <div><label class="lbl" for="tgl">Tanggal datang</label>
          <input class="field" id="tgl" type="date" min="${info.tanggal_min}" max="${info.tanggal_max}" value="${f.tanggal}">
          <div class="small muted" id="tglInfo" style="margin-top:4px"></div></div>
        <div><label class="lbl" for="jam">Jam datang</label>
          <select class="field" id="jam">${opts.map(j => `<option value="${j}" ${j === f.jam ? 'selected' : ''}>${j}</option>`).join('')}</select>
          ${opts.length ? '' : '<div class="small" style="color:var(--bad);margin-top:4px">Hari ini sudah tidak ada jam tersedia.</div>'}</div>
      </div>
      <div class="row2">
        <div><label class="lbl" for="orang">Jumlah orang</label>
          <input class="field" id="orang" type="number" min="1" ${info.max_orang > 0 ? `max="${info.max_orang}"` : ''} value="${f.orang}" inputmode="numeric"></div>
        <div><label class="lbl" for="hp">No. HP / WhatsApp</label>
          <input class="field" id="hp" type="tel" inputmode="tel" maxlength="20" value="${esc(f.hp)}" placeholder="08xxxxxxxxxx"></div>
      </div>
      <label class="lbl" for="nm">Nama pemesan</label>
      <input class="field" id="nm" maxlength="60" autocomplete="name" value="${esc(f.nama)}" placeholder="mis. Bu Sari">
      <label class="lbl" for="ct">Catatan (opsional)</label>
      <input class="field" id="ct" maxlength="200" value="${esc(f.catatan)}" placeholder="mis. rapat 20 orang, minta ruang belakang">
      <div id="errBox"></div>
      <button class="btn gold big block" id="next" style="margin-top:14px">Lanjut ke pesanan</button>
    </div>`;
  const tglInfo = () => { const v = $('#tgl').value; $('#tglInfo').textContent = v ? fmtTanggal(v) : ''; };
  tglInfo();
  $('#tgl').onchange = () => {
    f.tanggal = $('#tgl').value;
    const o = jamOptions(f.tanggal);
    const sel = $('#jam');
    if (!o.includes(f.jam)) f.jam = o[0] || '';
    sel.innerHTML = o.map(j => `<option value="${j}" ${j === f.jam ? 'selected' : ''}>${j}</option>`).join('');
    tglInfo();
  };
  $('#jam').onchange = () => { f.jam = $('#jam').value; };
  $('#next').onclick = () => {
    f.tanggal = $('#tgl').value; f.jam = $('#jam').value;
    f.orang = parseInt($('#orang').value, 10) || 0;
    f.nama = $('#nm').value.trim(); f.hp = $('#hp').value.trim(); f.catatan = $('#ct').value.trim();
    const err = m => { $('#errBox').innerHTML = `<div class="notice bad" style="margin-top:10px">${esc(m)}</div>`; toast(m, 'bad'); };
    if (!f.nama || f.nama.length < 2) return err('Isi nama pemesan.');
    if (f.hp.replace(/\D/g, '').length < 8) return err('Nomor HP/WhatsApp belum lengkap.');
    if (!f.orang || f.orang < 1) return err('Isi jumlah orang.');
    if (!f.tanggal) return err('Pilih tanggal datang.');
    if (!f.jam) return err('Pilih jam datang.');
    st.step = 2; render();
  };
}

/* ---------- langkah 2: pesanan ---------- */
function renderStep2() {
  $('#app').innerHTML = `
    <div class="card" style="padding-bottom:8px">
      ${stepsBar()}
      <h2>Pilih menu</h2>
      <p class="muted" style="margin:0">Boleh dikosongkan — bisa juga memesan saat sudah datang.</p>
    </div>
    <div class="tools"><input class="search" id="q" type="search" placeholder="🔍  Cari menu…" autocomplete="off" value="${esc(st.q)}"></div>
    <div class="cats" id="cats"></div>
    <div id="menu"></div>
    <div class="bar" id="bar"></div>`;
  $('#q').oninput = e => { st.q = e.target.value; drawMenu(); };
  drawCats(); drawMenu(); drawBar();
}
function drawCats() {
  const cats = ['Semua', ...new Set(st.items.map(p => p.category))];
  $('#cats').innerHTML = cats.map(c => `<button type="button" class="${st.cat === c ? 'on' : ''}" data-c="${esc(c)}">${esc(c)}</button>`).join('');
  $$('#cats button').forEach(b => b.onclick = () => { st.cat = b.dataset.c; drawCats(); drawMenu(); });
}
function drawMenu() {
  const q = st.q.trim().toLowerCase();
  const list = st.items.filter(p => (st.cat === 'Semua' || p.category === st.cat) && (!q || `${p.name} ${p.category} ${p.variant}`.toLowerCase().includes(q)));
  $('#menu').innerHTML = list.length ? list.map(p => `<div class="item ${p.sold_out ? 'off' : ''}">
      ${photo(p.image_key)}
      <div class="in"><div class="nm">${esc(p.name)}${p.variant ? ` <span class="small muted">${esc(p.variant)}</span>` : ''}</div>
      <div class="ds">${esc(p.description || p.category)}</div>
      <div class="pr"><span>${rp(p.price)}</span><button class="add" data-add="${esc(p.id)}" ${p.sold_out ? 'disabled' : ''} aria-label="Tambah ${esc(p.name)}">+</button></div></div></div>`).join('')
    : '<div class="empty">Menu tidak ditemukan.</div>';
  $$('#menu [data-add]').forEach(b => b.onclick = () => { const p = prod(b.dataset.add); if (p) itemSheet(p); });
}
function drawBar() {
  const bar = $('#bar'); if (!bar) return;
  bar.innerHTML = `<button class="btn ghost" id="back">Kembali</button>
    <div class="grow" id="cartInfo" role="button" tabindex="0"><div class="small muted">${count()} porsi</div><b>${rp(subtotal())}</b></div>
    <button class="btn gold" id="next2">Lanjut</button>`;
  $('#back').onclick = () => { st.step = 1; render(); };
  $('#cartInfo').onclick = cartSheet;
  $('#next2').onclick = () => { st.step = 3; render(); };
}
function itemSheet(p) {
  const picked = new Map(); let qty = 1;
  p.groups.forEach(g => { if (g.min_select > 0 && g.options.length) picked.set(g.id, new Set([g.options[0].id])); });
  const chosen = () => p.groups.flatMap(g => [...(picked.get(g.id) || [])].map(id => { const o = g.options.find(z => z.id === id); return { id: o.id, name: o.name, delta: o.price_delta, group: g.name }; }));
  const lacking = () => p.groups.find(g => (picked.get(g.id)?.size || 0) < g.min_select);
  const draw = s => {
    const extra = chosen().reduce((a, o) => a + o.delta, 0), miss = lacking();
    $('.sheet-b', s).innerHTML = `${p.description ? `<p class="muted" style="margin:0 0 6px">${esc(p.description)}</p>` : ''}<b style="font-size:18px">${rp(p.price)}</b>` +
      p.groups.map(g => `<div class="group"><div class="h"><span>${esc(g.name)}</span><span class="small ${g.min_select > 0 ? 'pill gold' : 'muted'}">${g.min_select > 0 ? 'Wajib pilih' : 'Boleh dilewati'}${g.max_select > 1 ? ` · maks ${g.max_select}` : ''}</span></div>
        ${g.options.map(o => { const on = (picked.get(g.id) || new Set()).has(o.id); return `<button class="opt ${g.max_select > 1 ? 'multi' : ''} ${on ? 'on' : ''}" data-g="${esc(g.id)}" data-o="${esc(o.id)}"><span class="box"></span><span>${esc(o.name)}</span><span class="pl">${o.price_delta ? signed(o.price_delta) : ''}</span></button>`; }).join('')}</div>`).join('');
    $('.sheet-f', s).innerHTML = `<div class="step"><button data-q="-1" aria-label="Kurangi">−</button><b>${qty}</b><button data-q="1" aria-label="Tambah">+</button></div><button class="btn gold" data-add ${miss ? 'disabled' : ''}>${miss ? `Pilih ${esc(miss.name)} dulu` : `Tambah · ${rp((p.price + extra) * qty)}`}</button>`;
    $$('.opt', s).forEach(b => b.onclick = () => {
      const g = p.groups.find(x => x.id === b.dataset.g), id = b.dataset.o, set = picked.get(g.id) || new Set();
      if (g.max_select > 1) { if (set.has(id)) set.delete(id); else if (set.size < g.max_select) set.add(id); else toast(`${g.name}: maksimal ${g.max_select} pilihan`, 'bad'); }
      else if (set.has(id) && g.min_select === 0) set.clear(); else { set.clear(); set.add(id); }
      picked.set(g.id, set); draw(s);
    });
    $$('[data-q]', s).forEach(b => b.onclick = () => { qty = Math.min(50, Math.max(1, qty + parseInt(b.dataset.q, 10))); draw(s); });
    $('[data-add]', s).onclick = () => { add(p, chosen(), qty); closeSheet(); toast(`${p.name} ditambahkan`, 'ok'); };
  };
  openSheet(p.name, '', ' ', draw);
}
function cartSheet() {
  if (!count()) return toast('Belum ada menu dipilih.', '');
  const draw = s => {
    $('.sheet-b', s).innerHTML = `<div id="cerr"></div>` + st.cart.map(l => `<div class="cl"><div class="info"><b>${esc(prod(l.pid)?.name || '?')}</b>${l.opts.length ? `<div class="op">${esc(optLabel(l.opts))}</div>` : ''}<div class="small muted">${rp(unit(l))} × ${l.qty} = <b>${rp(unit(l) * l.qty)}</b></div></div><div class="step"><button data-k="${esc(l.key)}" data-d="-1" aria-label="Kurangi">−</button><b>${l.qty}</b><button data-k="${esc(l.key)}" data-d="1" aria-label="Tambah">+</button></div></div>`).join('')
      + `<div class="sum"><span>Perkiraan total</span><b>${rp(subtotal())}</b></div><div class="note">Total akhir dihitung kasir saat konfirmasi.</div>`;
    $('.sheet-f', s).innerHTML = `<button class="btn ghost" data-x2>Tambah menu</button><button class="btn" data-x3>Selesai</button>`;
    $$('[data-k]', s).forEach(b => b.onclick = () => {
      const l = st.cart.find(x => x.key === b.dataset.k); l.qty += parseInt(b.dataset.d, 10);
      if (l.qty <= 0) st.cart = st.cart.filter(x => x !== l);
      if (l.qty > 50) l.qty = 50;
      st.reqId = null; drawBar(); if (!count()) return closeSheet(); draw(s);
    });
    $('[data-x2]', s).onclick = closeSheet;
    $('[data-x3]', s).onclick = closeSheet;
  };
  openSheet('Menu yang dipesan', '', ' ', draw);
}

/* ---------- langkah 3: ringkasan & kirim ---------- */
function renderStep3() {
  const f = st.form;
  const items = st.cart.map(l => `<div class="sum"><span>${l.qty}× ${esc(prod(l.pid)?.name || '?')}${l.opts.length ? ` <span class="small">(${esc(optLabel(l.opts))})</span>` : ''}</span><span>${rp(unit(l) * l.qty)}</span></div>`).join('');
  $('#app').innerHTML = `
    <div class="card">
      ${stepsBar()}
      <h2>Periksa reservasi</h2>
      <div class="review">
        <div><span>Tanggal</span><b>${esc(fmtTanggal(f.tanggal))}</b></div>
        <div><span>Jam</span><b>${esc(f.jam)}</b></div>
        <div><span>Jumlah orang</span><b>${f.orang} orang</b></div>
        <div><span>Nama</span><b>${esc(f.nama)}</b></div>
        <div><span>WhatsApp</span><b>${esc(f.hp)}</b></div>
        ${f.catatan ? `<div><span>Catatan</span><b>${esc(f.catatan)}</b></div>` : ''}
      </div>
      <button class="btn ghost sm" id="ubahData" style="margin-top:6px">Ubah data</button>
      <div class="sec-title" style="margin-top:16px">Pesanan</div>
      ${items || '<p class="muted" style="margin:0">Tanpa pre-order — memesan saat datang.</p>'}
      ${items ? `<div class="sum" style="margin-top:6px"><b>Perkiraan total</b><b>${rp(subtotal())}</b></div><button class="btn ghost sm" id="ubahMenu" style="margin-top:6px">Ubah pesanan</button>` : ''}
      <div id="errBox"></div>
      <button class="btn gold big block" id="kirim" style="margin-top:14px">Kirim reservasi</button>
      <button class="btn ghost block" id="kembali2" style="margin-top:8px">Kembali ke pesanan</button>
    </div>`;
  $('#ubahData').onclick = () => { st.step = 1; render(); };
  $('#ubahMenu')?.addEventListener('click', () => { st.step = 2; render(); });
  $('#kembali2').onclick = () => { st.step = 2; render(); };
  $('#kirim').onclick = kirim;
}
async function kirim() {
  if (st.busy) return;
  const f = st.form;
  const err = m => { const box = $('#errBox'); if (box) box.innerHTML = `<div class="notice bad">${esc(m)}</div>`; toast(m, 'bad'); };
  st.busy = true;
  const btn = $('#kirim'); btn.disabled = true; btn.textContent = 'Mengirim…';
  if (!st.reqId) st.reqId = crypto.randomUUID ? crypto.randomUUID() : 'r-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  try {
    const r = await api('/api/public/reservasi', {
      name: f.nama, phone: f.hp, party_size: f.orang, tanggal: f.tanggal, jam: f.jam, note: f.catatan, request_id: st.reqId,
      items: st.cart.map(l => ({ product_id: l.pid, quantity: l.qty, modifiers: l.opts.map(o => ({ id: o.id })) }))
    });
    saveToken(r.item.token);
    location.href = '/reservasi?t=' + encodeURIComponent(r.item.token);
  } catch (e) {
    st.busy = false; btn.disabled = false; btn.textContent = 'Kirim reservasi';
    if (e.status === 400 || e.status === 409) st.reqId = null;
    err(e.message);
  }
}

/* ---------- halaman status ---------- */
const STATUS_PILL = { baru: 'gold', ubah: 'warn', disetujui: 'ok', ditolak: 'bad', datang: 'ok', selesai: 'ok', batal: 'bad', tidak_datang: 'bad' };
async function statusView(token, dariSimpanan) {
  let r;
  try {
    r = (await api('/api/public/reservasi/' + encodeURIComponent(token))).item;
    st.info = await api('/api/public/reservasi/info').catch(() => null);
  } catch (e) {
    if (dariSimpanan) { removeToken(token); return false; }
    $('#app').innerHTML = `<div class="card"><h2>Reservasi tidak ditemukan</h2><p class="muted">${esc(e.message)}</p><a class="btn block" href="/reservasi?baru=1">Buat reservasi baru</a></div>`;
    return false;
  }
  st.token = token; saveToken(token);
  clearInterval(st.poll);
  $('#outlet').textContent = 'Kopi Sawah';
  const pill = STATUS_PILL[r.status] || '';
  const items = (r.items || []).map(i => `<div class="sum"><span>${i.quantity}× ${esc(i.name_snapshot)}${i.modifiers_summary ? ` <span class="small">(${esc(i.modifiers_summary)})</span>` : ''}</span><span>${rp(i.line_total)}</span></div>`).join('');
  const ubah = r.status === 'ubah' ? `
    <div class="note" style="background:var(--warn-soft);color:#6b4600">
      <b>Kasir menawarkan jam ${esc(r.proposed_jam)}.</b><br>Alasan: ${esc(r.change_reason || '-')}
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn" id="terima">Setuju, jam ${esc(r.proposed_jam)}</button>
        <button class="btn ghost" id="tolak">Tidak bisa</button>
      </div>
    </div>` : '';
  const waText = `Halo Kopi Sawah, saya ${r.name}. Reservasi ${r.id} tanggal ${r.tanggal} jam ${r.jam} untuk ${r.party_size} orang. Mohon konfirmasinya. Terima kasih.`;
  const wa = st.info?.wa ? waLink(st.info.wa, waText) : '';
  $('#app').innerHTML = `
    <div class="card">
      <div class="status-line"><span class="pill ${pill}">${esc(r.status_name)}</span><span class="small muted">${esc(r.tanggal)} · ${esc(r.jam)}</span></div>
      <div class="big-code">${esc(r.id)}</div>
      <p class="muted" style="margin:0 0 8px">${esc(r.name)} · ${r.party_size} orang${r.table_label ? ' · ' + esc(r.table_label) : ''}</p>
      ${ubah}
      ${r.status === 'baru' ? '<div class="note">Menunggu konfirmasi kasir. Halaman ini memperbarui sendiri; tidak perlu di-refresh.</div>' : ''}
      ${r.status === 'ditolak' ? `<div class="note" style="background:var(--bad-soft);color:#7a2a18">Ditolak: ${esc(r.reject_reason || '-')}</div>` : ''}
      ${r.status === 'disetujui' ? `<div class="note">Disetujui. Datang pukul ${esc(r.jam)}${r.table_label ? ', meja ' + esc(r.table_label) : ''}. ${esc(st.info?.info_bayar || '')}</div>` : ''}
      ${r.status === 'batal' ? `<div class="note" style="background:var(--bad-soft);color:#7a2a18">Reservasi dibatalkan. ${esc(r.kasir_note || '')}</div>` : ''}
      ${r.kasir_note && r.status !== 'batal' ? `<p class="small muted">Catatan kasir: ${esc(r.kasir_note)}</p>` : ''}
      ${items ? `<div class="sec-title" style="margin-top:14px">Menu yang dipesan</div>${items}<div class="sum"><b>Perkiraan total</b><b>${rp(r.total_estimate)}</b></div>` : ''}
      ${r.dp_amount ? `<div class="sum"><span>DP tercatat</span><b>${rp(r.dp_amount)}</b></div>` : ''}
      ${['baru', 'ubah', 'disetujui', 'datang'].includes(r.status) ? `<div class="note">${esc(st.info?.info_bayar || 'Pembayaran bisa di kasir, transfer DP atau QRIS. Konfirmasi pembayaran lewat WhatsApp.')}</div>` : ''}
      ${wa ? `<a class="btn gold block" style="margin-top:12px" target="_blank" rel="noopener" href="${wa}">Kirim ke WhatsApp kasir</a>` : ''}
      ${dariSimpanan ? '<p class="small muted" style="margin-top:10px">Ini reservasi terakhir yang tersimpan di perangkat ini.</p>' : '<p class="small muted" style="margin-top:10px">Simpan halaman ini untuk melihat status reservasi.</p>'}
      <a class="btn ghost block" style="margin-top:10px" href="/reservasi?baru=1">Buat reservasi baru</a>
    </div>`;
  if (ubah) {
    $('#terima').onclick = () => jawab(true);
    $('#tolak').onclick = () => jawab(false);
  }
  if (['baru', 'ubah', 'disetujui'].includes(r.status)) {
    st.poll = setInterval(async () => {
      try {
        const now = (await api('/api/public/reservasi/' + encodeURIComponent(token))).item;
        if (now.status !== r.status || now.jam !== r.jam || now.proposed_jam !== r.proposed_jam) statusView(token, dariSimpanan);
      } catch { /* coba lagi nanti */ }
    }, 20000);
  }
  return true;
}
async function jawab(terima) {
  try {
    await api('/api/public/reservasi/' + encodeURIComponent(st.token || TOKEN) + '/jawab', { terima });
    toast(terima ? 'Jam baru disetujui' : 'Reservasi dibatalkan', terima ? 'ok' : '');
    statusView(st.token || TOKEN);
  } catch (e) { toast(e.message, 'bad'); }
}

/* ---------- mulai ---------- */
(async () => {
  try {
    if (TOKEN) { await statusView(TOKEN, false); return; }
    if (!MULAI_BARU) {
      for (const it of getTokens()) {
        if (await statusView(it.token, true)) return;
      }
    }
    await formView();
  } catch (e) {
    $('#app').innerHTML = `<div class="card"><h2>Tidak bisa memuat</h2><div class="notice bad">${esc(e.message)}</div><button class="btn block" onclick="location.reload()">Coba lagi</button></div>`;
  }
})();
