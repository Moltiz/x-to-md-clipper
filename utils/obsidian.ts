import { sanitizeFileName } from "./thread";

export type ObsidianConfig = {
  vaultId: string;
  folder: string;
};

const STORAGE_KEYS = {
  vaultId: "obsidianVaultId",
  folder: "obsidianFolder"
} as const;

export const DEFAULT_OBSIDIAN_FOLDER = "raw/xthreads";

export async function getObsidianConfig(): Promise<ObsidianConfig> {
  const stored = await browser.storage.local.get([STORAGE_KEYS.vaultId, STORAGE_KEYS.folder]);

  return {
    vaultId: normalizeConfigValue(stored[STORAGE_KEYS.vaultId]),
    folder: normalizeConfigValue(stored[STORAGE_KEYS.folder]) || DEFAULT_OBSIDIAN_FOLDER
  };
}

export async function saveObsidianConfig(config: ObsidianConfig): Promise<void> {
  await browser.storage.local.set({
    [STORAGE_KEYS.vaultId]: config.vaultId.trim(),
    [STORAGE_KEYS.folder]: config.folder.trim() || DEFAULT_OBSIDIAN_FOLDER
  });
}

export function hasObsidianVault(config: ObsidianConfig): boolean {
  return Boolean(config.vaultId.trim());
}

export function buildObsidianNewNoteUrl(filenameTitle: string, config: ObsidianConfig): string {
  const filename = `${sanitizeFileName(filenameTitle || "X thread")}.md`;
  const folder = config.folder.trim().replace(/^\/+|\/+$/g, "") || DEFAULT_OBSIDIAN_FOLDER;
  const filePath = `${folder}/${filename}`;
  const params = new URLSearchParams({
    vault: config.vaultId.trim(),
    file: filePath,
    clipboard: "true"
  });

  return `obsidian://new?${params.toString()}`;
}

function normalizeConfigValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
