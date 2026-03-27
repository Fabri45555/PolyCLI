export type JsonObject = { [key: string]: any };

/**
 * Compare source JSON with the lockfile JSON and return only new/modified keys.
 */
export function getDelta(currentSource: JsonObject, lockfileSource: JsonObject = {}): JsonObject {
  const delta: JsonObject = {};

  for (const key in currentSource) {
    if (typeof currentSource[key] === 'object' && currentSource[key] !== null) {
      if (!lockfileSource[key] || typeof lockfileSource[key] !== 'object') {
        delta[key] = currentSource[key]; // Entire tree is new or changed
      } else {
        const nestedDelta = getDelta(currentSource[key], lockfileSource[key]);
        if (Object.keys(nestedDelta).length > 0) {
          delta[key] = nestedDelta;
        }
      }
    } else {
      if (currentSource[key] !== lockfileSource[key]) {
        delta[key] = currentSource[key];
      }
    }
  }

  return delta;
}

/**
 * Merge the newly translated delta back into the existing target translations.
 */
export function mergeTranslations(existingTarget: JsonObject, translatedDelta: JsonObject): JsonObject {
  const merged = { ...existingTarget };

  for (const key in translatedDelta) {
    if (typeof translatedDelta[key] === 'object' && translatedDelta[key] !== null) {
      merged[key] = mergeTranslations(existingTarget[key] || {}, translatedDelta[key]);
    } else {
      merged[key] = translatedDelta[key];
    }
  }

  return merged;
}

/**
 * Estimates translatable word count for CLI display purposes.
 *
 * This runs on the raw delta BEFORE server-side preprocessing, so it may
 * slightly overcount strings containing interpolation tokens (e.g. {{name}}).
 * The authoritative count used for billing is computed server-side in
 * /api/translate after preprocessing, where VAR tokens are excluded.
 */
export function countWords(item: unknown): number {
  if (typeof item === 'string') {
    return (item.match(/\b\w+\b/g) || []).length;
  }
  if (typeof item === 'object' && item !== null) {
    return Object.keys(item as Record<string, unknown>).reduce((acc, key) => {
      return acc + countWords((item as Record<string, unknown>)[key]);
    }, 0);
  }
  return 0;
}

/**
 * Splits a delta object into chunks that each stay under `threshold` words.
 *
 * Operates on top-level keys only — nested objects are never split mid-tree.
 * This mirrors the server-side chunkDelta in translate-utils.ts but runs on
 * the CLI side so each HTTP request contains at most one OpenAI call worth of
 * content, preventing Vercel serverless timeout on large deltas.
 */
export const CLI_CHUNK_WORD_THRESHOLD = 1200;

export function chunkDelta(
  delta: JsonObject,
  threshold: number = CLI_CHUNK_WORD_THRESHOLD
): JsonObject[] {
  const entries = Object.entries(delta);
  if (entries.length === 0) return [{}];

  const chunks: JsonObject[] = [];
  let current: JsonObject = {};
  let currentWords = 0;

  for (const [key, value] of entries) {
    const entryWords = countWords(value);
    if (currentWords + entryWords > threshold && Object.keys(current).length > 0) {
      chunks.push(current);
      current = {};
      currentWords = 0;
    }
    current[key] = value;
    currentWords += entryWords;
  }

  if (Object.keys(current).length > 0) chunks.push(current);
  return chunks;
}
