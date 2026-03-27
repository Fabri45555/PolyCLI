"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.preprocessPhpVars = preprocessPhpVars;
exports.preprocessJson = preprocessJson;
exports.postprocessJson = postprocessJson;
/**
 * Regex that matches interpolation tokens and HTML/JSX tags that must NOT be translated.
 *
 * Group breakdown (ordered by specificity — most specific first):
 *
 * 1. \{\{.+?\}\}
 *    Double curlies: {{name}}, {{user.firstName}}
 *    Covers: Handlebars, Vue (v-bind), React i18next
 *
 * 2. \{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}
 *    Single curlies with optional ONE level of nesting.
 *    Covers: {name}, {count} AND ICU plural forms like
 *      {count, plural, one {item} other {items}}
 *    Note: deeper nesting (ICU select inside plural) is NOT supported —
 *    edge case that would require a full parser.
 *
 * 3. <\/?\s*[a-zA-Z][^<>]*\/?>
 *    HTML/JSX/XML tags — opening, closing, self-closing.
 *    Requires the first char after < to be a letter, which prevents
 *    matching plain text comparisons like "speed < 100ms".
 *    Covers: <br>, </p>, <Component />, <a href="url">
 *
 * 4. %%.+?%%
 *    Double-percent delimiters: %%variable%%
 */
const VAR_REGEX = /(\{\{.+?\}\}|\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}|<\/?\s*[a-zA-Z][^<>]*\/?>|%%.+?%%)/g;
/**
 * Matches Laravel/PHP colon-prefix variables: :name, :count, :attribute, etc.
 *
 * Lookbehind (?<![\w/:]) prevents matching:
 *   - "https://"  → colon after a word char ('s')
 *   - "::class"   → colon preceded by another colon
 *   - "attr:val"  → colon inside a word
 *
 * Requires the first char after ':' to be a letter or underscore so plain ':'
 * and numeric tokens like ':1' are never matched.
 *
 * Produces [PHPV0], [PHPV1], … tokens — a distinct namespace from the
 * server-side [VAR0] tokens — so there is no collision when both are present.
 */
const PHP_VAR_REGEX = /(?<![\w/:]):[a-zA-Z_]\w*/g;
function preprocessPhpVars(json) {
    const mapping = {};
    let varCounter = 0;
    function processNode(node) {
        if (typeof node === 'string') {
            PHP_VAR_REGEX.lastIndex = 0;
            return node.replace(PHP_VAR_REGEX, (match) => {
                const token = `[PHPV${varCounter++}]`;
                mapping[token] = match;
                return token;
            });
        }
        if (Array.isArray(node))
            return node.map(processNode);
        if (typeof node === 'object' && node !== null) {
            return Object.fromEntries(Object.keys(node).map((key) => [key, processNode(node[key])]));
        }
        return node;
    }
    return { processedJson: processNode(json), mapping };
}
function preprocessJson(json) {
    const mapping = {};
    let varCounter = 0;
    function processNode(node) {
        if (typeof node === 'string') {
            // Reset lastIndex between calls (global regex is stateful)
            VAR_REGEX.lastIndex = 0;
            return node.replace(VAR_REGEX, (match) => {
                const token = `[VAR${varCounter++}]`;
                mapping[token] = match;
                return token;
            });
        }
        if (Array.isArray(node))
            return node.map(processNode);
        if (typeof node === 'object' && node !== null) {
            return Object.fromEntries(Object.keys(node).map((key) => [key, processNode(node[key])]));
        }
        return node;
    }
    return { processedJson: processNode(json), mapping };
}
function postprocessJson(json, mapping) {
    function processNode(node) {
        if (typeof node === 'string') {
            return Object.entries(mapping).reduce((str, [token, original]) => {
                // Escape regex special chars in the token (brackets)
                const escaped = token.replace(/[[\]]/g, '\\$&');
                return str.replace(new RegExp(escaped, 'g'), original);
            }, node);
        }
        if (Array.isArray(node))
            return node.map(processNode);
        if (typeof node === 'object' && node !== null) {
            return Object.fromEntries(Object.keys(node).map((key) => [key, processNode(node[key])]));
        }
        return node;
    }
    return processNode(json);
}
