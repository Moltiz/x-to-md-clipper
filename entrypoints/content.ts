import { linkMentions, titleFromText, type ExtractedThread, type ThreadImage, type ThreadPost } from "~/utils/thread";

type ExtractMessage = {
  type: "X_THREAD_CLIPPER_EXTRACT";
};

type ParsedTweet = {
  article: HTMLElement;
  post: ThreadPost;
};

type CachedTweet = ParsedTweet & {
  firstSeen: number;
  inMainThread: boolean;
};

const threadCache = {
  pageKey: "",
  nextIndex: 0,
  tweets: new Map<string, CachedTweet>()
};

const articleCache = new Map<string, ExtractedThread>();

export default defineContentScript({
  matches: ["https://x.com/*", "https://twitter.com/*"],
  main() {
    collectVisibleTweets();
    const observer = new MutationObserver(() => collectVisibleTweets());
    observer.observe(document.body, { childList: true, subtree: true });

    browser.runtime.onMessage.addListener((message: ExtractMessage) => {
      if (message?.type !== "X_THREAD_CLIPPER_EXTRACT") return;
      collectVisibleTweets();
      return Promise.resolve(extractThread());
    });
  }
});

function extractThread(): ExtractedThread {
  const sourceUrl = normalizeXUrl(window.location.href);
  const targetHandle = getHandleFromUrl(window.location.href);
  const targetStatusId = getStatusIdFromUrl(window.location.href);
  const articles = Array.from(document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]'));
  const parsedTweets = parseTweetArticles(articles);

  const shouldTryArticle = shouldTryArticleExtraction(parsedTweets);
  const article = extractArticle(sourceUrl, parsedTweets, shouldTryArticle);
  if (article) {
    articleCache.set(sourceUrl, article);
    return article;
  }

  if (shouldTryArticle) {
    const cachedArticle = articleCache.get(sourceUrl);
    if (cachedArticle) return cachedArticle;
    return buildEmptyArticleResult(sourceUrl, targetHandle);
  }

  markMainThreadFromSnapshot(parsedTweets, targetHandle, targetStatusId);
  const cachedMainThreadPosts = getCachedMainThreadPosts(targetHandle);
  const mainThreadPosts = cachedMainThreadPosts.length
    ? cachedMainThreadPosts
    : selectMainThreadPosts(parsedTweets, targetHandle, targetStatusId);
  const uniquePosts = dedupePosts(mainThreadPosts);
  const firstPost = uniquePosts[0];

  return {
    sourceUrl,
    authorHandle: firstPost?.authorHandle || targetHandle || "",
    authorName: firstPost?.authorName || firstPost?.authorHandle || targetHandle || "",
    title: titleFromText(firstPost?.text || document.title.replace(" / X", "")),
    posts: uniquePosts,
    capturedAt: new Date().toISOString(),
    isThread: uniquePosts.length > 1,
    sourceType: uniquePosts.length > 1 ? "thread" : "post"
  };
}

function collectVisibleTweets(): void {
  ensureCacheForCurrentPage();

  const targetHandle = getHandleFromUrl(window.location.href);
  const targetStatusId = getStatusIdFromUrl(window.location.href);
  const articles = Array.from(document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]'));
  const parsedTweets = parseTweetArticles(articles);

  for (const tweet of parsedTweets) {
    upsertCachedTweet(tweet, false);
  }

  markMainThreadFromSnapshot(parsedTweets, targetHandle, targetStatusId);
}

function parseTweetArticles(articles: HTMLElement[]): ParsedTweet[] {
  return articles
    .map((tweetArticle) => {
      const post = parseTweetArticle(tweetArticle);
      return post ? { article: tweetArticle, post } : undefined;
    })
    .filter((tweet): tweet is ParsedTweet => Boolean(tweet));
}

function markMainThreadFromSnapshot(tweets: ParsedTweet[], targetHandle?: string, targetStatusId?: string): void {
  const selected = selectMainThreadPosts(tweets, targetHandle, targetStatusId);
  if (selected.some((post) => !targetStatusId || post.id === targetStatusId)) {
    for (const post of selected) {
      const tweet = tweets.find((candidate) => candidate.post.id === post.id);
      if (tweet) upsertCachedTweet(tweet, true);
    }
    return;
  }

  const cachedPosts = getCachedMainThreadPosts(targetHandle);
  if (!cachedPosts.length || !targetHandle) return;

  for (const tweet of getLeadingSameAuthorRun(tweets, targetHandle)) {
    upsertCachedTweet(tweet, true);
  }
}

function getLeadingSameAuthorRun(tweets: ParsedTweet[], targetHandle: string): ParsedTweet[] {
  const run: ParsedTweet[] = [];

  for (const tweet of tweets) {
    if (!sameHandle(tweet.post.authorHandle, targetHandle)) break;
    run.push(tweet);
  }

  return run;
}

