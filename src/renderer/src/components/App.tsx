import { useCallback, useEffect, useState } from "react";
import type { Analysis, ProgressEvent, Settings } from "@shared/types";
import { Home } from "./Home";
import { SettingsDialog } from "./SettingsDialog";
import { Workspace } from "./Workspace";

type Screen = { name: "home" } | { name: "loading"; url: string } | { name: "workspace" };

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: "home" });
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [progress, setProgress] = useState<ProgressEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    void window.atlas.getSettings().then(setSettings);
    const offProgress = window.atlas.onProgress((event) => setProgress((list) => [...list.slice(-40), event]));
    const offAnalysis = window.atlas.onAnalysisUpdated((updated) =>
      setAnalysis((current) => (current && current.key === updated.key && current.pr.headSha === updated.pr.headSha ? updated : current)),
    );
    return () => {
      offProgress();
      offAnalysis();
    };
  }, []);

  useEffect(() => {
    if (!settings) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = settings.theme === "dark" || (settings.theme === "system" && media.matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [settings]);

  const open = useCallback(async (url: string, force = false) => {
    setError(null);
    setProgress([]);
    setScreen({ name: "loading", url });
    try {
      const result = await window.atlas.analyze(url, force);
      setAnalysis(result);
      setScreen({ name: "workspace" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(caught));
      setScreen({ name: "home" });
    }
  }, []);

  // Pulling new commits re-analyses in place, like VS Code's pull: the workspace stays open.
  const refresh = useCallback(async (url: string) => {
    setRefreshing(true);
    setError(null);
    try {
      setAnalysis(await window.atlas.analyze(url, true));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(caught));
    } finally {
      setRefreshing(false);
    }
  }, []);

  const saveSettings = useCallback(async (patch: Parameters<typeof window.atlas.saveSettings>[0]) => {
    setSettings(await window.atlas.saveSettings(patch));
  }, []);

  if (!settings) return <div className="boot">Atlas</div>;

  return (
    <>
      {screen.name === "workspace" && analysis ? (
        <Workspace
          analysis={analysis}
          settings={settings}
          progress={progress}
          onHome={() => setScreen({ name: "home" })}
          refreshing={refreshing}
          refreshError={error}
          onReanalyze={() => void refresh(analysis.pr.url)}
          onOpenSettings={() => setSettingsOpen(true)}
          onSaveSettings={saveSettings}
        />
      ) : (
        <Home
          loadingUrl={screen.name === "loading" ? screen.url : null}
          progress={progress}
          error={error}
          onOpen={(url) => void open(url)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}
      {settingsOpen && <SettingsDialog settings={settings} onSave={saveSettings} onClose={() => setSettingsOpen(false)} />}
    </>
  );
}
