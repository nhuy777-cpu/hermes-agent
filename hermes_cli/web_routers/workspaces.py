"""Cowork workspaces — a named folder that scopes one chat's tools.

Hermes already had every moving part except a name and a place to keep the list:
``register_task_env_overrides(task_id, {"cwd": ...})`` binds a session's tools to a
directory (ACP uses it), ``_authoritative_workspace_root`` makes the file tools honour
it, and ``_path_resolution_warning`` warns when a relative write escapes it. This
module only stores the folders and lets the chat socket pick one, so the agent's
terminal and file tools start inside the folder the user chose.

Storage is a flat JSON list in HERMES_HOME rather than the config file: these are
user data that changes per task, and config.yaml is rewritten by ``hermes update``
config migrations.
"""

import json
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

_STORE_NAME = "workspaces.json"

# A deliverable listing walks the workspace on request. These caps keep a huge
# folder (a repo with node_modules, a photo archive) from stalling the dashboard.
_MAX_SCAN_ENTRIES = 20000
_MAX_DELIVERABLES = 200
_SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", "dist", "build", ".next", ".cache",
}


class WorkspaceCreate(BaseModel):
    name: str
    path: str
    # Confine the chat's file tools to this folder (HERMES_STRICT_ROOT on the PTY).
    strict: bool = False


class WorkspaceUpdate(BaseModel):
    name: Optional[str] = None
    strict: Optional[bool] = None


def _store_path() -> Path:
    from hermes_cli.update_cmd import get_hermes_home

    return get_hermes_home() / _STORE_NAME


def _read_all() -> list[dict[str, Any]]:
    """Every stored workspace. A corrupt or missing file reads as empty rather
    than breaking the chat page that lists them."""
    path = _store_path()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    entries = raw.get("workspaces") if isinstance(raw, dict) else raw
    return [e for e in entries if isinstance(e, dict)] if isinstance(entries, list) else []


def _write_all(entries: list[dict[str, Any]]) -> None:
    path = _store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # Write-then-replace so a crash mid-write cannot leave a truncated list.
    tmp = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_text(
            json.dumps({"workspaces": entries}, indent=2, ensure_ascii=False),
            encoding="utf-8")
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)


def _validated_dir(raw_path: str) -> str:
    """Absolute, existing directory, or an HTTP error naming what was wrong.

    The path is operator-supplied through an authenticated dashboard, so this
    guards against mistakes (a typo, a file instead of a folder) rather than
    against a hostile caller.
    """
    text = (raw_path or "").strip()
    if not text:
        raise HTTPException(400, "Workspace path is required")
    try:
        resolved = Path(text).expanduser().resolve()
    except (OSError, ValueError) as exc:
        raise HTTPException(400, f"Unusable path: {exc}") from exc
    if not resolved.exists():
        raise HTTPException(400, f"Folder does not exist: {resolved}")
    if not resolved.is_dir():
        raise HTTPException(400, f"Not a folder: {resolved}")
    return str(resolved)


def _public(entry: dict[str, Any]) -> dict[str, Any]:
    """Shape returned to the dashboard, with a liveness flag so the UI can grey
    out a workspace whose folder was moved or unplugged."""
    path = entry.get("path") or ""
    try:
        exists = bool(path) and Path(path).is_dir()
    except OSError:
        exists = False
    return {**entry, "exists": exists}


def find_workspace(workspace_id: str) -> Optional[dict[str, Any]]:
    """Look up one workspace by id. Imported by the chat socket, which needs the
    path before it can bind a session's tools to it."""
    wanted = (workspace_id or "").strip()
    if not wanted:
        return None
    return next((e for e in _read_all() if e.get("id") == wanted), None)


@router.get("/api/workspaces")
async def list_workspaces() -> dict[str, Any]:
    return {"workspaces": [_public(e) for e in _read_all()]}


