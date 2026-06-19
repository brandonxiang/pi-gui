import { useEffect, useMemo, useRef, useState } from "react";
import Dropdown from "antd/es/dropdown";
import Modal from "antd/es/modal";
import type { MenuProps } from "antd";
import {
  createTranslator,
  formatMessageCount,
  formatRelativeTime,
  type Locale,
  type Translator
} from "./i18n";
import type { PiSessionProject } from "./types";

interface PiSessionSectionProps {
  isStreaming: boolean;
  locale: Locale;
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onRename: (sessionId: string) => void;
  archivedSessionIds: Set<string>;
  onArchive: (sessionId: string) => void;
  onRestore: (sessionId: string) => void;
  refreshKey?: number;
}

function buildMenuItems(
  sessionKey: string,
  isArchived: boolean,
  onRename: (id: string) => void,
  onArchive: (id: string) => void,
  onRestore: (id: string) => void,
  t: Translator
): MenuProps["items"] {
  if (isArchived) {
    return [{ key: "restore", label: t("actions.restore"), onClick: () => onRestore(sessionKey) }];
  }

  return [
    { key: "rename", label: t("actions.rename"), onClick: () => onRename(sessionKey) },
    { key: "archive", label: t("actions.archive"), onClick: () => onArchive(sessionKey) }
  ];
}

const ORDER_STORAGE_KEY = "my-pi-pi-project-order";