function upsertCachedTweet(tweet: ParsedTweet, inMainThread: boolean): void {
  const existing = threadCache.tweets.get(tweet.post.id);
  if (existing) {
    existing.article = tweet.article;
    existing.post = tweet.post;
    existing.inMainThread = existing.inMainThread || inMainThread;
    return;
  }

  threadCache.tweets.set(tweet.post.id, {
    ...tweet,
    firstSeen: threadCache.nextIndex,
    inMainThread
  });
  threadCache.nextIndex += 1;
}

function getCachedMainThreadPosts(targetHandle?: string): ThreadPost[] {
  return Array.from(threadCache.tweets.values())
    .filter((tweet) => tweet.inMainThread)
    .filter((tweet) => !targetHandle || sameHandle(tweet.post.authorHandle, targetHandle))
    .sort((left, right) => compareTweetOrder(left, right))
    .map((tweet) => tweet.post);
}

function compareTweetOrder(left: CachedTweet, right: CachedTweet): number {
  const idComparison = compareStatusIds(left.post.id, right.post.id);
  return idComparison || left.firstSeen - right.firstSeen;
}

function compareStatusIds(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    if (left.length !== right.length) return left.length - right.length;
    return left.localeCompare(right);
  }

  return 0;
}

function ensureCacheForCurrentPage(): void {
  const pageKey = normalizeXUrl(window.location.href);
  if (threadCache.pageKey === pageKey) return;

  threadCache.pageKey = pageKey;
  threadCache.nextIndex = 0;
  threadCache.tweets.clear();
}

function selectMainThreadPosts(tweets: ParsedTweet[], targetHandle?: string, targetStatusId?: string): ThreadPost[] {
  if (!tweets.length) return [];

  const targetIndex = findTargetTweetIndex(tweets, targetHandle, targetStatusId);
  if (targetIndex < 0) return [];

  const threadHandle = tweets[targetIndex].post.authorHandle;
  let start = targetIndex;
  let end = targetIndex;

  while (start > 0 && sameHandle(tweets[start - 1].post.authorHandle, threadHandle)) {
    start -= 1;
  }

  while (end + 1 < tweets.length && sameHandle(tweets[end + 1].post.authorHandle, threadHandle)) {
    end += 1;
  }

  return tweets.slice(start, end + 1).map((tweet) => tweet.post);
}

function findTargetTweetIndex(tweets: ParsedTweet[], targetHandle?: string, targetStatusId?: string): number {
  if (targetStatusId) {
    const statusIndex = tweets.findIndex((tweet) => tweet.post.id === targetStatusId);
    if (statusIndex >= 0) return statusIndex;
  }

  if (targetHandle) {
    const handleIndex = tweets.findIndex((tweet) => sameHandle(tweet.post.authorHandle, targetHandle));
    if (handleIndex >= 0) return handleIndex;
  }

  return 0;
}

function shouldTryArticleExtraction(parsedTweets: ParsedTweet[]): boolean {
  return isLikelyArticlePage() || (isStatusPageWithMissingTweetText(parsedTweets) && hasArticleContentSignal());
}

function extractArticle(
  sourceUrl: string,
  parsedTweets: ParsedTweet[],
  shouldTryArticle = shouldTryArticleExtraction(parsedTweets)
): ExtractedThread | undefined {
  if (!shouldTryArticle) return undefined;

  const root = findArticleRoot();
  if (!root) return undefined;

  const title = findArticleTitle(root);
  const text = findArticleText(root, title);
  if (!looksLikeArticleText(text, parsedTweets)) return undefined;

  const authorHandle = findAuthorHandle(root) || findAuthorHandle(document.body) || getHandleFromUrl(window.location.href) || "";
  const authorName = findAuthorName(root) || findAuthorName(document.body) || authorHandle;
  const published = root.querySelector("time")?.getAttribute("datetime") || undefined;

  return {
    sourceUrl,
    authorHandle,
    authorName,
    title: title || titleFromText(text),
    posts: [
      {
        id: sourceUrl,
        url: sourceUrl,
        authorHandle,
        authorName,
        text,
        published,
        images: isLongformArticle(root) || isBroadArticleRoot(root) ? [] : findImages(root)
      }
    ],
    capturedAt: new Date().toISOString(),
    isThread: false,
    sourceType: "article"
  };
}

function buildEmptyArticleResult(sourceUrl: string, targetHandle?: string): ExtractedThread {
  const authorHandle = targetHandle || getHandleFromUrl(sourceUrl) || "";
  const title = titleFromDocument() || "X article";

  return {
    sourceUrl,
    authorHandle,
    authorName: authorHandle,
    title,
    posts: [
      {
        id: sourceUrl,
        url: sourceUrl,
        authorHandle,
        authorName: authorHandle,
        text: "",
        images: []
      }
    ],
    capturedAt: new Date().toISOString(),
    isThread: false,
    sourceType: "article"
  };
}