@router.post("/api/workspaces")
async def create_workspace(body: WorkspaceCreate) -> dict[str, Any]:
    path = _validated_dir(body.path)
    name = (body.name or "").strip() or Path(path).name
    entries = _read_all()
    if any(e.get("path") == path for e in entries):
        raise HTTPException(409, f"A workspace already points at {path}")
    entry = {
        "id": uuid.uuid4().hex[:12],
        "name": name,
        "path": path,
        "strict": bool(body.strict),
        "created_at": time.time(),
    }
    entries.append(entry)
    _write_all(entries)
    return _public(entry)


@router.patch("/api/workspaces/{workspace_id}")
async def update_workspace(workspace_id: str, body: WorkspaceUpdate) -> dict[str, Any]:
    entries = _read_all()
    entry = next((e for e in entries if e.get("id") == workspace_id), None)
    if entry is None:
        raise HTTPException(404, "No such workspace")
    if body.name is not None:
        renamed = body.name.strip()
        if not renamed:
            raise HTTPException(400, "Name cannot be empty")
        entry["name"] = renamed
    if body.strict is not None:
        entry["strict"] = bool(body.strict)
    _write_all(entries)
    return _public(entry)


@router.delete("/api/workspaces/{workspace_id}")
async def delete_workspace(workspace_id: str) -> dict[str, Any]:
    entries = _read_all()
    kept = [e for e in entries if e.get("id") != workspace_id]
    if len(kept) == len(entries):
        raise HTTPException(404, "No such workspace")
    _write_all(kept)
    # Only the bookmark is removed; the folder and its contents are left alone.
    return {"ok": True, "removed": workspace_id}


def scan_deliverables(root: Path, *, limit: int = 50, since: float = 0.0) -> dict[str, Any]:
    """Files under *root* modified at or after *since* (epoch seconds), newest first.

    Mirrors Cowork's deliverables pane: with ``since`` set to the session's start
    this is "what the agent produced this session", and it works on any folder —
    no git repo needed, so a documents folder gets the same view a repo does.
    """
    capped = max(1, min(int(limit or 50), _MAX_DELIVERABLES))
    found: list[tuple[float, dict[str, Any]]] = []
    scanned = 0
    truncated = False

    for path in root.rglob("*"):
        scanned += 1
        if scanned > _MAX_SCAN_ENTRIES:
            truncated = True
            break
        try:
            if path.is_dir():
                continue
            # Skip build/vendor trees anywhere in the relative path, not just at
            # the top level: a monorepo hides node_modules several levels down.
            if _SKIP_DIRS.intersection(path.relative_to(root).parts[:-1]):
                continue
            stat = path.stat()
        except (OSError, ValueError):
            continue
        if stat.st_mtime < since:
            continue
        found.append((stat.st_mtime, {
            "name": path.name,
            "rel_path": str(path.relative_to(root)),
            "size": stat.st_size,
            "modified_at": stat.st_mtime,
        }))

    found.sort(key=lambda item: item[0], reverse=True)
    return {
        "root": str(root),
        "since": since,
        "truncated": truncated,
        "files": [item[1] for item in found[:capped]],
    }


@router.get("/api/workspaces/deliverables")
async def deliverables_for_path(path: str, limit: int = 50, since: float = 0.0) -> dict[str, Any]:
    """Path-addressed variant for surfaces that already know the folder (the
    desktop's session cwd) and keep no workspace bookmark."""
    root = Path(_validated_dir(path))
    return scan_deliverables(root, limit=limit, since=since)


@router.get("/api/workspaces/{workspace_id}/deliverables")
async def workspace_deliverables(workspace_id: str, limit: int = 50, since: float = 0.0) -> dict[str, Any]:
    entry = find_workspace(workspace_id)
    if entry is None:
        raise HTTPException(404, "No such workspace")
    root = Path(entry.get("path") or "")
    if not root.is_dir():
        raise HTTPException(410, f"Folder is gone: {root}")
    return {"workspace_id": workspace_id, **scan_deliverables(root, limit=limit, since=since)}
