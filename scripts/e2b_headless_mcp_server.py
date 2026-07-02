from dotenv import load_dotenv
load_dotenv()
"""
E2B Headless MCP Server — Sandbox Execution for AI Agents
===========================================================
Headless. No GUI, no desktop, no screenshots. Pure code/command execution
inside E2B sandboxes, with EXPLICIT sandbox identity tracking so the calling
AI always knows: same sandbox as before, or a freshly created one.

Why identity tracking matters:
E2B sandboxes die (timeout, kill, host recycle). A naive single-global
sandbox (like the desktop-mcp draft) silently swaps sandboxes underneath the
agent with zero signal. Here, every state-changing tool returns:
  - sandbox_id      (E2B's real ID — stable across reconnects)
  - project_id      (your logical key)
  - is_new          (true if this call just created a sandbox)
  - reconnected     (true if the old handle was dead and we recreated)
  - uptime_seconds  (age of the CURRENT underlying sandbox)

INSTALL:
    pip install e2b mcp

RUN (stdio):
    E2B_API_KEY=your_key python e2b_headless_mcp_server.py stdio

RUN (http):
    E2B_API_KEY=your_key python e2b_headless_mcp_server.py http
"""

import os
import sys
import json
import asyncio
from typing import Dict, Optional
from datetime import datetime, timezone

from mcp.server.fastmcp import FastMCP
from e2b import Sandbox

# ── Configuration ────────────────────────────────────────────────────────

E2B_API_KEY = os.getenv("E2B_API_KEY", "")
E2B_TEMPLATE_ID = os.getenv("E2B_TEMPLATE_ID")  # optional custom template
DEFAULT_WORKDIR = "/home/user/workspace"

# Sandbox lifetime per creation/renewal (E2B max: 3600s Hobby / 86400s Pro)
SANDBOX_TIMEOUT_S = 3600
# How often the keepalive loop renews the timeout
KEEPALIVE_INTERVAL_S = 20 * 60

# ── Registry: project_id -> sandbox record ──────────────────────────────
# This is the single source of truth for "which sandbox belongs to which
# project". Everything else derives from here.

class SandboxRecord:
    def __init__(self, sandbox: Sandbox):
        self.sandbox: Sandbox = sandbox
        self.sandbox_id: str = sandbox.sandbox_id
        self.created_at: datetime = datetime.now(timezone.utc)
        self.last_used_at: datetime = self.created_at
        self.recreate_count: int = 0
        self.keepalive_task: Optional[asyncio.Task] = None


_registry: Dict[str, SandboxRecord] = {}
_lock = asyncio.Lock()

# ── Helpers ──────────────────────────────────────────────────────────────

def _require_api_key():
    if not E2B_API_KEY:
        raise RuntimeError(
            "E2B_API_KEY not set. Export it or put it in a .env file."
        )


def _uptime_s(rec: SandboxRecord) -> float:
    return (datetime.now(timezone.utc) - rec.created_at).total_seconds()


def _probe_alive(sandbox: Sandbox) -> bool:
    """Real liveness check, not just an is_running() flag on a stale handle."""
    try:
        return bool(sandbox.is_running())
    except Exception:
        return False


async def _keepalive_loop(project_id: str):
    """Renews the sandbox timeout periodically. Dies quietly if the sandbox
    is gone — the next get_or_create call will detect that and recreate."""
    while True:
        await asyncio.sleep(KEEPALIVE_INTERVAL_S)
        rec = _registry.get(project_id)
        if rec is None:
            return
        try:
            rec.sandbox.set_timeout(SANDBOX_TIMEOUT_S)
        except Exception:
            return


def _start_keepalive(project_id: str, rec: SandboxRecord):
    if rec.keepalive_task and not rec.keepalive_task.done():
        rec.keepalive_task.cancel()
    rec.keepalive_task = asyncio.get_event_loop().create_task(
        _keepalive_loop(project_id)
    )


def _mkdir_workdir(sandbox: Sandbox):
    try:
        sandbox.commands.run(f"mkdir -p {DEFAULT_WORKDIR}", timeout=10)
    except Exception:
        pass


