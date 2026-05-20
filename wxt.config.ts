import { defineConfig } from "wxt";

export default defineConfig({
  webExt: {
    disabled: true
  },
  manifest: {
    name: "XtoMD Clipper",
    description: "Clip X posts, threads, and articles into Obsidian-ready Markdown.",
    version: "0.0.1",
    permissions: ["activeTab", "clipboardWrite", "scripting", "storage", "tabs"],
    action: {
      default_title: "XtoMD Clipper"
    },
    options_ui: {
      page: "options.html",
      open_in_tab: false
    }
  }
});
