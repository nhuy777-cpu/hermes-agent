"""The skill recorder writes a frame + event on start, refuses double starts, and
cleans up on discard. Real screen capture (win32 only), no synthetic input."""

import json
import sys
import time

import pytest

from tui_gateway import skill_recorder as sr

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="win32 ctypes recorder")


@pytest.fixture
def isolated_root(tmp_path, monkeypatch):
    monkeypatch.setattr(sr, "recordings_root", lambda: tmp_path / "skill-recordings")
    yield tmp_path / "skill-recordings"
    if sr._current is not None:
        sr.stop(discard=True)


def test_start_status_stop_writes_frame_and_readme(isolated_root):
    started = sr.start(name="demo")
    assert started["recording"] is True
    time.sleep(1.0)
    status = sr.status()
    assert status["recording"] and status["elapsed"] >= 0.9
    result = sr.stop(name="demo")
    assert result["recording"] is False and result["name"] == "demo"
    folder = isolated_root / result["id"]
    events = [json.loads(line) for line in (folder / "events.jsonl").read_text(encoding="utf-8").splitlines()]
    assert events and events[0]["type"] == "window" and events[0]["shot"]
    assert (folder / events[0]["shot"]).stat().st_size > 1000
    readme = (folder / "README.md").read_text(encoding="utf-8")
    assert "demo" in readme and "Keystrokes were not recorded" in readme
    assert json.loads((folder / "meta.json").read_text(encoding="utf-8"))["name"] == "demo"


def test_double_start_refused_and_discard_removes_folder(isolated_root):
    first = sr.start()
    with pytest.raises(RuntimeError, match="already running"):
        sr.start()
    result = sr.stop(discard=True)
    assert result == {"recording": False, "discarded": True}
    assert not (isolated_root / first["id"]).exists()
    assert sr.status() == {"recording": False}
    with pytest.raises(RuntimeError, match="No skill recording"):
        sr.stop()


def test_press_between_polls_counts_as_a_click(isolated_root, monkeypatch):
    # Simulate GetAsyncKeyState reporting "pressed since last call" (bit 0)
    # exactly once with the button already released — a sub-poll tap.
    calls = {"n": 0}

    class FakeUser32:
        def GetAsyncKeyState(self, vk):
            if vk == sr._VK_LBUTTON:
                calls["n"] += 1
                return 0x0001 if calls["n"] == 3 else 0
            return 0

        def GetCursorPos(self, pt):
            return True

        def GetForegroundWindow(self):
            return 0

        def GetWindowTextW(self, hwnd, buf, n):
            return 0

        def GetWindowThreadProcessId(self, hwnd, pid):
            return 0

        def SetProcessDPIAware(self):
            return True

    monkeypatch.setattr(sr, "_user32", lambda: FakeUser32())
    monkeypatch.setattr(sr, "_grab", lambda rec, tag: None)
    sr.start()
    time.sleep(0.5)
    result = sr.stop()
    assert result["clicks"] == 1
