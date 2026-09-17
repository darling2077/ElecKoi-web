import { describe, expect, it } from "vitest";
import {
  findLatestRegenerateTargetMessageId,
  findRegenerateBranchUserIndex,
} from "../src/renderer/src/modules/chat/model/chatRegeneration.js";

describe("chat regeneration targets", () => {
  it("allows regeneration directly from a sent user message without an assistant reply", () => {
    const messages = [{ id: "user-1", role: "user", content: "测试消息" }];

    expect(findLatestRegenerateTargetMessageId(messages)).toBe("user-1");
    expect(findRegenerateBranchUserIndex(messages, "user-1")).toBe(0);
  });

  it("uses the newest unanswered user message instead of an older assistant reply", () => {
    const messages = [
      { id: "user-1", role: "user", content: "第一条" },
      { id: "assistant-1", role: "assistant", content: "第一条回复" },
      { id: "user-2", role: "user", content: "第二条" },
    ];

    expect(findLatestRegenerateTargetMessageId(messages)).toBe("user-2");
    expect(findRegenerateBranchUserIndex(messages, "user-2")).toBe(2);
  });

  it("keeps the normal assistant-reply regeneration path", () => {
    const messages = [
      { id: "opening", role: "assistant", content: "开场白" },
      { id: "user-1", role: "user", content: "测试消息" },
      { id: "assistant-1", role: "assistant", content: "测试回复" },
    ];

    expect(findLatestRegenerateTargetMessageId(messages)).toBe("assistant-1");
    expect(findRegenerateBranchUserIndex(messages, "assistant-1")).toBe(1);
  });

  it("ignores opening messages and pending replies", () => {
    const messages = [
      { id: "opening", role: "assistant", content: "开场白" },
      { id: "user-1", role: "user", content: "测试消息" },
      { id: "pending-1", role: "assistant", content: "", pending: true },
    ];

    expect(findLatestRegenerateTargetMessageId(messages)).toBe("user-1");
  });
});
