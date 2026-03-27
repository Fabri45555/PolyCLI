"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CLI_CHUNK_WORD_THRESHOLD = void 0;
exports.getDelta = getDelta;
exports.mergeTranslations = mergeTranslations;
exports.countWords = countWords;
exports.chunkDelta = chunkDelta;
/**
 * Compare source JSON with the lockfile JSON and return only new/modified keys.
 */
function getDelta(currentSource, lockfileSource = {}) {
    const delta = {};
    for (const key in currentSource) {
        if (typeof currentSource[key] === 'object' && currentSource[key] !== null) {
            if (!lockfileSource[key] || typeof lockfileSource[key] !== 'object') {
                delta[key] = currentSource[key]; // Entire tree is new or changed
            }
            else {
                const nestedDelta = getDelta(currentSource[key], lockfileSource[key]);
                if (Object.keys(nestedDelta).length > 0) {
                    delta[key] = nestedDelta;
                }
            }
        }
        else {
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
function mergeTranslations(existingTarget, translatedDelta) {
    const merged = { ...existingTarget };
    for (const key in translatedDelta) {
        if (typeof translatedDelta[key] === 'object' && translatedDelta[key] !== null) {
            merged[key] = mergeTranslations(existingTarget[key] || {}, translatedDelta[key]);
        }
        else {
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
function countWords(item) {
    if (typeof item === 'string') {
        return (item.match(/\b\w+\b/g) || []).length;
    }
    if (typeof item === 'object' && item !== null) {
        return Object.keys(item).reduce((acc, key) => {
            return acc + countWords(item[key]);
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
exports.CLI_CHUNK_WORD_THRESHOLD = 1200;
function chunkDelta(delta, threshold = exports.CLI_CHUNK_WORD_THRESHOLD) {
    const entries = Object.entries(delta);
    if (entries.length === 0)
        return [{}];
    const chunks = [];
    let current = {};
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
    if (Object.keys(current).length > 0)
        chunks.push(current);
    return chunks;
}
