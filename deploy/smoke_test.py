import json
import os
import socket
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
import urllib.error
import urllib.request
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]


def req(port, path, method="GET", payload=None, origin="same"):
    data = None if payload is None else json.dumps(payload).encode()
    headers = {"Content-Type": "application/json"}
    if origin == "same":
        headers["Origin"] = f"http://127.0.0.1:{port}"
    elif origin is not None:
        headers["Origin"] = origin
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method,
                                     headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            return response.status, json.loads(response.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main():
    port = free_port()
    tmpdir = tempfile.mkdtemp(prefix="kopi-sawah-auth-test-")
    db_path = Path(tmpdir) / "smoke-test.sqlite3"
    env = dict(os.environ, KOPI_SAWAH_DB=str(db_path), KOPI_SAWAH_PORT=str(port), KOPI_SAWAH_REQUIRE_ORIGIN="1",
               KOPI_SAWAH_WRITE_UNTIL=(datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(timespec="seconds"))
    proc = subprocess.Popen([sys.executable, "app.py"], cwd=PROJECT, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        for _ in range(60):
            try:
                status, health = req(port, "/api/health")
                if status == 200:
                    break
            except Exception:
                time.sleep(.2)
        else:
            raise RuntimeError("server did not start: " + (proc.stdout.read() if proc.stdout else ""))
        assert health["counts"]["products"] == 124, health
        for origin in (None, "https://attacker.invalid"):
            code, result = req(port, "/api/products", "POST", {}, origin=origin)
            assert code == 403 and "asal" in result["error"].lower(), (origin, code, result)
        _, products = req(port, "/api/products?q=Long%20Black")
        long_black = next(p for p in products["items"] if p["name"] == "Long Black")
        assert long_black["price"] is None
        code, result = req(port, "/api/sales", "POST", {"items": [{"product_id": long_black["id"], "quantity": 1}], "payment_method": "uji"})
        blocked_unknown_price = code == 409 and "Harga" in result["error"]
        assert blocked_unknown_price, (code, result)
        _, sales = req(port, "/api/sales")
        assert sales["items"] == []
        code, updated = req(port, f"/api/products/{long_black['id']}", "PUT", {"price": 17500, "reorder_level": 1})
        assert code == 200 and updated["item"]["price"] == 17500
        code, stock = req(port, "/api/stock/count", "POST", {"product_id": long_black["id"], "counted_quantity": 3, "note": "hitung uji"})
        assert code == 201 and stock["item"]["stock_on_hand"] == 3
        code, sale = req(port, "/api/sales", "POST", {"items": [{"product_id": long_black["id"], "quantity": 2}], "payment_method": "uji manual", "discount_amount": 0})
        assert code == 201 and sale["item"]["total_amount"] == 35000, (code, sale)
        _, stock_list = req(port, "/api/stock")
        item = next(p for p in stock_list["items"] if p["id"] == long_black["id"])
        assert item["stock_on_hand"] == 1
        code, blocked = req(port, "/api/sales", "POST", {"items": [{"product_id": long_black["id"], "quantity": 2}], "payment_method": "uji manual"})
        assert code == 409 and "Stok" in blocked["error"]
        code, blocked_discount = req(port, "/api/sales", "POST", {"items": [{"product_id": long_black["id"], "quantity": 1}], "payment_method": "uji", "discount_amount": 1000})
        assert code == 409 and "Diskon" in blocked_discount["error"]
        _, summary = req(port, "/api/reports/summary")
        assert summary["all_transactions"] == 1 and summary["all_total"] == 35000 and summary["low_stock"] == 1, summary
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/static/images/coffee-long-black.jpg", timeout=3) as im:
            assert im.status == 200 and im.headers.get_content_type() == "image/jpeg"
        print(json.dumps({"health": health, "blocked_unknown_price": blocked_unknown_price,
                          "recorded_total": sale["item"]["total_amount"], "remaining_stock": item["stock_on_hand"],
                          "insufficient_stock_blocked": True, "discount_blocked": True,
                          "report": summary, "image_http": 200}, ensure_ascii=False))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        for suffix in ("", "-wal", "-shm"):
            try:
                Path(str(db_path) + suffix).unlink()
            except FileNotFoundError:
                pass
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    main()
