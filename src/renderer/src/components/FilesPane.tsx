import clsx from "clsx";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowUp, Eye, File, Folder, Pencil, RotateCw } from "lucide-react";
import type { FileEntry } from "@shared/types";
import { useStore } from "../state/store";
import { usePreviewOpener } from "./BlockCard";
import { opensInViewer } from "./DocumentCard";
import { Button, Empty } from "./ui";

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The tree beside the editor.
 *
 * The name gets the room. It did not: the date was a fixed eighty pixels and
 * the size another, on a pane that is 220 wide by default, which left about
 * twenty-eight pixels for the one thing anybody is looking for. A tree whose
 * entries read as a run of identical clipped stems is a tree you have to hover
 * to use. So the metadata became two narrow columns, tabular so they line up,
 * and the date — the least urgent of the three — stands down below about
 * 240px of pane.
 *
 * What is open is marked, because the tree and the editor are one element: it
 * was previously impossible to tell from the tree which of the files beside it
 * the editor was showing.
 */
export function FilesPane(): ReactNode {
  const session = useStore((s) =>
    s.sessions.find((x) => x.id === s.activeSessionId),
  );
  const [path, setPath] = useState(session?.cwd ?? "");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const openInBrowser = usePreviewOpener();
  const openInEditor = useStore((s) => s.openInEditor);
  const editing = useStore((s) => s.editorFile);

  // By id, not by the session object: a running turn replaces that every few seconds and each
  // new one reloaded the pane, throwing away the folder being browsed.
  const sessionId = session?.id;
  const environmentId = session?.environmentId;
  const load = useCallback(
    async (target: string) => {
      if (!sessionId || !environmentId) return;
      setLoading(true);
      setError(null);
      try {
        const result = await window.opendesktop.files.list(
          environmentId,
          target,
          sessionId,
        );
        setPath(result.path);
        setEntries(result.entries);
        /*
         * A folder that is not there is an answer now, not a throw: opening
         * this pane on a conversation whose folder had not been made yet put
         * `ENOENT: scandir` in front of the user. The message is theirs to
         * read, not an exception's.
         */
        setError(result.error ?? null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [sessionId, environmentId],
  );

  useEffect(() => {
    if (session) void load(session.cwd);
  }, [session?.id, session?.cwd, session?.environmentId, load]);

  if (!session) return <Empty>No session selected.</Empty>;

  const parent =
    path.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <div
        data-files-head
        className="border-ink-800 bg-ink-900 flex h-8 shrink-0 items-center gap-1 border-b px-2"
      >
        <Button
          size="sm"
          onClick={() => void load(parent)}
          title="Parent directory"
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" onClick={() => void load(path)} title="Reload">
          <RotateCw
            className={clsx("h-3.5 w-3.5", loading && "animate-spin")}
          />
        </Button>
        <input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void load(path);
          }}
          title={path}
          className="border-ink-800 bg-ink-850 text-ink-300 focus:border-ink-700 focus:text-ink-200 min-w-0 flex-1 rounded border px-2 py-[3px] font-mono text-[10.5px] outline-none"
        />
        <span className="text-ink-600 shrink-0 text-[10px]">
          {session.environmentId}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {error ? (
          <div className="text-bad px-3 py-3 font-mono text-[11px]">
            {error}
          </div>
        ) : entries.length === 0 ? (
          <Empty>Empty directory.</Empty>
        ) : (
          entries.map((entry) => {
            const isOpen =
              !entry.directory &&
              editing?.path === entry.path &&
              editing?.environmentId === session.environmentId;
            return (
              <div
                key={entry.path}
                className="group hover:bg-ink-850 relative flex items-center gap-2 rounded-[3px] px-2 py-[5px]"
                onDoubleClick={() => {
                  if (entry.directory) void load(entry.path);
                  else void openInBrowser(session.environmentId, entry.path);
                }}
              >
                {entry.directory ? (
                  <Folder className="text-info/80 h-3.5 w-3.5 shrink-0" />
                ) : (
                  <File
                    className={clsx(
                      "h-3.5 w-3.5 shrink-0",
                      isOpen ? "text-brand" : "text-ink-500",
                    )}
                  />
                )}
                <button
                  type="button"
                  title={entry.path}
                  onClick={() =>
                    entry.directory
                      ? void load(entry.path)
                      : opensInViewer(entry.path)
                        ? void openInBrowser(session.environmentId, entry.path)
                        : openInEditor({
                            environmentId: session.environmentId,
                            path: entry.path,
                            sessionId: session.id,
                          })
                  }
                  className={clsx(
                    "min-w-0 flex-1 truncate text-left font-mono text-[11.5px]",
                    isOpen ? "text-ink-100" : "text-ink-300 hover:text-ink-100",
                  )}
                >
                  {entry.name}
                  {entry.directory ? "/" : ""}
                </button>
                {/*
                 * Only on the row under the cursor, and laid over the
                 * metadata rather than beside it: it is the thing nobody
                 * needs until they are already pointing at the file, and it
                 * was costing the name a column it could not spare.
                 */}
                {entry.directory ? null : (
                  <button
                    type="button"
                    title={
                      opensInViewer(entry.path)
                        ? `Edit ${entry.name}`
                        : `View ${entry.name}`
                    }
                    onClick={() =>
                      opensInViewer(entry.path)
                        ? openInEditor({
                            environmentId: session.environmentId,
                            path: entry.path,
                            sessionId: session.id,
                          })
                        : void openInBrowser(session.environmentId, entry.path)
                    }
                    className="text-ink-500 hover:text-ink-100 bg-ink-850 absolute right-1.5 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    {opensInViewer(entry.path) ? (
                      <Pencil className="h-3 w-3" />
                    ) : (
                      <Eye className="h-3 w-3" />
                    )}
                  </button>
                )}
                <span className="text-ink-600 w-11 shrink-0 text-right text-[10px] tabular-nums">
                  {entry.directory ? "" : size(entry.size)}
                </span>
                <span className="text-ink-700 hidden w-[34px] shrink-0 text-right text-[10px] tabular-nums @[240px]:inline">
                  {entry.modifiedAt
                    ? new Date(entry.modifiedAt).toLocaleDateString("en-GB", {
                        day: "numeric",
                        month: "short",
                      })
                    : ""}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
