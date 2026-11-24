"""MCP server (Streamable HTTP, JSON responses) so AI assistants can drive the app.

Token-lean by design: few tools, short descriptions and compact pipe-separated
text results instead of verbose JSON. Permission modes:
  off  - every call is refused
  ask  - reading is free; download/edit/delete/open wait for approval in the app
  full - everything runs without asking
"""
from __future__ import annotations

import asyncio
import os
import time
from typing import Awaitable, Callable

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

PROTOCOLS = ("2025-06-18", "2025-03-26", "2024-11-05")
WRITE_TOOLS = {"download", "edit", "delete", "open"}

_S, _N, _B = {"type": "string"}, {"type": "number"}, {"type": "boolean"}
TOOLS = [
    {"name": "search", "description": "Search YouTube, or list a channel's uploads. Lines: url|title|channel|length|views. "
                                      "Pass the returned page token as page for more.",
     "inputSchema": {"type": "object", "properties": {
         "q": _S, "type": {"enum": ["video", "short", "channel"]}, "channel": {**_S, "description": "@handle or UC id"},
         "page": _S}}},
    {"name": "info", "description": "Media details for any video URL: duration, resolutions, audio languages, subtitles.",
     "inputSchema": {"type": "object", "properties": {"url": _S}, "required": ["url"]}},
    {"name": "download", "description": "Download into the gallery. quality: video height or mp3 kbps. start/end in "
                                        "seconds trim. wait=true returns when finished.",
     "inputSchema": {"type": "object", "properties": {
         "url": _S, "format": {"enum": ["mp4", "mp3"]}, "quality": _N, "start": _N, "end": _N,
         "audio_lang": _S, "subs": {**_S, "description": "subtitle language code"},
         "subs_mode": {"enum": ["embed", "srt", "burn"]}, "wait": _B}, "required": ["url"]}},
    {"name": "jobs", "description": "Active and recent downloads/edits.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "cancel", "description": "Cancel a job.", "inputSchema": {"type": "object", "properties": {"id": _S},
                                                                     "required": ["id"]}},
    {"name": "library", "description": "Downloaded files. Lines: id|title|format|size|length|path.",
     "inputSchema": {"type": "object", "properties": {"q": _S, "limit": _N}}},
    {"name": "edit", "description": "Re-cut or convert a library file with ffmpeg (start/end seconds, height, "
                                    "format). replace=true overwrites the original.",
     "inputSchema": {"type": "object", "properties": {
         "id": _S, "start": _N, "end": _N, "height": _N, "format": {"enum": ["mp4", "mp3"]},
         "replace": _B, "wait": _B}, "required": ["id"]}},
    {"name": "delete", "description": "Move library files to the Recycle Bin.",
     "inputSchema": {"type": "object", "properties": {"ids": {"type": "array", "items": _S}}, "required": ["ids"]}},
    {"name": "open", "description": "Show a library file to the user: play it, or reveal it in Explorer.",
     "inputSchema": {"type": "object", "properties": {"id": _S, "how": {"enum": ["play", "folder"]}},
                     "required": ["id"]}},
]
INSTRUCTIONS = ("Downloader desktop app. search -> info (optional) -> download. Files land in the app gallery; "
                "use library ids for edit/delete/open.")


class Approvals:
    def __init__(self):
        self.pending: dict[str, dict] = {}
        self.log: list[dict] = []

    async def request(self, tool: str, summary: str, client: dict | None = None, timeout: float = 180) -> bool:
        approval_id = os.urandom(6).hex()
        future = asyncio.get_running_loop().create_future()
        self.pending[approval_id] = {"id": approval_id, "tool": tool, "summary": summary, "created": time.time(),
                                     "ai": (client or {}).get("ai", "other"), "client": (client or {}).get("label", ""),
                                     "future": future}
        try:
            return await asyncio.wait_for(asyncio.shield(future), timeout)
        except asyncio.TimeoutError:
            return False
        finally:
            self.pending.pop(approval_id, None)

    def answer(self, approval_id: str, allow: bool) -> bool:
        item = self.pending.get(approval_id)
        if not item or item["future"].done():
            return False
        item["future"].set_result(bool(allow))
        return True

    def listing(self) -> list[dict]:
        return [{k: v for k, v in x.items() if k != "future"} for x in self.pending.values()]

    def record(self, tool: str, summary: str, status: str, client: dict | None = None) -> None:
        self.log.insert(0, {"tool": tool, "summary": summary, "status": status, "time": time.time(),
                            "ai": (client or {}).get("ai", "other"), "client": (client or {}).get("label", "")})
        del self.log[60:]


