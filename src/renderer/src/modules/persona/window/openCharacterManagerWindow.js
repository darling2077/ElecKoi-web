const CHARACTER_MANAGER_WINDOW_NAME = "character-manager";

export function openCharacterManagerWindow() {
  const managerUrl = new URL(window.location.href);
  managerUrl.search = "?view=character-manager";
  window.open(
    managerUrl.toString(),
    CHARACTER_MANAGER_WINDOW_NAME,
    "width=1500,height=1040",
  );
}
