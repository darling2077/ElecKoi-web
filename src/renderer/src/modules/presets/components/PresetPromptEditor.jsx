import { useEffect, useMemo, useRef, useState } from 'react';
import { Code, Copy, FileText, LinkSimple, MagnifyingGlass, PencilSimple, Plus } from '@phosphor-icons/react';
import { isHiddenToolTimelineEntry } from '@shared/contracts/presets/builtIns';
import { TrashIcon } from '../../../ui/icons/index.jsx';
import { DshFolderClosedIcon } from '../../../ui/icons/dshTreeIcons.jsx';
import { SETTING_LIBRARY_CREATE_ICONS } from '../../../ui/icons/settingLibraryCreateIcons.jsx';
import {
  ConfirmationDialog,
  PINNED_ENTRY_IDS,
  SettingLibraryInspector,
  SettingLibraryTree,
  SettingTreeActionsContext,
  createEntryDraft,
  createGroupDraft,
  hasSearchResults,
  moveTreeNode,
  nodeKey,
  parseNodeKey,
  treeNodes,
} from '../../settingLibraries/index.js';
import { PresetContextMenu, usePresetContextMenu } from './PresetContextMenu.jsx';

const HIDDEN_TIMELINE_DISABLE_CONFIRMATION = {
  title: '关闭隐藏工具时间线？',
  message: '关闭后 AI 回复将无法流式显示，请着重考虑。',
};

const CreateFolderIcon = SETTING_LIBRARY_CREATE_ICONS.group;
const CreateEntryIcon = SETTING_LIBRARY_CREATE_ICONS.entry;
const CreateReferenceIcon = SETTING_LIBRARY_CREATE_ICONS.reference;

export function shouldConfirmHiddenTimelineDisable(entry, nextEnabled) {
  return nextEnabled === false && isHiddenToolTimelineEntry(entry);
}

