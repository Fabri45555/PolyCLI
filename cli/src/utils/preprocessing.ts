import { JsonObject } from './delta';

export interface PreprocessingResult {
  processedJson: JsonObject;
  mapping: Record<string, string>; // e.g. { "[VAR0]": "{{user_name}}" }
}

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
const VAR_REGEX =
  /(\{\{.+?\}\}|\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}|<\/?\s*[a-zA-Z][^<>]*\/?>|%%.+?%%)/g;

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

export function preprocessPhpVars(json: JsonObject): PreprocessingResult {
  const mapping: Record<string, string> = {};
  let varCounter = 0;

  function processNode(node: unknown): unknown {
    if (typeof node === 'string') {
      PHP_VAR_REGEX.lastIndex = 0;
      return node.replace(PHP_VAR_REGEX, (match) => {
        const token = `[PHPV${varCounter++}]`;
        mapping[token] = match;
        return token;
      });
    }
    if (Array.isArray(node)) return node.map(processNode);
    if (typeof node === 'object' && node !== null) {
      return Object.fromEntries(
        Object.keys(node as JsonObject).map((key) => [key, processNode((node as JsonObject)[key])])
      );
    }
    return node;
  }

  return { processedJson: processNode(json) as JsonObject, mapping };
}

export function preprocessJson(json: JsonObject): PreprocessingResult {
  const mapping: Record<string, string> = {};
  let varCounter = 0;

  function processNode(node: unknown): unknown {
    if (typeof node === 'string') {
      // Reset lastIndex between calls (global regex is stateful)
      VAR_REGEX.lastIndex = 0;
      return node.replace(VAR_REGEX, (match) => {
        const token = `[VAR${varCounter++}]`;
        mapping[token] = match;
        return token;
      });
    }
    if (Array.isArray(node)) return node.map(processNode);
    if (typeof node === 'object' && node !== null) {
      return Object.fromEntries(
        Object.keys(node as JsonObject).map((key) => [key, processNode((node as JsonObject)[key])])
      );
    }
    return node;
  }

  return { processedJson: processNode(json) as JsonObject, mapping };
}

export function postprocessJson(json: JsonObject, mapping: Record<string, string>): JsonObject {
  function processNode(node: unknown): unknown {
    if (typeof node === 'string') {
      return Object.entries(mapping).reduce((str, [token, original]) => {
        // Escape regex special chars in the token (brackets)
        const escaped = token.replace(/[[\]]/g, '\\$&');
        return str.replace(new RegExp(escaped, 'g'), original);
      }, node);
    }
    if (Array.isArray(node)) return node.map(processNode);
    if (typeof node === 'object' && node !== null) {
      return Object.fromEntries(
        Object.keys(node as JsonObject).map((key) => [key, processNode((node as JsonObject)[key])])
      );
    }
    return node;
  }

  return processNode(json) as JsonObject;
}
