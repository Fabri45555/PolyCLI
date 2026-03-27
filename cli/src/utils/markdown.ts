import crypto from 'crypto';
import path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MarkdownBlock {
  /** Raw block content (lines joined with '\n', no surrounding blank lines). */
  content: string;
  /** Whether this block should be sent for translation. */
  isTranslatable: boolean;
  /**
   * SHA-256 (first 16 hex chars) of trimmed content.
   * Acts as a content-addressable key for delta and caching.
   * Same text always produces the same hash → zero re-translation on unchanged blocks.
   */
  hash: string;
}

/**
 * A sentence-level unit within a translatable block.
 * Blocks are split into sentences so that only changed sentences are re-translated,
 * saving credits when a paragraph is partially modified.
 */
export interface MarkdownSentence {
  /** Trimmed sentence text (the unit sent for translation). */
  content: string;
  /** SHA-256 (first 16 hex chars) of content — cache key. */
  hash: string;
  /**
   * Whitespace/separator that follows this sentence in the original text.
   * Used to reconstruct the block with correct spacing (e.g. " " between prose
   * sentences, "\n" between list items).
   */
  suffix: string;
}

/**
 * Represents a block that has at least one sentence not yet in the cache.
 * Used to build the minimal delta payload sent to the translation API.
 */
export interface BlockDeltaItem {
  block: MarkdownBlock;
  /** All sentences the block was split into. */
  sentences: MarkdownSentence[];
  /** Subset of sentences whose hash is absent from the cache. */
  uncachedSentences: MarkdownSentence[];
}

/**
 * Per-language, per-file translation cache.
 * { [targetLang]: { [filename]: { [sentenceOrBlockHash]: translatedText } } }
 *
 * Keys can be either block-level hashes (legacy / single-sentence blocks)
 * or sentence-level hashes (granular caching introduced in v2).
 */
export type MarkdownCache = {
  [targetLang: string]: {
    [filename: string]: {
      [hash: string]: string;
    };
  };
};

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function hashContent(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Block parser
// ---------------------------------------------------------------------------

const FENCE_START_RE = /^(`{3,}|~{3,})/;

/**
 * Parses a Markdown document into an ordered array of blocks.
 *
 * Preserved (isTranslatable = false):
 *   - YAML frontmatter (--- ... ---)
 *   - Fenced code blocks (``` or ~~~)
 *   - Blank line separators (content = '')
 *
 * Translatable (isTranslatable = true):
 *   - Headings, paragraphs, list items, blockquotes — anything else.
 *
 * Reconstruction: blocks.map(resolve).join('\n')
 * Blank separator blocks (content='') produce the double-newline between paragraphs.
 */
export function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = content.split('\n');

  let accumulated: string[] = [];
  let isPreserveMode = false;
  let inFrontmatter = false;
  let inCodeFence = false;
  let fenceChar = '';
  let fenceMinLen = 0;

  const flush = () => {
    if (accumulated.length === 0) return;
    const text = accumulated.join('\n');
    blocks.push({
      content: text,
      isTranslatable: !isPreserveMode && text.trim().length > 0,
      hash: hashContent(text.trim()),
    });
    accumulated = [];
    isPreserveMode = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // ── YAML frontmatter (only at the very start of the file) ────────────
    if (i === 0 && trimmed === '---') {
      inFrontmatter = true;
      isPreserveMode = true;
      accumulated.push(line);
      continue;
    }

    if (inFrontmatter) {
      accumulated.push(line);
      if (i > 0 && (trimmed === '---' || trimmed === '...')) {
        inFrontmatter = false;
        flush();
      }
      continue;
    }

    // ── Fenced code blocks ───────────────────────────────────────────────
    if (!inCodeFence) {
      const m = FENCE_START_RE.exec(trimmed);
      if (m) {
        flush();
        inCodeFence = true;
        fenceChar = m[1][0]; // '`' or '~'
        fenceMinLen = m[1].length;
        isPreserveMode = true;
        accumulated.push(line);
        continue;
      }
    }

    if (inCodeFence) {
      accumulated.push(line);
      if (trimmed[0] === fenceChar) {
        // Closing fence: all same char, at least fenceMinLen long, nothing else
        const rest = trimmed.replace(new RegExp(`^\\${fenceChar === '`' ? '`' : '~'}+`), '');
        const closingLen = trimmed.length - rest.length;
        if (rest.trim() === '' && closingLen >= fenceMinLen) {
          inCodeFence = false;
          flush();
        }
      }
      continue;
    }

    // ── Blank line separator ─────────────────────────────────────────────
    if (trimmed === '') {
      flush();
      // Store blank lines as preserve blocks with a position-unique hash.
      // When joining blocks with '\n', these produce the blank line between paragraphs.
      blocks.push({ content: '', isTranslatable: false, hash: `blank_${i}` });
      continue;
    }

    // ── Regular content (headings, paragraphs, lists, blockquotes) ───────
    accumulated.push(line);
  }

  flush();
  return blocks;
}

// ---------------------------------------------------------------------------
// Sentence splitter
// ---------------------------------------------------------------------------

/**
 * Splits a translatable block's content into sentence-level units.
 *
 * Strategy per block type:
 *  - Headings (# …)                 → single unit (already short)
 *  - List items / blockquotes        → one unit per non-empty line
 *  - Regular paragraphs              → split on sentence-ending punctuation
 *    (.!?) followed by whitespace + capital letter
 *
 * The `suffix` field carries the separator that should be inserted between
 * this sentence's translation and the next one when reconstructing the block
 * (e.g. " " for prose, "\n" for list lines).
 */
