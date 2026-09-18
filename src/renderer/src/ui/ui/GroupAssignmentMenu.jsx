import { useEffect, useRef } from "react";
import { CheckIcon } from "../icons/index.jsx";
import { DshFolderClosedIcon } from "../icons/dshTreeIcons.jsx";
import { MinusIcon } from "../icons/openSourceIcons.jsx";

export function GroupAssignmentMenu({ x, y, label, currentGroupId = "", groups, onMove }) {
  const menuRef = useRef(null);
  const estimatedHeight = Math.min(420, 20 + (groups.length + 1) * 34);
  const left = Math.max(8, Math.min(x, window.innerWidth - 220));
  const top = Math.max(8, Math.min(y, window.innerHeight - estimatedHeight - 8));

  useEffect(() => {
    menuRef.current?.querySelector("button:not(:disabled)")?.focus();
  }, []);

  function moveFocus(event) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = [...(menuRef.current?.querySelectorAll("button:not(:disabled)") || [])];
    if (!buttons.length) return;
    event.preventDefault();
    const currentIndex = buttons.indexOf(document.activeElement);
    if (event.key === "Home") buttons[0].focus();
    else if (event.key === "End") buttons.at(-1).focus();
    else {
      const step = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = (Math.max(0, currentIndex) + step + buttons.length) % buttons.length;
      buttons[nextIndex].focus();
    }
  }

  return (
    <div
      ref={menuRef}
      className="group-assignment-menu"
      role="menu"
      aria-label={label}
      style={{ left: `${left}px`, top: `${top}px` }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={moveFocus}
    >
      <button type="button" role="menuitem" disabled={!currentGroupId} onClick={() => void onMove("")}>
        {currentGroupId ? <MinusIcon /> : <CheckIcon />}
        <span>{currentGroupId ? "移出分组" : "未分组"}</span>
      </button>
      {groups.length ? <div className="group-assignment-menu-targets" role="group" aria-label="目标分组">
        {groups.map((group) => {
          const current = group.id === currentGroupId;
          return (
            <button key={group.id} type="button" role="menuitem" disabled={current} aria-current={current ? "true" : undefined} onClick={() => void onMove(group.id)}>
              {current ? <CheckIcon /> : <DshFolderClosedIcon />}
              <span>{group.name}</span>
            </button>
          );
        })}
      </div> : null}
    </div>
  );
}