def _new_sandbox() -> Sandbox:
    _require_api_key()
    kwargs = {"api_key": E2B_API_KEY, "timeout": SANDBOX_TIMEOUT_S}
    if E2B_TEMPLATE_ID:
        kwargs["template"] = E2B_TEMPLATE_ID
    sb = Sandbox.create(**kwargs)
    _mkdir_workdir(sb)
    return sb


async def _get_or_create(project_id: str) -> tuple[SandboxRecord, bool, bool]:
    async with _lock:
        rec = _registry.get(project_id)

        if rec is None:
            sb = _new_sandbox()
            rec = SandboxRecord(sb)
            _registry[project_id] = rec
            _start_keepalive(project_id, rec)
            return rec, True, False

        if _probe_alive(rec.sandbox):
            rec.last_used_at = datetime.now(timezone.utc)
            return rec, False, False

        sb = _new_sandbox()
        rec.sandbox = sb
        rec.sandbox_id = sb.sandbox_id
        rec.created_at = datetime.now(timezone.utc)
        rec.last_used_at = rec.created_at
        rec.recreate_count += 1
        _start_keepalive(project_id, rec)
        return rec, False, True


def _abspath(rel: str) -> str:
    rel = (rel or ".").lstrip("/")
    return DEFAULT_WORKDIR if rel in ("", ".") else f"{DEFAULT_WORKDIR}/{rel}"


mcp = FastMCP("E2B-Headless-Sandbox")


@mcp.tool()
async def get_or_create_sandbox(project_id: str) -> str:
    try:
        rec, is_new, reconnected = await _get_or_create(project_id)
        return json.dumps({
            "ok": True,
            "project_id": project_id,
            "sandbox_id": rec.sandbox_id,
            "is_new": is_new,
            "reconnected": reconnected,
            "recreate_count": rec.recreate_count,
            "uptime_seconds": round(_uptime_s(rec), 1),
        }, indent=2)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)}, indent=2)


@mcp.tool()
async def get_sandbox_status(project_id: str) -> str:
    rec = _registry.get(project_id)
    if rec is None:
        return json.dumps({"ok": True, "exists": False, "project_id": project_id}, indent=2)
    alive = _probe_alive(rec.sandbox)
    return json.dumps({
        "ok": True, "exists": True, "project_id": project_id,
        "sandbox_id": rec.sandbox_id, "alive": alive,
        "uptime_seconds": round(_uptime_s(rec), 1),
        "recreate_count": rec.recreate_count,
        "last_used_at": rec.last_used_at.isoformat(),
    }, indent=2)


@mcp.tool()
async def list_active_sandboxes() -> str:
    items = [{
        "project_id": pid, "sandbox_id": rec.sandbox_id,
        "uptime_seconds": round(_uptime_s(rec), 1),
        "recreate_count": rec.recreate_count,
    } for pid, rec in _registry.items()]
    return json.dumps({"ok": True, "count": len(items), "sandboxes": items}, indent=2)


@mcp.tool()
async def kill_sandbox(project_id: str) -> str:
    rec = _registry.pop(project_id, None)
    if rec is None:
        return json.dumps({"ok": True, "killed": False, "reason": "no such project_id"}, indent=2)
    if rec.keepalive_task:
        rec.keepalive_task.cancel()
    old_id = rec.sandbox_id
    try:
        rec.sandbox.kill()
    except Exception:
        pass
    return json.dumps({"ok": True, "killed": True, "project_id": project_id, "sandbox_id": old_id}, indent=2)


