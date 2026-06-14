import { useEffect, useRef, useState } from "react";
import type { PiSessionProject } from "./types";

function relativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

interface PiSessionSectionProps {
  isStreaming: boolean;
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
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
  selectedSessionId,
  onSelectSession
}: PiSessionSectionProps) {
  const [projects, setProjects] = useState<PiSessionProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [dragOverProjectPath, setDragOverProjectPath] = useState<string | null>(null);
  const dragProjectPathRef = useRef<string | null>(null);

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

        // Apply persisted project order
        const order = readStoredProjectOrder();
        const orderedProjects = sortProjectsByOrder(body.projects, order);
        setProjects(orderedProjects);
        // All projects collapsed by default
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load Pi sessions");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchPiSessions();
    return () => {
      cancelled = true;
    };
  }, []);

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
      // Keep collapsed by default
      // Select the newly created session (first session of the target project)
      const targetProject = orderedProjects.find((p) => p.path === projectPath);
      if (targetProject && targetProject.sessions.length > 0) {
        onSelectSession(targetProject.sessions[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create session");
    }
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

      // Persist
      writeStoredProjectOrder(reordered.map((p) => p.path));

      return reordered;
    });
  }

  function handleProjectDragEnd() {
    dragProjectPathRef.current = null;
    setDragOverProjectPath(null);
  }

  if (loading) {
    return null;
  }

  if (error) {
    return (
      <div className="pi-sessions-section">
        <div className="session-section-heading">
          <span>Pi Sessions</span>
        </div>
        <div className="pi-sessions-error">Pi CLI not available</div>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="pi-sessions-section">
        <div className="session-section-heading">
          <span>Pi Sessions</span>
        </div>
        <div className="pi-sessions-empty">No Pi sessions found</div>
      </div>
    );
  }

  const totalSessions = projects.reduce((sum, p) => sum + p.sessions.length, 0);

  return (
    <div className="pi-sessions-section">
      <div className="session-section-heading">
        <span>Pi Sessions</span>
        <small>{totalSessions}</small>
      </div>

      <div className="pi-sessions-list">
        {projects.map((project) => {
          const isExpanded = expandedProjects.has(project.path);
          const isDragOver = dragOverProjectPath === project.path;

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
                  title="New Pi session in this project"
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
                  {project.sessions.map((session) => (
                    <button
                      className={
                        "pi-session-row" +
                        (selectedSessionId === session.id
                          ? " pi-session-row-active"
                          : "")
                      }
                      key={session.id}
                      disabled={isStreaming}
                      type="button"
                      onClick={() => onSelectSession(session.id)}
                    >
                      <div className="pi-session-info">
                        <span className="pi-session-first-msg">
                          {session.firstMessage}
                        </span>
                        <small className="pi-session-meta">
                          {session.messageCount} messages · {relativeTime(session.modified)}
                        </small>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
