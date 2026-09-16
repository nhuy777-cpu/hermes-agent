"""Screen + click recorder behind "Record a skill" (Windows).

Captures what the user DOES, not what they type: a screenshot on every mouse
click (and whenever the foreground window changes), tagged with cursor
position, window title and process. Keystrokes are deliberately never
recorded — a workflow demo passes through password fields and chat windows.
The agent later reads events.jsonl + the frames and writes the SKILL.md.

No new dependencies: ctypes for the input/window polling, PIL.ImageGrab for
the frames (both already in the venv).
# ponytail: win32 only (ctypes user32); mac/linux would need pynput + mss.
"""

from __future__ import annotations

import ctypes
import json
import logging
import os
import shutil
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

_POLL_S = 0.03
_MAX_EVENTS = 400
_MAX_SHOT_WIDTH = 1600
_IDLE_SHOT_S = 8.0
_VK_LBUTTON, _VK_RBUTTON = 0x01, 0x02


@dataclass
class _Recording:
    id: str
    directory: Path
    started_at: float
    events: list[dict[str, Any]] = field(default_factory=list)
    stop_flag: threading.Event = field(default_factory=threading.Event)
    thread: Optional[threading.Thread] = None
    shots: int = 0
    truncated: bool = False


_current: Optional[_Recording] = None
_lock = threading.Lock()


def recordings_root() -> Path:
    from hermes_constants import get_hermes_home
    return Path(get_hermes_home()) / "skill-recordings"


# ── win32 helpers ────────────────────────────────────────────────────────────

def _user32():
    return ctypes.windll.user32


class _POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


def _cursor() -> tuple[int, int]:
    pt = _POINT()
    _user32().GetCursorPos(ctypes.byref(pt))
    return int(pt.x), int(pt.y)


def _foreground() -> tuple[str, str]:
    """(window title, process image name) of the foreground window."""
    u = _user32()
    hwnd = u.GetForegroundWindow()
    buf = ctypes.create_unicode_buffer(512)
    u.GetWindowTextW(hwnd, buf, 512)
    pid = ctypes.c_ulong()
    u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    exe = ""
    try:
        k = ctypes.windll.kernel32
        handle = k.OpenProcess(0x1000, False, pid.value)  # PROCESS_QUERY_LIMITED_INFORMATION
        if handle:
            size = ctypes.c_ulong(1024)
            path = ctypes.create_unicode_buffer(1024)
            if k.QueryFullProcessImageNameW(handle, 0, path, ctypes.byref(size)):
                exe = os.path.basename(path.value)
            k.CloseHandle(handle)
    except Exception:
        pass
    return buf.value, exe


def _button_state(vk: int) -> tuple[bool, bool]:
    """(held right now, pressed at least once since the previous call).

    The second flag is bit 0 of GetAsyncKeyState — without it a click whose
    down→up lasts less than one 30 ms poll (synthetic input, a fast tap) is
    never seen; with it a press between two polls still counts as one click."""
    state = _user32().GetAsyncKeyState(vk)
    return bool(state & 0x8000), bool(state & 0x0001)


def _grab(rec: _Recording, tag: str) -> Optional[str]:
    """Save a downscaled full-screen frame; returns the file name or None."""
    try:
        from PIL import ImageGrab
        img = ImageGrab.grab(all_screens=True)
        if img.width > _MAX_SHOT_WIDTH:
            ratio = _MAX_SHOT_WIDTH / img.width
            img = img.resize((_MAX_SHOT_WIDTH, int(img.height * ratio)))
        rec.shots += 1
        name = f"{rec.shots:03d}-{tag}.jpg"
        img.convert("RGB").save(rec.directory / name, "JPEG", quality=72)
        return name
    except Exception:
        logger.debug("skill recorder: screenshot failed", exc_info=True)
        return None