AI_PATTERNS = [
    ("claude", ("claude", "anthropic")),
    ("openai", ("codex", "openai", "chatgpt", "gpt")),
    ("gemini", ("gemini", "google")),
    ("kimi", ("kimi", "moonshot")),
    ("grok", ("grok", "xai")),
    ("deepseek", ("deepseek", "dsh")),
]
AI_NAMES = {"claude": "Claude", "openai": "OpenAI", "gemini": "Gemini", "kimi": "Kimi", "grok": "Grok",
            "deepseek": "DeepSeek", "other": "AI-kliens"}


def detect_ai(client_name: str) -> str:
    name = (client_name or "").casefold()
    return next((ai for ai, needles in AI_PATTERNS if any(n in name for n in needles)), "other")


class Sessions:
    """Connected MCP clients. stdio bridges send heartbeats; HTTP clients count while recently active."""

    def __init__(self):
        self.items: dict[str, dict] = {}
        self.revoked: set[str] = set()

    def open(self, client: dict, transport: str) -> dict:
        session_id = os.urandom(12).hex()
        name = str(client.get("name") or "MCP client")[:80]
        ai = detect_ai(name + " " + str(client.get("title") or ""))
        label = str(client.get("title") or name)[:80]
        self.items[session_id] = {"id": session_id, "ai": ai, "aiName": AI_NAMES[ai], "label": label,
                                  "version": str(client.get("version") or "")[:30], "transport": transport,
                                  "started": time.time(), "seen": time.time(), "calls": 0, "last": ""}
        return self.items[session_id]

    def touch(self, session_id: str | None) -> dict | None:
        session = self.items.get(session_id or "")
        if session:
            session["seen"] = time.time()
        return session

    def close(self, session_id: str) -> None:
        self.items.pop(session_id, None)

    def revoke(self, session_id: str) -> bool:
        if session_id not in self.items:
            return False
        self.revoked.add(session_id)
        self.items.pop(session_id, None)
        return True

    def listing(self) -> list[dict]:
        now = time.time()
        out = []
        for session in list(self.items.values()):
            limit = 45 if session["transport"] == "stdio" else 900
            if now - session["seen"] > limit * 4:
                self.items.pop(session["id"], None)
                continue
            out.append({**session, "connected": now - session["seen"] <= limit})
        return sorted(out, key=lambda s: -s["started"])