@mcp.tool()
async def run_command(project_id: str, command: str, timeout_s: int = 60, background: bool = False) -> str:
    try:
        rec, is_new, reconnected = await _get_or_create(project_id)
        sb = rec.sandbox
        if background:
            sb.commands.run(command, background=True, cwd=DEFAULT_WORKDIR)
            return json.dumps({
                "ok": True, "sandbox_id": rec.sandbox_id,
                "is_new": is_new, "reconnected": reconnected,
                "background": True, "command": command,
            }, indent=2)
        result = sb.commands.run(command, timeout=timeout_s, cwd=DEFAULT_WORKDIR)
        stdout = result.stdout
        stderr = result.stderr
        if len(stdout) > 6000: stdout = stdout[:6000] + "\n... (truncated)"
        if len(stderr) > 2000: stderr = stderr[:2000] + "\n... (truncated)"
        return json.dumps({
            "ok": result.exit_code == 0, "sandbox_id": rec.sandbox_id,
            "is_new": is_new, "reconnected": reconnected,
            "exit_code": result.exit_code, "stdout": stdout, "stderr": stderr,
        }, indent=2)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)}, indent=2)


@mcp.tool()
async def write_file(project_id: str, file_path: str, content: str) -> str:
    try:
        rec, is_new, reconnected = await _get_or_create(project_id)
        sb = rec.sandbox
        target = _abspath(file_path)
        parent = target.rsplit("/", 1)[0]
        sb.commands.run(f"mkdir -p {parent}", timeout=10)
        sb.files.write(target, content)
        return json.dumps({
            "ok": True, "sandbox_id": rec.sandbox_id,
            "is_new": is_new, "reconnected": reconnected,
            "file_path": file_path, "bytes": len(content),
        }, indent=2)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)}, indent=2)


@mcp.tool()
async def read_file(project_id: str, file_path: str) -> str:
    try:
        rec, is_new, reconnected = await _get_or_create(project_id)
        sb = rec.sandbox
        try:
            content = sb.files.read(_abspath(file_path))
        except Exception:
            return json.dumps({"ok": False, "sandbox_id": rec.sandbox_id,
                               "error": f"File not found: {file_path}"}, indent=2)
        truncated = len(content) > 8000
        return json.dumps({
            "ok": True, "sandbox_id": rec.sandbox_id,
            "is_new": is_new, "reconnected": reconnected,
            "file_path": file_path, "content": content[:8000],
            "truncated": truncated,
        }, indent=2)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)}, indent=2)


@mcp.tool()
async def delete_file(project_id: str, file_path: str) -> str:
    try:
        rec, is_new, reconnected = await _get_or_create(project_id)
        rec.sandbox.files.remove(_abspath(file_path))
        return json.dumps({
            "ok": True, "sandbox_id": rec.sandbox_id,
            "is_new": is_new, "reconnected": reconnected,
            "file_path": file_path,
        }, indent=2)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)}, indent=2)


@mcp.tool()
async def list_directory(project_id: str, path: str = ".") -> str:
    try:
        rec, is_new, reconnected = await _get_or_create(project_id)
        target = _abspath(path)
        res = rec.sandbox.commands.run(
            f"find {target} -not -path '*/node_modules/*' -not -path '*/.git/*' "
            f"2>/dev/null | head -200",
            timeout=15,
        )
        return json.dumps({
            "ok": True, "sandbox_id": rec.sandbox_id,
            "is_new": is_new, "reconnected": reconnected,
            "path": path, "listing": res.stdout,
        }, indent=2)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)}, indent=2)


@mcp.prompt()
def identity_first_prompt(project_id: str) -> str:
    return (
        f"Before running any command or file operation for project_id="
        f'"{project_id}", call get_or_create_sandbox("{project_id}") first. '
        "Check is_new and reconnected in the response."
    )


if __name__ == "__main__":
    transport = sys.argv[1] if len(sys.argv) > 1 else "stdio"
    if transport == "stdio":
        print("Starting E2B Headless MCP Server (stdio)...", file=sys.stderr)
        mcp.run(transport="stdio")
    elif transport == "http":
        print("Starting E2B Headless MCP Server (http on :8000/mcp)...", file=sys.stderr)
        from starlette.applications import Starlette
        import uvicorn
        app = Starlette()
        app.mount("/mcp", mcp.streamable_http_app())
        uvicorn.run(app, host="0.0.0.0", port=8000)
    else:
        print(f"Unknown transport: {transport}. Use: stdio or http", file=sys.stderr)
        sys.exit(1)