import { afterEach, describe, expect, it, vi } from "vitest";
import { openCharacterManagerWindow } from "../src/renderer/src/modules/persona/window/openCharacterManagerWindow.js";
import { characterArtworkAspectRatio } from "../src/renderer/src/modules/persona/components/CharacterManager.jsx";
import { openPresetManagerWindow } from "../src/renderer/src/modules/presets/window/openPresetManagerWindow.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("management window launchers", () => {
  it.each([
    [openCharacterManagerWindow, "character-manager"],
    [openPresetManagerWindow, "preset-manager"],
  ])("opens or focuses a singleton %s window", (openManager, view) => {
    const open = vi.fn(() => null);
    const assign = vi.fn();
    vi.stubGlobal("window", {
      location: {
        href: "http://127.0.0.1:5173/?view=chat&chat=conversation-1",
        assign,
      },
      open,
    });

    openManager();

    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(
      `http://127.0.0.1:5173/?view=${view}`,
      view,
      "width=1500,height=1040",
    );
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("character manager layout", () => {
  it("uses the Android waterfall artwork ratio cycle", () => {
    expect(Array.from({ length: 8 }, (_, index) => characterArtworkAspectRatio(index))).toEqual([
      0.76, 0.68, 0.84, 0.72,
      0.76, 0.68, 0.84, 0.72,
    ]);
  });
});
