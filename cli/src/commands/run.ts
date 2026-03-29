import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import ora, { Ora } from 'ora';
import { getDelta, countWords, chunkDelta, mergeTranslations, JsonObject } from '../utils/delta';
import {
  parseMarkdownBlocks,
  getMarkdownDelta,
  reconstructMarkdown,
  estimateMarkdownWords,
  getCachePath,
  MarkdownCache,
} from '../utils/markdown';
import {
  parseArb,
  buildArbDelta,
  reconstructArb,
  extractDescriptions,
} from '../utils/arb';
import { preprocessPhpVars, postprocessJson } from '../utils/preprocessing';
import { reviewCommand } from './review';

const POLYCLI_API_URL = process.env.POLYCLI_API_URL || 'https://www.polycli.dev';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BuildTranslatorConfig {
  sourceLanguage: string;
  targetLanguages: string[];
  localesPath: string;
  markdownPath?: string;
  arbPath?: string;
  arbPrefix?: string;
  translateArbDescriptions?: boolean;
  tone?: string;
  aiReviewer?: boolean;
  phpVariables?: boolean;
  glossarySync?: boolean;
  teamId?: string;
  glossary?: {
    doNotTranslate?: string[];
    preferredTranslations?: Record<string, string | Record<string, string>>;
  };
}

interface TranslateResponse {
  translated: JsonObject;
  wordsUsed: number;
}

// ---------------------------------------------------------------------------
// Cloud glossary sync
// ---------------------------------------------------------------------------

interface CloudGlossaryTerm {
  source_term: string;
  target_term: string;
  language_from: string;
  language_to: string;
  context_notes: string | null;
}

async function fetchCloudGlossary(
  apiKey: string,
  teamId: string,
  sourceLanguage: string,
): Promise<CloudGlossaryTerm[]> {
  const res = await fetch(
    `${POLYCLI_API_URL}/api/glossary?teamId=${encodeURIComponent(teamId)}&languageFrom=${encodeURIComponent(sourceLanguage)}`,
    {
      method: 'GET',
      headers: { 'x-api-key': apiKey },
    }
  );

  if (!res.ok) {
    let errorMsg = `Glossary sync failed: ${res.status}`;
    try {
      const data = await res.json() as { error?: string };
      if (data.error) errorMsg = data.error;
    } catch { /* not JSON */ }
    throw new Error(errorMsg);
  }

  const data = await res.json() as { terms: CloudGlossaryTerm[] };
  return data.terms ?? [];
}

/**
 * Merge cloud glossary terms into the local glossary config.
 * Cloud terms are additive: they extend local glossary.
 *
 * Convention:
 * - language_to = '*' + source === target  → doNotTranslate (keep term as-is in all langs)
 * - language_to = '*' + source !== target  → preferredTranslations with a global instruction
 * - language_to = 'es' etc.               → preferredTranslations per-language
 */