function isLikelyArticlePage(): boolean {
  const path = window.location.pathname;
  if (/^\/i\/article\/\d+/.test(path)) return true;
  if (/\/articles?\//.test(path)) return true;
  return Boolean(
    document.querySelector(
      [
        '[data-testid="article"]',
        '[data-testid="twitter-article-title"]',
        '[class*="longform-"]',
        '[data-testid="tweetText"] [data-testid="article"]'
      ].join(",")
    )
  );
}

function hasArticleContentSignal(): boolean {
  if (
    document.querySelector(
      [
        '[data-testid="article"]',
        '[data-testid="articleText"]',
        '[data-testid="articleBody"]',
        '[data-testid="twitter-article-title"]',
        '[class*="longform-"]'
      ].join(",")
    )
  ) {
    return true;
  }

  const main = document.querySelector<HTMLElement>('main[role="main"]');
  const headingText = normalizeText(main?.querySelector<HTMLElement>("h1, h2, [role='heading']")?.innerText || "");
  if (headingText.length > 40) return true;

  return titleFromDocument().length > 80;
}

function isStatusPageWithMissingTweetText(parsedTweets: ParsedTweet[]): boolean {
  if (!getStatusIdFromUrl(window.location.href)) return false;
  const targetHandle = getHandleFromUrl(window.location.href);
  const targetStatusId = getStatusIdFromUrl(window.location.href);
  const targetTweet = parsedTweets.find((tweet) => {
    if (targetStatusId && tweet.post.id === targetStatusId) return true;
    return targetHandle ? sameHandle(tweet.post.authorHandle, targetHandle) : false;
  });

  return !targetTweet || targetTweet.post.text.length < 120;
}

function findArticleRoot(): HTMLElement | undefined {
  const main = document.querySelector<HTMLElement>('main[role="main"]');
  const explicit = document.querySelector<HTMLElement>('[data-testid="article"]');
  if (explicit && normalizeText(explicit.innerText).length > 100) return explicit;

  const articleSignal = document.querySelector<HTMLElement>(
    [
      '[data-testid="twitter-article-title"]',
      '[data-testid="articleText"]',
      '[data-testid="articleBody"]',
      '[class*="longform-"]'
    ].join(",")
  );
  const scopedRoot = articleSignal ? findSpecificArticleRootFromSignal(articleSignal, main) : undefined;
  if (scopedRoot) return scopedRoot;

  const candidates = Array.from((main || document.body).querySelectorAll<HTMLElement>("article, section, div"))
    .filter((element) => {
      const text = normalizeText(element.innerText);
      return text.length > 500 && element.querySelector("h1, h2, [role='heading']");
    })
    .sort((a, b) => normalizeText(b.innerText).length - normalizeText(a.innerText).length);

  return candidates[0] || main || document.body;
}

function findSpecificArticleRootFromSignal(signal: HTMLElement, main?: HTMLElement | null): HTMLElement | undefined {
  let current: HTMLElement | null = signal;
  let best: HTMLElement | undefined;

  while (current && current !== main && current !== document.body) {
    const textLength = normalizeText(current.innerText).length;
    const hasArticleTitle = Boolean(current.querySelector('[data-testid="twitter-article-title"]'));
    const hasArticleBody = Boolean(current.querySelector('[data-testid="articleText"], [data-testid="articleBody"]'));
    const longformBlocks = Array.from(current.querySelectorAll<HTMLElement>('[class*="longform-"]'))
      .filter((element) => getLongformType(element));

    if (textLength > 300 && (hasArticleTitle || hasArticleBody || longformBlocks.length >= 2)) {
      best = current;
    }

    current = current.parentElement;
  }

  return best;
}

function findArticleTitle(root: HTMLElement): string {
  const articleTitle = document.querySelector<HTMLElement>('[data-testid="twitter-article-title"]');
  const articleTitleText = normalizeText(articleTitle?.innerText || "");
  if (articleTitleText) return articleTitleText;

  const documentTitle = titleFromDocument();
  if (documentTitle && !isArticleUiLine(documentTitle) && documentTitle.length > 20) return documentTitle;

  const heading = root.querySelector<HTMLElement>("h1, h2, [role='heading']");
  const text = normalizeText(heading?.innerText || "");
  if (text && text.length < 220 && !isArticleUiLine(text)) return text;

  return documentTitle;
}

function findArticleText(root: HTMLElement, title: string): string {
  const orderedLongform = extractOrderedLongformMarkdown(root, title);
  if (orderedLongform.length > 300) return orderedLongform;

  const broadRoot = isBroadArticleRoot(root);
  const candidates: string[] = [];
  const articleSelectors = broadRoot
    ? ['[data-testid="articleText"]', '[data-testid="articleBody"]', '[data-testid="noteTweetText"]']
    : ['[data-testid="articleText"]', '[data-testid="articleBody"]', '[data-testid="noteTweetText"]', '[data-testid="tweetText"]', '[lang]'];
  const articleBlocks = Array.from(
    root.querySelectorAll<HTMLElement>(articleSelectors.join(","))
  )
    .map((element) => normalizeText(element.innerText))
    .filter((line) => isUsefulArticleLine(line, title));

  candidates.push(dedupeLines(articleBlocks).join("\n\n"));

  const paragraphs = Array.from(root.querySelectorAll<HTMLElement>("p, h2, h3, li, blockquote"))
    .map((element) => normalizeText(element.innerText))
    .filter((line) => isUsefulArticleLine(line, title));

  candidates.push(dedupeLines(paragraphs).join("\n\n"));

  const fallbackLines = broadRoot ? [] : normalizeText(root.innerText)
    .split("\n")
    .map((line) => normalizeText(line))
    .filter(Boolean);

  candidates.push(trimArticleLines(dedupeLines(fallbackLines), title).join("\n\n"));

  return candidates
    .map((candidate) => cleanArticleText(candidate, title))
    .sort((a, b) => b.length - a.length)[0] || "";
}

function isBroadArticleRoot(root: HTMLElement): boolean {
  return root.matches("main[role='main'], body");
}

function isLongformArticle(root: HTMLElement): boolean {
  return Boolean(root.querySelector('[data-testid="twitter-article-title"], [class*="longform-"]'));
}

function extractOrderedLongformMarkdown(root: HTMLElement, title: string): string {
  const codeBoxes = findCodeBoxElements(root);
  const embeddedTweets = findEmbeddedTweetElements(root);
  const textBlocks = Array.from(root.querySelectorAll<HTMLElement>('[class*="longform-"]'))
    .filter((element) => isLongformTextBlock(element))
    .filter((element) => !embeddedTweets.some((tweet) => tweet.contains(element)))
    .filter((element) => !codeBoxes.some((box) => box !== element && box.contains(element)));
  const images = Array.from(root.querySelectorAll<HTMLImageElement>('img[src*="pbs.twimg.com/media/"]'))
    .filter((image) => !embeddedTweets.some((tweet) => tweet.contains(image)))
    .filter((image) => !codeBoxes.some((box) => box.contains(image)));
  const nodes = [...textBlocks, ...codeBoxes, ...embeddedTweets, ...images].sort((left, right) => {
      const position = left.compareDocumentPosition(right);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

  const parts: string[] = [];
  const seenTextBlocks = new Set<string>();
  const seenImages = new Set<string>();

  for (const node of nodes) {
    if (isEmbeddedTweetElement(node)) {
      const embeddedTweet = extractEmbeddedTweetMarkdown(node);
      if (!embeddedTweet) continue;

      const dedupeKey = `tweet:${embeddedTweet.sourceUrl || embeddedTweet.markdown}`;
      if (seenTextBlocks.has(dedupeKey)) continue;
      seenTextBlocks.add(dedupeKey);
      parts.push(embeddedTweet.markdown);
      continue;
    }

    if (node instanceof HTMLImageElement) {
      const imageMarkdown = imageMarkdownFromElement(node);
      if (!imageMarkdown || seenImages.has(imageMarkdown)) continue;
      seenImages.add(imageMarkdown);
      parts.push(imageMarkdown);
      continue;
    }

    if (isCodeBoxElement(node)) {
      const codeText = extractCodeBoxText(node);
      if (!codeText) continue;

      const dedupeKey = `code:${normalizeText(codeText)}`;
      if (seenTextBlocks.has(dedupeKey)) continue;
      seenTextBlocks.add(dedupeKey);
      parts.push(formatCodeBoxMarkdown(codeText));
      continue;
    }

    const offsetKey = node.getAttribute("data-offset-key");
    const rawText = extractLongformText(node);
    const normalizedText = normalizeText(rawText);
    if (!normalizedText || !isUsefulArticleLine(normalizedText, title)) continue;

    const dedupeKey = offsetKey || `${getLongformType(node)}:${normalizedText}`;
    if (seenTextBlocks.has(dedupeKey)) continue;
    seenTextBlocks.add(dedupeKey);

    parts.push(formatLongformBlock(node, normalizedText));
  }

  return parts.filter(Boolean).join("\n\n");
}

function findEmbeddedTweetElements(root: HTMLElement): HTMLElement[] {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>('[data-testid="tweetText"], [data-testid="User-Name"]'))
    .map((signal) => findEmbeddedTweetCardBoundary(signal, root))
    .filter((candidate): candidate is HTMLElement => Boolean(candidate));
  const uniqueCandidates = uniqueElements(candidates);

  return uniqueCandidates.filter((candidate) => {
    return !uniqueCandidates.some((other) => other !== candidate && other.contains(candidate));
  });
}

function findEmbeddedTweetCardBoundary(signal: HTMLElement, root: HTMLElement): HTMLElement | undefined {
  let current: HTMLElement | null = signal;

  while (current && current !== root && current !== document.body) {
    if (isEmbeddedTweetCardBoundary(current, root)) return current;
    current = current.parentElement;
  }

  return undefined;
}

function isEmbeddedTweetCardBoundary(element: HTMLElement, root: HTMLElement): boolean {
  if (element === root) return false;
  if (element.matches("main, body")) return false;
  if (element.querySelector('[data-testid="twitter-article-title"]')) return false;
  if (containsArticleLongformText(element)) return false;

  const sourceUrl = findStatusUrl(element);
  if (!sourceUrl) return false;

  const hasTweetText = Boolean(element.querySelector('[data-testid="tweetText"]'));
  const hasUserName = Boolean(element.querySelector('[data-testid="User-Name"]'));
  if (!hasTweetText && !hasUserName) return false;

  const text = extractEmbeddedTweetText(element, { includeNested: true });
  if (!text || text.length < 12) return false;
  if (text.length > 2200) return false;

  return true;
}

function containsArticleLongformText(element: HTMLElement): boolean {
  return Array.from(element.querySelectorAll<HTMLElement>('[class*="longform-"]'))
    .some((child) => isLongformTextBlock(child));
}

function uniqueElements(elements: HTMLElement[]): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  return elements.filter((element) => {
    if (seen.has(element)) return false;
    seen.add(element);
    return true;
  });
}

function findCodeBoxElements(root: HTMLElement): HTMLElement[] {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>("pre, code, div, section, figure"))
    .filter(isCodeBoxElement);

  return candidates.filter((candidate) => {
    return !candidates.some((other) => other !== candidate && candidate.contains(other));
  });
}

