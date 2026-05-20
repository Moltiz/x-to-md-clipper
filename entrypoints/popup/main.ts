import "./style.css";
import {
  formatThreadMarkdown,
  sanitizeFileName,
  type ExtractedThread
} from "~/utils/thread";
import { buildObsidianNewNoteUrl, getObsidianConfig, hasObsidianVault } from "~/utils/obsidian";

type ExtractMessage = {
  type: "X_THREAD_CLIPPER_EXTRACT";
};

const summary = document.querySelector<HTMLParagraphElement>("#summary");
const titleInput = document.querySelector<HTMLInputElement>("#title");
const preview = document.querySelector<HTMLTextAreaElement>("#preview");
const status = document.querySelector<HTMLParagraphElement>("#status");
const refreshButton = document.querySelector<HTMLButtonElement>("#refresh");
const copyButton = document.querySelector<HTMLButtonElement>("#copy");
const saveButton = document.querySelector<HTMLButtonElement>("#save");

let currentThread: ExtractedThread | undefined;

void loadThread().then(() => {
  window.setTimeout(() => {
    void loadThread();
  }, 250);
});

refreshButton?.addEventListener("click", () => {
  void loadThread();
});

titleInput?.addEventListener("input", () => {
  renderPreview();
});

copyButton?.addEventListener("click", async () => {
  const markdown = getCurrentMarkdown();
  if (!markdown) return;

  await navigator.clipboard.writeText(markdown);
  setStatus("Markdown kopiert.");
});

saveButton?.addEventListener("click", async () => {
  const markdown = getCurrentMarkdown();
  const filenameTitle = titleInput?.value.trim();
  if (!markdown || !filenameTitle) return;

  const obsidianConfig = await getObsidianConfig();
  if (!hasObsidianVault(obsidianConfig)) {
    setStatus("Legg inn Obsidian vault ID i Options for a bruke Save.");
    await browser.runtime.openOptionsPage();
    return;
  }

  await navigator.clipboard.writeText(markdown);
  await browser.tabs.create({ url: buildObsidianNewNoteUrl(filenameTitle, obsidianConfig), active: true });
  setStatus(`Sendt til Obsidian: ${sanitizeFileName(filenameTitle)}.md`);
});

async function loadThread() {
  setBusy(true);
  setStatus("");
  if (summary) summary.textContent = "Henter thread fra aktiv X-fane...";

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id || !isXUrl(tab.url)) {
    currentThread = undefined;
    if (summary) summary.textContent = "Apne en X-post, thread eller article for a bruke klipperen.";
    if (preview) preview.value = "";
    if (titleInput) titleInput.value = "";
    setStatus("Aktiv fane er ikke x.com/twitter.com.");
    setBusy(false);
    return;
  }

  try {
    currentThread = await browser.tabs.sendMessage<ExtractMessage, ExtractedThread>(tab.id, {
      type: "X_THREAD_CLIPPER_EXTRACT"
    });
    renderPreview();
  } catch {
    currentThread = undefined;
    if (summary) summary.textContent = "Kunne ikke lese X-siden enda.";
    if (preview) preview.value = "";
    setStatus("Refresh X-fanen, apne threaden igjen, og prov pa nytt.");
  } finally {
    setBusy(false);
  }
}

function renderPreview() {
  if (!currentThread) return;

  const title = titleInput?.value.trim() || currentThread.title;
  if (titleInput && document.activeElement !== titleInput) titleInput.value = title;
  if (preview) preview.value = formatThreadMarkdown(currentThread, title);
  if (summary) {
    if (currentThread.sourceType === "article") {
      summary.textContent = `Article funnet fra ${currentThread.authorHandle || "X"}.`;
    } else {
      const noun = currentThread.posts.length === 1 ? "post" : "poster";
      summary.textContent = `${currentThread.posts.length} ${noun} funnet fra ${currentThread.authorHandle}.`;
    }
  }
  setStatus("");
}

function getCurrentMarkdown(): string {
  if (!currentThread) {
    setStatus("Ingen thread er hentet enda.");
    return "";
  }

  const title = titleInput?.value.trim() || currentThread.title;
  return preview?.value.trim() ? `${preview.value.trimEnd()}\n` : formatThreadMarkdown(currentThread, title);
}

function setBusy(isBusy: boolean) {
  for (const button of [refreshButton, copyButton, saveButton]) {
    if (button) button.disabled = isBusy;
  }
}

function setStatus(message: string) {
  if (status) status.textContent = message;
}

function isXUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host === "x.com" || host === "twitter.com";
  } catch {
    return false;
  }
}
