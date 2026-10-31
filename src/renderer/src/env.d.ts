import type { AtlasApi } from "@shared/ipc";

declare global {
  interface Window {
    atlas: AtlasApi;
  }
}

export {};
