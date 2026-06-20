import { useEffect, useMemo, useRef, useState } from "react";
import Dropdown from "antd/es/dropdown";
import type { MenuProps } from "antd";
import {
  createTranslator,
  formatMessageCount,
  formatRelativeTime,
  type Locale,
  type Translator
} from "./i18n";
import type { PiSessionProject } from "./types";

const DEFAULT_VISIBLE_SESSION_COUNT = 10;

interface PiSessionSectionProps {
  isStreaming: boolean;
  locale: Locale;
  projects: PiSessionProject[];
  loading: boolean;
  error: string | null;
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onRename: (sessionId: string) => void;
  archivedSessionIds: Set<string>;
  onArchive: (sessionId: string) => void;
  onRestore: (sessionId: string) => void;
  onCreateSessionInProject: (projectPath: string) => void;
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
const EXPANDED_STORAGE_KEY = "my-pi-pi-project-expanded";

function readStoredProjectOrder(): string[] {
  try {
    const raw = localStorage.getItem(ORDER_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as string[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStoredProjectOrder(order: string[]) {
  try {
    localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(order));
  } catch {
    // Ignore storage errors and keep in-memory order.
  }
}

function readStoredExpandedProjects(): string[] {
  try {
    const raw = localStorage.getItem(EXPANDED_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as string[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStoredExpandedProjects(paths: string[]) {
  try {
    localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(paths));
  } catch {
    // Ignore storage errors and keep in-memory expansion state.
  }
}

export function sortProjectsByOrder(
  projects: PiSessionProject[],
  order: string[]
): PiSessionProject[] {
  if (order.length === 0) return projects;

  const projectMap = new Map(projects.map((project) => [project.path, project]));
  const sorted: PiSessionProject[] = [];

  for (const path of order) {
    const project = projectMap.get(path);
    if (project) {
      sorted.push(project);
      projectMap.delete(path);
    }
  }

  return [...sorted, ...Array.from(projectMap.values())];
}

export function ensureExpandedProjectPaths(
  projects: PiSessionProject[],
  storedExpandedPaths: string[],
  selectedSessionId: string | null
): string[] {
  const availablePaths = new Set(projects.map((project) => project.path));
  const nextExpanded = storedExpandedPaths.filter((path) => availablePaths.has(path));

  if (selectedSessionId) {
    const selectedProject = projects.find((project) =>
      project.sessions.some((session) => session.id === selectedSessionId)
    );
    if (selectedProject && !nextExpanded.includes(selectedProject.path)) {
      nextExpanded.push(selectedProject.path);
    }
  }

  if (nextExpanded.length > 0) {
    return nextExpanded;
  }

  return projects.length > 0 ? [projects[0].path] : [];
}

export function getVisibleProjectSessions<T>(
  sessions: T[],
  showAll: boolean,
  limit = DEFAULT_VISIBLE_SESSION_COUNT
) {
  if (showAll || sessions.length <= limit) {
    return {
      sessions,
      hiddenCount: 0
    };
  }

  return {
    sessions: sessions.slice(0, limit),
    hiddenCount: sessions.length - limit
  };
}

export function PiSessionSection({
  isStreaming,
  locale,
  projects,
  loading,
  error,
  selectedSessionId,
  onSelectSession,
  onRename,
  archivedSessionIds,
  onArchive,
  onRestore,
  onCreateSessionInProject
}: PiSessionSectionProps) {
  const t = createTranslator(locale);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    () => new Set(readStoredExpandedProjects())
  );
  const [projectOrder, setProjectOrder] = useState<string[]>(() => readStoredProjectOrder());
  const [dragOverProjectPath, setDragOverProjectPath] = useState<string | null>(null);
  const [expandedSessionProjects, setExpandedSessionProjects] = useState<Set<string>>(new Set());
  const dragProjectPathRef = useRef<string | null>(null);
  const previousSelectedSessionIdRef = useRef<string | null>(null);
  const previousProjectPathsRef = useRef<string>("");

  const orderedProjects = useMemo(
    () => sortProjectsByOrder(projects, projectOrder),
    [projectOrder, projects]
  );

  function stopPropagation(event: React.MouseEvent) {
    event.stopPropagation();
  }

  useEffect(() => {
    const currentProjectPaths = orderedProjects.map((project) => project.path).join("|");
    const selectionChanged = previousSelectedSessionIdRef.current !== selectedSessionId;
    const projectsChanged = previousProjectPathsRef.current !== currentProjectPaths;

    previousSelectedSessionIdRef.current = selectedSessionId;
    previousProjectPathsRef.current = currentProjectPaths;

    if (!selectionChanged && !projectsChanged) {
      return;
    }

    const nextExpanded = ensureExpandedProjectPaths(
      orderedProjects,
      Array.from(expandedProjects),
      selectedSessionId
    );
    const currentExpanded = Array.from(expandedProjects);

    if (
      nextExpanded.length !== currentExpanded.length ||
      nextExpanded.some((path) => !expandedProjects.has(path))
    ) {
      setExpandedProjects(new Set(nextExpanded));
      writeStoredExpandedProjects(nextExpanded);
    }
  }, [expandedProjects, orderedProjects, selectedSessionId]);

  useEffect(() => {
    // Skip sync when projects haven't loaded yet, to avoid overwriting the stored order with an empty list.
    if (projects.length === 0) return;

    const availablePaths = new Set(projects.map((project) => project.path));
    const nextOrder = projectOrder.filter((path) => availablePaths.has(path));
    const missingPaths = projects
      .map((project) => project.path)
      .filter((path) => !nextOrder.includes(path));

    if (missingPaths.length > 0 || nextOrder.length !== projectOrder.length) {
      const mergedOrder = [...nextOrder, ...missingPaths];
      setProjectOrder(mergedOrder);
      writeStoredProjectOrder(mergedOrder);
    }
  }, [projectOrder, projects]);

  function toggleProject(path: string) {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      writeStoredExpandedProjects(Array.from(next));
      return next;
    });
  }

  function toggleProjectSessions(path: string) {
    setExpandedSessionProjects((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

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

    setProjectOrder((prev) => {
      const next = sortProjectsByOrder(projects, prev).map((project) => project.path);
      const sourceIndex = next.indexOf(sourcePath);
      const targetIndex = next.indexOf(targetPath);

      if (sourceIndex === -1 || targetIndex === -1) {
        return prev;
      }

      const reordered = [...next];
      const [moved] = reordered.splice(sourceIndex, 1);
      reordered.splice(targetIndex, 0, moved);
      writeStoredProjectOrder(reordered);
      return reordered;
    });
  }

  function handleProjectDragEnd() {
    dragProjectPathRef.current = null;
    setDragOverProjectPath(null);
  }

  if (loading) {
    return (
      <div className="pi-sessions-section">
        <div className="session-section-heading">
          <span>{t("sidebar.piSessions")}</span>
        </div>
        <div className="pi-sessions-empty">{t("sidebar.loadingPiSessionTitle")}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="pi-sessions-section">
        <div className="session-section-heading">
          <span>{t("sidebar.piSessions")}</span>
        </div>
        <div className="pi-sessions-error">{error}</div>
      </div>
    );
  }

  const totalSessions = projects.reduce((sum, project) => sum + project.sessions.length, 0);

  return (
    <div className="pi-sessions-section">
      <div className="session-section-heading">
        <span>{t("sidebar.piSessions")}</span>
        <small>{totalSessions}</small>
      </div>

      {projects.length === 0 ? (
        <div className="pi-sessions-empty">{t("workspace.noneFound")}</div>
      ) : (
        <div className="pi-sessions-list">
          {orderedProjects.map((project) => {
            const isExpanded = expandedProjects.has(project.path);
            const isDragOver = dragOverProjectPath === project.path;
            const showAllSessions = expandedSessionProjects.has(project.path);
            const visibleSessions = getVisibleProjectSessions(
              project.sessions,
              showAllSessions
            );

            return (
              <div
                className={"pi-project-group" + (isDragOver ? " pi-project-group-drag-over" : "")}
                key={project.path}
                draggable={!isStreaming}
                onDragStart={() => handleProjectDragStart(project.path)}
                onDragOver={(event) => handleProjectDragOver(event, project.path)}
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
                    <span className={"pi-project-chevron" + (isExpanded ? " pi-project-chevron-expanded" : "")}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </span>
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
                      onCreateSessionInProject(project.path);
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </button>
                </div>

                {isExpanded ? (
                  <div className="pi-session-list">
                    {visibleSessions.sessions.map((session) => {
                      const isArchived = archivedSessionIds.has(session.id);

                      return (
                        <button
                          className={
                            "pi-session-row" +
                            (selectedSessionId === session.id ? " pi-session-row-active" : "") +
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
                                <circle cx="12" cy="5" r="2" />
                                <circle cx="12" cy="12" r="2" />
                                <circle cx="12" cy="19" r="2" />
                              </svg>
                            </Dropdown>
                          </span>
                        </button>
                      );
                    })}
                    {visibleSessions.hiddenCount > 0 ? (
                      <button
                        className="pi-session-show-more"
                        disabled={isStreaming}
                        type="button"
                        onClick={() => toggleProjectSessions(project.path)}
                      >
                        {showAllSessions
                          ? t("sidebar.showLess")
                          : t("sidebar.showMore", { count: visibleSessions.hiddenCount })}
                      </button>
                    ) : null}
                    {showAllSessions && project.sessions.length > DEFAULT_VISIBLE_SESSION_COUNT ? (
                      <button
                        className="pi-session-show-more"
                        disabled={isStreaming}
                        type="button"
                        onClick={() => toggleProjectSessions(project.path)}
                      >
                        {t("sidebar.showLess")}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
