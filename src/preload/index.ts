import { contextBridge, ipcRenderer } from "electron";
import { IpcChannels, type AtlasApi } from "@shared/ipc";
import type { Analysis, ProgressEvent } from "@shared/types";

const api: AtlasApi = {
  analyze: (url, force) => ipcRenderer.invoke(IpcChannels.analyze, url, force),
  regenerateNarrative: (key) => ipcRenderer.invoke(IpcChannels.regenerateNarrative, key),
  loadAnalysis: (key) => ipcRenderer.invoke(IpcChannels.loadAnalysis, key),
  listRecent: () => ipcRenderer.invoke(IpcChannels.listRecent),
  ask: (key, question, focusIds, history) => ipcRenderer.invoke(IpcChannels.ask, key, question, focusIds, history),
  getSettings: () => ipcRenderer.invoke(IpcChannels.getSettings),
  saveSettings: (patch) => ipcRenderer.invoke(IpcChannels.saveSettings, patch),
  getReviewState: (key) => ipcRenderer.invoke(IpcChannels.getReviewState, key),
  setViewed: (key, ids, viewed) => ipcRenderer.invoke(IpcChannels.setViewed, key, ids, viewed),
  syncReview: (key) => ipcRenderer.invoke(IpcChannels.syncReview, key),
  checkForUpdates: (key) => ipcRenderer.invoke(IpcChannels.checkForUpdates, key),
  readFile: (key, path, side) => ipcRenderer.invoke(IpcChannels.readFile, key, path, side),
  findUsages: (key, symbolId) => ipcRenderer.invoke(IpcChannels.findUsages, key, symbolId),
  exportFile: (defaultName, kind, content) => ipcRenderer.invoke(IpcChannels.exportFile, defaultName, kind, content),
  openExternal: (url) => ipcRenderer.invoke(IpcChannels.openExternal, url),
  checkTools: () => ipcRenderer.invoke(IpcChannels.checkTools),
  onProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ProgressEvent) => listener(payload);
    ipcRenderer.on(IpcChannels.progress, handler);
    return () => ipcRenderer.removeListener(IpcChannels.progress, handler);
  },
  onAnalysisUpdated: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: Analysis) => listener(payload);
    ipcRenderer.on(IpcChannels.analysisUpdated, handler);
    return () => ipcRenderer.removeListener(IpcChannels.analysisUpdated, handler);
  },
};

contextBridge.exposeInMainWorld("atlas", api);
