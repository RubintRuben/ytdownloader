"""`Downloader.exe --mcp`: tiny stdio <-> HTTP relay for MCP clients (Claude Desktop, Claude Code).

Kept free of heavy imports so the MCP client gets an answer fast; the running app
does the real work. If the app is not running yet, it is started in the background.
"""
from __future__ import annotations

import json
import os
import subprocess
import threading
import sys
import time
from pathlib import Path
from typing import Callable


def server_file() -> Path:
    return Path(os.environ.get("APPDATA") or Path.home()) / "Downloader" / "server.json"


def launch_app() -> None:
    if getattr(sys, "frozen", False):
        command = [sys.executable]
        cwd = str(Path(sys.executable).resolve().parent)
    else:
        app_py = Path(__file__).resolve().parent / "app.py"
        command, cwd = [sys.executable, str(app_py)], str(app_py.parent)
    flags = 0x00000008 | 0x00000200 if os.name == "nt" else 0  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    # A new, independent app instance: it must unpack its own files instead of
    # sharing (and later blocking) this short-lived bridge process's temp folder.
    env = {**os.environ, "PYINSTALLER_RESET_ENVIRONMENT": "1"}
    subprocess.Popen(command, cwd=cwd, creationflags=flags, close_fds=True, env=env,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main() -> int:
    return run_stdio_bridge(server_file(), launch_app)


def run_stdio_bridge(server_file, launch: Callable[[], None]) -> int:
    """Relay stdio JSON-RPC lines to the running app's /mcp endpoint."""
    import httpx

    if os.name == "nt" and getattr(sys, "frozen", False):
        # A windowed EXE has no Python stdio objects; use the pipes the MCP client handed us.
        import ctypes
        import msvcrt
        get = ctypes.windll.kernel32.GetStdHandle
        get.restype = ctypes.c_void_p
        stdin = os.fdopen(msvcrt.open_osfhandle(get(-10), os.O_RDONLY | os.O_BINARY), "rb", buffering=0)
        stdout = os.fdopen(msvcrt.open_osfhandle(get(-11), os.O_BINARY), "wb", buffering=0)
    else:
        stdin, stdout = sys.stdin.buffer, sys.stdout.buffer

    def endpoint():
        try:
            data = json.loads(server_file.read_text(encoding="utf-8"))
            with httpx.Client(timeout=2, trust_env=False) as client:
                client.get(data["url"] + "/api/version").raise_for_status()
            return data
        except Exception:  # noqa: BLE001
            return None

    target = endpoint()
    if not target:
        launch()
        deadline = time.monotonic() + 60
        while not target and time.monotonic() < deadline:
            time.sleep(0.5)
            target = endpoint()
    client = httpx.Client(timeout=httpx.Timeout(900, connect=10), trust_env=False)
    state = {"session": None, "init": None}
    lock = threading.Lock()

    def send(obj):
        with lock:
            stdout.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n")
            stdout.flush()

    def headers():
        h = {"Authorization": f"Bearer {target['token']}", "Content-Type": "application/json", "X-MCP-Transport": "stdio"}
        if state["session"]:
            h["Mcp-Session-Id"] = state["session"]
        return h

    def revoked(response) -> bool:
        return response.status_code == 404 and response.headers.get("x-downloader-revoked") == "1"

    def reregister():
        """The app restarted: register this client again so it shows up as connected."""
        if not state["init"] or not target:
            return
        state["session"] = None
        response = client.post(target["url"] + "/mcp", content=state["init"], headers=headers())
        state["session"] = response.headers.get("mcp-session-id") or None

    def heartbeat():
        beat = httpx.Client(timeout=5, trust_env=False)
        while True:
            time.sleep(15)
            if not target or not state["session"]:
                continue
            try:
                response = beat.post(target["url"] + "/mcp/heartbeat", headers=headers())
                if revoked(response):
                    os._exit(0)  # the user disconnected this AI in the app
                if response.status_code == 404:
                    reregister()
            except Exception:  # noqa: BLE001 - the app may be restarting
                pass

    threading.Thread(target=heartbeat, daemon=True).start()

    for raw in iter(stdin.readline, b""):
        line = raw.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if not target:
            target = endpoint()
        if not target:
            if isinstance(message, dict) and message.get("id") is not None:
                send({"jsonrpc": "2.0", "id": message["id"],
                      "error": {"code": -32000, "message": "The Downloader app is not running."}})
            continue
        is_init = isinstance(message, dict) and message.get("method") == "initialize"
        if is_init:
            state["init"], state["session"] = line, None
        try:
            response = client.post(target["url"] + "/mcp", content=line, headers=headers())
            if revoked(response):
                if isinstance(message, dict) and message.get("id") is not None:
                    send({"jsonrpc": "2.0", "id": message["id"],
                          "error": {"code": -32002, "message": "Disconnected by the user in Downloader."}})
                os._exit(0)
            if is_init and response.headers.get("mcp-session-id"):
                state["session"] = response.headers["mcp-session-id"]
            if response.status_code == 200 and response.content:
                send(response.json())
        except Exception as exc:  # noqa: BLE001
            target = None
            if isinstance(message, dict) and message.get("id") is not None:
                send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32000, "message": str(exc)}})
    if target and state["session"]:
        try:
            client.request("DELETE", target["url"] + "/mcp", headers=headers(), timeout=3)
        except Exception:  # noqa: BLE001
            pass
    return 0
