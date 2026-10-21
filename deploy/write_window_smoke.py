#!/usr/bin/env python3
"""Verify a review-write window fails closed after its UTC deadline."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

PROJECT = Path(__file__).resolve().parents[1]


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def request(port: int, path: str, method: str = "GET", payload: dict | None = None):
    data = None if payload is None else json.dumps(payload).encode()
    headers = {"Host": f"127.0.0.1:{port}", "Origin": f"http://127.0.0.1:{port}", "Content-Type": "application/json"}
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=3) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def run_case(expiry: datetime | str | None, expected_status: int) -> int:
    with tempfile.TemporaryDirectory(prefix="kopi-write-window-") as tmp:
        port = free_port()
        db = Path(tmp) / "fixture.sqlite3"
        env = {**os.environ, "KOPI_SAWAH_PORT": str(port), "KOPI_SAWAH_DB": str(db),
               "KOPI_SAWAH_REQUIRE_ORIGIN": "1"}
        if expiry is not None:
            env["KOPI_SAWAH_WRITE_UNTIL"] = expiry.isoformat(timespec="seconds") if isinstance(expiry, datetime) else expiry
        proc = subprocess.Popen(
            [sys.executable, str(PROJECT / "app.py")], cwd=PROJECT, env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
        )
        try:
            ready = False
            for _ in range(80):
                try:
                    code, health = request(port, "/api/health")
                    if code == 200:
                        ready = True
                        break
                except OSError:
                    time.sleep(0.1)
            if not ready:
                raise AssertionError("fixture app did not become ready")
            code, result = request(port, "/api/products", "POST", {"name": "Dummy window test", "category": "Fixture", "price": 100})
            assert code == expected_status, (repr(expiry), code, result)
            code, products = request(port, "/api/products")
            assert code == 200
            return len(products["items"])
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)


def main() -> None:
    now = datetime.now(timezone.utc)
    future_count = run_case(now + timedelta(minutes=30), 201)
    expired_count = run_case(now - timedelta(minutes=1), 403)
    missing_count = run_case(None, 403)
    invalid_count = run_case("not-a-date", 403)
    assert future_count == 125, future_count
    assert expired_count == missing_count == invalid_count == 124, (expired_count, missing_count, invalid_count)
    print(f"future_write=201 expired_write=403 missing_deadline=403 invalid_deadline=403 counts={future_count}/{expired_count}/{missing_count}/{invalid_count}")


if __name__ == "__main__":
    main()