function getLongformType(element: Element): string | undefined {
  return Array.from(element.classList).find((className) => {
    return [
      "longform-unstyled",
      "longform-header-one",
      "longform-header-two",
      "longform-blockquote",
      "longform-unordered-list-item",
      "longform-ordered-list-item",
      "longform-code-block"
    ].some((type) => className.startsWith(type));
  });
}

function isLongformTextBlock(element: HTMLElement): boolean {
  if (!getLongformType(element)) return false;

  const nestedBlocks = Array.from(element.querySelectorAll<HTMLElement>('[class*="longform-"]'))
    .filter((child) => child !== element && getLongformType(child));
  if (nestedBlocks.length) return false;

  const text = normalizeText(extractLongformText(element));
  return Boolean(text);
}

function extractLongformText(element: HTMLElement): string {
  const textSpans = Array.from(element.querySelectorAll<HTMLElement>('span[data-text="true"]'));
  if (textSpans.length) return textSpans.map((span) => span.textContent || "").join("");
  return element.innerText;
}

function formatLongformBlock(element: HTMLElement, text: string): string {
  const type = getLongformType(element) || "";

  if (type.includes("header-one")) return `## ${text}`;
  if (type.includes("header-two")) return `## ${text}`;
  if (type.includes("blockquote")) return text.split("\n").map((line) => `> ${line}`).join("\n");
  if (type.includes("unordered-list-item")) return `- ${text}`;
  if (type.includes("ordered-list-item")) return `1. ${text}`;
  if (type.includes("code")) return extractCodeBoxText(element) || text;

  return text;
}

