export interface PiSessionDetail {
  id: string;
  name: string;
  cwd: string;
  projectName: string;
  created: string;
  modified: string;
}

export interface PiSessionDetailResponse {
  session: PiSessionDetail;
  messages: unknown[];
}

export type ActivePanelView =
  | { kind: "local" }
  | { kind: "pi"; sessionId: string };

/**
 * After renaming a session, derive the updated piSessionDetail.
 *
 * Returns the updated detail when the renamed session is the active Pi session,
 * or null otherwise (caller should keep the existing detail unchanged).
 */
export function applySessionRename(
  piSessionDetail: PiSessionDetailResponse | null,
  activePanelView: ActivePanelView,
  renameTargetId: string,
  newName: string
): PiSessionDetailResponse | null {
  if (!piSessionDetail) return null;
  if (activePanelView.kind !== "pi") return null;

  // Only update when the renamed session is the one currently displayed.
  if (piSessionDetail.session.id !== renameTargetId) {
    return piSessionDetail;
  }

  return {
    ...piSessionDetail,
    session: {
      ...piSessionDetail.session,
      name: newName
    }
  };
}
