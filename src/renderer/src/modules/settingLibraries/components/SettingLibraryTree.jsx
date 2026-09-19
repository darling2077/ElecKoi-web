import { createContext, useContext } from "react";
import { ChatCircleDots, Code, LinkSimple } from "@phosphor-icons/react";
import { DshFolderClosedIcon, DshFolderOpenIcon, DshTriangleRightIcon } from "../../../ui/icons/dshTreeIcons.jsx";
import { HeadlessTree } from "../../../ui/tree/HeadlessTree.jsx";
import { SettingEntryGlyph } from "./SettingLibraryEntryEditor.jsx";

export const SettingTreeActionsContext = createContext(null);

function entryIcon(data) {
  if (data.entryKind === "opening") return ChatCircleDots;
  if (data.dynamicMode === "ejs_controller") return Code;
  if (data.dynamicMode === "ejs_reference") return LinkSimple;
  return null;
}

export function SettingTreeNode({ item, data, itemProps, style, level, isSelected, isExpanded, isDropTarget, isDragging }) {
  const actions = useContext(SettingTreeActionsContext);
  const Icon = entryIcon(data);

  return (
    <div
      {...itemProps}
      className={`setting-library-tree-row${data.nodeKind === "entry" ? " has-toggle" : ""}${data.enabled === false ? " is-disabled" : ""}${level > 0 ? " is-nested" : ""}${isSelected ? " is-selected" : ""}${isDropTarget ? " is-drop-target" : ""}${isDragging ? " is-dragging" : ""}`}
      style={style}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (!item.isFolder()) return;
        if (item.isExpanded()) item.collapse();
        else item.expand();
      }}
      onContextMenu={(event) => actions.openContextMenu(event, data)}
    >
      <div className="setting-library-tree-row-content">
        <span className="setting-library-tree-chevron">
          {data.nodeKind === "group" ? (
            <button
              type="button"
              className="setting-library-tree-expander"
              aria-label={isExpanded ? "折叠文件夹" : "展开文件夹"}
              aria-expanded={isExpanded}
              onClick={(event) => {
                event.stopPropagation();
                if (item.isExpanded()) item.collapse();
                else item.expand();
              }}
            >
              <DshTriangleRightIcon className={isExpanded ? "is-expanded" : ""} />
            </button>
          ) : null}
        </span>
        {data.nodeKind === "group" ? (
          <span className="setting-library-tree-folder" aria-hidden="true">
            {isExpanded ? <DshFolderOpenIcon /> : <DshFolderClosedIcon />}
          </span>
        ) : <span className={`setting-library-tree-entry-icon${data.dynamicMode === "ejs_controller" ? " is-controller" : ""}${data.dynamicMode === "ejs_reference" ? " is-reference" : ""}`} aria-hidden="true">
          {Icon ? <Icon weight="regular" /> : <SettingEntryGlyph iconId={data.iconId} weight="regular" />}
        </span>}
        <span className="setting-library-tree-label">{data.label}</span>
        {data.nodeKind === "group" ? <span className="setting-library-tree-count">{data.childCount}</span> : (
          <button
            type="button"
            className="setting-library-tree-switch"
            role="switch"
            aria-checked={data.enabled}
            aria-label={`${data.enabled ? "停用" : "启用"}${data.label}`}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              actions.updateEntryById(data.recordId, { enabled: !data.enabled });
            }}
          ><span aria-hidden="true" /></button>
        )}
      </div>
    </div>
  );
}

export function SettingLibraryTree({ nodes, query, selectedId, expandedIds, onSelectedIdChange, onExpandedIdsChange, onMove, ariaLabel }) {
  return <HeadlessTree
    nodes={nodes}
    query={query}
    selectedId={selectedId}
    expandedIds={expandedIds}
    ariaLabel={ariaLabel}
    dragLineClassName="setting-library-tree-drop-cursor"
    onSelectedIdChange={onSelectedIdChange}
    onExpandedIdsChange={onExpandedIdsChange}
    onMove={onMove}
    renderItem={(props) => <SettingTreeNode key={props.key} {...props} />}
  />;
}