function isEmbeddedTweetElement(element: HTMLElement): boolean {
  return isEmbeddedTweetCardBoundary(element, document.body);
}

function extractEmbeddedTweetMarkdown(element: HTMLElement): { markdown: string; sourceUrl: string } | undefined {
  const sourceUrl = findStatusUrl(element) || "";
  const statusParts = sourceUrl ? parseStatusUrl(sourceUrl) : undefined;
  const authorHandle = statusParts?.handle || findAuthorHandle(element) || "";
  const authorName = findAuthorName(element) || authorHandle;
  const text = extractEmbeddedTweetText(element, { includeNested: false });
  const nestedTweetElements = findNestedEmbeddedTweetElements(element);
  const images = Array.from(element.querySelectorAll<HTMLImageElement>('img[src*="pbs.twimg.com/media/"]'))
    .filter((image) => !nestedTweetElements.some((tweet) => tweet.contains(image)))
    .map((image) => imageMarkdownFromElement(image))
    .filter(Boolean)
    .map((imageMarkdown) => `> ${imageMarkdown}`)
    .join("\n>\n");
  const nestedTweets = nestedTweetElements
    .map((tweet) => extractEmbeddedTweetMarkdown(tweet))
    .filter((tweet): tweet is { markdown: string; sourceUrl: string } => Boolean(tweet));

  if (!sourceUrl || (!text && !images && !nestedTweets.length)) return undefined;

  const header = authorHandle
    ? `> **${formatHandleWikilink(authorHandle)}${authorName && authorName !== authorHandle ? ` (${authorName})` : ""}**`
    : "> **Embedded X post**";
  const quotedText = text
    .split("\n")
    .filter(Boolean)
    .map((line) => `> ${line}`)
    .join("\n");
  const nestedMarkdown = nestedTweets
    .map((tweet) => quoteNestedEmbeddedTweet(tweet.markdown))
    .join("\n>\n");

  return {
    sourceUrl,
    markdown: [
      header,
      ">",
      quotedText,
      images ? ">" : "",
      images,
      nestedMarkdown ? ">" : "",
      nestedMarkdown ? "> Referenced post:" : "",
      nestedMarkdown,
      ">",
      `> [Source](${sourceUrl})`
    ].filter(Boolean).join("\n")
  };
}