export function PresetPromptEditor({ preset, onChange, saveAction }) {
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [selected, setSelected] = useState(null);
  const [pendingHiddenTimelineDisableId, setPendingHiddenTimelineDisableId] = useState('');
  const nameInputRef = useRef(null);
  const context = usePresetContextMenu();
  const library = useMemo(() => ({
    characterId: `agent-preset:${preset.id}`,
    name: preset.name,
    entries: preset.entries,
    groups: preset.groups,
    promptPositions: preset.promptPositions,
    activeVersionId: preset.activeVersionId,
    versions: [],
    listAllExpanded: false,
    expandedGroupIds: preset.expandedGroupIds,
  }), [preset]);
  const nodes = useMemo(() => treeNodes(library), [library]);
  const searchHasResults = useMemo(() => hasSearchResults(library, query), [library, query]);
  const selectedValue = selected?.kind === 'group'
    ? preset.groups.find((group) => group.id === selected.id)
    : selected?.kind === 'entry'
      ? preset.entries.find((entry) => entry.id === selected.id)
      : null;

  useEffect(() => {
    setSelected(null);
    setQuery('');
    context.close();
  }, [preset.id]);

  function createNode(kind, target = selected) {
    const parentId = target?.kind === 'group'
      ? target.id
      : target?.kind === 'entry'
        ? preset.entries.find((entry) => entry.id === target.id)?.groupId || ''
        : '';
    const order = 1 + Math.max(0,
      ...preset.groups.filter((group) => group.parentId === parentId).map((group) => group.treeViewOrder),
      ...preset.entries.filter((entry) => entry.groupId === parentId).map((entry) => entry.treeViewOrder),
    );
    if (kind === 'group') {
      const group = createGroupDraft(parentId, order, new Set(preset.groups.filter((item) => item.parentId === parentId).map((item) => item.name)));
      onChange({ ...preset, groups: [...preset.groups, group], expandedGroupIds: [...new Set([...preset.expandedGroupIds, parentId].filter(Boolean))] });
      setSelected({ kind: 'group', id: group.id });
    } else {
      const entry = { ...createEntryDraft(parentId, order, preset.entries, kind === 'reference' ? 'reference' : 'prompt'), title: kind === 'reference' ? '新建 EJS引用设定' : '新建提示词' };
      onChange({ ...preset, entries: [...preset.entries, entry], expandedGroupIds: [...new Set([...preset.expandedGroupIds, parentId].filter(Boolean))] });
      setSelected({ kind: 'entry', id: entry.id });
    }
    setAddOpen(false);
    setQuery('');
    requestAnimationFrame(() => nameInputRef.current?.select());
  }

  function duplicateEntry(source) {
    const order = Math.max(0, ...preset.groups.filter((group) => group.parentId === source.groupId).map((group) => group.treeViewOrder), ...preset.entries.filter((entry) => entry.groupId === source.groupId).map((entry) => entry.treeViewOrder)) + 1;
    const fresh = createEntryDraft(source.groupId, order, preset.entries);
    const entry = { ...structuredClone(source), id: fresh.id, title: `${source.title || '未命名提示词'} 副本`, treeViewOrder: order, viewOrder: fresh.viewOrder, groupViewOrder: fresh.groupViewOrder, createdAt: fresh.createdAt, updatedAt: fresh.updatedAt };
    onChange({ ...preset, entries: [...preset.entries, entry] });
    setSelected({ kind: 'entry', id: entry.id });
  }

  function renameNode(target) {
    setSelected({ kind: target.kind, id: target.value.id });
    requestAnimationFrame(() => nameInputRef.current?.select());
  }

  function updateEntry(entry) {
    onChange({ ...preset, entries: preset.entries.map((item) => item.id === entry.id ? entry : item) });
  }

  function requestEntryEnabledChange(entry) {
    const nextEnabled = entry.enabled === false;
    if (shouldConfirmHiddenTimelineDisable(entry, nextEnabled)) {
      setPendingHiddenTimelineDisableId(entry.id);
      return;
    }
    updateEntry({ ...entry, enabled: nextEnabled });
  }

  function confirmHiddenTimelineDisable() {
    const entry = preset.entries.find((item) => item.id === pendingHiddenTimelineDisableId);
    if (entry && isHiddenToolTimelineEntry(entry)) updateEntry({ ...entry, enabled: false });
    setPendingHiddenTimelineDisableId('');
  }

  function updateTreeEntry(entryId, patch) {
    const entry = preset.entries.find((item) => item.id === entryId);
    if (!entry) return;
    if (Object.hasOwn(patch, 'enabled') && patch.enabled !== entry.enabled) {
      requestEntryEnabledChange(entry);
      return;
    }
    updateEntry({ ...entry, ...patch });
  }

  function handleExpandedIdsChange(expandedKeys) {
    const expandedGroupIds = expandedKeys.map(parseNodeKey).filter((item) => item.kind === 'group').map((item) => item.id);
    onChange({ ...preset, expandedGroupIds });
  }

  function handleMove({ dragId, parentId, destinationIndex, expandParentId }) {
    const moved = parseNodeKey(dragId);
    const destinationParentId = parentId ? parseNodeKey(parentId).id : '';
    if (!moved.id || PINNED_ENTRY_IDS.has(moved.id)) return;
    const next = moveTreeNode(
      preset,
      moved,
      destinationParentId,
      destinationIndex,
    );
    const expandedParent = expandParentId ? parseNodeKey(expandParentId).id : '';
    onChange(expandedParent
      ? { ...next, expandedGroupIds: [...new Set([...next.expandedGroupIds, expandedParent])] }
      : next);
  }

  function deleteEntry(entryId) {
    onChange({ ...preset, entries: preset.entries.filter((entry) => entry.id !== entryId) });
    if (selected?.kind === 'entry' && selected.id === entryId) setSelected(null);
  }

  function deleteGroup(groupId) {
    const removed = descendantGroups(preset.groups, groupId);
    onChange({
      ...preset,
      groups: preset.groups.filter((group) => !removed.has(group.id)),
      entries: preset.entries.filter((entry) => !removed.has(entry.groupId)),
      expandedGroupIds: preset.expandedGroupIds.filter((id) => !removed.has(id)),
    });
    setSelected(null);
  }

  function openTreeNodeContextMenu(event, data) {
    setAddOpen(false);
    if (data.fixed) {
      context.open(event);
      return;
    }
    const value = data.nodeKind === 'group'
      ? preset.groups.find((group) => group.id === data.recordId)
      : preset.entries.find((entry) => entry.id === data.recordId);
    if (!value) return;
    context.open(event, { kind: data.nodeKind, value });
  }

  function openTreeContextMenu(event) {
    setAddOpen(false);
    context.open(event);
  }

  const menuTarget = context.menu?.target;
  const createTarget = menuTarget ? { kind: menuTarget.kind, id: menuTarget.value.id } : null;
  const pinnedMenuTarget = menuTarget?.kind === 'entry' && PINNED_ENTRY_IDS.has(menuTarget.value.id);
  const menuActions = pinnedMenuTarget ? [] : !menuTarget || menuTarget.kind === 'group' ? [
    { label: '新建文件夹', icon: CreateFolderIcon, run: () => createNode('group', createTarget) },
    { label: '新建提示词', icon: CreateEntryIcon, run: () => createNode('entry', createTarget) },
    { label: '新建 EJS引用设定', icon: CreateReferenceIcon, run: () => createNode('reference', createTarget) },
  ] : [{ label: '复制', icon: Copy, run: () => duplicateEntry(menuTarget.value) }];
  if (menuTarget && !pinnedMenuTarget) menuActions.push(
    { label: '重命名', icon: PencilSimple, run: () => renameNode(menuTarget) },
    { label: '删除', icon: TrashIcon, danger: true, run: () => menuTarget.kind === 'group' ? deleteGroup(menuTarget.value.id) : deleteEntry(menuTarget.value.id) },
  );

  return (
    <section className="preset-prompt-editor setting-library-layout" aria-label="预设提示词" onMouseDown={() => setAddOpen(false)}>
      <div className="setting-library-browser">
        <div className="setting-library-toolbar" onMouseDown={(event) => event.stopPropagation()}>
          <label className="setting-library-search">
            <MagnifyingGlass size={15} aria-hidden="true" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索提示词" aria-label="搜索提示词" />
          </label>
          <div className="setting-library-add-wrap">
            <button type="button" className="setting-library-create-button" aria-expanded={addOpen} onClick={() => setAddOpen((value) => !value)}><Plus size={16} />新建</button>
            {addOpen ? <div className="setting-library-popover" role="menu">
              <button type="button" role="menuitem" onClick={() => createNode('group')}><CreateFolderIcon size={16} />文件夹</button>
              <button type="button" role="menuitem" onClick={() => createNode('entry')}><CreateEntryIcon size={16} />提示词</button>
              <button type="button" role="menuitem" onClick={() => createNode('reference')}><CreateReferenceIcon size={16} />EJS引用设定</button>
            </div> : null}
          </div>
          {saveAction}
        </div>
        <div
          className="preset-prompt-tree setting-library-tree"
          tabIndex={0}
          aria-label="预设提示词列表"
          onMouseDown={(event) => {
            if (event.button === 0 && !event.target.closest('[role="treeitem"]')) setSelected(null);
          }}
          onContextMenu={openTreeContextMenu}
        >
          <SettingTreeActionsContext.Provider value={{ openContextMenu: openTreeNodeContextMenu, updateEntryById: updateTreeEntry }}>
            <SettingLibraryTree
              key={preset.id}
              nodes={nodes}
              query={query}
              selectedId={selected ? nodeKey(selected.kind, selected.id) : ''}
              expandedIds={preset.expandedGroupIds.map((id) => nodeKey('group', id))}
              onSelectedIdChange={(id) => {
                const next = parseNodeKey(id);
                setSelected(next.id ? next : null);
              }}
              onExpandedIdsChange={handleExpandedIdsChange}
              onMove={handleMove}
              ariaLabel="预设提示词树"
            />
          </SettingTreeActionsContext.Provider>
          {!query && !nodes.length ? <p className="setting-library-empty">还没有预设提示词</p> : null}
          {query && !searchHasResults ? <p className="setting-library-empty">没有匹配的提示词</p> : null}
        </div>
      </div>

      {selectedValue ? <SettingLibraryInspector
        selected={{ kind: selected.kind, value: selectedValue }}
        library={library}
        allowCustomPromptPositions
        nameInputRef={nameInputRef}
        SelectedIcon={selected.kind === 'group' ? DshFolderClosedIcon : selectedValue.dynamicMode === 'ejs_controller' ? Code : selectedValue.dynamicMode === 'ejs_reference' ? LinkSimple : FileText}
        onClose={() => setSelected(null)}
        onUpdateGroup={(patch) => onChange({ ...preset, groups: preset.groups.map((group) => group.id === selected.id ? { ...group, ...patch } : group) })}
        onDeleteGroup={() => deleteGroup(selected.id)}
        onUpdateEntry={updateEntry}
        onEntriesChange={(entries) => onChange({ ...preset, entries })}
        onOpenEntry={(entryId) => setSelected({ kind: 'entry', id: entryId })}
        onRequestDeleteOpening={() => {}}
        onPromptPositionsChange={(promptPositions, entries = preset.entries) => onChange({ ...preset, promptPositions, entries })}
      /> : null}
      {context.menu ? <PresetContextMenu menu={context.menu} actions={menuActions} onClose={context.close} /> : null}
      <ConfirmationDialog
        target={pendingHiddenTimelineDisableId ? HIDDEN_TIMELINE_DISABLE_CONFIRMATION : null}
        confirmLabel="仍要关闭"
        onCancel={() => setPendingHiddenTimelineDisableId('')}
        onConfirm={confirmHiddenTimelineDisable}
      />
    </section>
  );
}

function descendantGroups(groups, groupId) {
  const removed = new Set([groupId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of groups) {
      if (removed.has(group.parentId) && !removed.has(group.id)) {
        removed.add(group.id);
        changed = true;
      }
    }
  }
  return removed;
}
