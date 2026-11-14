// The notice a Space shows when a save fails and the page shows nothing itself:
// a mutation with no `onError` would otherwise fail silently.

const NOTICE_ID = "hatch-space-failure-notice";
const VISIBLE_MS = 6_000;
const FALLBACK = "Something went wrong. Please try again.";

let hideTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * The page's own wording for the notice: the text to show, `null` to show nothing (the page
 * already shows this failure), or `undefined` to keep `message`, the error's own message, which
 * is English when the SDK wrote it.
 */
export type FailureNoticeText = (error: unknown, message: string) => string | null | undefined;

let pageText: FailureNoticeText | undefined;

/** Lets a page word the automatic save-failure notice in its own language. */
export function setFailureNoticeText(text: FailureNoticeText | undefined): void {
  pageText = text;
}

function noticeText(error: unknown): string {
  if (error !== null && typeof error === "object" && (error as { name?: unknown }).name === "SpaceActionError") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return FALLBACK;
}

/** Shows `error`'s readable message at the bottom of the page for a few seconds. */
export function showFailureNotice(error: unknown): void {
  if (typeof document === "undefined" || document.body === null) return;
  const message = noticeText(error);
  let text: string | null | undefined;
  try {
    text = pageText?.(error, message);
  } catch {
    text = undefined;
  }
  if (text === null || text === "") return;
  let notice = document.getElementById(NOTICE_ID);
  if (notice === null) {
    notice = document.createElement("div");
    notice.id = NOTICE_ID;
    notice.setAttribute("role", "alert");
    Object.assign(notice.style, {
      position: "fixed",
      left: "16px",
      right: "16px",
      bottom: "calc(16px + var(--bottom-padding, 0px) + env(safe-area-inset-bottom, 0px))",
      width: "fit-content",
      maxWidth: "480px",
      marginInline: "auto",
      // Never blocks the controls under it, such as a bottom tab bar.
      pointerEvents: "none",
      padding: "12px 16px",
      borderRadius: "12px",
      background: "var(--text, #1c1c1e)",
      color: "var(--bg, #ffffff)",
      font: "500 15px/1.4 system-ui, -apple-system, sans-serif",
      whiteSpace: "pre-line",
      boxShadow: "0 6px 24px rgba(0, 0, 0, 0.2)",
      zIndex: "2147483647",
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(notice);
  }
  notice.textContent = text ?? message;
  notice.hidden = false;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (notice !== null) notice.hidden = true;
  }, VISIBLE_MS);
}
