"""RPC surface for "Record a skill": start/stop/status of the screen+click recorder.
Bodies are rebound onto server.py's globals at install (method_ctx.bind_module)."""

from __future__ import annotations

from .method_ctx import HandlerRegistry, bind_module

_registry = HandlerRegistry()
method = _registry.method

_E_SKILL_RECORD = 5071


def _call(rid, fn, **kwargs) -> dict:
    try:
        return _ok(rid, fn(**kwargs))
    except Exception as e:
        return _err(rid, _E_SKILL_RECORD, str(e))


@method("skill_record.start")
def _(rid, params: dict) -> dict:
    from tui_gateway import skill_recorder
    return _call(rid, skill_recorder.start, name=str(params.get("name") or ""))


@method("skill_record.status")
def _(rid, params: dict) -> dict:
    from tui_gateway import skill_recorder
    return _call(rid, skill_recorder.status)


@method("skill_record.stop")
def _(rid, params: dict) -> dict:
    from tui_gateway import skill_recorder
    return _call(rid, skill_recorder.stop, name=str(params.get("name") or ""),
                 discard=bool(params.get("discard")))


def register(server) -> None:
    bind_module(globals(), server, skip=("_",))
