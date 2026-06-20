import { useCallback, useEffect, useRef, useState } from "react";

/** CSS selector for user-message bubbles — only these become dots */
const USER_BUBBLE_SELECTOR = ".ant-bubble-list-scroll-content > .chat-bubble-user";

interface MinimapProps {
  /** Total number of user messages */
  userCount: number;
  /** Preview text for each user message (same order, truncated) */
  userPreviews: string[];
  /** Ref to the scrollable container */
  scrollContainer: HTMLElement | null;
  /** Called when user clicks a position; index is 0-based among user bubbles */
  onNavigate: (userIndex: number) => void;
}

/**
 * Vertical minimap with dots representing each **user** message.
 * Hover a dot to preview its content. Click to scroll to that message.
 * Uses flexbox for dot positioning so padding is respected natively.
 */
export default function Minimap({ userCount, userPreviews, scrollContainer, onNavigate }: MinimapProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  /* ── scroll syncing ── */
  useEffect(() => {
    if (!scrollContainer || userCount === 0) return;

    const el = scrollContainer;

    function findNearestIndex() {
      const containerRect = el.getBoundingClientRect();
      const userBubbles = el.querySelectorAll<HTMLElement>(USER_BUBBLE_SELECTOR);

      let bestIdx = 0;
      let bestDist = Infinity;

      userBubbles.forEach((bubble, i) => {
        const rect = bubble.getBoundingClientRect();
        const dist = Math.abs(rect.top - containerRect.top);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      });

      setActiveIndex(bestIdx);
    }

    function update() {
      const { scrollTop, scrollHeight, clientHeight } = el;
      const maxScroll = scrollHeight - clientHeight;

      setAtBottom(maxScroll <= 0 || scrollTop >= maxScroll - 2);
      findNearestIndex();
    }

    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);

    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [scrollContainer, userCount]);

  /* ── click handler — maps click Y to user index ── */
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!scrollContainer || userCount === 0) return;

      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return;

      // Offset by padding so click at very top/bottom maps to first/last user
      const pad = 10;
      const innerTop = rect.top + pad;
      const innerHeight = rect.height - pad * 2;

      if (innerHeight <= 0) return;

      const y = e.clientY - innerTop;
      const fraction = Math.max(0, Math.min(1, y / innerHeight));
      const userIndex = Math.min(userCount - 1, Math.floor(fraction * userCount));

      onNavigate(userIndex);
    },
    [scrollContainer, userCount, onNavigate]
  );

  /* ── mouse move handler for hover preview ── */
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (userCount === 0) return;
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return;

      const pad = 10;
      const innerTop = rect.top + pad;
      const innerHeight = rect.height - pad * 2;

      if (innerHeight <= 0) {
        setHoverIndex(null);
        return;
      }

      const y = e.clientY - innerTop;
      const fraction = Math.max(0, Math.min(1, y / innerHeight));
      const idx = Math.min(userCount - 1, Math.floor(fraction * userCount));

      setHoverIndex((prev) => (prev !== idx ? idx : prev));
    },
    [userCount]
  );

  const handleMouseLeave = useCallback(() => {
    setHoverIndex(null);
  }, []);

  if (userCount === 0) return null;

  const dots: React.ReactNode[] = [];
  for (let i = 0; i < userCount; i++) {
    const isActive = i === activeIndex;
    const isPast = i < activeIndex;
    const isHovered = i === hoverIndex;

    dots.push(
      <div
        key={i}
        className={`minimap-dot${isActive ? " minimap-dot-active" : ""}${isPast ? " minimap-dot-past" : ""}${isHovered ? " minimap-dot-hovered" : ""}`}
      >
        {isHovered && userPreviews[i] && (
          <div className="minimap-preview">
            <span className="minimap-preview-text">{userPreviews[i]}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="minimap-track"
      ref={trackRef}
      onClick={handleClick}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      role="slider"
      aria-label="Conversation minimap"
      aria-valuemin={0}
      aria-valuemax={userCount - 1}
      aria-valuenow={activeIndex}
    >
      <div className="minimap-body">
        <div className="minimap-line" />
        {dots}
        {atBottom && userCount > 0 && <div className="minimap-indicator" />}
      </div>
    </div>
  );
}
