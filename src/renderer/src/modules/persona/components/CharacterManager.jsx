import { useEffect, useMemo, useRef, useState } from "react";
import { ExportIcon, ImportIcon, PencilIcon, PlusIcon, TrashIcon } from "../../../ui/icons/index.jsx";
import { DshSearchField } from "../../../ui/ui/DshSearchField.jsx";
import { GroupAssignmentMenu } from "../../../ui/ui/GroupAssignmentMenu.jsx";
import { openCharacterEditorWindow } from "../window/openCharacterEditorWindow.js";
import { AddGroupDialog } from "./AddGroupDialog.jsx";
import { CharacterCard } from "./CharacterCard.jsx";
import { CharacterImportDialog } from "./CharacterImportDialog.jsx";
import { ALL_CHARACTERS, characterGroup, characterName } from "./characterUtils.js";

const CHARACTER_ARTWORK_RATIOS = [0.76, 0.68, 0.84, 0.72];

export function characterArtworkAspectRatio(index) {
  return CHARACTER_ARTWORK_RATIOS[index % CHARACTER_ARTWORK_RATIOS.length];
}

export function CharacterManager({ characters, persona, onSaveGroups, onDeleteCharacters, onImportCharacters, onExportCharacter }) {
  const [selectedGroup, setSelectedGroup] = useState(ALL_CHARACTERS);
  const [selectedCharacterId, setSelectedCharacterId] = useState(characters.active_character_id || characters.items?.[0]?.id || "");
  const [keyword, setKeyword] = useState("");
  const [deleteMode, setDeleteMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [groupMenu, setGroupMenu] = useState(null);
  const [cardGroupMenu, setCardGroupMenu] = useState(null);
  const [groupDialog, setGroupDialog] = useState(null);
  const [groupDraft, setGroupDraft] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const exportControlRef = useRef(null);
  const exportMenuRef = useRef(null);

  const groups = useMemo(() => {
    const names = [...new Set((characters.groups || []).map((group) => group.trim()).filter(Boolean))];
    for (const character of characters.items || []) {
      const group = characterGroup(character);
      if (group && !names.includes(group)) names.push(group);
    }
    return names;
  }, [characters]);
  const visibleCharacters = useMemo(() => {
    const key = keyword.trim().toLocaleLowerCase();
    return (characters.items || []).filter((character) => {
      const inGroup = selectedGroup === ALL_CHARACTERS || characterGroup(character) === selectedGroup;
      const matches = !key || `${characterName(character)} ${characterGroup(character)}`.toLocaleLowerCase().includes(key);
      return inGroup && matches;
    });
  }, [characters, keyword, selectedGroup]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  useEffect(() => {
    if (selectedGroup !== ALL_CHARACTERS && !groups.includes(selectedGroup)) setSelectedGroup(ALL_CHARACTERS);
  }, [groups, selectedGroup]);

  useEffect(() => {
    if ((characters.items || []).some((character) => character.id === selectedCharacterId)) return;
    setSelectedCharacterId(characters.active_character_id || characters.items?.[0]?.id || "");
  }, [characters, selectedCharacterId]);

  useEffect(() => {
    function closeMenus(event) {
      if (event.type === "keydown" && event.key !== "Escape") return;
      if (event.type !== "keydown" && exportControlRef.current?.contains(event.target)) return;
      setGroupMenu(null);
      setCardGroupMenu(null);
      setExportOpen(false);
    }
    window.addEventListener("pointerdown", closeMenus);
    window.addEventListener("keydown", closeMenus);
    return () => {
      window.removeEventListener("pointerdown", closeMenus);
      window.removeEventListener("keydown", closeMenus);
    };
  }, []);

  useEffect(() => {
    if (exportOpen) exportMenuRef.current?.querySelector("button")?.focus();
  }, [exportOpen]);

  function countByGroup(group) {
    return (characters.items || []).filter((character) => characterGroup(character) === group).length;
  }

  function openGroupMenu(event, group = selectedGroup === ALL_CHARACTERS ? "" : selectedGroup) {
    event.preventDefault();
    event.stopPropagation();
    if (group) setSelectedGroup(group);
    setCardGroupMenu(null);
    setGroupMenu({
      group,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 164)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 116)),
    });
  }

  function openGroupDialog(mode, group = "") {
    setGroupDialog({ mode, group });
    setGroupDraft(group);
    setGroupMenu(null);
    setCardGroupMenu(null);
  }

  function openCardGroupMenu(event, character) {
    event.preventDefault();
    event.stopPropagation();
    if (deleteMode) return;
    setSelectedCharacterId(character.id);
    setGroupMenu(null);
    setExportOpen(false);
    setCardGroupMenu({ character, x: event.clientX, y: event.clientY });
  }

  async function moveCharacterToGroup(group) {
    const character = cardGroupMenu?.character;
    if (!character || characterGroup(character) === group) return;
    setError("");
    try {
      await onSaveGroups(groups, [{ characterId: character.id, group }]);
      setCardGroupMenu(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "移动角色卡失败，请重试。");
    }
  }

  async function saveGroup() {
    const name = groupDraft.trim();
    if (!name || name === ALL_CHARACTERS) return;
    setError("");
    try {
      if (groupDialog?.mode === "rename") {
        if (name === groupDialog.group || groups.includes(name)) return;
        const nextGroups = groups.map((group) => group === groupDialog.group ? name : group);
        const assignments = (characters.items || [])
          .filter((character) => characterGroup(character) === groupDialog.group)
          .map((character) => ({ characterId: character.id, group: name }));
        await onSaveGroups(nextGroups, assignments);
        setSelectedGroup(name);
      } else {
        if (groups.includes(name)) return;
        await onSaveGroups([...groups, name]);
        setSelectedGroup(name);
      }
      setGroupDialog(null);
      setGroupDraft("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存分组失败，请重试。");
    }
  }

  async function deleteGroup(group) {
    setGroupMenu(null);
    setError("");
    try {
      const remaining = groups.filter((item) => item !== group);
      const targetGroup = remaining[0] || "";
      const assignments = (characters.items || [])
        .filter((character) => characterGroup(character) === group)
        .map((character) => ({ characterId: character.id, group: targetGroup }));
      await onSaveGroups(remaining, assignments);
      setSelectedGroup(ALL_CHARACTERS);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除分组失败，请重试。");
    }
  }

  function toggleSelected(characterId) {
    setSelectedIds((current) => current.includes(characterId)
      ? current.filter((id) => id !== characterId)
      : [...current, characterId]);
  }

  function cancelDeleteMode() {
    setDeleteMode(false);
    setSelectedIds([]);
  }

  async function confirmDelete() {
    if (!selectedIds.length) return;
    setError("");
    try {
      await onDeleteCharacters(selectedIds);
      cancelDeleteMode();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除失败，请重试。");
    }
  }

  async function exportCharacter(format) {
    const characterId = selectedCharacterId || characters.active_character_id || characters.items?.[0]?.id;
    if (!characterId || exporting) return;
    setExporting(true);
    setError("");
    try {
      await onExportCharacter(characterId, format);
      setExportOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导出失败，请重试。");
    } finally {
      setExporting(false);
    }
  }

  return (
    <section className="character-manager-window" aria-label="角色卡管理器">
      <aside className="character-manager-groups" onContextMenu={(event) => openGroupMenu(event)}>
        <button
          className={`character-manager-group ${selectedGroup === ALL_CHARACTERS ? "active" : ""}`}
          type="button"
          onClick={() => setSelectedGroup(ALL_CHARACTERS)}
        >
          <span>{ALL_CHARACTERS}</span>
          <em>{characters.items?.length || 0}</em>
        </button>
        <small>分组</small>
        <div className="character-manager-group-list">
          {groups.map((group) => (
            <button
              className={`character-manager-group ${selectedGroup === group ? "active" : ""}`}
              type="button"
              key={group}
              onClick={() => setSelectedGroup(group)}
              onContextMenu={(event) => openGroupMenu(event, group)}
            >
              <span>{group}</span>
              <em>{countByGroup(group)}</em>
            </button>
          ))}
        </div>
        <button className="character-add-group-button" type="button" onClick={() => openGroupDialog("add")}>
          <PlusIcon />
          添加分组
        </button>
      </aside>

      <section className="character-manager-main">
        <header className="character-manager-titlebar">
          <h2>角色卡管理器</h2>
          <DshSearchField
            className="character-manager-search"
            value={keyword}
            onValueChange={setKeyword}
            placeholder="搜索角色…"
            ariaLabel="搜索角色"
          />
          {!deleteMode ? (
            <>
              <button type="button" onClick={() => setImportOpen(true)}><ImportIcon />导入角色</button>
              <div className="character-manager-export" ref={exportControlRef}>
                <button
                  type="button"
                  disabled={!characters.items?.length}
                  aria-haspopup="menu"
                  aria-expanded={exportOpen}
                  onClick={() => setExportOpen((current) => !current)}
                >
                  <ExportIcon />导出角色
                </button>
                {exportOpen ? (
                  <div className="character-manager-export-menu" ref={exportMenuRef} role="menu" aria-label="选择角色卡格式">
                    <button type="button" role="menuitem" disabled={exporting} onClick={() => exportCharacter("png")}>PNG 角色卡</button>
                    <button type="button" role="menuitem" disabled={exporting} onClick={() => exportCharacter("json")}>JSON 角色卡</button>
                  </div>
                ) : null}
              </div>
              <button type="button" disabled={!characters.items?.length} onClick={() => setDeleteMode(true)}><TrashIcon />删除</button>
            </>
          ) : (
            <>
              <button className="character-manager-confirm-delete" type="button" disabled={!selectedIds.length} onClick={confirmDelete}>
                确认{selectedIds.length ? ` ${selectedIds.length}` : ""}
              </button>
              <button type="button" onClick={cancelDeleteMode}>取消</button>
            </>
          )}
        </header>

        {error ? <p className="character-manager-error" role="alert">{error}</p> : null}
        <div className="character-manager-scroll">
          {visibleCharacters.length ? (
            <div className="character-manager-grid">
              {visibleCharacters.map((character, index) => (
                <CharacterCard
                  key={character.id}
                  character={character}
                  artworkAspectRatio={characterArtworkAspectRatio(index)}
                  authorName={persona?.user_name || "用户"}
                  authorAvatar={persona?.user_avatar || ""}
                  selectable={deleteMode}
                  selected={selectedSet.has(character.id)}
                  onClick={deleteMode ? toggleSelected : setSelectedCharacterId}
                  onDoubleClick={deleteMode ? undefined : openCharacterEditorWindow}
                  onContextMenu={deleteMode ? undefined : openCardGroupMenu}
                />
              ))}
            </div>
          ) : <p className="character-manager-empty">这个分组里还没有角色卡。</p>}
        </div>
      </section>

      {groupMenu ? (
        <div className="character-group-context-menu" style={{ left: `${groupMenu.x}px`, top: `${groupMenu.y}px` }} onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" onClick={() => openGroupDialog("add")}><PlusIcon /><span>添加分组</span></button>
          {groupMenu.group ? (
            <>
              <button type="button" onClick={() => openGroupDialog("rename", groupMenu.group)}><PencilIcon /><span>重命名该组</span></button>
              <button type="button" onClick={() => deleteGroup(groupMenu.group)}><TrashIcon /><span>删除分组</span></button>
            </>
          ) : null}
        </div>
      ) : null}

      {cardGroupMenu ? (
        <GroupAssignmentMenu
          x={cardGroupMenu.x}
          y={cardGroupMenu.y}
          label={`移动${characterName(cardGroupMenu.character)}到分组`}
          currentGroupId={characterGroup(cardGroupMenu.character)}
          groups={groups.map((group) => ({ id: group, name: group }))}
          onMove={moveCharacterToGroup}
        />
      ) : null}

      {groupDialog ? (
        <AddGroupDialog
          title={groupDialog.mode === "rename" ? "重命名该组" : "添加分组"}
          value={groupDraft}
          onChange={setGroupDraft}
          onConfirm={saveGroup}
          onCancel={() => setGroupDialog(null)}
        />
      ) : null}
      {importOpen ? <CharacterImportDialog onClose={() => setImportOpen(false)} onImported={onImportCharacters} /> : null}
    </section>
  );
}
