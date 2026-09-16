import { useEffect, useRef, useState } from 'react';
import { getListCollapseState, saveListCollapseState } from '../api/settingsApi.js';
import { normalizeCollapsedGroups } from '../model/listCollapseState.js';

const collapseStateCache = new Map();

export function usePersistentCollapseState(area, defaults = {}, validKeys) {
  const cachedState = collapseStateCache.get(area);
  const [collapsedGroups, setCollapsedGroupsState] = useState(() => normalizeCollapsedGroups(cachedState, defaults, validKeys));
  const [hydrated, setHydrated] = useState(() => collapseStateCache.has(area));
  const changedBeforeHydrationRef = useRef(false);
  const defaultsRef = useRef(defaults);
  const validKeysRef = useRef(validKeys);
  defaultsRef.current = defaults;
  validKeysRef.current = validKeys;
  const validKeysSignature = validKeys ? JSON.stringify(validKeys) : null;

  useEffect(() => {
    let active = true;
    getListCollapseState(area).then((saved) => {
      if (!active) return;
      if (!changedBeforeHydrationRef.current) {
        const normalized = normalizeCollapsedGroups(saved, defaultsRef.current, validKeysRef.current);
        collapseStateCache.set(area, normalized);
        setCollapsedGroupsState(normalized);
      }
      setHydrated(true);
    }).catch(() => {
      if (active) setHydrated(true);
    });
    return () => { active = false; };
  }, [area]);

  useEffect(() => {
    if (validKeysSignature === null) return;
    const currentValidKeys = JSON.parse(validKeysSignature);
    setCollapsedGroupsState((current) => {
      const normalized = normalizeCollapsedGroups(current, defaultsRef.current, currentValidKeys);
      if (hydrated) collapseStateCache.set(area, normalized);
      return normalized;
    });
  }, [area, hydrated, validKeysSignature]);

  useEffect(() => {
    if (!hydrated) return;
    void saveListCollapseState(area, collapsedGroups).catch(() => {});
  }, [area, collapsedGroups, hydrated]);

  function setCollapsedGroups(value) {
    changedBeforeHydrationRef.current = true;
    setCollapsedGroupsState((current) => {
      const next = typeof value === 'function' ? value(current) : value;
      const normalized = normalizeCollapsedGroups(next, defaultsRef.current, validKeysRef.current);
      collapseStateCache.set(area, normalized);
      return normalized;
    });
  }

  return [collapsedGroups, setCollapsedGroups, hydrated];
}
