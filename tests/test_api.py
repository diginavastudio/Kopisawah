"""Uji API Kopi Sawah. Menjalankan server sungguhan di port acak dengan DB sementara.

Ini DATA TIRUAN di DB sementara — bukan uji terhadap server/DB toko yang hidup.
Jalankan:  python3 -m unittest discover -s tests -v
"""
import http.cookiejar
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
SETUP_CODE = "12345678"
OWNER_PIN = "482916"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Client:
    def __init__(self, port):
        self.port = port
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def call(self, method, path, payload=None, origin=True, raw=False, ip=None):
        data = None if payload is None else json.dumps(payload).encode()
        headers = {"Content-Type": "application/json"}
        if ip:
            headers["X-Real-IP"] = ip
        if origin:
            headers["Origin"] = f"http://127.0.0.1:{self.port}"
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method, headers=headers)
        try:
            with self.opener.open(req, timeout=10) as r:
                body = r.read()
                return r.status, (body if raw else json.loads(body.decode())), r.headers
        except urllib.error.HTTPError as e:
            body = e.read()
            return e.code, (body if raw else json.loads(body.decode())), e.headers


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.port = free_port()
        env = {**os.environ, "KOPI_SAWAH_PORT": str(cls.port), "KOPI_SAWAH_DB": str(Path(cls.tmp.name) / "t.sqlite3"),
               "KOPI_SAWAH_REQUIRE_ORIGIN": "1", "KOPI_SAWAH_SETUP_CODE": SETUP_CODE}
        cls.proc = subprocess.Popen([sys.executable, str(PROJECT / "app.py")], env=env,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        for _ in range(80):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/api/health", timeout=1)
                break
            except Exception:
                time.sleep(0.1)
        else:
            raise RuntimeError("server tidak naik")

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(5)
        cls.tmp.cleanup()

    # --- urutan tes dijaga lewat nama (test_01 ... ) karena berbagi satu DB
    def test_01_belum_login_ditolak_dan_setup(self):
        c = Client(self.port)
        self.assertEqual(c.call("GET", "/api/products")[0], 401)
        self.assertEqual(c.call("POST", "/api/sales", {})[0], 401)
        st, body, _ = c.call("GET", "/api/auth/status")
        self.assertTrue(body["setup_required"])
        st, body, _ = c.call("POST", "/api/auth/setup", {"name": "Digi", "pin": OWNER_PIN, "setup_code": "00000000"})
        self.assertEqual(st, 403)
        st, body, _ = c.call("POST", "/api/auth/setup", {"name": "Digi", "pin": "111111", "setup_code": SETUP_CODE})
        self.assertEqual(st, 400, "PIN berulang harus ditolak")
        st, body, hdr = c.call("POST", "/api/auth/setup", {"name": "Digi", "pin": OWNER_PIN, "setup_code": SETUP_CODE})
        self.assertEqual(st, 201)
        self.assertIn("HttpOnly", hdr["Set-Cookie"])
        self.assertIn("SameSite=Strict", hdr["Set-Cookie"])
        st, _, _ = Client(self.port).call("POST", "/api/auth/setup", {"name": "X", "pin": "482917", "setup_code": SETUP_CODE})
        self.assertEqual(st, 409, "setup tidak boleh dipakai dua kali")

    def test_02_origin_asing_ditolak(self):
        c = self.login("Digi", OWNER_PIN)
        self.assertEqual(c.call("POST", "/api/shifts/open", {"opening_cash": 0}, origin=False)[0], 403)

    def login(self, name, pin):
        c = Client(self.port)
        staff = c.call("GET", "/api/auth/status")[1]["staff"]
        uid = next(s["id"] for s in staff if s["name"] == name)
        st, body, _ = c.call("POST", "/api/auth/login", {"user_id": uid, "pin": pin})
        self.assertEqual(st, 200, body)
        return c

    def products(self, c):
        return {p["name"]: p for p in c.call("GET", "/api/products")[1]["items"]}

    def test_03_peran_dan_shift(self):
        owner = self.login("Digi", OWNER_PIN)
        st, b, _ = owner.call("POST", "/api/users", {"name": "Sari", "role": "kasir", "pin": "2468"})
        self.assertEqual(st, 201, b)
        kasir = self.login("Sari", "2468")
        # kasir tidak boleh mengubah harga / melihat laporan / mengelola tim
        pid = self.products(kasir)["Es Teh"]["id"]
        self.assertEqual(kasir.call("PUT", f"/api/products/{pid}", {"price": 1})[0], 403)
        self.assertEqual(kasir.call("GET", "/api/reports/summary")[0], 403)
        self.assertEqual(kasir.call("GET", "/api/users")[0], 403)
        self.assertEqual(kasir.call("GET", "/api/admin/backup", raw=True)[0], 403)
        self.assertNotIn("cost", self.products(kasir)["Es Teh"], "HPP tidak boleh bocor ke kasir")
        # belum buka kasir -> tidak bisa jual
        body = {"items": [{"product_id": pid, "quantity": 1, "modifiers": []}], "payment_method": "qris"}
        self.assertEqual(kasir.call("POST", "/api/sales", body)[0], 409)

    def test_04_penjualan_hitungan_dan_kembalian(self):
        owner = self.login("Digi", OWNER_PIN)
        kasir = self.login("Sari", "2468")
        self.assertEqual(kasir.call("POST", "/api/shifts/open", {"opening_cash": 100000})[0], 201)
        self.assertEqual(kasir.call("POST", "/api/shifts/open", {"opening_cash": 1})[0], 409)
        p = self.products(owner)
        nasgor = p["Nasi Goreng Original"]  # Rp20.000, kategori Makanan (varian: sambal opsional)
        # tunai kurang -> ditolak
        item = [{"product_id": nasgor["id"], "quantity": 2, "modifiers": []}]
        st, b, _ = kasir.call("POST", "/api/sales", {"items": item, "payment_method": "tunai", "amount_paid": 39000})
        self.assertEqual(st, 400, b)
        st, b, _ = kasir.call("POST", "/api/sales", {"items": item, "payment_method": "tunai", "amount_paid": 50000, "request_id": "req-aaaa-0001"})
        self.assertEqual(st, 201, b)
        sale = b["item"]
        self.assertEqual((sale["subtotal"], sale["total_amount"], sale["change_amount"]), (40000, 40000, 10000))
        self.assertRegex(sale["id"], r"^KS\d{6}-001$")
        # kunci idempoten: kirim ulang tidak membuat transaksi baru
        st, b, _ = kasir.call("POST", "/api/sales", {"items": item, "payment_method": "tunai", "amount_paid": 50000, "request_id": "req-aaaa-0001"})
        self.assertEqual((st, b.get("duplicate")), (200, True))
        self.assertEqual(len(owner.call("GET", "/api/sales")[1]["items"]), 1)

    def test_05_pajak_service_pembulatan_diskon(self):
        owner = self.login("Digi", OWNER_PIN)
        kasir = self.login("Sari", "2468")
        nasgor = self.products(owner)["Nasi Goreng Original"]
        item = [{"product_id": nasgor["id"], "quantity": 1, "modifiers": []}]
        # kasir tidak boleh diskon sebelum pemilik mengizinkan
        d = {"type": "percent", "value": 10, "reason": "teman"}
        self.assertEqual(kasir.call("POST", "/api/sales", {"items": item, "payment_method": "qris", "discount": d})[0], 403)
        self.assertEqual(kasir.call("PUT", "/api/settings", {"tax_percent": "10"})[0], 403)
        st, b, _ = owner.call("PUT", "/api/settings", {"tax_percent": "10", "service_percent": "5", "rounding": "100", "kasir_max_discount_percent": "10"})
        self.assertEqual(st, 200, b)
        # 20.000 -> service 1.000 -> pajak 10% dari 21.000 = 2.100 -> 23.100
        st, b, _ = kasir.call("POST", "/api/sales", {"items": item, "payment_method": "qris"})
        self.assertEqual(st, 201, b)
        s = b["item"]
        self.assertEqual((s["service_amount"], s["tax_amount"], s["total_amount"], s["amount_paid"]), (1000, 2100, 23100, 23100))
        # diskon 10% = 2.000 -> dasar 18.000 -> service 900 -> pajak 1.890 -> 20.790 -> dibulatkan 20.800
        st, b, _ = kasir.call("POST", "/api/sales", {"items": item, "payment_method": "qris", "discount": d})
        self.assertEqual(st, 201, b)
        s = b["item"]
        self.assertEqual((s["discount_amount"], s["service_amount"], s["tax_amount"], s["rounding_amount"], s["total_amount"]),
                         (2000, 900, 1890, 10, 20800))
        # lebih dari batas kasir
        d50 = {"type": "percent", "value": 50, "reason": "x"}
        self.assertEqual(kasir.call("POST", "/api/sales", {"items": item, "payment_method": "qris", "discount": d50})[0], 403)
        self.assertEqual(kasir.call("POST", "/api/sales", {"items": item, "payment_method": "qris", "discount": {"type": "percent", "value": 5}})[0], 400, "alasan wajib")
        owner.call("PUT", "/api/settings", {"tax_percent": "0", "service_percent": "0", "rounding": "0"})

    def test_06_varian_dan_stok(self):
        owner = self.login("Digi", OWNER_PIN)
        kasir = self.login("Sari", "2468")
        p = self.products(owner)
        kopi = p["Coffee Latte"]  # Es / Panas → punya pilihan Suhu
        # varian wajib belum dipilih -> ditolak
        st, b, _ = kasir.call("POST", "/api/sales", {"items": [{"product_id": kopi["id"], "quantity": 1, "modifiers": []}], "payment_method": "qris"})
        self.assertEqual(st, 400, b)
        mods = [{"id": "suhu-1"}, {"id": "gula-1"}, {"id": "es-1"}, {"id": "ukuran-2"}, {"id": "susu-2"}]  # Large +5k, Oat +5k
        self.assertEqual(kasir.call("POST", "/api/sales", {"items": [{"product_id": kopi["id"], "quantity": 1, "modifiers": mods + [{"id": "asal-1"}]}], "payment_method": "qris"})[0], 400, "pilihan milik menu lain ditolak")
        st, b, _ = kasir.call("POST", "/api/sales", {"items": [{"product_id": kopi["id"], "quantity": 1, "modifiers": mods}], "payment_method": "qris"})
        self.assertEqual(st, 201, b)
        self.assertEqual(b["item"]["subtotal"], kopi["price"] + 10000)
        summary = b["item"]["items"][0]["modifiers_summary"]
        self.assertIn("Level Gula Normal", summary)  # "Normal" ganda diberi nama kelompok
        self.assertIn("Level Es Normal", summary)
        # stok: dua baris produk sama dengan varian berbeda dihitung gabungan
        tea = p["Es Teh"]
        self.assertEqual(kasir.call("POST", "/api/stock/count", {"product_id": tea["id"], "counted_quantity": 5})[0], 403)
        self.assertEqual(owner.call("POST", "/api/stock/count", {"product_id": tea["id"], "counted_quantity": 5})[0], 201)
        two = [{"product_id": tea["id"], "quantity": 3, "modifiers": [{"id": "gula-1"}, {"id": "es-1"}, {"id": "ukuran-1"}]},
               {"product_id": tea["id"], "quantity": 3, "modifiers": [{"id": "gula-2"}, {"id": "es-1"}, {"id": "ukuran-1"}]}]
        st, b, _ = kasir.call("POST", "/api/sales", {"items": two, "payment_method": "qris"})
        self.assertEqual(st, 409, "6 > stok 5 harus ditolak walau dipecah dua baris")
        one = [dict(two[0], quantity=5)]
        st, b, _ = kasir.call("POST", "/api/sales", {"items": one, "payment_method": "qris"})
        self.assertEqual(st, 201, b)
        sale_id = b["item"]["id"]
        self.assertEqual(self.products(owner)["Es Teh"]["stock_on_hand"], 0)
        # menu ditandai habis -> ditolak
        self.assertEqual(kasir.call("POST", f"/api/products/{kopi['id']}/availability", {"available": False})[0], 200)
        st, b, _ = kasir.call("POST", "/api/sales", {"items": [{"product_id": kopi["id"], "quantity": 1, "modifiers": mods}], "payment_method": "qris"})
        self.assertEqual(st, 409)
        kasir.call("POST", f"/api/products/{kopi['id']}/availability", {"available": True})
        # void mengembalikan stok; hanya pemilik
        self.assertEqual(kasir.call("POST", f"/api/sales/{sale_id}/void", {"reason": "salah"})[0], 403)
        self.assertEqual(owner.call("POST", f"/api/sales/{sale_id}/void", {})[0], 400)
        self.assertEqual(owner.call("POST", f"/api/sales/{sale_id}/void", {"reason": "salah input"})[0], 200)
        self.assertEqual(self.products(owner)["Es Teh"]["stock_on_hand"], 5)
        self.assertEqual(owner.call("POST", f"/api/sales/{sale_id}/void", {"reason": "lagi"})[0], 409)

    def test_07_laporan_csv_cadangan(self):
        owner = self.login("Digi", OWNER_PIN)
        owner.call("PUT", f"/api/products/{self.products(owner)['Nasi Goreng Original']['id']}", {"cost": 8000})
        kasir = self.login("Sari", "2468")
        nasgor = self.products(owner)["Nasi Goreng Original"]
        kasir.call("POST", "/api/sales", {"items": [{"product_id": nasgor["id"], "quantity": 1, "modifiers": []}], "payment_method": "qris"})
        st, r, _ = owner.call("GET", "/api/reports/range")
        self.assertEqual(st, 200)
        self.assertGreaterEqual(r["transactions"], 4)
        self.assertEqual(r["void_count"], 1)
        self.assertTrue(r["by_method"] and r["top"] and r["by_hour"])
        self.assertEqual(r["gross_profit_known"], r["revenue_with_cost"] - r["cost_known"])
        self.assertEqual(owner.call("GET", "/api/reports/range?from=2026-02-01&to=2026-01-01")[0], 400)
        st, raw, hdr = owner.call("GET", "/api/reports/export.csv", raw=True)
        self.assertEqual(st, 200)
        self.assertIn("text/csv", hdr["Content-Type"])
        self.assertIn(b"No. Nota", raw)
        st, raw, _ = owner.call("GET", "/api/admin/backup", raw=True)
        self.assertEqual((st, raw[:2]), (200, b"PK"))
        import io, zipfile
        names = zipfile.ZipFile(io.BytesIO(raw)).namelist()
        self.assertIn("kopi-sawah.sqlite3", names)
        self.assertEqual(owner.call("GET", "/api/audit")[1]["items"][0]["action"], "unduh_cadangan")
        st, s, _ = owner.call("GET", "/api/reports/summary")
        self.assertEqual(st, 200)
        self.assertEqual(len(s["series"]), 7)

    def test_08_tutup_kasir_dan_riwayat_kasir(self):
        kasir = self.login("Sari", "2468")
        st, cur, _ = kasir.call("GET", "/api/shifts/current")
        sh = cur["shift"]
        cash_sales = sum(m["total"] for m in sh["by_method"] if m["payment_method"] == "tunai")
        noncash = sum(m["total"] for m in sh["by_method"] if m["payment_method"] != "tunai")
        self.assertEqual(sh["expected_cash"], 100000 + cash_sales)
        self.assertEqual(cash_sales, 40000)
        self.assertEqual(sh["expected_noncash"], noncash, "QRIS/transfer dihitung terpisah dari laci")
        self.assertEqual(len(kasir.call("GET", "/api/sales")[1]["items"]), 6)  # termasuk 1 transaksi batal
        st, closed, _ = kasir.call("POST", "/api/shifts/close", {"counted_cash": 139000, "counted_noncash": noncash - 500, "note": "kurang seribu"})
        self.assertEqual(st, 200, closed)
        self.assertEqual((closed["shift"]["expected_cash"], closed["shift"]["difference"]), (140000, -1000))
        self.assertEqual((closed["shift"]["counted_noncash"], closed["shift"]["difference_noncash"]), (noncash - 500, -500))
        item = [{"product_id": self.products(kasir)["Nasi Goreng Original"]["id"], "quantity": 1, "modifiers": []}]
        self.assertEqual(kasir.call("POST", "/api/sales", {"items": item, "payment_method": "qris"})[0], 409, "setelah tutup kasir tidak bisa jual")

    def test_08b_kemasan_hanya_makanan(self):
        owner = self.login("Digi", OWNER_PIN)
        kasir = self.login("Sari", "2468")
        st, cur, _ = kasir.call("GET", "/api/shifts/current")
        if not cur.get("shift"):
            self.assertEqual(kasir.call("POST", "/api/shifts/open", {"opening_cash": 0})[0], 201)
        p = self.products(owner)
        air, nasgor, teh = p["Air Es"], p["Nasi Goreng Original"], p["Es Teh"]
        teh_mods = [{"id": "gula-1"}, {"id": "es-1"}, {"id": "ukuran-1"}]
        # minuman saja -> tanpa biaya kemasan
        st, b, _ = kasir.call("POST", "/api/sales", {"items": [{"product_id": teh["id"], "quantity": 2, "modifiers": teh_mods}],
                                                     "payment_method": "qris", "order_type": "take_away"})
        self.assertEqual(st, 201, b)
        self.assertEqual(b["item"]["packing_fee"], 0, "minuman tidak dikenai biaya kemasan")
        # add-on (air es) juga tanpa biaya kemasan
        st, b, _ = kasir.call("POST", "/api/sales", {"items": [{"product_id": air["id"], "quantity": 1, "modifiers": []}],
                                                     "payment_method": "qris", "order_type": "take_away"})
        self.assertEqual(st, 201, b)
        self.assertEqual(b["item"]["packing_fee"], 0, "add-on bukan makanan")
        # makanan -> kena biaya kemasan
        st, b, _ = kasir.call("POST", "/api/sales", {"items": [{"product_id": nasgor["id"], "quantity": 1, "modifiers": []}],
                                                     "payment_method": "qris", "order_type": "take_away"})
        self.assertEqual(st, 201, b)
        self.assertEqual(b["item"]["packing_fee"], 1000)
        # per item: hanya makanan yang dihitung
        self.assertEqual(owner.call("PUT", "/api/settings", {"packing_fee_per": "item"})[0], 200)
        st, b, _ = kasir.call("POST", "/api/sales", {"items": [{"product_id": nasgor["id"], "quantity": 2, "modifiers": []},
                                                              {"product_id": teh["id"], "quantity": 3, "modifiers": teh_mods}],
                                                     "payment_method": "qris", "order_type": "take_away"})
        self.assertEqual(st, 201, b)
        self.assertEqual(b["item"]["packing_fee"], 2000, "3 minuman tidak ikut dihitung")
        owner.call("PUT", "/api/settings", {"packing_fee_per": "order"})
        # makan di tempat tidak kena
        st, b, _ = kasir.call("POST", "/api/sales", {"items": [{"product_id": nasgor["id"], "quantity": 1, "modifiers": []}],
                                                     "payment_method": "qris", "order_type": "dine_in"})
        self.assertEqual(st, 201, b)
        self.assertEqual(b["item"]["packing_fee"], 0)

    def test_09_pin_throttle_dan_logout(self):
        self.login("Digi", OWNER_PIN).call("POST", "/api/users", {"name": "Budi", "role": "kasir", "pin": "1357"})
        c = Client(self.port)
        staff = c.call("GET", "/api/auth/status")[1]["staff"]
        uid = next(s["id"] for s in staff if s["name"] == "Budi")  # akun khusus uji kunci, agar Sari tidak ikut terkunci
        codes = [c.call("POST", "/api/auth/login", {"user_id": uid, "pin": "0000"})[0] for _ in range(5)]
        self.assertEqual(codes, [401] * 5)
        self.assertEqual(c.call("POST", "/api/auth/login", {"user_id": uid, "pin": "1357"})[0], 429, "terkunci walau PIN benar")
        owner = self.login("Digi", OWNER_PIN)
        self.assertEqual(owner.call("POST", "/api/auth/logout")[0], 200)
        self.assertEqual(owner.call("GET", "/api/products")[0], 401)

    def test_10_pemilik_terakhir_tidak_bisa_dinonaktifkan(self):
        owner = self.login("Digi", OWNER_PIN)
        me = next(u for u in owner.call("GET", "/api/users")[1]["items"] if u["name"] == "Digi")
        self.assertEqual(owner.call("PUT", f"/api/users/{me['id']}", {"active": False})[0], 409)
        self.assertEqual(owner.call("PUT", f"/api/users/{me['id']}", {"role": "kasir"})[0], 409)

    def test_11_halaman_statis_dan_header(self):
        c = Client(self.port)
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/") as r:
            self.assertEqual(r.status, 200)
            self.assertIn("Content-Security-Policy", r.headers)
            self.assertIn("connect-src 'self' http://localhost:9100", r.headers["Content-Security-Policy"])
        self.assertEqual(c.call("GET", "/static/../app.py", raw=True)[0], 404)
        self.assertEqual(c.call("GET", "/static/%2e%2e/app.py", raw=True)[0], 404)


    # ------------------------------------------------------------------ Menu Baru
    def test_12_katalog_menu_baru(self):
        owner = self.login("Digi", OWNER_PIN)
        p = self.products(owner)
        self.assertIn("Air Es", p)
        self.assertNotIn("Oriental", p, "judul halaman sampul bukan menu")
        self.assertEqual(p["Air Es"]["price"], 1000)
        self.assertEqual(p["Bakmi Goreng"]["image_key"], "bakmi-goreng")
        self.assertEqual(p["Nasi Goreng Original"]["image_key"], "none", "tanpa foto PDF → tidak memakai foto lain")
        self.assertTrue(p["Nasi Goreng Original"]["description"])
        self.assertTrue(p["Ayam Goreng"]["featured"])
        mods = owner.call("GET", "/api/modifiers")[1]
        self.assertEqual(mods["categories"]["Wedangan"], ["gula"])
        cap = p["Cappucino"]  # baris Es dan Panas masih dua menu
        self.assertIn(cap["id"], mods["product_groups"])
        self.assertNotIn("suhu", mods["product_groups"][cap["id"]], "Suhu ganda dengan baris Es/Panas sudah dihapus")
        udang = p["Udang Krispy"]
        self.assertIn("nasi", mods["product_groups"][udang["id"]])
        nasi = next(g for g in mods["groups"] if g["id"] == "nasi")
        self.assertEqual([o["price_delta"] for o in nasi["options"]], [0, -4000])

    def test_13_tanpa_nasi_harga_negatif(self):
        owner = self.login("Digi", OWNER_PIN)
        owner.call("POST", "/api/shifts/open", {"opening_cash": 0})
        udang = self.products(owner)["Udang Krispy"]
        mk = lambda nasi: [{"product_id": udang["id"], "quantity": 1, "modifiers": [{"id": nasi}]}]
        st, b, _ = owner.call("POST", "/api/sales", {"items": mk("nasi-2"), "payment_method": "qris"})
        self.assertEqual((st, b["item"]["subtotal"]), (201, 25000), b)
        st, b, _ = owner.call("POST", "/api/sales", {"items": mk("nasi-1"), "payment_method": "qris"})
        self.assertEqual(b["item"]["subtotal"], 29000)
        self.assertIn("Tanpa nasi (−4rb)", owner.call("GET", "/api/sales")[1]["items"][1]["items"][0]["modifiers_summary"])

    def test_14_pilihan_khusus_menu_dan_foto(self):
        owner = self.login("Digi", OWNER_PIN)
        kasir = self.login("Sari", "2468")
        tea = self.products(owner)["Es Teh"]
        self.assertEqual(owner.call("PUT", f"/api/products/{tea['id']}/modifiers", {"mode": "custom", "group_ids": ["gula"]})[0], 200)
        self.assertEqual(owner.call("PUT", f"/api/products/{tea['id']}/modifiers", {"mode": "custom", "group_ids": ["nope"]})[0], 400)
        self.assertEqual(kasir.call("PUT", f"/api/products/{tea['id']}/modifiers", {"mode": "category", "group_ids": []})[0], 403)
        self.assertIn(tea["id"], owner.call("GET", "/api/modifiers")[1]["product_groups"])
        # unggah foto: harus JPEG
        import base64
        jpeg = b"\xff\xd8\xff\xe0" + b"\x00" * 2000
        st, b, _ = owner.call("POST", f"/api/products/{tea['id']}/photo", {"image": "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()})
        self.assertEqual(st, 200, b)
        key = b["image_key"]
        self.assertRegex(key, r"^up-[0-9a-f]{12}$")
        st, raw, hdr = Client(self.port).call("GET", f"/media/{key}.jpg", raw=True)
        self.assertEqual((st, raw[:3]), (200, b"\xff\xd8\xff"))
        self.assertEqual(owner.call("POST", f"/api/products/{tea['id']}/photo", {"image": "data:image/png;base64,AAAA"})[0], 400)
        self.assertEqual(kasir.call("POST", f"/api/products/{tea['id']}/photo", {"image": "x"})[0], 403)
        self.assertEqual(self.products(owner)["Es Teh"]["image_key"], key)

    # ------------------------------------------------------------------ QR meja
    def test_15_qr_meja_dari_pelanggan_ke_kasir(self):
        owner = self.login("Digi", OWNER_PIN)
        kasir = self.login("Sari", "2468")
        anon = Client(self.port)
        # meja: hanya pemilik yang membuat; kasir tidak melihat token
        self.assertEqual(kasir.call("POST", "/api/tables", {"count": 2})[0], 403)
        self.assertEqual(owner.call("POST", "/api/tables", {"count": 3, "prefix": "Meja"})[0], 201)
        self.assertEqual(owner.call("POST", "/api/tables", {"label": "Meja 1"})[0], 409)
        tables = owner.call("GET", "/api/tables")[1]["items"]
        self.assertEqual([t["label"] for t in tables], ["Meja 1", "Meja 2", "Meja 3"])
        self.assertTrue(all("token" not in t for t in kasir.call("GET", "/api/tables")[1]["items"]))
        tok = tables[0]["token"]
        # menu publik tanpa login
        self.assertEqual(anon.call("GET", "/api/public/menu?t=salah")[0], 404)
        st, menu, _ = anon.call("GET", f"/api/public/menu?t={tok}")
        self.assertEqual(st, 200)
        self.assertEqual(menu["table"]["label"], "Meja 1")
        names = {i["name"]: i for i in menu["items"]}
        self.assertNotIn("cost", names["Bakmi Goreng"])
        self.assertNotIn("stock_on_hand", names["Bakmi Goreng"])
        self.assertEqual(menu["items"][0]["category"], "Makanan", "urutan kategori sesuai kartu menu")
        # kirim pesanan: harga dari klien diabaikan
        bakmi = names["Bakmi Goreng"]
        body = {"t": tok, "customer_name": "Bu Sari", "note": "tanpa seledri", "request_id": "cust-req-0001",
                "items": [{"product_id": bakmi["id"], "quantity": 2, "modifiers": [], "price": 1}]}
        st, r, _ = anon.call("POST", "/api/public/orders", body)
        self.assertEqual(st, 201, r)
        order = r["order"]
        self.assertEqual((order["status"], order["subtotal"], order["table_label"]), ("pending", 40000, "Meja 1"))
        st, again, _ = anon.call("POST", "/api/public/orders", body)
        self.assertEqual((st, again.get("duplicate")), (200, True), "kirim ulang tidak membuat pesanan baru")
        # pilihan wajib & stok tetap diperiksa
        v = names["Capcay"]
        self.assertEqual(anon.call("POST", "/api/public/orders", {"t": tok, "items": [{"product_id": v["id"], "quantity": 1}]})[0], 400)
        self.assertEqual(anon.call("POST", "/api/public/orders", {"t": tok, "items": [{"product_id": bakmi["id"], "quantity": 99}]})[0], 400)
        self.assertEqual(anon.call("POST", "/api/public/orders", {"t": tok, "items": [{"product_id": "nope", "quantity": 1}]})[0], 404)
        # kasir melihat & memproses
        self.assertEqual(kasir.call("GET", "/api/orders/summary")[1]["pending"], 1)
        orders = kasir.call("GET", "/api/orders")[1]["orders"]
        self.assertEqual([o["id"] for o in orders], [order["id"]])
        oid = order["id"]
        pay = {"order_ids": [oid], "payment_method": "qris"}
        self.assertEqual(owner.call("POST", "/api/sales", pay)[0], 409, "belum diterima → belum bisa dibayar")
        self.assertEqual(kasir.call("POST", f"/api/orders/{oid}/status", {"status": "ready"})[0], 409, "tak boleh loncat dari pending ke siap")
        self.assertEqual(kasir.call("POST", f"/api/orders/{oid}/status", {"status": "accepted"})[0], 200)
        self.assertEqual(anon.call("GET", f"/api/public/orders?t={tok}&ids={oid}")[1]["orders"][0]["status"], "accepted")
        self.assertEqual(anon.call("GET", f"/api/public/orders?t={tables[1]['token']}&ids={oid}")[1]["orders"], [], "meja lain tak bisa melihat")
        self.assertEqual(anon.call("POST", f"/api/public/orders/{oid}/cancel", {"t": tok})[0], 409, "sudah diterima → pelanggan tak bisa batal sendiri")
        self.assertEqual(kasir.call("POST", f"/api/orders/{oid}/status", {"status": "ready"})[0], 200)
        self.assertEqual(kasir.call("POST", f"/api/orders/{oid}/status", {"status": "served"})[0], 200)
        # bayar: item diambil dari pesanan, bukan dari klien
        st, sale, _ = owner.call("POST", "/api/sales", dict(pay, items=[{"product_id": bakmi["id"], "quantity": 1}], request_id="pay-req-0001"))
        self.assertEqual(st, 201, sale)
        s = sale["item"]
        self.assertEqual((s["subtotal"], s["table_no"], s["order_ids"]), (40000, "Meja 1", oid))
        self.assertEqual(owner.call("POST", "/api/sales", dict(pay, request_id="pay-req-0002"))[0], 409, "tidak bisa dibayar dua kali")
        self.assertEqual(kasir.call("GET", "/api/orders")[1]["orders"], [])
        # batal oleh pelanggan saat masih menunggu
        st, r, _ = anon.call("POST", "/api/public/orders", {"t": tok, "items": [{"product_id": bakmi["id"], "quantity": 1}]})
        self.assertEqual(anon.call("POST", f"/api/public/orders/{r['order']['id']}/cancel", {"t": tok})[1]["order"]["status"], "cancelled")
        # menu habis tidak bisa dipesan
        kasir.call("POST", f"/api/products/{bakmi['id']}/availability", {"available": False})
        self.assertEqual(anon.call("POST", "/api/public/orders", {"t": tok, "items": [{"product_id": bakmi["id"], "quantity": 1}]})[0], 409)
        self.assertTrue({i["name"]: i for i in anon.call("GET", f"/api/public/menu?t={tok}")[1]["items"]}["Bakmi Goreng"]["sold_out"])
        kasir.call("POST", f"/api/products/{bakmi['id']}/availability", {"available": True})

    def test_16_panggil_pelayan_dan_ganti_kode_qr(self):
        owner = self.login("Digi", OWNER_PIN)
        kasir = self.login("Sari", "2468")
        anon = Client(self.port)
        t2 = owner.call("GET", "/api/tables")[1]["items"][1]
        self.assertEqual(anon.call("POST", "/api/public/call", {"t": t2["token"], "kind": "bill"})[0], 200)
        self.assertEqual(anon.call("POST", "/api/public/call", {"t": t2["token"], "kind": "bill"})[0], 429, "panggilan beruntun ditahan")
        self.assertEqual(anon.call("POST", "/api/public/call", {"t": t2["token"], "kind": "x"})[0], 400)
        calls = kasir.call("GET", "/api/orders")[1]["calls"]
        self.assertEqual([(c["table_label"], c["kind"]) for c in calls], [("Meja 2", "bill")])
        self.assertEqual(kasir.call("GET", "/api/orders/summary")[1]["calls"], 1)
        self.assertEqual(kasir.call("POST", f"/api/calls/{calls[0]['id']}/done")[0], 200)
        self.assertEqual(kasir.call("GET", "/api/orders")[1]["calls"], [])
        # ganti kode → kode lama mati
        st, r, _ = owner.call("POST", f"/api/tables/{t2['id']}/rotate")
        self.assertEqual(st, 200)
        self.assertEqual(anon.call("GET", f"/api/public/menu?t={t2['token']}")[0], 404)
        self.assertEqual(anon.call("GET", f"/api/public/menu?t={r['token']}")[0], 200)
        self.assertEqual(kasir.call("POST", f"/api/tables/{t2['id']}/rotate")[0], 403)
        # nonaktif
        owner.call("PUT", f"/api/tables/{t2['id']}", {"active": False})
        self.assertEqual(anon.call("GET", f"/api/public/menu?t={r['token']}")[0], 404)

    def test_17_batas_pesan_beruntun(self):
        owner = self.login("Digi", OWNER_PIN)
        anon = Client(self.port)
        tok = next(x for x in owner.call("GET", "/api/tables")[1]["items"] if x["label"] == "Meja 3")["token"]
        bakmi = self.products(owner)["Bakmi Goreng"]
        codes = [anon.call("POST", "/api/public/orders", {"t": tok, "items": [{"product_id": bakmi["id"], "quantity": 1}]}, ip="10.9.9.9")[0] for _ in range(7)]
        self.assertEqual(codes[:5], [201] * 5)
        self.assertEqual(codes[5], 429, "maksimal 5 pesanan menunggu per meja")

    def test_18_halaman_pelanggan(self):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/m/abcDEF123") as r:
            self.assertEqual(r.status, 200)
            self.assertIn(b"order.js", r.read())
        self.assertEqual(Client(self.port).call("GET", "/m/..%2Fapp", raw=True)[0], 404)

    # ------------------------------------------------------------------ Ronde 5
    def test_19_cadangan_otomatis_qris_dan_sw(self):
        owner = self.login("Digi", OWNER_PIN)
        kasir = self.login("Sari", "2468")
        import base64, io, zipfile
        # cadangan otomatis: daftar, jalankan, unduh
        st, b, _ = owner.call("POST", "/api/admin/backups/run")
        self.assertEqual(st, 200, b)
        name = b["name"]
        self.assertRegex(name, r"^auto-\d{8}\.zip$")
        st, raw, hdr = owner.call("GET", f"/api/admin/backups/{name}", raw=True)
        self.assertEqual((st, raw[:2]), (200, b"PK"))
        self.assertIn("kopi-sawah.sqlite3", zipfile.ZipFile(io.BytesIO(raw)).namelist())
        self.assertEqual(kasir.call("GET", "/api/admin/backups")[0], 403)
        self.assertEqual(kasir.call("POST", "/api/admin/backups/run")[0], 403)
        self.assertEqual(owner.call("GET", "/api/admin/backups/auto-../../etc.zip", raw=True)[0], 404)
        # gambar QRIS toko
        jpeg = b"\xff\xd8\xff\xe0" + b"\x00" * 3000
        data = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()
        self.assertEqual(kasir.call("POST", "/api/settings/qris", {"image": data})[0], 403)
        self.assertEqual(owner.call("POST", "/api/settings/qris", {"image": "data:image/png;base64,AAAA"})[0], 400)
        st, r, _ = owner.call("POST", "/api/settings/qris", {"image": data})
        self.assertEqual(st, 200, r)
        tok = owner.call("GET", "/api/tables")[1]["items"][0]["token"]
        menu = Client(self.port).call("GET", f"/api/public/menu?t={tok}")[1]
        self.assertEqual(menu["settings"]["qris_image"], r["qris_image"])
        self.assertEqual(Client(self.port).call("GET", f"/media/{r['qris_image']}.jpg", raw=True)[0], 200)
        self.assertEqual(owner.call("PUT", "/api/settings", {"qris_image": "up-000000000000"})[0], 400, "tidak bisa diubah lewat PUT /settings")
        self.assertEqual(owner.call("DELETE", "/api/settings/qris")[0], 200)
        self.assertEqual(Client(self.port).call("GET", f"/api/public/menu?t={tok}")[1]["settings"]["qris_image"], "")
        # service worker dilayani dari akar dengan cakupan "/"
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/sw.js") as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.headers["Service-Worker-Allowed"], "/")
            self.assertIn("javascript", resp.headers["Content-Type"])

    def test_20_level_pedas_dan_pindah_meja_dan_bayar_sebagian(self):
        owner = self.login("Digi", OWNER_PIN)
        mods = owner.call("GET", "/api/modifiers")[1]
        pedas = next(g for g in mods["groups"] if g["id"] == "pedas")
        self.assertEqual((pedas["min_select"], [o["name"] for o in pedas["options"]]), (0, ["Tidak pedas", "Sedang", "Pedas", "Extra pedas"]))
        self.assertIn("pedas", mods["categories"]["Makanan"])
        self.assertNotIn("pedas", mods["categories"]["Kopi"])
        anon = Client(self.port)
        tables = {t["label"]: t for t in owner.call("GET", "/api/tables")[1]["items"] if t["active"]}
        a, b = tables["Meja 1"], tables["Meja 3"]
        p = self.products(owner)
        def order(tok, name, ip):
            st, r, _ = anon.call("POST", "/api/public/orders", {"t": tok, "items": [{"product_id": p[name]["id"], "quantity": 1, "modifiers": [{"id": "pedas-2"}]}]}, ip=ip)
            self.assertEqual(st, 201, r)
            return r["order"]["id"]
        o1 = order(a["token"], "Bakmi Goreng", "10.7.0.1")
        o2 = order(a["token"], "Bakmi Godog", "10.7.0.1")
        self.assertIn("Sedang", owner.call("GET", "/api/orders")[1]["orders"][-1]["items"][0]["modifiers_summary"])
        for o in (o1, o2):
            self.assertEqual(owner.call("POST", f"/api/orders/{o}/status", {"status": "accepted"})[0], 200)
        # pindah semua pesanan Meja 1 ke Meja 3
        self.assertEqual(owner.call("POST", "/api/orders/move", {"order_ids": [o1, o2], "to_table_id": 99999})[0], 404)
        self.assertEqual(owner.call("POST", "/api/orders/move", {"order_ids": [o1, o2], "to_table_id": b["id"]})[0], 200)
        labels = {o["id"]: o["table_label"] for o in owner.call("GET", "/api/orders")[1]["orders"]}
        self.assertEqual((labels[o1], labels[o2]), ("Meja 3", "Meja 3"))
        # bayar sebagian: hanya o1 dulu, lalu o2
        st, s1, _ = owner.call("POST", "/api/sales", {"order_ids": [o1], "payment_method": "qris", "request_id": "split-req-001"})
        self.assertEqual((st, s1["item"]["subtotal"], s1["item"]["table_no"]), (201, 20000, "Meja 3"), s1)
        left = [o["id"] for o in owner.call("GET", "/api/orders")[1]["orders"]]
        self.assertNotIn(o1, left)
        self.assertIn(o2, left)
        self.assertEqual(owner.call("POST", "/api/orders/move", {"order_ids": [o1], "to_table_id": a["id"]})[0], 409, "yang sudah dibayar tak bisa dipindah")
        self.assertEqual(owner.call("POST", "/api/sales", {"order_ids": [o2], "payment_method": "tunai", "amount_paid": 20000, "request_id": "split-req-002"})[0], 201)

    # ------------------------------------------------------------------ Ronde 6: laporan & pelanggan
    def test_21_laporan_pelanggan_dan_beranda(self):
        owner = self.login("Digi", OWNER_PIN)
        kasir = self.login("Sari", "2468")
        p = self.products(owner)
        item = [{"product_id": p["Bakmi Goreng"]["id"], "quantity": 2, "modifiers": []}]
        for i, nm in enumerate(["Bu Sari", "bu sari", "Pak Budi"]):
            self.assertEqual(owner.call("POST", "/api/sales", {"items": item, "payment_method": "qris", "customer_name": nm, "request_id": f"cust-sale-{i:03d}"})[0], 201)
        self.assertEqual(owner.call("POST", "/api/sales", {"items": item, "payment_method": "qris", "request_id": "cust-sale-anon1"})[0], 201)
        # transaksi pelanggan: nama tak membedakan huruf besar/kecil
        r = owner.call("GET", "/api/reports/customers")[1]
        by = {c["name"].lower(): c for c in r["items"]}
        self.assertEqual((by["bu sari"]["n"], by["bu sari"]["total"]), (3, 120000))  # 2 dari tes ini + 1 dari pesanan QR atas nama Bu Sari
        self.assertEqual(by["pak budi"]["n"], 1)
        self.assertGreaterEqual(r["anonymous"]["n"], 1)
        det = owner.call("GET", "/api/reports/customer?name=BU%20SARI")[1]
        self.assertEqual(len(det["items"]), 3)
        self.assertEqual(det["items"][0]["items"][0]["name_snapshot"], "Bakmi Goreng")
        self.assertEqual(kasir.call("GET", "/api/reports/customers")[0], 403)
        self.assertIn("Bu Sari", kasir.call("GET", "/api/customers/names")[1]["items"] + owner.call("GET", "/api/customers/names")[1]["items"])
        # HP hanya pemilik; nomor dibersihkan
        self.assertEqual(kasir.call("PUT", "/api/customers", {"name": "Bu Sari", "phone": "0812"})[0], 403)
        self.assertEqual(owner.call("PUT", "/api/customers", {"name": "Bu Sari", "phone": "0812-3456 <script>", "note": "suka kopi"})[0], 200)
        c2 = {c["name"].lower(): c for c in owner.call("GET", "/api/reports/customers")[1]["items"]}
        self.assertEqual(c2["bu sari"]["phone"], "0812-3456")
        # ganti nama menggabungkan riwayat
        self.assertEqual(owner.call("PUT", "/api/customers", {"name": "Pak Budi", "rename_to": "Bu Sari"})[0], 200)
        c3 = {c["name"].lower(): c for c in owner.call("GET", "/api/reports/customers")[1]["items"]}
        self.assertEqual(c3["bu sari"]["n"], 4)
        self.assertNotIn("pak budi", c3)
        # laporan lain
        pr = owner.call("GET", "/api/reports/products?sort=revenue")[1]
        self.assertTrue(pr["items"] and pr["total_qty"] == sum(i["qty"] for i in pr["items"]))
        self.assertGreaterEqual(pr["items"][0]["revenue"], pr["items"][-1]["revenue"])
        mo = owner.call("GET", "/api/reports/monthly?months=12")[1]["items"]
        self.assertEqual(len(mo), 12)
        self.assertGreater(mo[-1]["total"], 0)
        tr = owner.call("GET", "/api/reports/transactions")[1]
        self.assertTrue(tr["items"] and "unpaid_orders" in tr)
        for kind in ("products", "customers"):
            st, raw, hdr = owner.call("GET", f"/api/reports/export.csv?type={kind}", raw=True)
            self.assertEqual(st, 200)
            self.assertIn("text/csv", hdr["Content-Type"])
        # ringkasan Beranda lengkap
        s = owner.call("GET", "/api/reports/summary")[1]
        for key in ("stats", "series30", "hours_today", "methods_today", "types_today", "categories_month", "top_week", "customers", "open_orders", "void_today"):
            self.assertIn(key, s)
        self.assertEqual(len(s["series30"]), 30)
        self.assertEqual(s["stats"]["today"]["n"], s["today_transactions"])
        self.assertEqual(kasir.call("GET", "/api/reports/products")[0], 403)
        # kasir boleh menulis nama pelanggan di nota (opsional)
        self.assertEqual(kasir.call("GET", "/api/shifts/current")[0], 200)


    def test_22_tombol_aktif_meja_membuka_dan_menutup_pesanan_pelanggan(self):
        """Meja hanya terbuka untuk pelanggan bila berstatus aktif (tombol Aktifkan)."""
        owner = self.login("Digi", OWNER_PIN)
        kasir = self.login("Sari", "2468")
        anon = Client(self.port)
        st, r, _ = owner.call("POST", "/api/tables", {"label": "Meja Uji Aktif"})
        self.assertIn(st, (200, 201))
        meja = [x for x in owner.call("GET", "/api/tables")[1]["items"] if x["label"] == "Meja Uji Aktif"][0]
        tok = meja["token"]
        self.assertTrue(meja["active"], "meja baru langsung aktif")
        # terbuka: halaman & menu pelanggan bisa dibuka
        self.assertEqual(anon.call("GET", f"/api/public/menu?t={tok}")[0], 200)
        self.assertEqual(anon.call("GET", f"/m/{tok}", raw=True)[0], 200)   # halaman QR selalu terbuka; gerbangnya di API
        # kasir tidak boleh mengubah status meja
        self.assertEqual(kasir.call("PUT", f"/api/tables/{meja['id']}", {"active": False})[0], 403)
        # pemilik menutup meja -> pelanggan tidak bisa memesan
        self.assertEqual(owner.call("PUT", f"/api/tables/{meja['id']}", {"active": False})[0], 200)
        st, r404, _ = anon.call("GET", f"/api/public/menu?t={tok}")
        self.assertEqual(st, 404)
        self.assertIn("tidak dikenal", r404["error"], "pelanggan diberi pesan jelas saat meja ditutup")
        # label & status tidak hilang saat ditutup
        meja2 = [x for x in owner.call("GET", "/api/tables")[1]["items"] if x["label"] == "Meja Uji Aktif"][0]
        self.assertEqual(meja2["active"], 0)
        # diaktifkan lagi -> terbuka kembali untuk pelanggan
        self.assertEqual(owner.call("PUT", f"/api/tables/{meja['id']}", {"active": True})[0], 200)
        self.assertEqual(anon.call("GET", f"/api/public/menu?t={tok}")[0], 200)
        # jejak audit mencatat perubahan status
        audit = owner.call("GET", "/api/audit?limit=50")[1]["items"]
        self.assertTrue(any("ubah_meja" in (a.get("action") or "") and "aktif=" in (a.get("detail") or "") for a in audit))


    def test_23_metode_pemesanan_tagihan_dan_gabung(self):
        """Buat Pesanan / Piutang / Gabungkan Pesanan: tagihan terbuka, satu nota saat lunas."""
        owner = self.login("Digi", OWNER_PIN)
        kasir = self.login("Sari", "2468")
        owner.call("POST", "/api/shifts/open", {"opening_cash": 0})   # 409 bila kasir sudah dibuka
        p = self.products(owner)
        nasgor, esteh = p["Nasi Goreng Original"], p["Air Es"]   # Air Es: tanpa pilihan wajib
        before = owner.call("GET", "/api/reports/summary")[1]["today_total"]

        # 1. Buat Pesanan: tagihan terbuka, belum menjadi omzet
        items1 = [{"product_id": nasgor["id"], "quantity": 1, "modifiers": []}]
        st, b, _ = owner.call("POST", "/api/sales", {"items": items1, "order_method": "pesanan",
                                                    "order_type": "dine_in", "table_no": "Meja Uji 7",
                                                    "customer_name": "Bu Uji", "request_id": "uji-bill-0001"})
        self.assertEqual(st, 201, b)
        bill = b["bill"]
        self.assertRegex(bill["id"], r"^TG\d{6}-\d{3}$")
        self.assertEqual((bill["kind"], bill["status"], bill["total_amount"]), ("pesanan", "open", nasgor["price"]))
        self.assertEqual(owner.call("GET", "/api/reports/summary")[1]["today_total"], before,
                         "tagihan yang belum dibayar tidak boleh menambah omzet")
        st, b2, _ = owner.call("POST", "/api/sales", {"items": items1, "order_method": "pesanan", "request_id": "uji-bill-0001"})
        self.assertEqual((st, b2.get("duplicate")), (200, True), "kunci idempoten juga berlaku untuk tagihan")

        # 2. Pelanggan pesan lagi -> digabung ke tagihan yang sama
        st, b, _ = owner.call("POST", f"/api/bills/{bill['id']}/items",
                              {"items": [{"product_id": esteh["id"], "quantity": 2, "modifiers": []}]})
        self.assertEqual(st, 200, b)
        merged = b["bill"]
        self.assertEqual(len(merged["items"]), 2)
        self.assertEqual(merged["subtotal"], nasgor["price"] + 2 * esteh["price"])
        self.assertEqual((merged["total_amount"], merged["item_count"]), (merged["subtotal"], 3))

        # 3. Lunas -> satu nota berisi semua pesanan yang digabung
        st, b, _ = owner.call("POST", f"/api/bills/{bill['id']}/settle", {"payment_method": "qris"})
        self.assertEqual(st, 200, b)
        sale = b["item"]
        self.assertEqual((sale["status"], sale["total_amount"], len(sale["items"])),
                         ("paid", merged["total_amount"], 2))
        self.assertEqual(owner.call("GET", "/api/reports/summary")[1]["today_total"], before + merged["total_amount"],
                         "omzet dihitung saat tagihan dilunasi")
        self.assertNotIn(bill["id"], [x["id"] for x in owner.call("GET", "/api/bills?status=open")[1]["items"]])
        self.assertEqual(owner.call("POST", f"/api/bills/{bill['id']}/items",
                                    {"items": [{"product_id": esteh["id"], "quantity": 1, "modifiers": []}]})[0], 409,
                         "tagihan lunas tidak bisa digabung lagi")

        # 4. Piutang: tercatat sebagai piutang, dilunasi belakangan
        st, b, _ = owner.call("POST", "/api/sales", {"items": [{"product_id": esteh["id"], "quantity": 1, "modifiers": []}],
                                                    "order_method": "piutang", "customer_name": "Pak Uji"})
        self.assertEqual(st, 201, b)
        piutang = b["bill"]
        self.assertEqual((piutang["kind"], piutang["status"]), ("piutang", "open"))
        self.assertIn(piutang["id"], [x["id"] for x in owner.call("GET", "/api/bills?kind=piutang")[1]["items"]])
        st, b, _ = owner.call("POST", f"/api/bills/{piutang['id']}/settle",
                              {"payment_method": "tunai", "amount_paid": piutang["total_amount"]})
        self.assertEqual((st, b["item"]["payment_method"]), (200, "tunai"))

        # 5. Batalkan tagihan: pemilik boleh, kasir ditolak
        st, b, _ = owner.call("POST", "/api/sales", {"items": [{"product_id": esteh["id"], "quantity": 1, "modifiers": []}],
                                                    "order_method": "pesanan"})
        batal = b["bill"]
        self.assertEqual(kasir.call("POST", f"/api/bills/{batal['id']}/void", {"reason": "salah input"})[0], 403)
        st, b, _ = owner.call("POST", f"/api/bills/{batal['id']}/void", {"reason": "salah input"})
        self.assertEqual((st, b["bill"]["status"]), (200, "void"))
        self.assertNotIn(batal["id"], [x["id"] for x in owner.call("GET", "/api/bills?status=open")[1]["items"]])

        # 6. Bayar langsung tetap seperti sebelumnya
        st, b, _ = owner.call("POST", "/api/sales", {"items": [{"product_id": esteh["id"], "quantity": 1, "modifiers": []}],
                                                    "payment_method": "qris"})
        self.assertEqual((st, b["item"]["status"]), (201, "paid"))


    def test_24_hapus_transaksi_hanya_pemilik(self):
        """Pemilik bisa menghapus transaksi permanen; kasir tidak. Tagihan yang notanya dihapus kembali terbuka."""
        owner = self.login("Digi", OWNER_PIN)
        kasir = self.login("Sari", "2468")
        owner.call("POST", "/api/shifts/open", {"opening_cash": 0})
        air = self.products(owner)["Air Es"]
        item = [{"product_id": air["id"], "quantity": 1, "modifiers": []}]
        st, b, _ = owner.call("POST", "/api/sales", {"items": item, "payment_method": "qris", "request_id": "uji-hapus-0001"})
        sale = b["item"]
        before = owner.call("GET", "/api/reports/summary")[1]["today_total"]
        self.assertEqual(kasir.call("DELETE", f"/api/sales/{sale['id']}", {"reason": "coba"})[0], 403, "kasir tidak boleh menghapus")
        self.assertEqual(owner.call("DELETE", f"/api/sales/{sale['id']}", {})[0], 400, "alasan wajib")
        st, b, _ = owner.call("DELETE", f"/api/sales/{sale['id']}", {"reason": "uji hapus"})
        self.assertEqual(st, 200, b)
        self.assertEqual(owner.call("GET", f"/api/sales/{sale['id']}")[0], 404)
        self.assertEqual(owner.call("GET", "/api/reports/summary")[1]["today_total"], before - sale["total_amount"],
                         "omzet berkurang setelah transaksi dihapus")
        audit = owner.call("GET", "/api/audit?limit=50")[1]["items"]
        self.assertTrue(any(a["action"] == "hapus_transaksi" and sale["id"] in a["detail"] for a in audit),
                        "penghapusan tercatat di audit")
        self.assertEqual(owner.call("DELETE", f"/api/sales/{sale['id']}", {"reason": "x"})[0], 404, "sudah tidak ada")

        # nota hasil pelunasan dihapus -> tagihannya kembali terbuka
        st, b, _ = owner.call("POST", "/api/sales", {"items": item, "order_method": "pesanan", "request_id": "uji-hapus-0002"})
        bill = b["bill"]
        st, b, _ = owner.call("POST", f"/api/bills/{bill['id']}/settle", {"payment_method": "qris"})
        sale2 = b["item"]
        self.assertEqual(owner.call("DELETE", f"/api/sales/{sale2['id']}", {"reason": "salah lunas"})[0], 200)
        st, b, _ = owner.call("GET", f"/api/bills/{bill['id']}")
        self.assertEqual((b["item"]["status"], b["item"]["sale_id"]), ("open", None))

    def test_25_saran_menu_hanya_pemilik(self):
        """Saran menu adalah draf pemilik: kasir tidak boleh, menu tak dikenal 404."""
        owner = self.login("Digi", OWNER_PIN)
        kasir = self.login("Sari", "2468")
        p = self.products(owner)["Ayam Bakar"]
        st, b, _ = owner.call("GET", f"/api/products/{p['id']}/saran")
        self.assertEqual(st, 200, b)
        self.assertIn("ada", b["item"], "endpoint harus menjawab walau belum ada draf")
        self.assertEqual(kasir.call("GET", f"/api/products/{p['id']}/saran")[0], 403)
        self.assertEqual(owner.call("GET", "/api/products/tidak-ada/saran")[0], 404)

    def test_26_reservasi_meja_dan_preorder(self):
        """Reservasi meja + pre-order: pelanggan mengajukan, kasir menyetujui/menawar jam/menolak."""
        owner = self.login("Digi", OWNER_PIN)
        kasir = self.login("Sari", "2468")
        anon = Client(self.port)
        owner.call("PUT", "/api/settings", {"reservasi_batas_jam": "23:59", "reservasi_wa": "08123456789"})   # uji tidak bergantung jam berjalan
        before = owner.call("GET", "/api/reports/summary")[1]["today_total"]
        st, info, _ = anon.call("GET", "/api/public/reservasi/info")
        self.assertEqual(st, 200, info)
        self.assertTrue(info["aktif"])
        self.assertEqual(info["wa"], "628123456789", "nomor WA kasir dinormalkan ke 62…")
        tanggal = info["tanggal_min"]
        jam1 = info.get("jam_min_hari_ini") or info["jam"][2]      # jam pertama yang masih boleh hari ini
        jam2 = info["jam"][3]
        besok = (datetime.now(timezone(timedelta(hours=7))).date() + timedelta(days=1)).isoformat()
        air = self.products(owner)["Air Es"]
        body = {"name": "Bu Uji", "phone": "081234567890", "party_size": 4, "tanggal": tanggal, "jam": jam1,
                "note": "meja dekat kolam", "request_id": "uji-resv-0001",
                "items": [{"product_id": air["id"], "quantity": 2, "modifiers": []}]}
        st, b, _ = anon.call("POST", "/api/public/reservasi", body)
        self.assertEqual(st, 201, b)
        r1 = b["item"]
        self.assertRegex(r1["id"], r"^RSV-\d{6}-\d{3}$")
        self.assertEqual((r1["status"], r1["total_estimate"]), ("baru", 2 * air["price"]))
        st, b2, _ = anon.call("POST", "/api/public/reservasi", body)
        self.assertEqual((st, b2.get("duplicate")), (200, True), "kunci idempoten berlaku")
        st, d, _ = kasir.call("GET", f"/api/reservasi?tanggal={tanggal}")
        self.assertEqual((st, d["baru"], len(d["items"])), (200, 1, 1))
        st, b, _ = kasir.call("POST", f"/api/reservasi/{r1['id']}/setujui", {"table_label": "Meja 5"})
        self.assertEqual((st, b["item"]["status"], b["item"]["table_label"]), (200, "disetujui", "Meja 5"))
        st, b, _ = anon.call("GET", f"/api/public/reservasi/{r1['token']}")
        self.assertEqual((st, b["item"]["status"]), (200, "disetujui"))
        # tawar jam lain -> pelanggan menerima
        st, b, _ = anon.call("POST", "/api/public/reservasi", {**body, "tanggal": besok, "jam": jam2, "request_id": "uji-resv-0002"})
        r2 = b["item"]
        st, b, _ = kasir.call("POST", f"/api/reservasi/{r2['id']}/setujui", {"jam": jam1, "reason": "jam itu penuh"})
        self.assertEqual((st, b["item"]["status"], b["item"]["proposed_jam"]), (200, "ubah", jam1))
        st, b, _ = anon.call("POST", f"/api/public/reservasi/{r2['token']}/jawab", {"terima": True})
        self.assertEqual((st, b["item"]["status"], b["item"]["jam"]), (200, "disetujui", jam1))
        # tolak
        st, b, _ = anon.call("POST", "/api/public/reservasi", {**body, "request_id": "uji-resv-0003"})
        r3 = b["item"]
        st, b, _ = kasir.call("POST", f"/api/reservasi/{r3['id']}/tolak", {"reason": "penuh"})
        self.assertEqual((st, b["item"]["status"]), (200, "ditolak"))
        # tamu datang lalu selesai
        self.assertEqual(kasir.call("POST", f"/api/reservasi/{r1['id']}/datang")[0], 200)
        self.assertEqual(kasir.call("POST", f"/api/reservasi/{r1['id']}/selesai")[0], 200)
        # jam di luar daftar ditolak
        self.assertEqual(anon.call("POST", "/api/public/reservasi", {**body, "jam": "03:00", "request_id": "uji-resv-0004"})[0], 400)
        # reservasi bukan penjualan: omzet tidak berubah
        self.assertEqual(owner.call("GET", "/api/reports/summary")[1]["today_total"], before)

    def test_27_edit_tagihan_terbuka(self):
        """Tagihan belum dibayar bisa diedit; total, catatan, stok, dan audit harus ikut konsisten."""
        owner = self.login("Digi", OWNER_PIN)
        owner.call("POST", "/api/shifts/open", {"opening_cash": 0})
        products = self.products(owner)
        tea, water = products["Es Teh"], products["Air Es"]
        owner.call("POST", "/api/stock/count", {"product_id": tea["id"], "counted_quantity": 10})
        st, created, _ = owner.call("POST", "/api/sales", {
            "items": [{"product_id": tea["id"], "quantity": 2, "modifiers": [{"id": "gula-1"}]},
                      {"product_id": water["id"], "quantity": 1, "modifiers": []}],
            "order_method": "pesanan", "note": "sebelum edit"})
        self.assertEqual(st, 201, created)
        bill = created["bill"]
        tea_line, water_line = bill["items"]
        st, edited, _ = owner.call("PUT", f"/api/bills/{bill['id']}/edit", {
            "items": [{"id": tea_line["id"], "quantity": 4, "note": "Tanpa gula"},
                      {"id": water_line["id"], "quantity": 0, "note": ""}],
            "note": "Catatan pesanan diperbarui", "revision": bill["revision"]})
        self.assertEqual(st, 200, edited)
        current = edited["bill"]
        self.assertEqual(len(current["items"]), 1, "quantity 0 menghapus baris item")
        self.assertEqual((current["items"][0]["quantity"], current["items"][0]["note"]), (4, "Tanpa gula"))
        self.assertEqual(current["note"], "Catatan pesanan diperbarui")
        self.assertEqual((current["subtotal"], current["item_count"]), (4 * tea["price"], 4))
        self.assertEqual(self.products(owner)["Es Teh"]["stock_on_hand"], 6)

        st, _, _ = owner.call("PUT", f"/api/bills/{bill['id']}/edit", {
            "items": [{"id": tea_line["id"], "quantity": 3, "note": "versi lama"}],
            "revision": bill["revision"]})
        self.assertEqual(st, 409, "edit dari layar lama tidak boleh menimpa perubahan terbaru")

        # Kegagalan validasi stok tidak boleh mengubah pesanan atau stok.
        st, _, _ = owner.call("PUT", f"/api/bills/{bill['id']}/edit", {
            "items": [{"id": tea_line["id"], "quantity": 20, "note": ""}],
            "note": "gagal", "revision": current["revision"]})
        self.assertEqual(st, 409)
        self.assertEqual(self.products(owner)["Es Teh"]["stock_on_hand"], 6)
        self.assertEqual(owner.call("GET", f"/api/bills/{bill['id']}")[1]["item"]["items"][0]["quantity"], 4)

        st, reduced, _ = owner.call("PUT", f"/api/bills/{bill['id']}/edit", {
            "items": [{"id": tea_line["id"], "quantity": 1, "note": "Kurangi gula"}],
            "note": "", "revision": current["revision"]})
        self.assertEqual(st, 200, reduced)
        self.assertEqual(self.products(owner)["Es Teh"]["stock_on_hand"], 9)
        audit = owner.call("GET", "/api/audit?limit=50")[1]["items"]
        self.assertTrue(any(a["action"] == "edit_tagihan" and bill["id"] in a["detail"] for a in audit))

        st, _, _ = owner.call("POST", f"/api/bills/{bill['id']}/void", {"reason": "uji edit"})
        self.assertEqual(st, 200)
        self.assertEqual(self.products(owner)["Es Teh"]["stock_on_hand"], 10,
                         "pembatalan mengembalikan stok bersih, bukan jumlah kotor gerakan")
        self.assertEqual(owner.call("PUT", f"/api/bills/{bill['id']}/edit", {
            "items": [{"id": tea_line["id"], "quantity": 1, "note": ""}],
            "revision": reduced["bill"]["revision"]})[0], 409)

        st, paid_created, _ = owner.call("POST", "/api/sales", {
            "items": [{"product_id": water["id"], "quantity": 1, "modifiers": []}],
            "order_method": "pesanan"})
        self.assertEqual(st, 201, paid_created)
        paid_bill = paid_created["bill"]
        st, _, _ = owner.call("POST", f"/api/bills/{paid_bill['id']}/settle", {"payment_method": "qris"})
        self.assertEqual(st, 200)
        self.assertEqual(owner.call("PUT", f"/api/bills/{paid_bill['id']}/edit", {
            "items": [{"id": paid_bill["items"][0]["id"], "quantity": 2, "note": ""}],
            "revision": paid_bill["revision"]})[0], 409, "tagihan lunas tidak boleh diedit")


class SetupTanpaKodeTest(unittest.TestCase):
    """Penyiapan awal tanpa KODE PENYIAPAN (KOPI_SAWAH_SETUP_TANPA_KODE=1)."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.port = free_port()
        env = {**os.environ, "KOPI_SAWAH_PORT": str(cls.port), "KOPI_SAWAH_DB": str(Path(cls.tmp.name) / "t.sqlite3"),
               "KOPI_SAWAH_REQUIRE_ORIGIN": "1", "KOPI_SAWAH_SETUP_CODE": SETUP_CODE,
               "KOPI_SAWAH_SETUP_TANPA_KODE": "1"}
        cls.proc = subprocess.Popen([sys.executable, str(PROJECT / "app.py")], env=env,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        for _ in range(80):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/api/health", timeout=1)
                break
            except Exception:
                time.sleep(0.1)
        else:
            raise RuntimeError("server tidak naik")

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(5)
        cls.tmp.cleanup()

    def test_setup_tanpa_kode(self):
        c = Client(self.port)
        st, b, _ = c.call("GET", "/api/auth/status")
        self.assertEqual(st, 200)
        self.assertTrue(b["setup_tanpa_kode"], "layar penyiapan harus tahu kode dimatikan")
        st, b, _ = c.call("POST", "/api/auth/setup", {"name": "Pemilik", "pin": "482916"})
        self.assertEqual(st, 201, b)
        self.assertEqual(c.call("GET", "/api/products")[0], 200)
        self.assertEqual(Client(self.port).call("POST", "/api/auth/setup", {"name": "Lain", "pin": "482916"})[0], 409,
                         "setelah akun ada, pendaftaran pemilik ditutup")


if __name__ == "__main__":
    unittest.main()
