export type ThreadImage = {
  url: string;
  alt?: string;
};

export type ThreadPost = {
  id: string;
  url: string;
  authorHandle: string;
  authorName: string;
  text: string;
  markdown?: string;
  published?: string;
  images: ThreadImage[];
};

export type ExtractedThread = {
  sourceUrl: string;
  authorHandle: string;
  authorName: string;
  title: string;
  posts: ThreadPost[];
  capturedAt: string;
  isThread: boolean;
  sourceType?: "post" | "thread" | "article";
};

export function formatThreadMarkdown(thread: ExtractedThread, titleOverride?: string): string {
  const title = normalizeTitle(titleOverride || thread.title || "X thread");
  const firstPublished = thread.posts.find((post) => post.published)?.published || "";
  const body = thread.posts
    .map((post) => formatPostBody(post))
    .filter(Boolean)
    .join("\n\n");

  return [
    "---",
    `source: ${yamlQuote(thread.sourceUrl)}`,
    `author: ${yamlQuote(linkHandle(thread.authorHandle))}`,
    `author_name: ${yamlQuote(thread.authorName)}`,
    `published: ${firstPublished ? yamlQuote(firstPublished) : ""}`,
    `captured: ${yamlQuote(thread.capturedAt)}`,
    'platform: "X"',
    `type: ${yamlQuote(thread.sourceType || (thread.isThread ? "thread" : "post"))}`,
    "---",
    "",
    `# ${title}`,
    "",
    stripLeadingTitle(body, title)
  ].join("\n").trimEnd() + "\n";
}

export function sanitizeFileName(input: string): string {
  const fallback = "X thread";
  const cleaned = normalizeTitle(input || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 110);

  return cleaned || fallback;
}

export function normalizeTitle(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function titleFromText(text: string): string {
  const lines = text
    .replace(/https?:\/\/\S+/g, "")
    .split("\n")
    .map((line) => normalizeTitle(line))
    .filter(Boolean);
  const firstLine = lines[0] || "";

  if (firstLine) {
    return trimTitle(firstLine);
  }

  const cleaned = normalizeTitle(text.replace(/https?:\/\/\S+/g, ""));
  const sentenceMatch = cleaned.match(/^(.{20,180}?[.!?])(\s|$)/);
  const title = sentenceMatch?.[1] || cleaned.slice(0, 90);
  return trimTitle(title);
}

function formatPostBody(post: ThreadPost): string {
  if (post.markdown) return cleanTweetText(post.markdown);

  const text = linkMentions(cleanTweetText(post.text));
  const images = post.images.map((image) => `![](${image.url})`);
  return [text, ...images].filter(Boolean).join("\n\n");
}

function cleanTweetText(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripLeadingTitle(body: string, title: string): string {
  const normalizedTitle = normalizeComparableText(title);
  const paragraphs = body.split(/\n{2,}/);
  const firstParagraph = paragraphs[0];

  if (firstParagraph && normalizeComparableText(firstParagraph) === normalizedTitle) {
    return paragraphs.slice(1).join("\n\n").trim();
  }

  return body;
}

function stripTitlePrefix(text: string, title: string): string {
  const compactTitle = normalizeComparableText(title);
  let consumed = 0;
  let comparable = "";

  for (const char of text) {
    consumed += char.length;
    comparable = normalizeComparableText(text.slice(0, consumed));
    if (comparable.length >= compactTitle.length && compactTitle.startsWith(comparable) === false) break;
    if (comparable === compactTitle) {
      return text.slice(consumed).replace(/^[\s.!?:;,–-]+/, "").trim();
    }
  }

  return text;
}

function normalizeComparableText(text: string): string {
  return text
    .replace(/[#*_`~>\[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "")
    .toLowerCase();
}

function trimTitle(title: string): string {
  return normalizeTitle(title).slice(0, 90).trim().replace(/[.!?]+$/, "") || "X thread";
}

export function linkMentions(text: string): string {
  return text.replace(/(^|[^\w\]])@([A-Za-z0-9_]{1,15})\b/g, (_match, prefix: string, handle: string) => {
    return `${prefix}${linkHandle(`@${handle}`)}`;
  });
}

function linkHandle(handle: string): string {
  const normalized = handle.startsWith("@") ? handle : `@${handle}`;
  return `[[${normalized}]]`;
}

function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