export function splitBlockIntoSentences(text: string): MarkdownSentence[] {
  const trimmed = text.trim();

  // Headings → single unit
  if (/^#{1,6}\s/.test(trimmed)) {
    return [{ content: trimmed, hash: hashContent(trimmed), suffix: '' }];
  }

  // List items and blockquotes → one unit per non-empty line
  if (/^([-*+]|\d+[.)]|>)[ \t]/.test(trimmed)) {
    const lines = text.split('\n');
    const result: MarkdownSentence[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.length > 0) {
        result.push({
          content: line,
          hash: hashContent(line),
          suffix: i < lines.length - 1 ? '\n' : '',
        });
      }
    }
    return result.length > 0 ? result : [{ content: trimmed, hash: hashContent(trimmed), suffix: '' }];
  }

  // Regular paragraphs → split on sentence boundaries
  // Pattern: a sentence-ending punctuation mark followed by whitespace and
  // the start of a new sentence (capital letter or unicode capital).
  const parts: MarkdownSentence[] = [];
  // Matches the punctuation + the inter-sentence whitespace (captured separately).
  // The lookahead ensures we only split before an actual new sentence, not at
  // abbreviations mid-sentence (which typically aren't followed by a capital).
  const re = /([.!?])(\s+)(?=[A-Z\u00C0-\u024F\u0400-\u04FF])/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    // Include the punctuation mark in the current sentence (match.index + 1)
    const sentenceEnd = match.index + match[1].length;
    const sentence = text.slice(lastIndex, sentenceEnd).trim();
    const suffix = match[2]; // the whitespace that separates sentences

    if (sentence.length > 0) {
      parts.push({ content: sentence, hash: hashContent(sentence), suffix });
    }

    lastIndex = sentenceEnd + suffix.length;
  }

  // Remainder — the last (or only) sentence
  const last = text.slice(lastIndex).trim();
  if (last.length > 0) {
    parts.push({ content: last, hash: hashContent(last), suffix: '' });
  }

  return parts.length > 0
    ? parts
    : [{ content: trimmed, hash: hashContent(trimmed), suffix: '' }];
}

// ---------------------------------------------------------------------------
// Delta (sentence-level)
// ---------------------------------------------------------------------------

/**
 * Returns the set of blocks that still have at least one untranslated sentence.
 *
 * For each translatable block:
 *  1. If the block-level hash is already cached (legacy or single-sentence),
 *     the block is considered fully translated → skip.
 *  2. Otherwise split the block into sentences and find those whose hash is
 *     absent from the cache.
 *  3. If all sentences are already cached, the block can be reconstructed
 *     without any new API call → skip.
 *
 * @param blocks  Parsed markdown blocks for the current source file.
 * @param cache   Flat hash→translation map for a single (language, filename) pair.
 */
export function getMarkdownDelta(
  blocks: MarkdownBlock[],
  cache: Record<string, string>
): BlockDeltaItem[] {
  const result: BlockDeltaItem[] = [];

  for (const block of blocks) {
    if (!block.isTranslatable) continue;

    // Block fully cached at block level (backward-compat / single-sentence blocks)
    if (block.hash in cache) continue;

    const sentences = splitBlockIntoSentences(block.content);
    const uncachedSentences = sentences.filter((s) => !(s.hash in cache));

    if (uncachedSentences.length > 0) {
      result.push({ block, sentences, uncachedSentences });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Reconstruction
// ---------------------------------------------------------------------------

/**
 * Rebuilds the full translated Markdown from the parsed blocks.
 *
 * Resolution order per translatable block:
 *  1. Block-level cache hit  → use it directly (backward compat).
 *  2. All sentences cached   → reconstruct by joining translated sentences
 *     with their original separators.
 *  3. Fallback               → return source content unchanged.
 *
 * Preserve blocks are returned verbatim.
 * Blocks are joined with '\n'. Blank separator blocks (content='') produce
 * the double newline between paragraphs:
 *   "paragraph A" + '\n' + '' + '\n' + "paragraph B" → "paragraph A\n\nparagraph B"
 */
export function reconstructMarkdown(
  blocks: MarkdownBlock[],
  cache: Record<string, string>
): string {
  return blocks
    .map((block) => {
      if (!block.isTranslatable) return block.content;

      // 1. Block-level cache (legacy entries or single-sentence headings)
      if (block.hash in cache) return cache[block.hash];

      // 2. Sentence-level reconstruction
      const sentences = splitBlockIntoSentences(block.content);
      const allCached = sentences.every((s) => s.hash in cache);
      if (allCached) {
        return sentences
          .map((s, i) => (cache[s.hash] ?? s.content) + (i < sentences.length - 1 ? s.suffix : ''))
          .join('');
      }

      // 3. Fallback: source text
      return block.content;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Rough word count estimate for CLI display (pre-server-preprocessing).
 * Counts only the words in sentences that still need to be translated,
 * so the estimate reflects actual credit usage rather than the full block size.
 * Actual billing uses the server-side count (post-preprocessing, VAR tokens excluded).
 */
export function estimateMarkdownWords(items: BlockDeltaItem[]): number {
  return items.reduce(
    (acc, item) =>
      acc +
      item.uncachedSentences.reduce(
        (sacc, s) => sacc + (s.content.match(/\b\w+\b/g) || []).length,
        0
      ),
    0
  );
}

/** Returns the cache file path for a given markdownPath root. */
export function getCachePath(markdownPath: string): string {
  return path.join(markdownPath, '.polycli-md-cache.json');
}
