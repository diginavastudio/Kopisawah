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

    def call(self, method, path, payload=None, origin=True, raw=False):
        data = None if payload is None else json.dumps(payload).encode()
        headers = {"Content-Type": "application/json"}
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
        kopi = p["Cappucino"] if "Cappucino" in p else next(v for v in p.values() if v["category"] == "Kopi" and v["price"])
        # varian wajib belum dipilih -> ditolak
        st, b, _ = kasir.call("POST", "/api/sales", {"items": [{"product_id": kopi["id"], "quantity": 1, "modifiers": []}], "payment_method": "qris"})
        self.assertEqual(st, 400, b)
        mods = [{"id": "suhu-1"}, {"id": "gula-1"}, {"id": "es-1"}, {"id": "ukuran-2"}, {"id": "susu-2"}]  # Large +5k, Oat +5k
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
        two = [{"product_id": tea["id"], "quantity": 3, "modifiers": [{"id": "suhu-1"}, {"id": "gula-1"}, {"id": "es-1"}, {"id": "ukuran-1"}]},
               {"product_id": tea["id"], "quantity": 3, "modifiers": [{"id": "suhu-1"}, {"id": "gula-2"}, {"id": "es-1"}, {"id": "ukuran-1"}]}]
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
        self.assertEqual((st, raw[:15]), (200, b"SQLite format 3"))
        self.assertEqual(owner.call("GET", "/api/audit")[1]["items"][0]["action"], "unduh_cadangan")
        st, s, _ = owner.call("GET", "/api/reports/summary")
        self.assertEqual(st, 200)
        self.assertEqual(len(s["series"]), 7)

    def test_08_tutup_kasir_dan_riwayat_kasir(self):
        kasir = self.login("Sari", "2468")
        st, cur, _ = kasir.call("GET", "/api/shifts/current")
        sh = cur["shift"]
        cash_sales = sum(m["total"] for m in sh["by_method"] if m["payment_method"] == "tunai")
        self.assertEqual(sh["expected_cash"], 100000 + cash_sales)
        self.assertEqual(cash_sales, 40000)
        self.assertEqual(len(kasir.call("GET", "/api/sales")[1]["items"]), 6)  # termasuk 1 transaksi batal
        st, closed, _ = kasir.call("POST", "/api/shifts/close", {"counted_cash": 139000, "note": "kurang seribu"})
        self.assertEqual(st, 200, closed)
        self.assertEqual((closed["shift"]["expected_cash"], closed["shift"]["difference"]), (140000, -1000))
        item = [{"product_id": self.products(kasir)["Nasi Goreng Original"]["id"], "quantity": 1, "modifiers": []}]
        self.assertEqual(kasir.call("POST", "/api/sales", {"items": item, "payment_method": "qris"})[0], 409, "setelah tutup kasir tidak bisa jual")

    def test_09_pin_throttle_dan_logout(self):
        c = Client(self.port)
        staff = c.call("GET", "/api/auth/status")[1]["staff"]
        uid = next(s["id"] for s in staff if s["name"] == "Sari")
        codes = [c.call("POST", "/api/auth/login", {"user_id": uid, "pin": "0000"})[0] for _ in range(5)]
        self.assertEqual(codes, [401] * 5)
        self.assertEqual(c.call("POST", "/api/auth/login", {"user_id": uid, "pin": "2468"})[0], 429, "terkunci walau PIN benar")
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
        self.assertEqual(c.call("GET", "/static/../app.py", raw=True)[0], 404)
        self.assertEqual(c.call("GET", "/static/%2e%2e/app.py", raw=True)[0], 404)


if __name__ == "__main__":
    unittest.main()