function findNestedEmbeddedTweetElements(element: HTMLElement): HTMLElement[] {
  return findEmbeddedTweetElements(element);
}

function quoteNestedEmbeddedTweet(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function extractEmbeddedTweetText(element: HTMLElement, options: { includeNested: boolean }): string {
  const nestedTweets = options.includeNested ? [] : findNestedEmbeddedTweetElements(element);
  const tweetText = Array.from(element.querySelectorAll<HTMLElement>('[data-testid="tweetText"]'))
    .find((candidate) => !nestedTweets.some((tweet) => tweet.contains(candidate)));
  if (tweetText) return normalizeText(tweetText.innerText);
  if (!options.includeNested && nestedTweets.length) return "";

  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(
    [
      "button",
      "[role='button']",
      "svg",
      "img",
      "time",
      "[data-testid='User-Name']",
      "[aria-label]"
    ].join(",")
  ).forEach((node) => node.remove());

  const lines = normalizeText(clone.innerText || clone.textContent || "")
    .split("\n")
    .map((line) => normalizeText(line))
    .filter((line) => line && !isArticleUiLine(line));

  return dedupeLines(lines).join("\n");
}

function formatHandleWikilink(handle: string): string {
  const cleaned = handle.replace(/\[\[|\]\]/g, "");
  const normalized = cleaned.startsWith("@") ? cleaned : `@${cleaned}`;
  return `[[${normalized}]]`;
}

function isCodeBoxElement(element: HTMLElement): boolean {
  if (element instanceof HTMLImageElement) return false;

  const tagName = element.tagName.toLowerCase();
  const text = extractCodeBoxText(element);
  if (!text || text.length < 20) return false;
  if (text.length > 2500) return false;
  if (element.querySelector('[data-testid="twitter-article-title"]')) return false;

  if (tagName === "pre" || tagName === "code") return true;
  if (getLongformType(element)?.includes("code")) return true;
  if (element.matches('[data-testid*="code" i]')) return true;

  const nestedLongformBlocks = Array.from(element.querySelectorAll<HTMLElement>('[class*="longform-"]'))
    .filter((child) => getLongformType(child));
  if (nestedLongformBlocks.length > 1) return false;

  const lines = text.split("\n").filter((line) => line.trim());
  if (lines.length < 3) return false;

  const hasCopyControl = Array.from(element.querySelectorAll<HTMLElement>("button, [role='button'], svg, [aria-label]"))
    .some((control) => /copy|kopier/i.test(control.getAttribute("aria-label") || control.innerText || ""));
  const fontFamily = window.getComputedStyle(element).fontFamily.toLowerCase();
  const looksMonospace = /mono|consolas|courier|menlo|monaco/.test(fontFamily);
  const looksDiagramOrCommand = /(^|\n)\s*(bash|json|markdown|#|\{|\}|[A-Za-z0-9_./-]+\s*(->|→|↓|\+)|claude\s|npm\s|git\s|dev\s)/.test(text);

  return (hasCopyControl || looksMonospace) && looksDiagramOrCommand;
}

function extractCodeBoxText(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("button, [role='button'], svg").forEach((node) => node.remove());

  const lines = (clone.innerText || clone.textContent || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .filter((line) => !isCodeBoxUiLine(line.trim()));

  return trimBlankLines(lines).join("\n");
}

function trimBlankLines(lines: string[]): string[] {
  const trimmed = [...lines];
  while (trimmed.length && !trimmed[0].trim()) trimmed.shift();
  while (trimmed.length && !trimmed[trimmed.length - 1].trim()) trimmed.pop();
  return trimmed;
}

function isCodeBoxUiLine(line: string): boolean {
  return /^(copy|kopier|copied|kopiert)$/i.test(line);
}

function formatCodeBoxMarkdown(text: string): string {
  return `\`\`\`text\n${text}\n\`\`\``;
}

function imageMarkdownFromElement(image: HTMLImageElement): string {
  const src = normalizeImageUrl(image.src);
  if (!src || !src.includes("pbs.twimg.com/media/")) return "";
  return `![](${src})`;
}

function parseTweetArticle(article: HTMLElement): ThreadPost | null {
  const statusUrl = findStatusUrl(article, getStatusIdFromUrl(window.location.href));
  const statusParts = statusUrl ? parseStatusUrl(statusUrl) : undefined;
  const authorHandle = statusParts?.handle || findAuthorHandle(article);
  const embeddedTweets = findEmbeddedTweetElementsInTweetArticle(article, statusUrl);
  const text = findTweetText(article, embeddedTweets);

  if (!authorHandle || !text) return null;

  return {
    id: statusParts?.id || `${authorHandle}-${text.slice(0, 30)}`,
    url: statusUrl || window.location.href,
    authorHandle,
    authorName: findAuthorName(article) || authorHandle,
    text,
    markdown: findTweetMarkdown(article, embeddedTweets),
    published: article.querySelector("time")?.getAttribute("datetime") || undefined,
    images: []
  };
}

function findStatusUrl(article: HTMLElement, preferredStatusId?: string): string | undefined {
  const anchors = Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]'));
  const hrefs = anchors
    .map((anchor) => anchor.href)
    .filter((candidate) => /\/[^/]+\/status\/\d+/.test(new URL(candidate, window.location.origin).pathname));
  const href = preferredStatusId
    ? hrefs.find((candidate) => parseStatusUrl(candidate)?.id === preferredStatusId) || hrefs[0]
    : hrefs[0];

  return href ? normalizeXUrl(href) : undefined;
}

function parseStatusUrl(url: string): { handle: string; id: string } | undefined {
  const parsed = new URL(url, window.location.origin);
  const match = parsed.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
  if (!match) return undefined;
  return { handle: `@${match[1]}`, id: match[2] };
}

function findAuthorHandle(article: HTMLElement): string | undefined {
  const candidates = Array.from(article.querySelectorAll<HTMLAnchorElement>("a[href]"))
    .map((anchor) => anchor.getAttribute("href") || "")
    .map((href) => href.match(/^\/([A-Za-z0-9_]{1,15})$/)?.[1])
    .filter(Boolean);

  return candidates[0] ? `@${candidates[0]}` : undefined;
}

function findAuthorName(article: HTMLElement): string | undefined {
  const userNameBlock = article.querySelector<HTMLElement>('[data-testid="User-Name"]');
  const firstLine = userNameBlock?.innerText.split("\n").map((line) => line.trim()).find(Boolean);
  return firstLine;
}

function findEmbeddedTweetElementsInTweetArticle(article: HTMLElement, articleStatusUrl?: string): HTMLElement[] {
  const articleStatusId = articleStatusUrl ? parseStatusUrl(articleStatusUrl)?.id : undefined;
  const candidates = Array.from(article.querySelectorAll<HTMLElement>('[data-testid="tweetText"], [data-testid="User-Name"]'))
    .map((signal) => findEmbeddedTweetCardBoundary(signal, article))
    .filter((candidate): candidate is HTMLElement => Boolean(candidate))
    .filter((candidate) => {
      const candidateStatusUrl = findStatusUrl(candidate);
      const candidateStatusId = candidateStatusUrl ? parseStatusUrl(candidateStatusUrl)?.id : undefined;
      return Boolean(candidateStatusId && candidateStatusId !== articleStatusId);
    });
  const uniqueCandidates = uniqueElements(candidates);

  return uniqueCandidates.filter((candidate) => {
    return !uniqueCandidates.some((other) => other !== candidate && other.contains(candidate));
  });
}

function findTweetText(article: HTMLElement, embeddedTweets: HTMLElement[]): string {
  const textBlocks = Array.from(article.querySelectorAll<HTMLElement>('[data-testid="tweetText"]'))
    .filter((block) => !embeddedTweets.some((tweet) => tweet.contains(block)));
  return textBlocks.map((block) => block.innerText.trim()).filter(Boolean).join("\n\n");
}

function findTweetMarkdown(article: HTMLElement, embeddedTweets: HTMLElement[]): string {
  const textBlocks = Array.from(article.querySelectorAll<HTMLElement>('[data-testid="tweetText"]'))
    .filter((block) => !embeddedTweets.some((tweet) => tweet.contains(block)));
  const images = Array.from(article.querySelectorAll<HTMLImageElement>('img[src*="pbs.twimg.com/media/"]'))
    .filter((image) => !embeddedTweets.some((tweet) => tweet.contains(image)));
  const nodes = [...textBlocks, ...embeddedTweets, ...images].sort((left, right) => {
    const position = left.compareDocumentPosition(right);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });

  const parts: string[] = [];
  const seen = new Set<string>();

  for (const node of nodes) {
    if (isEmbeddedTweetElement(node)) {
      const embeddedTweet = extractEmbeddedTweetMarkdown(node);
      if (!embeddedTweet) continue;

      const key = `tweet:${embeddedTweet.sourceUrl || embeddedTweet.markdown}`;
      if (seen.has(key)) continue;
      seen.add(key);
      parts.push(embeddedTweet.markdown);
      continue;
    }

    if (node instanceof HTMLImageElement) {
      const imageMarkdown = imageMarkdownFromElement(node);
      if (!imageMarkdown || seen.has(imageMarkdown)) continue;
      seen.add(imageMarkdown);
      parts.push(imageMarkdown);
      continue;
    }

    const text = linkMentions(cleanTweetMarkdownText(node.innerText));
    if (!text) continue;

    const key = `text:${normalizeText(text)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(text);
  }

  return parts.filter(Boolean).join("\n\n");
}

function cleanTweetMarkdownText(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findImages(article: HTMLElement): ThreadImage[] {
  const urls = Array.from(article.querySelectorAll<HTMLImageElement>("img"))
    .map((image) => image.src)
    .filter((src) => src.includes("pbs.twimg.com/media/"))
    .map((src) => normalizeImageUrl(src))
    .filter(Boolean);

  return Array.from(new Set(urls)).map((url) => ({ url }));
}

function dedupeLines(lines: string[]): string[] {
  const seen = new Set<string>();
  return lines.filter((line) => {
    const key = line.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isArticleUiLine(line: string): boolean {
  if (/^\d+(\.\d+)?[KMB]?$/i.test(line)) return true;
  if (/^\d+(\.\d+)?[KMB]?\s+(Views|Likes|Reposts|Quotes|Bookmarks|Replies)$/i.test(line)) return true;
  if (/^(Views|Likes|Reposts|Quotes|Bookmarks|Replies)$/i.test(line)) return true;
  if (/^Replying to @/i.test(line)) return true;
  if (/^From\s+.+$/i.test(line)) return true;
  if (/^\d{1,2}:\d{2}\s+(AM|PM)\s+.+$/i.test(line)) return true;

  return [
    "Post",
    "Reply",
    "Repost",
    "Quote",
    "Like",
    "Likes",
    "Share",
    "Share this article",
    "Views",
    "Follow",
    "Following",
    "Subscribe",
    "Read more",
    "Show more",
    "Translate post",
    "Relevant people",
    "What is happening",
    "Who to follow"
  ].includes(line);
}

function normalizeImageUrl(src: string): string {
  if (!src.includes("pbs.twimg.com/media/")) return "";
  try {
    const url = new URL(src);
    url.searchParams.set("name", "large");
    return url.toString();
  } catch {
    return src.replace(/&name=\w+/, "&name=large");
  }
}

function normalizeText(text: string): string {
  return text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function titleFromDocument(): string {
  const quoted = document.title.match(/[«"](.{20,220})[»"]/);
  if (quoted?.[1]) return normalizeText(quoted[1]);

  return normalizeText(
    document.title
      .replace(/^\(\d+\)\s*/, "")
      .replace(/\s*\/\s*X$/, "")
      .replace(/\s*on X:.*$/, "")
      .replace(/\s+på X:\s*/, ": ")
      .trim()
  );
}

function isUsefulArticleLine(line: string, title: string): boolean {
  if (!line) return false;
  if (line === title) return false;
  if (normalizeTitleForCompare(line) === normalizeTitleForCompare(title)) return false;
  if (isArticleUiLine(line)) return false;
  if (line.length <= 2) return false;
  return true;
}

function trimArticleLines(lines: string[], title: string): string[] {
  const titleIndex = lines.findIndex((line) => normalizeTitleForCompare(line) === normalizeTitleForCompare(title));
  const contentLines = titleIndex >= 0 ? lines.slice(titleIndex + 1) : lines;
  const trimmed: string[] = [];

  for (const line of contentLines) {
    const accumulatedLength = trimmed.join(" ").length;
    if (accumulatedLength > 300 && isArticleUiLine(line)) break;
    if (accumulatedLength > 300 && /^@?[A-Za-z0-9_]{1,15}$/.test(line)) break;
    trimmed.push(line);
  }

  return trimmed.filter((line) => isUsefulArticleLine(line, title));
}

function cleanArticleText(text: string, title: string): string {
  const lines = text
    .split("\n")
    .map((line) => normalizeText(line))
    .filter(Boolean);

  return trimArticleLines(dedupeLines(lines), title).join("\n\n");
}

function looksLikeArticleText(text: string, parsedTweets: ParsedTweet[]): boolean {
  const normalized = normalizeText(text);
  if (normalized.length < 300) return false;

  const longestTweet = Math.max(0, ...parsedTweets.map((tweet) => tweet.post.text.length));
  return normalized.length > longestTweet + 120;
}

function normalizeTitleForCompare(text: string): string {
  return normalizeText(text)
    .replace(/[.!?]+$/, "")
    .toLowerCase();
}

function dedupePosts(posts: ThreadPost[]): ThreadPost[] {
  const seen = new Set<string>();
  return posts.filter((post) => {
    const key = post.id || post.url || post.text;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getHandleFromUrl(url: string): string | undefined {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/([^/]+)\/status\/\d+/);
  return match ? `@${match[1]}` : undefined;
}

function getStatusIdFromUrl(url: string): string | undefined {
  const parsed = new URL(url);
  return parsed.pathname.match(/^\/[^/]+\/status\/(\d+)/)?.[1];
}

function sameHandle(left: string, right: string): boolean {
  return normalizeHandle(left) === normalizeHandle(right);
}

function normalizeHandle(handle: string): string {
  return handle.replace(/^@/, "").toLowerCase();
}

function normalizeXUrl(url: string): string {
  const parsed = new URL(url, window.location.origin);
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}
