import "./style.css";
import { DEFAULT_OBSIDIAN_FOLDER, getObsidianConfig, saveObsidianConfig } from "~/utils/obsidian";

const vaultInput = document.querySelector<HTMLInputElement>("#vaultId");
const folderInput = document.querySelector<HTMLInputElement>("#folder");
const saveButton = document.querySelector<HTMLButtonElement>("#save");
const status = document.querySelector<HTMLParagraphElement>("#status");

void loadConfig();

saveButton?.addEventListener("click", async () => {
  await saveObsidianConfig({
    vaultId: vaultInput?.value || "",
    folder: folderInput?.value || DEFAULT_OBSIDIAN_FOLDER
  });

  setStatus("Settings saved.");
});

async function loadConfig(): Promise<void> {
  const config = await getObsidianConfig();
  if (vaultInput) vaultInput.value = config.vaultId;
  if (folderInput) folderInput.value = config.folder;
}

function setStatus(message: string): void {
  if (status) status.textContent = message;
}