def _append(rec: _Recording, event: dict[str, Any]) -> None:
    if len(rec.events) >= _MAX_EVENTS:
        rec.truncated = True
        return
    event["t"] = round(time.time() - rec.started_at, 2)
    rec.events.append(event)
    with (rec.directory / "events.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(event, ensure_ascii=False) + "\n")


def _loop(rec: _Recording) -> None:
    try:
        _user32().SetProcessDPIAware()
    except Exception:
        pass
    last_title, last_exe = _foreground()
    _append(rec, {"type": "window", "title": last_title, "app": last_exe, "shot": _grab(rec, "start")})
    was_down = {_VK_LBUTTON: False, _VK_RBUTTON: False}
    last_shot = time.time()
    while not rec.stop_flag.is_set():
        for vk, button in ((_VK_LBUTTON, "left"), (_VK_RBUTTON, "right")):
            down, pressed_since = _button_state(vk)
            if (down or pressed_since) and not was_down[vk]:
                x, y = _cursor()
                title, exe = _foreground()
                # Frame taken just after the press so the clicked control is still visible.
                time.sleep(0.12)
                _append(rec, {"type": "click", "button": button, "x": x, "y": y,
                              "title": title, "app": exe, "shot": _grab(rec, "click")})
                last_shot = time.time()
            was_down[vk] = down
        title, exe = _foreground()
        if (title, exe) != (last_title, last_exe):
            last_title, last_exe = title, exe
            _append(rec, {"type": "window", "title": title, "app": exe, "shot": _grab(rec, "window")})
            last_shot = time.time()
        elif time.time() - last_shot > _IDLE_SHOT_S:
            _append(rec, {"type": "idle", "title": title, "app": exe, "shot": _grab(rec, "idle")})
            last_shot = time.time()
        time.sleep(_POLL_S)


# ── public API (used by the RPC layer) ───────────────────────────────────────

def start(name: str = "") -> dict[str, Any]:
    global _current
    if sys.platform != "win32":
        raise RuntimeError("Record a skill is Windows-only for now")
    with _lock:
        if _current is not None:
            raise RuntimeError("A skill recording is already running")
        rid = time.strftime("%Y%m%d-%H%M%S")
        directory = recordings_root() / rid
        directory.mkdir(parents=True, exist_ok=True)
        rec = _Recording(id=rid, directory=directory, started_at=time.time())
        (directory / "meta.json").write_text(
            json.dumps({"id": rid, "name": name, "started_at": rec.started_at}, ensure_ascii=False),
            encoding="utf-8")
        rec.thread = threading.Thread(target=_loop, args=(rec,), name="skill-recorder", daemon=True)
        rec.thread.start()
        _current = rec
        return status()


def status() -> dict[str, Any]:
    rec = _current
    if rec is None:
        return {"recording": False}
    return {"recording": True, "id": rec.id, "directory": str(rec.directory),
            "elapsed": round(time.time() - rec.started_at, 1),
            "clicks": sum(1 for e in rec.events if e.get("type") == "click"),
            "shots": rec.shots, "truncated": rec.truncated}


def stop(name: str = "", discard: bool = False) -> dict[str, Any]:
    global _current
    with _lock:
        rec = _current
        if rec is None:
            raise RuntimeError("No skill recording is running")
        rec.stop_flag.set()
        if rec.thread:
            rec.thread.join(timeout=3)
        _current = None
    if discard:
        shutil.rmtree(rec.directory, ignore_errors=True)
        return {"recording": False, "discarded": True}
    _write_readme(rec, name)
    clicks = sum(1 for e in rec.events if e.get("type") == "click")
    return {"recording": False, "id": rec.id, "directory": str(rec.directory), "name": name,
            "duration": round(time.time() - rec.started_at, 1),
            "clicks": clicks, "shots": rec.shots, "truncated": rec.truncated,
            "prompt": skill_prompt(name, rec.directory, clicks)}


def skill_prompt(name: str, directory: Path, clicks: int) -> str:
    """The turn the desktop drops into the composer after Stop. Lives here, not in
    the renderer, so tuning it never needs a 10-minute Electron rebuild.

    Vietnamese on purpose (the user's profile answers in Vietnamese). Tight on
    purpose: the first live run spent 77 API calls / 8M tokens because the agent
    was told "look at the screenshots" and cropped every frame repeatedly through
    vision_analyze (~50k chars per call). Now: README + events first, only the
    click frames, each at most once, no region crops, then write the skill."""
    title = (name or "").strip() or "skill-moi"
    d = str(directory)
    sep = os.sep
    return "\n".join([
        f"Tạo skill từ bản ghi thao tác của tôi tại thư mục: {d}",
        f"1. Đọc {d}{sep}README.md và {d}{sep}events.jsonl bằng read_file — đã có sẵn thời điểm, toạ độ click, "
        "tên cửa sổ, app và tên ảnh cho từng bước. Dùng dữ liệu này làm khung các bước.",
        f"2. Chỉ xem các ảnh *-click.jpg ({clicks} ảnh) bằng vision_analyze, MỖI ẢNH ĐÚNG 1 LẦN, "
        "toàn ảnh, KHÔNG crop vùng. Bỏ qua ảnh idle/window/start trừ khi 1 click chưa rõ. "
        "Tối đa 12 lượt gọi tool cho toàn bộ bước này.",
        f"3. Ngay sau đó dùng skill_manage tạo skill tên \"{title}\" gồm: mục đích, điều kiện bắt đầu, "
        "các bước (app, cửa sổ, thao tác, kết quả mong đợi), cách kiểm tra đã xong. "
        "Viết để sau này tự thực hiện lại bằng computer_use/browser, hoặc hướng dẫn tôi từng bước.",
        "4. Phím gõ KHÔNG được ghi lại — không suy đoán nội dung đã gõ; ghi chú \"(người dùng nhập …)\" "
        "ở bước đó và hỏi lại tôi nếu chưa rõ. Không lặp lại việc phân tích ảnh sau khi đã tạo skill.",
    ])


def _write_readme(rec: _Recording, name: str) -> None:
    clicks = sum(1 for e in rec.events if e.get("type") == "click")
    lines = [
        f"# Skill recording {rec.id}" + (f" — {name}" if name else ""),
        "",
        f"Duration: {round(time.time() - rec.started_at)}s · clicks: {clicks} · frames: {rec.shots}"
        + (" · TRUNCATED (event cap hit)" if rec.truncated else ""),
        "",
        "Keystrokes were not recorded. Each line: time, what happened, app/window, frame file.",
        "",
    ]
    for e in rec.events:
        where = f"{e.get('app') or '?'} — {e.get('title') or ''}".strip(" —")
        if e["type"] == "click":
            lines.append(
                f"- {e['t']:>7.2f}s  {e['button']} click at ({e['x']}, {e['y']})  in {where}  → {e.get('shot')}")
        else:
            lines.append(f"- {e['t']:>7.2f}s  {e['type']}  {where}  → {e.get('shot')}")
    (rec.directory / "README.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