def create_router(handlers: dict[str, Callable[[dict], Awaitable[str]]],
                  describe: Callable[[str, dict], Awaitable[str]],
                  mode: Callable[[], str], token: Callable[[], str], version: str,
                  blocked: Callable[[], list] = lambda: []) -> tuple[APIRouter, Approvals]:
    router = APIRouter()
    approvals = Approvals()
    sessions = Sessions()
    router.sessions = sessions  # type: ignore[attr-defined]

    async def call_tool(name: str, args: dict, client: dict | None) -> dict:
        if name not in handlers:
            return _text(f"Unknown tool {name}", True)
        current = mode()
        if current == "off":
            return _text("MCP access is turned off in the Downloader settings.", True)
        if client:
            client["calls"] += 1
            client["last"] = name
        summary = await describe(name, args) if name in WRITE_TOOLS else name
        if name in WRITE_TOOLS and current != "full":
            if not await approvals.request(name, summary, client):
                approvals.record(name, summary, "denied", client)
                return _text("The user declined this action (or did not answer in time).", True)
        try:
            result = await handlers[name](args)
            approvals.record(name, summary, "ok", client)
            return _text(result)
        except Exception as exc:  # noqa: BLE001 - report tool errors to the model, not as protocol errors
            approvals.record(name, summary, "error", client)
            return _text(f"Error: {exc}", True)

    async def handle(message: dict, session: dict | None, transport: str, created: list) -> dict | None:
        method, msg_id = message.get("method"), message.get("id")
        params = message.get("params") or {}
        if msg_id is None:  # notification
            return None
        if method == "initialize":
            client = params.get("clientInfo") or {}
            if detect_ai(str(client.get("name") or "") + " " + str(client.get("title") or "")) in blocked():
                return {"jsonrpc": "2.0", "id": msg_id,
                        "error": {"code": -32001, "message": "This AI is blocked in the Downloader settings."}}
            created.append(sessions.open(client, transport))
            requested = params.get("protocolVersion")
            result = {"protocolVersion": requested if requested in PROTOCOLS else PROTOCOLS[0],
                      "capabilities": {"tools": {}}, "serverInfo": {"name": "downloader", "version": version},
                      "instructions": INSTRUCTIONS}
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": TOOLS}
        elif method == "tools/call":
            if session and session["ai"] in blocked():
                result = _text("This AI is blocked in the Downloader settings.", True)
            else:
                result = await call_tool(params.get("name", ""), params.get("arguments") or {}, session)
        else:
            return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": "Method not found"}}
        return {"jsonrpc": "2.0", "id": msg_id, "result": result}

    def authorized(request: Request) -> bool:
        origin = request.headers.get("origin")
        if origin and not origin.startswith(("http://127.0.0.1", "http://localhost")):
            return False
        return request.headers.get("authorization", "") == f"Bearer {token()}"

    @router.post("/mcp")
    async def mcp_post(request: Request):
        if not authorized(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        session_id = request.headers.get("mcp-session-id")
        if session_id and session_id in sessions.revoked:
            return JSONResponse({"jsonrpc": "2.0", "id": None, "error": {"code": -32002, "message": "Disconnected by the user."}},
                                status_code=404, headers={"X-Downloader-Revoked": "1"})
        session = sessions.touch(session_id)
        transport = "stdio" if request.headers.get("x-mcp-transport") == "stdio" else "http"
        try:
            body = await request.json()
        except ValueError:
            return JSONResponse({"jsonrpc": "2.0", "id": None,
                                 "error": {"code": -32700, "message": "Parse error"}}, status_code=400)
        created: list = []
        if isinstance(body, list):
            replies = [r for r in await asyncio.gather(*(handle(m, session, transport, created) for m in body)) if r]
            response = JSONResponse(replies) if replies else Response(status_code=202)
        else:
            reply = await handle(body, session, transport, created)
            response = JSONResponse(reply) if reply else Response(status_code=202)
        if created:
            response.headers["Mcp-Session-Id"] = created[0]["id"]
        return response

    @router.post("/mcp/heartbeat")
    async def mcp_heartbeat(request: Request):
        if not authorized(request):
            return Response(status_code=401)
        session_id = request.headers.get("mcp-session-id") or ""
        if session_id in sessions.revoked:
            return Response(status_code=404, headers={"X-Downloader-Revoked": "1"})
        return Response(status_code=204 if sessions.touch(session_id) else 404)

    @router.get("/mcp")
    async def mcp_get():
        return Response(status_code=405, headers={"Allow": "POST"})

    @router.delete("/mcp")
    async def mcp_delete(request: Request):
        if authorized(request):
            sessions.close(request.headers.get("mcp-session-id") or "")
        return Response(status_code=200)

    return router, approvals


def _text(text: str, error: bool = False) -> dict:
    return {"content": [{"type": "text", "text": text}], "isError": error}
