#!/usr/bin/env python3
"""Minimal MCP stdio bridge to the host executor Unix socket."""
from __future__ import annotations

import json
import os
import socket
import sys
import uuid

SOCKET_PATH = os.environ.get("HOST_EXECUTOR_SOCKET", "/workspace/extra/host-executor-run/executor.sock")

TOOL = {
    "name": "host_exec",
    "description": (
        "Execute a shell command on the trusted host computer as the host user, outside the container. "
        "Use only when the request needs host files, services, Docker, processes, or hardware that the container cannot access. "
        "Commands are audited. Root commands still depend on the host's sudo policy."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "command": {"type": "string", "description": "Bash command to run on the host"},
            "cwd": {"type": "string", "description": "Absolute host working directory; defaults to the host home"},
            "timeout": {"type": "integer", "minimum": 1, "maximum": 600, "default": 120},
            "confirm_dangerous": {
                "type": "boolean",
                "default": False,
                "description": "Set true only when the user explicitly approved this destructive/root-impacting command",
            },
        },
        "required": ["command"],
        "additionalProperties": False,
    },
}


def host_call(args: dict) -> dict:
    request = {"id": str(uuid.uuid4()), **args}
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(min(max(int(args.get("timeout", 120)) + 5, 10), 605))
        s.connect(SOCKET_PATH)
        s.sendall(json.dumps(request, ensure_ascii=False).encode("utf-8") + b"\n")
        data = b""
        while b"\n" not in data:
            chunk = s.recv(8192)
            if not chunk:
                break
            data += chunk
    return json.loads(data.split(b"\n", 1)[0].decode("utf-8"))


def reply(msg_id, result=None, error=None):
    out = {"jsonrpc": "2.0", "id": msg_id}
    if error is not None:
        out["error"] = error
    else:
        out["result"] = result
    sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    for line in sys.stdin:
        try:
            msg = json.loads(line)
            method = msg.get("method")
            msg_id = msg.get("id")
            if method == "initialize":
                reply(msg_id, {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "nanoclaw-host-executor", "version": "0.1.0"},
                })
            elif method == "notifications/initialized":
                continue
            elif method == "ping":
                reply(msg_id, {})
            elif method == "tools/list":
                reply(msg_id, {"tools": [TOOL]})
            elif method == "tools/call":
                params = msg.get("params") or {}
                if params.get("name") != "host_exec":
                    reply(msg_id, error={"code": -32602, "message": "unknown tool"})
                    continue
                try:
                    result = host_call(params.get("arguments") or {})
                    text = json.dumps(result, ensure_ascii=False, indent=2)
                    reply(msg_id, {"content": [{"type": "text", "text": text}], "isError": not result.get("ok", False)})
                except Exception as e:
                    reply(msg_id, {"content": [{"type": "text", "text": f"host executor error: {type(e).__name__}: {e}"}], "isError": True})
            elif msg_id is not None:
                reply(msg_id, error={"code": -32601, "message": "method not found"})
        except Exception as e:
            # Parse errors without a usable id are reported as JSON-RPC errors.
            reply(None, error={"code": -32700, "message": f"parse error: {type(e).__name__}"})


if __name__ == "__main__":
    main()
