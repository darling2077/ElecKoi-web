import { createContext, useContext } from "react";
import { BracketsCurly, HashStraight, ListBullets, ListDashes, TextT, ToggleRight, TreeStructure } from "@phosphor-icons/react";
import { DshTriangleRightIcon } from "../../../ui/icons/dshTreeIcons.jsx";
import { HeadlessTree } from "../../../ui/tree/HeadlessTree.jsx";
import { VARIABLE_INITIALIZATION_OBJECT_ID } from "../../../../../shared/contracts/variables/schemas.ts";

export const VariableTreeActionsContext = createContext(null);

const VARIABLE_TYPE_ICONS = Object.freeze({
  number: HashStraight,
  string: TextT,
  boolean: ToggleRight,
  object: BracketsCurly,
  array: ListBullets,
});

export function VariableGroupIcon({ initialization = false, size = 17, className = "" }) {
  const Icon = initialization ? ListDashes : TreeStructure;
  return <Icon size={size} className={className} aria-hidden="true" />;
}

export function VariableEntryIcon({ type = "", size = 17, className = "" }) {
  const Icon = VARIABLE_TYPE_ICONS[type] || BracketsCurly;
  return <Icon size={size} className={className} aria-hidden="true" />;
}

export function VariableTreeNode({ item, data, itemProps, style, level, isSelected, isExpanded, isDropTarget, isDragging }) {
  const actions = useContext(VariableTreeActionsContext);

  return (
    <div
      {...itemProps}
      className={`variable-tree-row${data.enabled === false ? " is-disabled" : ""}${level > 0 ? " is-nested" : ""}${isSelected ? " is-selected" : ""}${isDropTarget ? " is-drop-target" : ""}${isDragging ? " is-dragging" : ""}`}
      style={style}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (!item.isFolder()) return;
        if (item.isExpanded()) item.collapse();
        else item.expand();
      }}
      onContextMenu={(event) => actions.openContextMenu(event, data)}
    >
      <span className="variable-tree-chevron">
        {data.nodeKind === "object" && !data.fixed ? (
          <button type="button" className="variable-tree-expander" aria-label={isExpanded ? "折叠变量组" : "展开变量组"} aria-expanded={isExpanded} onClick={(event) => { event.stopPropagation(); if (item.isExpanded()) item.collapse(); else item.expand(); }}>
            <DshTriangleRightIcon className={isExpanded ? "is-expanded" : ""} />
          </button>
        ) : null}
      </span>
      {data.nodeKind === "object"
        ? <VariableGroupIcon initialization={data.fixed} className="variable-tree-icon" />
        : <VariableEntryIcon type={data.valueType} className="variable-tree-icon" />}
      <span className="variable-tree-label">{data.dynamicKey ? `<${data.label}>` : data.label}</span>
      {data.readMode === "required" ? <span className="variable-tree-required" title="必读">必读</span> : null}
      {!data.fixed ? (
        <button type="button" className="variable-tree-switch" role="switch" aria-checked={data.enabled} aria-label={`${data.ownEnabled ? "停用" : "启用"}${data.label}`} disabled={!data.ancestorEnabled} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); actions.toggleNode(data); }}><span aria-hidden="true" /></button>
      ) : null}
    </div>
  );
}

export function VariableConfigTree({ nodes, query, selectedId, expandedIds, onSelectedIdChange, onExpandedIdsChange, onMove }) {
  return <HeadlessTree
    nodes={nodes}
    query={query}
    selectedId={selectedId}
    expandedIds={expandedIds}
    ariaLabel="变量配置树"
    dragLineClassName="variable-tree-drop-cursor"
    onSelectedIdChange={onSelectedIdChange}
    onExpandedIdsChange={onExpandedIdsChange}
    onMove={onMove}
    renderItem={(props) => <VariableTreeNode key={props.key} {...props} />}
  />;
}

export { VARIABLE_INITIALIZATION_OBJECT_ID };
