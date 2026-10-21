#!/usr/bin/env python3
"""Exercise the writable review proxy using only a disposable app/database."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time

PROJECT = Path(__file__).resolve().parents[1]
LOCATION = PROJECT / "deploy" / "nginx-writable-location.conf"
HOST = "kopisawah.diginavastudio.com"


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def request(port: int, method: str, path: str, payload: dict | None = None, origin: str | None = None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=4)
    headers = {"Host": HOST}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    if origin is not None:
        headers["Origin"] = origin
    conn.request(method, path, body=None if payload is None else json.dumps(payload), headers=headers)
    r = conn.getresponse()
    result = r.status, r.read()
    conn.close()
    return result


def main() -> None:
    nginx = shutil.which("nginx")
    if not nginx:
        raise SystemExit("nginx binary unavailable")
    expiry = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(timespec="seconds")
    with tempfile.TemporaryDirectory(prefix="kopi-writable-", dir="/root/.hermes/cache/scratch") as tmp_name:
        tmp = Path(tmp_name)
        app_port, proxy_port = free_port(), free_port()
        db_path = tmp / "fixture.sqlite3"
        location_path = tmp / "writable-location.conf"
        location_path.write_text(LOCATION.read_text(encoding="utf-8").replace("127.0.0.1:8791", f"127.0.0.1:{app_port}"), encoding="utf-8")
        nginx_conf = tmp / "nginx.conf"
        nginx_conf.write_text(f"""user root;
worker_processes 1;
pid {tmp / 'nginx.pid'};
error_log {tmp / 'error.log'} notice;
events {{ worker_connections 64; }}
http {{
  access_log {tmp / 'access.log'};
  server {{
    listen 127.0.0.1:{proxy_port};
    server_name {HOST};
    location / {{ include {location_path}; }}
  }}
}}
""", encoding="utf-8")
        app = subprocess.Popen(
            ["python3", str(PROJECT / "app.py")], cwd=PROJECT,
            env={**os.environ, "KOPI_SAWAH_PORT": str(app_port), "KOPI_SAWAH_DB": str(db_path),
                 "KOPI_SAWAH_REQUIRE_ORIGIN": "1", "KOPI_SAWAH_WRITE_UNTIL": expiry},
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
        )
        proxy = None
        try:
            ready = False
            for _ in range(80):
                try:
                    code, _ = request(app_port, "GET", "/api/health")
                    if code == 200:
                        ready = True
                        break
                except OSError:
                    time.sleep(0.1)
            if not ready:
                raise AssertionError("fixture app did not become ready")
            check = subprocess.run([nginx, "-p", f"{tmp}/", "-c", str(nginx_conf), "-t"], capture_output=True, text=True)
            if check.returncode:
                raise AssertionError(f"nginx config test failed: {check.stderr}")
            proxy = subprocess.Popen([nginx, "-p", f"{tmp}/", "-c", str(nginx_conf)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            ready = False
            for _ in range(40):
                try:
                    code, _ = request(proxy_port, "GET", "/")
                    if code == 200:
                        ready = True
                        break
                except OSError:
                    time.sleep(0.1)
            if not ready:
                raise AssertionError("isolated proxy did not become ready")

            code, body = request(proxy_port, "GET", "/api/products")
            assert code == 200 and len(json.loads(body)["items"]) == 124, code
            same = f"http://{HOST}"
            code, body = request(proxy_port, "POST", "/api/products", {"name": "Disposable proxy test", "category": "Fixture", "price": 20000}, same)
            assert code == 201, (code, body)
            product = json.loads(body)["item"]
            code, body = request(proxy_port, "PUT", f"/api/products/{product['id']}", {"price": 21000}, same)
            assert code == 200 and json.loads(body)["item"]["price"] == 21000, (code, body)
            code, body = request(proxy_port, "POST", "/api/stock/count", {"product_id": product["id"], "counted_quantity": 5, "note": "uji"}, same)
            assert code == 201, (code, body)
            code, body = request(proxy_port, "POST", "/api/sales", {"items": [{"product_id": product["id"], "quantity": 2}], "payment_method": "dummy", "discount_amount": 0}, same)
            assert code == 201 and json.loads(body)["item"]["total_amount"] == 42000, (code, body)
            code, body = request(proxy_port, "POST", "/api/products", {"name": "Foreign write", "category": "Fixture", "price": 1}, "https://attacker.invalid")
            assert code == 403, (code, body)
            code, body = request(proxy_port, "GET", "/api/health")
            health = json.loads(body)
            assert code == 200 and health["counts"] == {"products": 125, "sales": 1}, health
            print("anonymous_read=200 add=201 edit=200 stock=201 sale=201 foreign_origin=403 persistent_fixture=ok")
        finally:
            if proxy is not None and proxy.poll() is None:
                subprocess.run([nginx, "-p", f"{tmp}/", "-c", str(nginx_conf), "-s", "quit"], capture_output=True, text=True, check=False)
                try:
                    proxy.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proxy.kill(); proxy.wait(timeout=5)
            if app.poll() is None:
                app.terminate()
                try:
                    app.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    app.kill(); app.wait(timeout=5)


if __name__ == "__main__":
    main()