function mergeCloudGlossary(
  localGlossary: BuildTranslatorConfig['glossary'],
  cloudTerms: CloudGlossaryTerm[],
): BuildTranslatorConfig['glossary'] {
  const merged = { ...localGlossary };

  const doNotTranslate = [...(merged.doNotTranslate ?? [])];
  const preferred: Record<string, string | Record<string, string>> = {
    ...(merged.preferredTranslations ?? {}),
  };

  for (const term of cloudTerms) {
    const isWildcard = term.language_to === '*';
    const isSameTerm = term.source_term === term.target_term;

    if (isWildcard && isSameTerm) {
      // Do Not Translate — keep as-is in all languages
      if (!doNotTranslate.includes(term.source_term)) {
        doNotTranslate.push(term.source_term);
      }
    } else if (isWildcard && !isSameTerm) {
      // Global preferred translation / instruction (applies to all target languages)
      const existing = preferred[term.source_term];
      if (!existing) {
        preferred[term.source_term] = term.target_term;
      }
      // Don't overwrite existing local preferred translation
    } else {
      // Language-specific preferred translation
      const existing = preferred[term.source_term];
      if (typeof existing === 'object' && existing !== null) {
        // Already a per-language map — add this language
        existing[term.language_to] = term.target_term;
      } else if (typeof existing === 'string') {
        // Convert global instruction to per-language map
        preferred[term.source_term] = { [term.language_to]: term.target_term };
      } else {
        preferred[term.source_term] = { [term.language_to]: term.target_term };
      }
    }
  }

  if (doNotTranslate.length) merged.doNotTranslate = doNotTranslate;
  if (Object.keys(preferred).length) merged.preferredTranslations = preferred;

  return merged;
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

const _printedWarnings = new Set<string>();

async function callTranslateApiSingle(
  apiKey: string,
  delta: JsonObject,
  sourceLang: string,
  targetLang: string,
  type: 'json' | 'markdown',
  extras: { context?: string; tone?: string; glossary?: BuildTranslatorConfig['glossary'] }
): Promise<TranslateResponse> {
  const res = await fetch(`${POLYCLI_API_URL}/api/translate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({ delta, sourceLang, targetLang, type, ...extras }),
  });

  if (!res.ok) {
    let errorMsg = `API error: ${res.status}`;
    try {
      const text = await res.text();
      const data = JSON.parse(text) as { error?: string };
      if (data.error) errorMsg = data.error;
    } catch { /* response body was not JSON */ }
    if (res.status === 402) {
      throw new Error(
        `${errorMsg}\n  Buy more credits at ${POLYCLI_API_URL}/dashboard`
      );
    }
    throw new Error(errorMsg);
  }

  const data = await res.json() as {
    translated?: JsonObject;
    wordsUsed?: number;
    warnings?: string[];
    error?: string;
  };

  if (!data.translated) throw new Error('API returned no translated data.');

  for (const warning of data.warnings ?? []) {
    if (!_printedWarnings.has(warning)) {
      _printedWarnings.add(warning);
      console.warn(chalk.yellow(`  ⚠ ${warning}`));
    }
  }

  return { translated: data.translated, wordsUsed: data.wordsUsed ?? 0 };
}

/**
 * Splits the delta into CLI_CHUNK_WORD_THRESHOLD-word chunks and sends each
 * as a separate HTTP request. This ensures each server-side call triggers at
 * most one OpenAI completion, keeping every request well under Vercel's
 * serverless timeout regardless of delta size.
 */
async function callTranslateApi(
  apiKey: string,
  delta: JsonObject,
  sourceLang: string,
  targetLang: string,
  type: 'json' | 'markdown' = 'json',
  extras: { context?: string; tone?: string; glossary?: BuildTranslatorConfig['glossary'] } = {}
): Promise<TranslateResponse> {
  const chunks = chunkDelta(delta);

  if (chunks.length === 1) {
    return callTranslateApiSingle(apiKey, chunks[0], sourceLang, targetLang, type, extras);
  }

  let totalWords = 0;
  const parts: JsonObject[] = [];
  for (const chunk of chunks) {
    const result = await callTranslateApiSingle(apiKey, chunk, sourceLang, targetLang, type, extras);
    parts.push(result.translated);
    totalWords += result.wordsUsed;
  }
  return { translated: Object.assign({}, ...parts) as JsonObject, wordsUsed: totalWords };
}

async function callAnalyzeApi(
  apiKey: string,
  delta: object | string,
  sourceLang: string,
  type: 'json' | 'markdown'
): Promise<string> {
  const res = await fetch(`${POLYCLI_API_URL}/api/analyze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({ delta, sourceLang, type }),
  });
  if (!res.ok) {
    let errorMsg = `analyze API returned ${res.status}`;
    try {
      const text = await res.text();
      const data = JSON.parse(text) as { error?: string };
      if (data.error) errorMsg = data.error;
    } catch { /* not JSON */ }
    throw new Error(errorMsg);
  }
  const data = await res.json() as { context?: string };
  return data.context ?? '';
}

// ---------------------------------------------------------------------------
// JSON translation phase
// ---------------------------------------------------------------------------

