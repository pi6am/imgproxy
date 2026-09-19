// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import type { AppConfig } from "./types.js";
import SettingsPage from "./pages/SettingsPage.js";
import HistoryPage from "./pages/HistoryPage.js";
import TestPage from "./pages/TestPage.js";

type Tab = "test" | "history" | "settings";

export default function App() {
  const [tab, setTab] = useState<Tab>("test");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState("");
  const [configVersion, setConfigVersion] = useState(0);

  const refreshConfig = useCallback(async () => {
    try {
      setConfig(await api.getConfig());
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refreshConfig();
  }, [refreshConfig]);

  const activeProvider = config?.providers.find((p) => p.id === config.activeProviderId) ?? config?.providers[0];

  return (
    <div className="app">
      <header className="header">
        <span className="logo">imgproxy</span>
        <span className="active-provider" title="Active provider">
          {activeProvider ? `${activeProvider.name} · ${activeProvider.type}` : "no provider configured"}
        </span>
        <nav className="tabs">
          <button className={tab === "test" ? "tab active" : "tab"} onClick={() => setTab("test")}>
            Test
          </button>
          <button className={tab === "history" ? "tab active" : "tab"} onClick={() => setTab("history")}>
            History
          </button>
          <button className={tab === "settings" ? "tab active" : "tab"} onClick={() => setTab("settings")}>
            Settings
          </button>
        </nav>
      </header>
      {error && <div className="banner error">{error}</div>}
      {!config && !error && <div className="banner">Loading…</div>}
      {config && tab === "test" && <TestPage config={config} />}
      {config && tab === "history" && <HistoryPage />}
      {config && tab === "settings" && (
        <SettingsPage
          key={configVersion}
          config={config}
          onSaved={async () => {
            await refreshConfig();
            setConfigVersion((v) => v + 1);
          }}
        />
      )}
      <footer className="footer">
        OpenAI: <code>POST /v1/images/generations</code> · A1111: <code>POST /sdapi/v1/txt2img</code>
      </footer>
    </div>
  );
}
