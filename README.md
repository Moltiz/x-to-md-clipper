# XtoMD Clipper

XtoMD Clipper is a Chrome extension that turns X posts, threads, and longform articles into clean, Obsidian-ready Markdown.

It is built for a simple workflow: open an X post, click the extension, preview the Markdown, copy it, or send it directly into an Obsidian vault.

## Features

- Clips single X posts into Markdown.
- Clips visible X threads from the main author.
- Clips X longform articles, including code blocks, images, and embedded posts.
- Keeps repeated X UI, buttons, metrics, and navigation out of the note.
- Adds YAML frontmatter with source URL, author, capture time, platform, and content type.
- Sends notes to Obsidian through the `obsidian://new` URI flow.

## Setup

Install dependencies:

```bash
npm install
```

Run the development extension:

```bash
npm run dev
```

Then load the unpacked Chrome extension from:

```text
.output/chrome-mv3-dev
```

Build a production extension:

```bash
npm run build
```

Create a zip for distribution:

```bash
npm run zip
```

## Obsidian Setup

Open the extension options and set:

- Obsidian vault ID
- Destination folder, for example `raw/xthreads`

The vault ID is stored locally in Chrome extension storage. It is not committed to this repo.

Copy Markdown works without Obsidian settings. Save to Obsidian requires a vault ID.

## Known Limitations

- X changes its DOM often, so clipping may need maintenance over time.
- The extension reads what X has rendered in the page; it does not call a private X API.
- Images are saved as Markdown image URLs.
- Screenshot images of tweets are not OCR-read.
- Video clipping is not supported yet.

## Development

```bash
npm run compile
npm run build
```

## License

MIT
