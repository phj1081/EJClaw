#!/usr/bin/env python3
"""Host-side command executor for one trusted NanoClaw agent.

Protocol: one JSON object per Unix-socket connection, one JSON response.
The socket is mode 0600 and peer UID must match the service UID.
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import selectors
import signal
import socket
import struct
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone

RUNTIME_DIR = pathlib.Path(os.environ.get("HOST_EXECUTOR_RUNTIME", pathlib.Path.home() / ".local/share/nanoclaw-host-executor"))
SOCKET_PATH = RUNTIME_DIR / "executor.sock"
AUDIT_PATH = RUNTIME_DIR / "audit.jsonl"
MAX_REQUEST = 64 * 1024
MAX_OUTPUT = 100 * 1024
MAX_TIMEOUT = 600
EXPECTED_UID = os.getuid()

DANGEROUS_COMMANDS = re.compile(
    r"(?:"
    r"\brm\s+-[^\s]*(?:r[^\s]*f|f[^\s]*r)[^\s]*\b|"
    r"(?:^|[;&|]\s*)sudo\b|"
    r"\b(?:mkfs(?:\.\w+)?|fdisk|parted|shutdown|reboot|poweroff|halt)\b|"
    r"\bdd\s+[^\n]*\bof=/dev/|"
    r"\bgit\s+(?:reset\s+--hard|clean\s+-[^\s]*f)|"
    r"\bchmod\s+-R\s+777\s+/|"
    r":\(\)\s*\{"
    r")",
    re.IGNORECASE | re.MULTILINE,
)


def audit(record: dict) -> None:
    record = {"at": datetime.now(timezone.utc).isoformat(), **record}
    with AUDIT_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def peer_uid(conn: socket.socket) -> int | None:
    try:
        raw = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        _pid, uid, _gid = struct.unpack("3i", raw)
        return uid
    except (AttributeError, OSError):
        return None


def trim(data: bytes) -> tuple[str, bool]:
    truncated = len(data) > MAX_OUTPUT
    if truncated:
        data = data[:MAX_OUTPUT]
    return data.decode("utf-8", errors="replace"), truncated


def execute(req: dict) -> dict:
    request_id = str(req.get("id") or uuid.uuid4())
    command = req.get("command")
    if not isinstance(command, str) or not command.strip() or len(command) > 20000:
        return {"ok": False, "id": request_id, "error": "command must be a non-empty string up to 20000 chars"}
    if DANGEROUS_COMMANDS.search(command) and req.get("confirm_dangerous") is not True:
        result = {
            "ok": False,
            "id": request_id,
            "error": "dangerous command requires confirm_dangerous=true after explicit user approval",
        }
        audit({"id": request_id, "command": command, "denied": "dangerous_confirmation_required"})
        return result

    cwd_raw = req.get("cwd") or str(pathlib.Path.home())
    if not isinstance(cwd_raw, str) or not os.path.isabs(cwd_raw) or not os.path.isdir(cwd_raw):
        return {"ok": False, "id": request_id, "error": "cwd must be an existing absolute directory"}

    try:
        timeout = max(1, min(int(req.get("timeout", 120)), MAX_TIMEOUT))
    except (TypeError, ValueError):
        timeout = 120

    started = time.monotonic()
    base_audit = {
        "id": request_id,
        "cwd": cwd_raw,
        "command": command,
        "timeout": timeout,
    }
    try:
        proc = subprocess.run(
            ["/bin/bash", "-lc", command],
            cwd=cwd_raw,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            env={
                "HOME": str(pathlib.Path.home()),
                "USER": os.environ.get("USER", "ejclaw"),
                "LOGNAME": os.environ.get("LOGNAME", os.environ.get("USER", "ejclaw")),
                "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
                "LANG": os.environ.get("LANG", "C.UTF-8"),
                "TZ": os.environ.get("TZ", "Asia/Seoul"),
                # 1Password service account (user approved full access 2026-07-14).
                # Commands still go through the audit log; secrets resolve via `op read`.
                **({"OP_SERVICE_ACCOUNT_TOKEN": os.environ["OP_SERVICE_ACCOUNT_TOKEN"]}
                   if os.environ.get("OP_SERVICE_ACCOUNT_TOKEN") else {}),
            },
            check=False,
        )
        stdout, out_truncated = trim(proc.stdout)
        stderr, err_truncated = trim(proc.stderr)
        result = {
            "ok": proc.returncode == 0,
            "id": request_id,
            "exit_code": proc.returncode,
            "stdout": stdout,
            "stderr": stderr,
            "truncated": out_truncated or err_truncated,
            "elapsed_ms": round((time.monotonic() - started) * 1000),
        }
        audit({**base_audit, "result": {k: result[k] for k in ("ok", "exit_code", "truncated", "elapsed_ms")}})
        return result
    except subprocess.TimeoutExpired as e:
        stdout, out_truncated = trim(e.stdout or b"")
        stderr, err_truncated = trim(e.stderr or b"")
        result = {
            "ok": False,
            "id": request_id,
            "error": "timeout",
            "timed_out": True,
            "stdout": stdout,
            "stderr": stderr,
            "truncated": out_truncated or err_truncated,
            "elapsed_ms": round((time.monotonic() - started) * 1000),
        }
        audit({**base_audit, "result": {"ok": False, "error": "timeout", "elapsed_ms": result["elapsed_ms"]}})
        return result


def handle(conn: socket.socket) -> None:
    uid = peer_uid(conn)
    if uid is not None and uid != EXPECTED_UID:
        audit({"denied": "peer_uid", "peer_uid": uid})
        conn.sendall(json.dumps({"ok": False, "error": "peer uid denied"}).encode() + b"\n")
        return
    data = b""
    while b"\n" not in data and len(data) <= MAX_REQUEST:
        chunk = conn.recv(8192)
        if not chunk:
            break
        data += chunk
    if len(data) > MAX_REQUEST:
        response = {"ok": False, "error": "request too large"}
    else:
        try:
            req = json.loads(data.split(b"\n", 1)[0].decode("utf-8"))
            response = execute(req) if isinstance(req, dict) else {"ok": False, "error": "request must be an object"}
        except Exception as e:
            response = {"ok": False, "error": f"invalid request: {type(e).__name__}"}
    conn.sendall(json.dumps(response, ensure_ascii=False).encode("utf-8") + b"\n")


def main() -> None:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(RUNTIME_DIR, 0o700)
    if SOCKET_PATH.exists() or SOCKET_PATH.is_socket():
        SOCKET_PATH.unlink()
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(SOCKET_PATH))
    os.chmod(SOCKET_PATH, 0o600)
    server.listen(16)
    server.settimeout(1.0)
    stopping = False

    def stop(_sig, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    audit({"event": "started", "pid": os.getpid(), "socket": str(SOCKET_PATH)})
    try:
        while not stopping:
            try:
                conn, _ = server.accept()
            except socket.timeout:
                continue
            with conn:
                handle(conn)
    finally:
        server.close()
        try:
            SOCKET_PATH.unlink()
        except FileNotFoundError:
            pass
        audit({"event": "stopped", "pid": os.getpid()})


if __name__ == "__main__":
    main()
