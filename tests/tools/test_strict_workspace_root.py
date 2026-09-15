"""A strict workspace root confines every file tool to one folder.

The guard lives in ``_resolve_path_for_task`` so absolute paths, ``..`` and a
``cd`` out of the folder all hit the same wall; the writers' ``_resolved or
path`` fallback must not be able to route around it.
"""

import json
import os

import pytest

import tools.terminal_tool as tt
from tools.file_tools import read_file_tool, write_file_tool
from tools.file_tools_paths import _resolve_path_for_task


@pytest.fixture
def strict_task(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "inside.txt").write_text("in", encoding="utf-8")
    outside = tmp_path / "elsewhere.txt"
    outside.write_text("out", encoding="utf-8")
    task_id = "strict-test"
    tt.register_task_env_overrides(task_id, {"cwd": str(root), "strict_root": str(root)})
    try:
        yield task_id, root, outside
    finally:
        tt.clear_task_env_overrides(task_id)


def test_inside_root_resolves(strict_task):
    task_id, root, _ = strict_task
    assert str(_resolve_path_for_task("inside.txt", task_id)) == str(root / "inside.txt")


def test_absolute_path_outside_root_is_denied(strict_task):
    task_id, _, outside = strict_task
    with pytest.raises(PermissionError, match="outside the workspace"):
        _resolve_path_for_task(str(outside), task_id)


def test_dotdot_escape_is_denied(strict_task):
    task_id, _, _ = strict_task
    with pytest.raises(PermissionError):
        _resolve_path_for_task(os.path.join("..", "elsewhere.txt"), task_id)


def test_write_outside_root_does_not_land_at_raw_path(strict_task):
    task_id, _, outside = strict_task
    result = json.loads(write_file_tool(str(outside), "clobbered", task_id=task_id))
    assert "outside the workspace" in result.get("error", "")
    assert outside.read_text(encoding="utf-8") == "out"


def test_read_outside_root_is_denied(strict_task):
    task_id, _, outside = strict_task
    result = json.loads(read_file_tool(str(outside), task_id=task_id))
    assert "outside the workspace" in result.get("error", "")


def test_env_var_root_applies_without_override(tmp_path, monkeypatch):
    root = tmp_path / "ws"
    root.mkdir()
    monkeypatch.setenv("HERMES_STRICT_ROOT", str(root))
    monkeypatch.setenv("TERMINAL_CWD", str(root))
    task_id = "strict-env-test"
    tt.clear_task_env_overrides(task_id)
    with pytest.raises(PermissionError):
        _resolve_path_for_task(str(tmp_path / "x.txt"), task_id)
    assert str(_resolve_path_for_task("a.txt", task_id)) == str(root / "a.txt")


def test_unrestricted_task_is_unchanged(tmp_path):
    task_id = "unrestricted-test"
    tt.register_task_env_overrides(task_id, {"cwd": str(tmp_path)})
    try:
        target = tmp_path.parent / "anywhere.txt"
        assert str(_resolve_path_for_task(str(target), task_id)) == str(target)
    finally:
        tt.clear_task_env_overrides(task_id)
