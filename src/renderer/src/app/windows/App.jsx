import { MainWindow } from "./MainWindow.jsx";
import { ChatWindow } from "./ChatWindow.jsx";
import { CharacterEditorWindow } from "./CharacterEditorWindow.jsx";
import { CharacterManagerWindow } from "./CharacterManagerWindow.jsx";
import { PresetManagerWindow } from "./PresetManagerWindow.jsx";

export default function App() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("view") === "chat") {
    return <ChatWindow />;
  }
  if (params.get("view") === "character-editor") {
    return <CharacterEditorWindow />;
  }
  if (params.get("view") === "character-manager") {
    return <CharacterManagerWindow />;
  }
  if (params.get("view") === "preset-manager") {
    return <PresetManagerWindow />;
  }
  return <MainWindow />;
}