async function runJsonTranslation(
  config: BuildTranslatorConfig,
  apiKey: string,
  spinner: Ora,
  translationContext: string
): Promise<JsonObject | null> {
  if (!config.localesPath) return null;

  const localesPath = path.resolve(process.cwd(), config.localesPath);
  const sourceFile = path.join(localesPath, `${config.sourceLanguage}.json`);
  const lockFile = path.join(localesPath, '.translator-lock.json');

  if (!fs.existsSync(sourceFile)) {
    spinner.info(`JSON: source file not found at ${sourceFile} — skipping.`);
    return null;
  }

  let currentSource: JsonObject;
  try {
    currentSource = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  } catch {
    spinner.fail(`Failed to parse source file: ${sourceFile}`);
    process.exit(1);
  }

  let lockSource: JsonObject = {};
  if (fs.existsSync(lockFile)) {
    try {
      lockSource = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    } catch {
      spinner.warn('Could not parse JSON lockfile — treating all keys as new.');
    }
  }

  spinner.text = 'Calculating JSON delta...';
  const delta = getDelta(currentSource, lockSource);
  const wordsInDelta = countWords(delta);

  // Determine which target languages have no output file yet (new languages).
  // These need a full translation of currentSource regardless of the delta.
  const newLanguages = config.targetLanguages.filter(
    (lang) => !fs.existsSync(path.join(localesPath, `${lang}.json`))
  );

  if (wordsInDelta === 0 && newLanguages.length === 0) {
    spinner.succeed('JSON: no new strings to translate.');
    return null;
  }

  if (wordsInDelta > 0 && newLanguages.length > 0) {
    spinner.succeed(
      `JSON: ~${wordsInDelta} changed word(s) for ${config.targetLanguages.length - newLanguages.length} language(s) + full source for ${newLanguages.length} new language(s): ${newLanguages.join(', ')}.`
    );
  } else if (wordsInDelta > 0) {
    spinner.succeed(
      `JSON: found ~${wordsInDelta} word(s) × ${config.targetLanguages.length} language(s).`
    );
  } else {
    spinner.succeed(
      `JSON: full translation needed for ${newLanguages.length} new language(s): ${newLanguages.join(', ')}.`
    );
  }

  for (const targetLang of config.targetLanguages) {
    const targetFile = path.join(localesPath, `${targetLang}.json`);
    const isNewLang = newLanguages.includes(targetLang);

    // Skip languages that already have a file when there's no delta
    if (!isNewLang && wordsInDelta === 0) continue;

    spinner.start(`JSON → ${targetLang}...`);
    try {
      let existingTarget: JsonObject = {};
      if (!isNewLang && fs.existsSync(targetFile)) {
        try {
          existingTarget = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
        } catch {
          spinner.warn(`Could not parse existing ${targetLang}.json — will overwrite.`);
        }
      }

      // New languages get the full source; existing languages get only the delta.
      let deltaToSend = isNewLang ? currentSource : delta;
      let phpVarMapping: Record<string, string> = {};

      if (config.phpVariables) {
        const { processedJson, mapping } = preprocessPhpVars(deltaToSend);
        deltaToSend = processedJson;
        phpVarMapping = mapping;
      }

      const { translated: rawTranslated } = await callTranslateApi(
        apiKey, deltaToSend, config.sourceLanguage, targetLang, 'json',
        { context: translationContext, tone: config.tone, glossary: config.glossary }
      );

      const translated = config.phpVariables
        ? postprocessJson(rawTranslated, phpVarMapping)
        : rawTranslated;

      const merged = mergeTranslations(existingTarget, translated);
      fs.writeFileSync(targetFile, JSON.stringify(merged, null, 2), 'utf8');
      spinner.succeed(`JSON → ${targetLang} done.`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      spinner.fail(`JSON → ${targetLang} failed: ${message}`);
      process.exit(1);
    }
  }

  fs.writeFileSync(lockFile, JSON.stringify(currentSource, null, 2), 'utf8');

  // Return the delta that was actually translated so the review phase can scope itself.
  // New languages received the full source, so return currentSource for them;
  // otherwise return only the changed keys.
  return newLanguages.length > 0 ? currentSource : delta;
}

// ---------------------------------------------------------------------------
// Markdown translation phase
// ---------------------------------------------------------------------------

async function runMarkdownTranslation(
  config: BuildTranslatorConfig,
  apiKey: string,
  spinner: Ora,
  translationContext: string
): Promise<void> {
  const markdownPath = path.resolve(process.cwd(), config.markdownPath!);
  const sourceLangDir = path.join(markdownPath, config.sourceLanguage);

  if (!fs.existsSync(sourceLangDir)) {
    spinner.warn(
      `Markdown source directory not found: ${sourceLangDir}\n` +
      `  Create it and place your .md files there.`
    );
    return;
  }

  const mdFiles = fs.readdirSync(sourceLangDir).filter((f) => f.endsWith('.md'));
  if (mdFiles.length === 0) {
    spinner.info('Markdown: no .md files found in source directory.');
    return;
  }

  // Load per-language translation cache
  const cacheFile = getCachePath(markdownPath);
  let cache: MarkdownCache = {};
  if (fs.existsSync(cacheFile)) {
    try {
      cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch {
      spinner.warn('Could not parse Markdown cache — starting fresh.');
    }
  }

  let totalFilesProcessed = 0;

  for (const filename of mdFiles) {
    const sourcePath = path.join(sourceLangDir, filename);
    let sourceContent: string;
    try {
      sourceContent = fs.readFileSync(sourcePath, 'utf8');
    } catch {
      spinner.warn(`Could not read ${filename} — skipping.`);
      continue;
    }

    const blocks = parseMarkdownBlocks(sourceContent);

    for (const targetLang of config.targetLanguages) {
      // Language cache for this file: { [blockHash]: translatedText }
      const fileCache: Record<string, string> =
        cache[targetLang]?.[filename] ?? {};

      const deltaItems = getMarkdownDelta(blocks, fileCache);

      if (deltaItems.length === 0) {
        spinner.info(`Markdown: ${filename} → ${targetLang}: up to date.`);
        continue;
      }

      const estimatedWords = estimateMarkdownWords(deltaItems);
      const totalSentences = deltaItems.reduce((acc, item) => acc + item.uncachedSentences.length, 0);
      spinner.start(
        `Markdown: ${filename} → ${targetLang} (${totalSentences} sentence(s) in ${deltaItems.length} block(s), ~${estimatedWords} words)...`
      );

      // Build sentence-level delta payload: { [sentenceHash]: sentenceText }
      // Only uncached sentences are sent — unchanged sentences reuse the cache.
      const deltaPayload: JsonObject = {};
      for (const item of deltaItems) {
        for (const sentence of item.uncachedSentences) {
          deltaPayload[sentence.hash] = sentence.content;
        }
      }

      let translatedMap: JsonObject;
      try {
        const response = await callTranslateApi(
          apiKey, deltaPayload, config.sourceLanguage, targetLang, 'markdown',
          { context: translationContext, tone: config.tone, glossary: config.glossary }
        );
        translatedMap = response.translated;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        spinner.fail(`Markdown: ${filename} → ${targetLang} failed: ${message}`);
        // Do not update cache or write file on failure
        process.exit(1);
      }

      // Merge new translations into the language cache
      if (!cache[targetLang]) cache[targetLang] = {};
      if (!cache[targetLang][filename]) cache[targetLang][filename] = {};
      for (const [hash, translatedText] of Object.entries(translatedMap)) {
        if (typeof translatedText === 'string') {
          cache[targetLang][filename][hash] = translatedText;
        }
      }

      // Reconstruct the full translated Markdown and write to target directory
      const targetDir = path.join(markdownPath, targetLang);
      fs.mkdirSync(targetDir, { recursive: true });
      const targetPath = path.join(targetDir, filename);
      const reconstructed = reconstructMarkdown(blocks, cache[targetLang][filename]);
      fs.writeFileSync(targetPath, reconstructed, 'utf8');

      spinner.succeed(`Markdown: ${filename} → ${targetLang} done (${targetPath}).`);
      totalFilesProcessed++;
    }
  }

  // Persist updated cache
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), 'utf8');

  if (totalFilesProcessed > 0) {
    console.log(chalk.cyan(`\nMarkdown cache saved to ${cacheFile}`));
  }
}

