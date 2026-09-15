/**
 * Cowork workspace bar — picks the folder one chat's tools are scoped to.
 *
 * Selecting a workspace sends `?workspace=<id>` on the PTY socket; the server
 * turns that into TERMINAL_CWD for the spawned agent, so its terminal starts
 * there and its file tools resolve relative paths against it. A strict
 * workspace also exports HERMES_STRICT_ROOT, confining the file tools to it.
 *
 * Changing the selection (or strict) restarts the chat: both are read once
 * when the PTY spawns, so a live session cannot be re-rooted. ChatPage folds
 * the id into its channel key to force that restart, and the confirm below
 * makes the cost explicit instead of silently dropping the conversation.
 */
import { Button } from "@nous-research/ui/ui/components/button";
import { ChevronUp, FolderOpen, Lock, Plus, RefreshCw, Trash2, Unlock } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  api,
  type Workspace,
  type WorkspaceBrowse,
  type WorkspaceDeliverable,
} from "@/lib/api";
import { cn } from "@/lib/utils";

interface WorkspaceBarProps {
  /** Currently selected workspace id, or "" for none (agent's default folder). */
  value: string;
  /** Called with the new id; ChatPage persists it and restarts the PTY. */
  onChange: (workspaceId: string) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatWhen(epochSeconds: number): string {
  const deltaMs = Date.now() - epochSeconds * 1000;
  const minutes = Math.floor(deltaMs / 60000);
  if (minutes < 1) return "vừa xong";
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} giờ trước`;
  return `${Math.floor(hours / 24)} ngày trước`;
}

const inputClass = cn(
  "rounded border border-current/15 bg-transparent px-2 py-1 outline-none",
  "focus:border-current/40 disabled:opacity-50",
);

export function WorkspaceBar({ value, onChange }: WorkspaceBarProps) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");
  const [newStrict, setNewStrict] = useState(false);
  const [browse, setBrowse] = useState<WorkspaceBrowse | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const [sessionOnly, setSessionOnly] = useState(true);
  const [files, setFiles] = useState<WorkspaceDeliverable[] | null>(null);
  const [filesTruncated, setFilesTruncated] = useState(false);
  const [busy, setBusy] = useState(false);

  // The PTY (re)spawns whenever the selection changes, so "this session" starts
  // at the moment the selection was last applied.
  const sessionStartRef = useRef(Math.floor(Date.now() / 1000));
  useEffect(() => {
    sessionStartRef.current = Math.floor(Date.now() / 1000);
  }, [value]);

  const selected = workspaces.find((w) => w.id === value) ?? null;

  const refresh = useCallback(async () => {
    try {
      const res = await api.listWorkspaces();
      setWorkspaces(res.workspaces);
      setError(null);
    } catch (err) {
      setError(`Không tải được danh sách: ${err}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadFiles = useCallback(async () => {
    if (!value) return;
    setBusy(true);
    try {
      const since = sessionOnly ? sessionStartRef.current : 0;
      const res = await api.getWorkspaceDeliverables(value, 50, since);
      setFiles(res.files);
      setFilesTruncated(res.truncated);
      setError(null);
    } catch (err) {
      setError(`Không đọc được thư mục: ${err}`);
    } finally {
      setBusy(false);
    }
  }, [value, sessionOnly]);

  // Reload the file list when the panel opens, the workspace changes, or the
  // scope flips; drop a stale list immediately so the previous workspace's
  // files are never shown under the new one's name.
  useEffect(() => {
    setFiles(null);
    if (showFiles && value) void loadFiles();
  }, [showFiles, value, loadFiles]);

  const handleSelect = (nextId: string) => {
    if (nextId === value) return;
    // A live PTY cannot be re-rooted, so this drops the running conversation.
    if (
      value &&
      !window.confirm(
        "Đổi workspace sẽ bắt đầu phiên chat mới (phiên hiện tại kết thúc). Tiếp tục?",
      )
    ) {
      return;
    }
    onChange(nextId);
  };