function readStoredProjectOrder(): string[] {
  try {
    const raw = localStorage.getItem(ORDER_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeStoredProjectOrder(order: string[]) {
  localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(order));
}

function sortProjectsByOrder(
  projects: PiSessionProject[],
  order: string[]
): PiSessionProject[] {
  if (order.length === 0) return projects;

  const projectMap = new Map(projects.map((p) => [p.path, p]));
  const sorted: PiSessionProject[] = [];
  const unsorted: PiSessionProject[] = [];

  for (const path of order) {
    const p = projectMap.get(path);
    if (p) sorted.push(p);
  }
  for (const p of projects) {
    if (!sorted.find((s) => s.path === p.path)) unsorted.push(p);
  }

  return [...sorted, ...unsorted];
}

export function PiSessionSection({
  isStreaming,
  locale,
  selectedSessionId,
  onSelectSession,
  onRename,
  archivedSessionIds,
  onArchive,
  onRestore,
  refreshKey = 0
}: PiSessionSectionProps) {
  const [projects, setProjects] = useState<PiSessionProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [dragOverProjectPath, setDragOverProjectPath] = useState<string | null>(null);
  const dragProjectPathRef = useRef<string | null>(null);

  /* ───── Add workspace modal ───── */
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [workspaceBrowseName, setWorkspaceBrowseName] = useState<string | null>(null);
  const [workspaceResolvedPath, setWorkspaceResolvedPath] = useState<string | null>(null);
  const [workspaceResolving, setWorkspaceResolving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const t = useMemo(() => createTranslator(locale), [locale]);

  useEffect(() => {
    let cancelled = false;

    async function fetchPiSessions() {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch("/api/pi-sessions");
        if (!response.ok) {
          throw new Error(`Failed to load Pi sessions: ${response.status}`);
        }
        const body = (await response.json()) as { projects: PiSessionProject[] };
        if (cancelled) return;

        const order = readStoredProjectOrder();
        const orderedProjects = sortProjectsByOrder(body.projects, order);
        setProjects(orderedProjects);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t("sidebar.piCliUnavailable"));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchPiSessions();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  function toggleProject(path: string) {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  async function handleNewSession(projectPath: string) {
    if (isStreaming) return;
    try {
      const response = await fetch("/api/pi-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectPath })
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(err?.error || `Request failed with ${response.status}`);
      }
      const body = (await response.json()) as { projects: PiSessionProject[] };
      const order = readStoredProjectOrder();
      const orderedProjects = sortProjectsByOrder(body.projects, order);
      setProjects(orderedProjects);
      const targetProject = orderedProjects.find((p) => p.path === projectPath);
      if (targetProject && targetProject.sessions.length > 0) {
        onSelectSession(targetProject.sessions[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("workspace.newPiSession"));
    }
  }

  function stopPropagation(e: React.MouseEvent) {
    e.stopPropagation();
  }

  /* ───── Project-level drag & drop ───── */

  function handleProjectDragStart(projectPath: string) {
    dragProjectPathRef.current = projectPath;
  }

  function handleProjectDragOver(event: React.DragEvent, projectPath: string) {
    event.preventDefault();
    if (dragProjectPathRef.current && dragProjectPathRef.current !== projectPath) {
      setDragOverProjectPath(projectPath);
    }
  }

  function handleProjectDragLeave() {
    setDragOverProjectPath(null);
  }

  function handleProjectDrop(targetPath: string) {
    const sourcePath = dragProjectPathRef.current;
    dragProjectPathRef.current = null;
    setDragOverProjectPath(null);

    if (!sourcePath || sourcePath === targetPath) return;

    setProjects((prev) => {
      const paths = prev.map((p) => p.path);
      const sourceIdx = paths.indexOf(sourcePath);
      const targetIdx = paths.indexOf(targetPath);
      if (sourceIdx === -1 || targetIdx === -1) return prev;

      const reordered = [...prev];
      const [moved] = reordered.splice(sourceIdx, 1);
      reordered.splice(targetIdx, 0, moved);

      writeStoredProjectOrder(reordered.map((p) => p.path));

      return reordered;
    });
  }

  function handleProjectDragEnd() {
    dragProjectPathRef.current = null;
    setDragOverProjectPath(null);
  }

  /* ───── Add workspace handlers ───── */

  function openWorkspaceModal() {
    setWorkspaceBrowseName(null);
    setWorkspaceResolvedPath(null);
    setWorkspaceResolving(false);
    setError(null);
    setWorkspaceModalOpen(true);
  }

  function closeWorkspaceModal() {
    setWorkspaceModalOpen(false);
    setWorkspaceBrowseName(null);
    setWorkspaceResolvedPath(null);
    setWorkspaceResolving(false);
  }

  function handleBrowseClick() {
    fileInputRef.current?.click();
  }

  async function handleBrowseChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const path = files[0].webkitRelativePath;
    const folderName = path.split("/")[0];
    setWorkspaceBrowseName(folderName);
    setWorkspaceResolvedPath(null);
    setError(null);
    // Reset so the same folder can be re-selected
    event.target.value = "";

    // Resolve the folder name to a full path on the server
    setWorkspaceResolving(true);
    try {
      const response = await fetch("/api/resolve-workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: folderName })
      });
      const body = (await response.json()) as {
        found: boolean;
        path?: string;
        error?: string;
      };

      if (body.found && body.path) {
        setWorkspaceResolvedPath(body.path);
        // Auto-create workspace immediately
        await createWorkspace(body.path);
      } else {
        setError(body.error || `Could not find directory "${folderName}"`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("workspace.resolving"));
    } finally {
      setWorkspaceResolving(false);
    }
  }

  async function createWorkspace(cwd: string) {
    try {
      const response = await fetch("/api/pi-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd })
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(err?.error || `Request failed with ${response.status}`);
      }
      const body = (await response.json()) as { projects: PiSessionProject[] };
      const order = readStoredProjectOrder();
      const orderedProjects = sortProjectsByOrder(body.projects, order);
      setProjects(orderedProjects);

      // Auto-expand the new project and select the new session
      setExpandedProjects((prev) => new Set(prev).add(cwd));

      const targetProject = orderedProjects.find((p) => p.path === cwd);
      if (targetProject && targetProject.sessions.length > 0) {
        onSelectSession(targetProject.sessions[0].id);
      }

      closeWorkspaceModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("workspace.title"));
    }
  }

  if (loading) {
    return null;
  }

  if (error) {
    return (
      <div className="pi-sessions-section">
        <div className="session-section-heading">
          <span>{t("sidebar.piSessions")}</span>
        </div>
        <div className="pi-sessions-error">{t("sidebar.piCliUnavailable")}</div>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="pi-sessions-section">
        <div className="session-section-heading">
          <span>{t("sidebar.piSessions")}</span>
        </div>
        <div className="pi-sessions-empty">{t("workspace.noneFound")}</div>
      </div>
    );
  }

  const totalSessions = projects.reduce((sum, p) => sum + p.sessions.length, 0);

  return (
    <>
      <div className="pi-sessions-section">
        <div className="session-section-heading">
          <span>{t("sidebar.piSessions")}</span>
          <div className="sidebar-actions">
            <button
              className="icon-button"
              disabled={isStreaming}
              type="button"
              title={t("sidebar.addWorkspace")}
              onClick={openWorkspaceModal}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              </svg>
            </button>
          </div>
          <small>{totalSessions}</small>
        </div>

        <div className="pi-sessions-list">
          {projects.map((project) => {
            const isExpanded = expandedProjects.has(project.path);
            const isDragOver = dragOverProjectPath === project.path;
            const visibleSessions = project.sessions.filter(
              (session) => !archivedSessionIds.has(session.id)
            );

            return (
              <div
                className={
                  "pi-project-group" +
                  (isDragOver ? " pi-project-group-drag-over" : "")
                }
                key={project.path}
                draggable={!isStreaming}
                onDragStart={() => handleProjectDragStart(project.path)}
                onDragOver={(e) => handleProjectDragOver(e, project.path)}
                onDragLeave={handleProjectDragLeave}
                onDrop={() => handleProjectDrop(project.path)}
                onDragEnd={handleProjectDragEnd}
              >
                <div className="pi-project-header-row">
                  <button
                    className="pi-project-header"
                    disabled={isStreaming}
                    type="button"
                    onClick={() => toggleProject(project.path)}
                  >
                    <span className="pi-project-name">{project.name}</span>
                    <small className="pi-project-count">{project.sessions.length}</small>
                  </button>
                  <button
                    className="pi-new-session-btn"
                    disabled={isStreaming}
                    type="button"
                    title={t("workspace.newPiSession")}
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleNewSession(project.path);
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19"/>
                      <line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                  </button>
                </div>

                {isExpanded && (
                  <div className="pi-session-list">
                    {visibleSessions.map((session) => {
                      const isArchived = archivedSessionIds.has(session.id);

                      return (
                        <button
                          className={
                            "pi-session-row" +
                            (selectedSessionId === session.id
                              ? " pi-session-row-active"
                              : "") +
                            (isArchived ? " pi-session-row-archived" : "")
                          }
                          key={session.id}
                          disabled={isStreaming}
                          type="button"
                          onClick={() => onSelectSession(session.id)}
                        >
                          <div className="pi-session-info">
                            <span className="pi-session-first-msg">
                              {session.name || session.firstMessage}
                            </span>
                            <small className="pi-session-meta">
                              {formatMessageCount(locale, session.messageCount)} · {formatRelativeTime(locale, session.modified)}
                            </small>
                          </div>
                          <span className="pi-session-menu-trigger" onClick={stopPropagation}>
                            <Dropdown
                              menu={{
                                items: buildMenuItems(
                                  session.id,
                                  isArchived,
                                  onRename,
                                  onArchive,
                                  onRestore,
                                  t
                                )
                              }}
                              placement="bottomRight"
                              trigger={["click"]}
                            >
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                                <circle cx="12" cy="5" r="2"/>
                                <circle cx="12" cy="12" r="2"/>
                                <circle cx="12" cy="19" r="2"/>
                              </svg>
                            </Dropdown>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        className="workspace-file-input"
        {...({ webkitdirectory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
        onChange={handleBrowseChange}
      />

      <Modal
        centered
        open={workspaceModalOpen}
        title={t("workspace.title")}
        footer={
          <div className="workspace-modal-footer">
            <button className="settings-btn settings-btn-cancel" type="button" onClick={closeWorkspaceModal}>
              {t("settings.cancel")}
            </button>
          </div>
        }
        onCancel={closeWorkspaceModal}
      >
        <div className="workspace-modal-body">
          <p className="workspace-description">{t("workspace.description")}</p>

          <div className="workspace-browse-row">
            <button
              className="workspace-browse-btn"
              type="button"
              onClick={handleBrowseClick}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              </svg>
              {t("workspace.browse")}
            </button>
            {workspaceResolving && (
              <span className="workspace-resolving-label">{t("workspace.resolving")}</span>
            )}
            {workspaceResolvedPath && !workspaceResolving && (
              <span className="workspace-resolved-label">
                ✓ <strong>{workspaceBrowseName}</strong>
                <small>{workspaceResolvedPath}</small>
              </span>
            )}
          </div>

          {error && <div className="workspace-error">{error}</div>}
        </div>
        </Modal>
    </>
  );
}