// ---------------------------------------------------------------------------
// ARB translation phase
// ---------------------------------------------------------------------------

async function runArbTranslation(
  config: BuildTranslatorConfig,
  apiKey: string,
  spinner: Ora,
  translationContext: string
): Promise<Record<string, string> | null> {
  const prefix = config.arbPrefix ?? 'app';
  const arbPath = path.resolve(process.cwd(), config.arbPath!);
  const sourceFile = path.join(arbPath, `${prefix}_${config.sourceLanguage}.arb`);
  const lockFile = path.join(arbPath, '.polycli-arb-lock.json');

  if (!fs.existsSync(sourceFile)) {
    spinner.fail(`ARB source file not found: ${sourceFile}`);
    process.exit(1);
    return null;
  }

  let source;
  try {
    source = parseArb(fs.readFileSync(sourceFile, 'utf8'));
  } catch {
    spinner.fail(`Failed to parse ARB source file: ${sourceFile}`);
    process.exit(1);
  }

  let lockData: Record<string, string> = {};
  if (fs.existsSync(lockFile)) {
    try {
      lockData = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    } catch {
      spinner.warn('Could not parse ARB lock file — treating all keys as new.');
    }
  }

  const delta = buildArbDelta(source.translatableKeys, lockData);
  const wordsInDelta = Object.values(delta).join(' ').split(/\s+/).filter(Boolean).length;

  const newLanguages = config.targetLanguages.filter(
    (lang) => !fs.existsSync(path.join(arbPath, `${prefix}_${lang}.arb`))
  );

  if (wordsInDelta === 0 && newLanguages.length === 0) {
    spinner.succeed('ARB: no new strings to translate.');
    return null;
  }

  if (wordsInDelta > 0 && newLanguages.length > 0) {
    spinner.succeed(
      `ARB: ~${wordsInDelta} changed word(s) for ${config.targetLanguages.length - newLanguages.length} language(s) + full source for ${newLanguages.length} new language(s): ${newLanguages.join(', ')}.`
    );
  } else if (wordsInDelta > 0) {
    spinner.succeed(`ARB: found ~${wordsInDelta} word(s) × ${config.targetLanguages.length} language(s).`);
  } else {
    spinner.succeed(`ARB: full translation needed for ${newLanguages.length} new language(s): ${newLanguages.join(', ')}.`);
  }

  const descriptions = config.translateArbDescriptions
    ? extractDescriptions(source.metadata)
    : {};

  for (const targetLang of config.targetLanguages) {
    const targetFile = path.join(arbPath, `${prefix}_${targetLang}.arb`);
    const isNewLang = newLanguages.includes(targetLang);

    if (!isNewLang && wordsInDelta === 0) continue;

    spinner.start(`ARB → ${targetLang}...`);
    try {
      let existingTranslated: Record<string, string> = {};
      if (!isNewLang && fs.existsSync(targetFile)) {
        try {
          existingTranslated = parseArb(fs.readFileSync(targetFile, 'utf8')).translatableKeys;
        } catch {
          spinner.warn(`Could not parse existing ${prefix}_${targetLang}.arb — will overwrite.`);
        }
      }

      const stringsPayload: JsonObject = isNewLang ? { ...source.translatableKeys } : { ...delta };

      if (config.translateArbDescriptions) {
        for (const [key, desc] of Object.entries(descriptions)) {
          stringsPayload[`@__desc__${key}`] = desc;
        }
      }

      const { translated } = await callTranslateApi(
        apiKey, stringsPayload, config.sourceLanguage, targetLang, 'json',
        { context: translationContext, tone: config.tone, glossary: config.glossary }
      );

      const newTranslations: Record<string, string> = {};
      const translatedDescriptions: Record<string, string> = {};

      for (const [key, value] of Object.entries(translated)) {
        if (typeof value !== 'string') continue;
        if (key.startsWith('@__desc__')) {
          translatedDescriptions[key.slice('@__desc__'.length)] = value;
        } else {
          newTranslations[key] = value;
        }
      }

      const output = reconstructArb(
        existingTranslated,
        newTranslations,
        source.metadata,
        targetLang,
        source.keyOrder,
        config.translateArbDescriptions ? translatedDescriptions : null
      );

      fs.mkdirSync(arbPath, { recursive: true });
      fs.writeFileSync(targetFile, output, 'utf8');
      spinner.succeed(`ARB → ${targetLang} done.`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      spinner.fail(`ARB → ${targetLang} failed: ${message}`);
      process.exit(1);
    }
  }

  fs.writeFileSync(lockFile, JSON.stringify(source.translatableKeys, null, 2), 'utf8');

  // Return the ARB delta that was translated (or full source for new languages).
  return newLanguages.length > 0 ? source.translatableKeys : delta;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runCommand(options: { key?: string; review?: boolean }): Promise<void> {
  const apiKey = options.key ?? process.env.POLYCLI_API_KEY;
  if (!apiKey) {
    console.error(
      chalk.red('Error: API key is required.\n') +
      chalk.dim('  Pass it with --key <key> or set the POLYCLI_API_KEY environment variable.')
    );
    process.exit(1);
  }

  const spinner = ora('Loading configuration...').start();
  const configPath = path.resolve(process.cwd(), 'buildtranslator.json');

  if (!fs.existsSync(configPath)) {
    spinner.fail('"buildtranslator.json" not found. Run "polycli init" first.');
    process.exit(1);
  }

  let config: BuildTranslatorConfig;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    spinner.fail('Failed to parse "buildtranslator.json". Ensure it is valid JSON.');
    process.exit(1);
  }

  const { sourceLanguage, targetLanguages } = config;
  if (!sourceLanguage || !Array.isArray(targetLanguages) || targetLanguages.length === 0) {
    spinner.fail(
      '"buildtranslator.json" is missing required fields: sourceLanguage, targetLanguages.'
    );
    process.exit(1);
  }
  if (!config.localesPath && !config.arbPath && !config.markdownPath) {
    spinner.fail(
      '"buildtranslator.json" must have at least one of: localesPath, arbPath, markdownPath.'
    );
    process.exit(1);
  }

  spinner.succeed('Configuration loaded.');

  // ── Cloud Glossary Sync ──────────────────────────────────────────────────
  if (config.glossarySync && config.teamId) {
    try {
      spinner.start('Syncing cloud glossary...');
      const cloudTerms = await fetchCloudGlossary(apiKey, config.teamId, config.sourceLanguage);
      if (cloudTerms.length > 0) {
        config.glossary = mergeCloudGlossary(config.glossary, cloudTerms);
        spinner.succeed(`Cloud glossary synced: ${cloudTerms.length} term(s) merged.`);
      } else {
        spinner.info('Cloud glossary: no terms found for this team/language.');
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      spinner.warn(`Cloud glossary sync failed: ${message} — continuing with local glossary.`);
    }
  }

  // Validate tone length
  if (config.tone && config.tone.length > 200) {
    console.error(
      `Error: "tone" in buildtranslator.json exceeds 200 characters (found ${config.tone.length}). Please shorten it and re-run.`
    );
    process.exit(1);
  }

  // Call /api/analyze once before translation loops
  let translationContext = '';
  try {
    spinner.start('Analyzing content for translation context...');
    const jsonSourcePath = config.localesPath
      ? path.resolve(process.cwd(), config.localesPath, `${config.sourceLanguage}.json`)
      : '';

    if (jsonSourcePath && fs.existsSync(jsonSourcePath)) {
      const sourceForAnalysis = JSON.parse(fs.readFileSync(jsonSourcePath, 'utf8'));
      translationContext = await callAnalyzeApi(apiKey, sourceForAnalysis, config.sourceLanguage, 'json');
    } else if (config.markdownPath) {
      const mdSourceDir = path.resolve(process.cwd(), config.markdownPath, config.sourceLanguage);
      const mdFiles = fs.existsSync(mdSourceDir)
        ? fs.readdirSync(mdSourceDir).filter((f: string) => f.endsWith('.md'))
        : [];
      if (mdFiles.length > 0) {
        const firstMd = fs.readFileSync(path.join(mdSourceDir, mdFiles[0]), 'utf8');
        translationContext = await callAnalyzeApi(apiKey, firstMd, config.sourceLanguage, 'markdown');
      }
    } else if (config.arbPath) {
      const prefix = config.arbPrefix ?? 'app';
      const arbSourcePath = path.resolve(
        process.cwd(), config.arbPath, `${prefix}_${config.sourceLanguage}.arb`
      );
      if (fs.existsSync(arbSourcePath)) {
        const parsed = parseArb(fs.readFileSync(arbSourcePath, 'utf8'));
        translationContext = await callAnalyzeApi(apiKey, parsed.translatableKeys, config.sourceLanguage, 'json');
      }
    }
    if (translationContext) spinner.succeed('Context analysis done.');
    else spinner.info('No source content found for context analysis — skipping.');
  } catch {
    spinner.warn('Context analysis failed — proceeding without context.');
  }

  // ── Phase 1: JSON files ──────────────────────────────────────────────────
  const jsonDelta = await runJsonTranslation(config, apiKey, spinner, translationContext);

  // ── Phase 2: Markdown files (optional) ──────────────────────────────────
  if (config.markdownPath) {
    await runMarkdownTranslation(config, apiKey, spinner, translationContext);
  }

  // ── Phase 3: Flutter ARB files (optional) ────────────────────────────────
  let arbDelta: Record<string, string> | null = null;
  if (config.arbPath) {
    arbDelta = await runArbTranslation(config, apiKey, spinner, translationContext);
  }

  console.log(chalk.bold.green('\nAll translations completed successfully.'));

  // ── Phase 4: AI Review (optional) ─────────────────────────────────────────
  const shouldReview = options.review || config.aiReviewer
  if (shouldReview) {
    console.log(chalk.cyan('\nStarting AI Review phase...'))
    await reviewCommand({ key: apiKey, jsonDelta: jsonDelta ?? undefined, arbDelta: arbDelta ?? undefined })
  }
}