  const openBrowse = async (path = "") => {
    setBusy(true);
    try {
      setBrowse(await api.browseWorkspaceFolders(path));
      setError(null);
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = async () => {
    if (!newPath.trim()) {
      setError("Chọn hoặc nhập đường dẫn thư mục");
      return;
    }
    setBusy(true);
    try {
      const created = await api.createWorkspace({
        name: newName.trim(),
        path: newPath.trim(),
        strict: newStrict,
      });
      setNewName("");
      setNewPath("");
      setNewStrict(false);
      setBrowse(null);
      setAdding(false);
      setError(null);
      await refresh();
      onChange(created.id);
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  const handleToggleStrict = async () => {
    if (!selected) return;
    const next = !selected.strict;
    if (
      !window.confirm(
        next
          ? "Bật giới hạn: agent chỉ đọc/ghi file trong thư mục này. Phiên chat hiện tại sẽ khởi động lại. Tiếp tục?"
          : "Tắt giới hạn: agent được đọc/ghi file ngoài thư mục. Phiên chat hiện tại sẽ khởi động lại. Tiếp tục?",
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.updateWorkspace(selected.id, { strict: next });
      await refresh();
      setError(null);
      // Same id, new env: force the PTY restart by bouncing the selection.
      onChange("");
      window.setTimeout(() => onChange(selected.id), 0);
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    if (
      !window.confirm(
        `Xoá workspace "${selected.name}"?\n\nChỉ xoá lối tắt trong Hermes — thư mục và file trên ổ đĩa giữ nguyên.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.deleteWorkspace(selected.id);
      onChange("");
      await refresh();
      setError(null);
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-current/10 bg-background/40 px-2 py-1.5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <FolderOpen className="h-4 w-4 shrink-0 text-text-secondary" />
        <span className="shrink-0 text-text-secondary">Workspace:</span>

        <select
          value={value}
          onChange={(e) => handleSelect(e.target.value)}
          disabled={busy}
          aria-label="Chọn workspace"
          className={cn(inputClass, "min-w-[12rem] max-w-full flex-1")}
        >
          <option value="">(thư mục mặc định)</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.strict ? "🔒 " : ""}
              {w.name}
              {w.exists ? "" : "  ⚠ không tìm thấy thư mục"}
            </option>
          ))}
        </select>

        <Button
          ghost
          size="icon"
          onClick={() => {
            setAdding((v) => !v);
            setBrowse(null);
          }}
          disabled={busy}
          aria-label="Thêm workspace"
          title="Thêm workspace"
        >
          <Plus className="h-4 w-4" />
        </Button>

        {selected && (
          <>
            <Button
              ghost
              size="sm"
              onClick={handleToggleStrict}
              disabled={busy}
              title={
                selected.strict
                  ? "Đang giới hạn: file tools chỉ làm việc trong thư mục này (terminal không bị giới hạn). Bấm để tắt."
                  : "Không giới hạn: agent có thể đọc/ghi ngoài thư mục. Bấm để bật giới hạn."
              }
            >
              {selected.strict ? (
                <Lock className="mr-1 h-3.5 w-3.5" />
              ) : (
                <Unlock className="mr-1 h-3.5 w-3.5" />
              )}
              {selected.strict ? "Giới hạn" : "Tự do"}
            </Button>
            <Button
              ghost
              size="sm"
              onClick={() => setShowFiles((v) => !v)}
              disabled={busy}
              title="File agent tạo hoặc sửa"
            >
              {showFiles ? "Ẩn kết quả" : "Kết quả"}
            </Button>
            <Button
              ghost
              size="icon"
              onClick={handleDelete}
              disabled={busy}
              aria-label="Xoá workspace"
              title="Xoá workspace (không xoá thư mục thật)"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </>
        )}
      </div>

      {selected && (
        <div className="mt-1 truncate pl-6 text-xs text-text-secondary" title={selected.path}>
          {selected.path}
          {!selected.exists && (
            <span className="ml-2 text-warning">— thư mục không còn tồn tại</span>
          )}
        </div>
      )}

      {adding && (
        <div className="mt-2 border-t border-current/10 pt-2">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              placeholder="Đường dẫn thư mục, ví dụ E:\\Du-an\\Bao-cao"
              aria-label="Đường dẫn thư mục"
              className={cn(inputClass, "min-w-[16rem] flex-1")}
            />
            <Button
              ghost
              size="sm"
              onClick={() => void openBrowse(browse ? browse.path : newPath.trim())}
              disabled={busy}
            >
              Duyệt…
            </Button>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Tên (bỏ trống = tên thư mục)"
              aria-label="Tên workspace"
              className={cn(inputClass, "min-w-[10rem]")}
            />
            <label className="flex items-center gap-1 text-xs text-text-secondary">
              <input
                type="checkbox"
                checked={newStrict}
                onChange={(e) => setNewStrict(e.target.checked)}
              />
              Giới hạn trong thư mục
            </label>
            <Button size="sm" onClick={handleCreate} disabled={busy}>
              Thêm
            </Button>
            <Button
              ghost
              size="sm"
              onClick={() => {
                setAdding(false);
                setBrowse(null);
              }}
              disabled={busy}
            >
              Huỷ
            </Button>
          </div>

          {browse && (
            <div className="mt-2 rounded border border-current/10">
              <div className="flex items-center gap-2 border-b border-current/10 px-2 py-1 text-xs">
                <Button
                  ghost
                  size="icon"
                  onClick={() => void openBrowse(browse.parent ?? "")}
                  disabled={busy || browse.parent === null}
                  aria-label="Lên thư mục cha"
                  title="Lên thư mục cha"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </Button>
                <span className="flex-1 truncate" title={browse.path}>
                  {browse.path || "Ổ đĩa"}
                </span>
                {browse.path && (
                  <Button
                    size="sm"
                    onClick={() => {
                      setNewPath(browse.path);
                      setBrowse(null);
                    }}
                    disabled={busy}
                  >
                    Chọn thư mục này
                  </Button>
                )}
              </div>
              <div className="max-h-48 overflow-y-auto">
                {browse.dirs.length === 0 ? (
                  <div className="px-2 py-2 text-xs text-text-secondary">Không có thư mục con</div>
                ) : (
                  browse.dirs.map((d) => (
                    <button
                      key={d.path}
                      type="button"
                      onClick={() => void openBrowse(d.path)}
                      disabled={busy}
                      className="block w-full truncate px-2 py-1 text-left text-xs hover:bg-current/5"
                      title={d.path}
                    >
                      📁 {d.name}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {showFiles && selected && (
        <div className="mt-2 border-t border-current/10 pt-2">
          <div className="mb-1 flex items-center gap-2 text-xs text-text-secondary">
            <span>{sessionOnly ? "Tạo/sửa trong phiên này" : "Sửa gần nhất (toàn thư mục)"}</span>
            <Button ghost size="sm" onClick={() => setSessionOnly((v) => !v)} disabled={busy}>
              {sessionOnly ? "Xem tất cả" : "Chỉ phiên này"}
            </Button>
            <Button
              ghost
              size="icon"
              onClick={() => void loadFiles()}
              disabled={busy}
              aria-label="Tải lại danh sách file"
              title="Tải lại"
            >
              <RefreshCw className={cn("h-3 w-3", busy && "animate-spin")} />
            </Button>
            {filesTruncated && (
              <span className="text-warning">thư mục quá lớn — danh sách chưa đầy đủ</span>
            )}
          </div>
          <div className="max-h-48 overflow-y-auto">
            {files === null ? (
              <div className="py-2 text-xs text-text-secondary">Đang đọc…</div>
            ) : files.length === 0 ? (
              <div className="py-2 text-xs text-text-secondary">
                {sessionOnly ? "Phiên này chưa tạo hay sửa file nào" : "Thư mục trống"}
              </div>
            ) : (
              <table className="w-full text-xs">
                <tbody>
                  {files.map((f) => (
                    <tr key={f.rel_path} className="border-b border-current/5 last:border-0">
                      <td className="truncate py-0.5 pr-2" title={f.rel_path}>
                        {f.rel_path}
                      </td>
                      <td className="whitespace-nowrap py-0.5 pr-2 text-right text-text-secondary">
                        {formatSize(f.size)}
                      </td>
                      <td className="whitespace-nowrap py-0.5 text-right text-text-secondary">
                        {formatWhen(f.modified_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {error && <div className="mt-1 pl-6 text-xs text-danger">{error}</div>}
    </div>
  );
}
