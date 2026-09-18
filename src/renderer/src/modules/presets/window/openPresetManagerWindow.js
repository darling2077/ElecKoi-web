const PRESET_MANAGER_WINDOW_NAME = "preset-manager";

export function openPresetManagerWindow() {
  const managerUrl = new URL(window.location.href);
  managerUrl.search = "?view=preset-manager";
  window.open(
    managerUrl.toString(),
    PRESET_MANAGER_WINDOW_NAME,
    "width=1500,height=1040",
  );
}
