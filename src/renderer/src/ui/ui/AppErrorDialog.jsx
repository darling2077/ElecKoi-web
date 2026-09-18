import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CopyIcon, XIcon } from "../icons/index.jsx";

export function AppErrorDialog({ notice, onDismiss }) {
  const titleId = useId();
  const detailId = useId();
  const statusId = useId();
  const dialogRef = useRef(null);
  const copyRef = useRef(null);
  const onDismissRef = useRef(onDismiss);
  const [copyState, setCopyState] = useState("idle");

  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!notice?.message || typeof document === "undefined") return undefined;
    const previousFocus = document.activeElement;
    const focusFrame = window.requestAnimationFrame(() => copyRef.current?.focus());

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        onDismissRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = Array.from(dialogRef.current?.querySelectorAll("button:not(:disabled)") || []);
      if (!controls.length) {
        event.preventDefault();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", handleKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [notice?.id]);

  useEffect(() => {
    setCopyState("idle");
  }, [notice?.id]);

  if (!notice?.message) return null;

  async function copyError() {
    try {
      await writeClipboard(notice.message);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  const copyLabel = copyState === "copied" ? "已复制" : copyState === "failed" ? "重试复制" : "复制错误";
  const statusText = copyState === "copied"
    ? "错误内容已复制"
    : copyState === "failed"
      ? "复制失败，请手动选择错误内容"
      : "";

  const dialog = (
    <div className="app-error-overlay" role="presentation" onMouseDown={() => onDismiss?.()}>
      <section
        ref={dialogRef}
        className="app-error-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${detailId}${statusText ? ` ${statusId}` : ""}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="app-error-header">
          <h2 id={titleId}>运行错误</h2>
          <button type="button" className="app-error-close" aria-label="关闭错误详情" onClick={onDismiss}>
            <XIcon size={18} />
          </button>
        </header>
        <pre id={detailId} className="app-error-detail" tabIndex={0}>{notice.message}</pre>
        <div className="app-error-footer">
          <span id={statusId} className={`app-error-copy-status${copyState === "failed" ? " is-failed" : ""}`} role="status" aria-live="polite">
            {statusText}
          </span>
          <div className="app-error-actions">
            <button type="button" onClick={onDismiss}>关闭</button>
            <button ref={copyRef} type="button" className="is-primary" onClick={copyError}>
              <CopyIcon size={15} />
              <span>{copyLabel}</span>
            </button>
          </div>
        </div>
      </section>
    </div>
  );

  const portalTarget = typeof document === "undefined" ? null : document.body;
  return portalTarget ? createPortal(dialog, portalTarget) : dialog;
}

async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard write failed");
}
