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
         "subs_mode": {"enum": ["embed", "srt"]}, "wait": _B}, "required": ["url"]}},
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

    async def request(self, tool: str, summary: str, timeout: float = 180) -> bool:
        approval_id = os.urandom(6).hex()
        future = asyncio.get_running_loop().create_future()
        self.pending[approval_id] = {"id": approval_id, "tool": tool, "summary": summary,
                                     "created": time.time(), "future": future}
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

    def record(self, tool: str, summary: str, status: str) -> None:
        self.log.insert(0, {"tool": tool, "summary": summary, "status": status, "time": time.time()})
        del self.log[40:]


def create_router(handlers: dict[str, Callable[[dict], Awaitable[str]]],
                  describe: Callable[[str, dict], Awaitable[str]],
                  mode: Callable[[], str], token: Callable[[], str], version: str) -> tuple[APIRouter, Approvals]:
    router = APIRouter()
    approvals = Approvals()

    async def call_tool(name: str, args: dict) -> dict:
        if name not in handlers:
            return _text(f"Unknown tool {name}", True)
        current = mode()
        if current == "off":
            return _text("MCP access is turned off in the Downloader settings.", True)
        summary = await describe(name, args) if name in WRITE_TOOLS else name
        if name in WRITE_TOOLS and current != "full":
            if not await approvals.request(name, summary):
                approvals.record(name, summary, "denied")
                return _text("The user declined this action (or did not answer in time).", True)
        try:
            result = await handlers[name](args)
            if name in WRITE_TOOLS:
                approvals.record(name, summary, "ok")
            return _text(result)
        except Exception as exc:  # noqa: BLE001 - report tool errors to the model, not as protocol errors
            if name in WRITE_TOOLS:
                approvals.record(name, summary, "error")
            return _text(f"Error: {exc}", True)

    async def handle(message: dict) -> dict | None:
        method, msg_id = message.get("method"), message.get("id")
        params = message.get("params") or {}
        if msg_id is None:  # notification
            return None
        if method == "initialize":
            requested = params.get("protocolVersion")
            result = {"protocolVersion": requested if requested in PROTOCOLS else PROTOCOLS[0],
                      "capabilities": {"tools": {}}, "serverInfo": {"name": "downloader", "version": version},
                      "instructions": INSTRUCTIONS}
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": TOOLS}
        elif method == "tools/call":
            result = await call_tool(params.get("name", ""), params.get("arguments") or {})
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
        try:
            body = await request.json()
        except ValueError:
            return JSONResponse({"jsonrpc": "2.0", "id": None,
                                 "error": {"code": -32700, "message": "Parse error"}}, status_code=400)
        if isinstance(body, list):
            replies = [r for r in await asyncio.gather(*(handle(m) for m in body)) if r]
            return JSONResponse(replies) if replies else Response(status_code=202)
        reply = await handle(body)
        return JSONResponse(reply) if reply else Response(status_code=202)

    @router.get("/mcp")
    async def mcp_get():
        return Response(status_code=405, headers={"Allow": "POST"})

    @router.delete("/mcp")
    async def mcp_delete():
        return Response(status_code=200)

    return router, approvals


def _text(text: str, error: bool = False) -> dict:
    return {"content": [{"type": "text", "text": text}], "isError": error}
