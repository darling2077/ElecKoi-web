export const HEADLESS_TREE_ROOT_ID = "__eleckoi_tree_root__";

function filterNodes(nodes, needle) {
  return nodes.flatMap((node) => {
    const children = filterNodes(node.children || [], needle);
    if (!node.searchText?.includes(needle) && !children.length) return [];
    return [{ ...node, children }];
  });
}

export function visibleTreeNodes(nodes, query) {
  const needle = query.trim().toLocaleLowerCase();
  return needle ? filterNodes(nodes, needle) : nodes;
}

export function createHeadlessTreeIndex(nodes) {
  const items = new Map();
  const children = new Map([[HEADLESS_TREE_ROOT_ID, nodes.map((node) => node.id)]]);

  function visit(node) {
    items.set(node.id, node);
    const childNodes = node.children || [];
    children.set(node.id, childNodes.map((child) => child.id));
    childNodes.forEach(visit);
  }

  nodes.forEach(visit);
  return { items, children };
}

export function expandedTreeIdsForSearch(nodes, query, expandedIds) {
  if (!query.trim()) return expandedIds;
  const result = [];
  const visit = (node) => {
    if (node.children?.length) result.push(node.id);
    node.children?.forEach(visit);
  };
  nodes.forEach(visit);
  return result;
}

/**
 * Headless Tree reports a post-removal insertion index. Convert it to the
 * index used by the domain model, which excludes fixed root entries.
 */
export function resolveHeadlessTreeDrop({ dragIds, parentId, insertionIndex, siblings, nestedParentId = "" }) {
  const dragged = new Set(dragIds);
  const remaining = siblings.filter((node) => !dragged.has(node.id));
  const slot = Math.max(0, Math.min(insertionIndex, remaining.length));
  const previous = remaining[slot - 1];
  if (
    nestedParentId
    && previous?.id === nestedParentId
    && !previous.fixed
    && ["group", "object"].includes(previous.nodeKind)
    && !(previous.children || []).length
  ) {
    return {
      dragId: dragIds[0] || "",
      parentId: previous.id,
      destinationIndex: 0,
      expandParentId: previous.id,
    };
  }
  return {
    dragId: dragIds[0] || "",
    parentId: parentId === HEADLESS_TREE_ROOT_ID ? "" : parentId,
    destinationIndex: remaining.slice(0, slot).filter((node) => !node.fixed).length,
    expandParentId: "",
  };
}

export function canDropAtHeadlessTarget({ query, draggedNodes, parentNode, insertionIndex, siblings }) {
  if (query.trim() || draggedNodes.length !== 1 || draggedNodes[0]?.fixed) return false;
  const isRoot = parentNode?.id === HEADLESS_TREE_ROOT_ID;
  if (!isRoot && parentNode?.nodeKind !== "group" && parentNode?.nodeKind !== "object") return false;
  if (!isRoot && parentNode?.fixed) return false;
  if (!isRoot || insertionIndex === null) return true;

  const dragged = new Set(draggedNodes.map((node) => node.id));
  const remaining = siblings.filter((node) => !dragged.has(node.id));
  const firstMovableIndex = remaining.findIndex((node) => !node.fixed);
  const fixedPrefixLength = firstMovableIndex < 0 ? remaining.length : firstMovableIndex;
  return fixedPrefixLength <= 0 || insertionIndex >= fixedPrefixLength;
}
