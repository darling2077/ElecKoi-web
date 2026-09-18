import { describe, expect, it } from "vitest";
import {
  collapseSessionsByCharacter,
  filterHiddenConversationEntries,
  hideConversationEntry,
  restoreConversationEntry,
  sortSessionsByPinned,
} from "../src/renderer/src/modules/chat/model/chatSessionView.js";

function session(id, characterId, updatedAt) {
  return {
    id,
    character_id: characterId,
    character_name: characterId,
    updated_at: updatedAt,
  };
}

describe("conversation list entries", () => {
  it("hides the collapsed entry without deleting any conversation history", () => {
    const allSessions = [
      session("latest-session", "same-character", "2026-09-19T03:00:00Z"),
      session("older-session", "same-character", "2026-09-19T01:00:00Z"),
    ];

    const collapsed = collapseSessionsByCharacter(sortSessionsByPinned(allSessions, []), "");
    const visible = filterHiddenConversationEntries(collapsed, ["latest-session"]);

    expect(visible).toEqual([]);
    expect(allSessions.map((item) => item.id)).toEqual(["latest-session", "older-session"]);
  });

  it("restores only the matching hidden entry when that conversation becomes active again", () => {
    const hidden = ["other-session", "active-session", "older-session"];

    expect(restoreConversationEntry(hidden, "active-session")).toEqual([
      "other-session",
      "older-session",
    ]);
    expect(restoreConversationEntry(hidden, "missing")).toEqual(hidden);
  });

  it("adds one normalized hidden entry without duplicates", () => {
    expect(hideConversationEntry([" existing ", "existing"], " next ")).toEqual([
      "next",
      "existing",
    ]);
    expect(hideConversationEntry(["existing"], "existing")).toEqual(["existing"]);
  });
});
