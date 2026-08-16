import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DEFAULT_THEME_MODE, loadThemeMode } from "./recordStore";
import "./styles.css";

async function mount(): Promise<void> {
  const initialTheme = await loadThemeMode().catch(() => DEFAULT_THEME_MODE);
  document.documentElement.style.colorScheme = initialTheme;
  document.body.style.background = initialTheme === "dark" ? "#080808" : "#f5f6fa";
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App initialTheme={initialTheme} />
    </StrictMode>,
  );
}

void mount();
