"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCommand = runCommand;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const chalk_1 = __importDefault(require("chalk"));
const ora_1 = __importDefault(require("ora"));
const delta_1 = require("../utils/delta");
const markdown_1 = require("../utils/markdown");
const arb_1 = require("../utils/arb");
const preprocessing_1 = require("../utils/preprocessing");
const review_1 = require("./review");
const POLYCLI_API_URL = process.env.POLYCLI_API_URL || 'https://www.polycli.dev';
// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------
const _printedWarnings = new Set();
async function callTranslateApiSingle(apiKey, delta, sourceLang, targetLang, type, extras) {
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
            const data = JSON.parse(text);
            if (data.error)
                errorMsg = data.error;
        }
        catch { /* response body was not JSON */ }
        if (res.status === 402) {
            throw new Error(`${errorMsg}\n  Buy more credits at ${POLYCLI_API_URL}/dashboard`);
        }
        throw new Error(errorMsg);
    }
    const data = await res.json();
    if (!data.translated)
        throw new Error('API returned no translated data.');
    for (const warning of data.warnings ?? []) {
        if (!_printedWarnings.has(warning)) {
            _printedWarnings.add(warning);
            console.warn(chalk_1.default.yellow(`  ⚠ ${warning}`));
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
async function callTranslateApi(apiKey, delta, sourceLang, targetLang, type = 'json', extras = {}) {
    const chunks = (0, delta_1.chunkDelta)(delta);
    if (chunks.length === 1) {
        return callTranslateApiSingle(apiKey, chunks[0], sourceLang, targetLang, type, extras);
    }
    let totalWords = 0;
    const parts = [];
    for (const chunk of chunks) {
        const result = await callTranslateApiSingle(apiKey, chunk, sourceLang, targetLang, type, extras);
        parts.push(result.translated);
        totalWords += result.wordsUsed;
    }
    return { translated: Object.assign({}, ...parts), wordsUsed: totalWords };
}
async function callAnalyzeApi(apiKey, delta, sourceLang, type) {
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
            const data = JSON.parse(text);
            if (data.error)
                errorMsg = data.error;
        }
        catch { /* not JSON */ }
        throw new Error(errorMsg);
    }
    const data = await res.json();
    return data.context ?? '';
}
// ---------------------------------------------------------------------------
// JSON translation phase
// ---------------------------------------------------------------------------
async function runJsonTranslation(config, apiKey, spinner, translationContext) {
    if (!config.localesPath)
        return;
    const localesPath = path_1.default.resolve(process.cwd(), config.localesPath);
    const sourceFile = path_1.default.join(localesPath, `${config.sourceLanguage}.json`);
    const lockFile = path_1.default.join(localesPath, '.translator-lock.json');
    if (!fs_1.default.existsSync(sourceFile)) {
        spinner.info(`JSON: source file not found at ${sourceFile} — skipping.`);
        return;
    }
    let currentSource;
    try {
        currentSource = JSON.parse(fs_1.default.readFileSync(sourceFile, 'utf8'));
    }
    catch {
        spinner.fail(`Failed to parse source file: ${sourceFile}`);
        process.exit(1);
    }
    let lockSource = {};
    if (fs_1.default.existsSync(lockFile)) {
        try {
            lockSource = JSON.parse(fs_1.default.readFileSync(lockFile, 'utf8'));
        }
        catch {
            spinner.warn('Could not parse JSON lockfile — treating all keys as new.');
        }
    }
    spinner.text = 'Calculating JSON delta...';
    const delta = (0, delta_1.getDelta)(currentSource, lockSource);
    const wordsInDelta = (0, delta_1.countWords)(delta);
    // Determine which target languages have no output file yet (new languages).
    // These need a full translation of currentSource regardless of the delta.
    const newLanguages = config.targetLanguages.filter((lang) => !fs_1.default.existsSync(path_1.default.join(localesPath, `${lang}.json`)));
    if (wordsInDelta === 0 && newLanguages.length === 0) {
        spinner.succeed('JSON: no new strings to translate.');
        return;
    }
    if (wordsInDelta > 0 && newLanguages.length > 0) {
        spinner.succeed(`JSON: ~${wordsInDelta} changed word(s) for ${config.targetLanguages.length - newLanguages.length} language(s) + full source for ${newLanguages.length} new language(s): ${newLanguages.join(', ')}.`);
    }
    else if (wordsInDelta > 0) {
        spinner.succeed(`JSON: found ~${wordsInDelta} word(s) × ${config.targetLanguages.length} language(s).`);
    }
    else {
        spinner.succeed(`JSON: full translation needed for ${newLanguages.length} new language(s): ${newLanguages.join(', ')}.`);
    }
    for (const targetLang of config.targetLanguages) {
        const targetFile = path_1.default.join(localesPath, `${targetLang}.json`);
        const isNewLang = newLanguages.includes(targetLang);
        // Skip languages that already have a file when there's no delta
        if (!isNewLang && wordsInDelta === 0)
            continue;
        spinner.start(`JSON → ${targetLang}...`);
        try {
            let existingTarget = {};
            if (!isNewLang && fs_1.default.existsSync(targetFile)) {
                try {
                    existingTarget = JSON.parse(fs_1.default.readFileSync(targetFile, 'utf8'));
                }
                catch {
                    spinner.warn(`Could not parse existing ${targetLang}.json — will overwrite.`);
                }
            }
            // New languages get the full source; existing languages get only the delta.
            let deltaToSend = isNewLang ? currentSource : delta;
            let phpVarMapping = {};
            if (config.phpVariables) {
                const { processedJson, mapping } = (0, preprocessing_1.preprocessPhpVars)(deltaToSend);
                deltaToSend = processedJson;
                phpVarMapping = mapping;
            }
            const { translated: rawTranslated } = await callTranslateApi(apiKey, deltaToSend, config.sourceLanguage, targetLang, 'json', { context: translationContext, tone: config.tone, glossary: config.glossary });
            const translated = config.phpVariables
                ? (0, preprocessing_1.postprocessJson)(rawTranslated, phpVarMapping)
                : rawTranslated;
            const merged = (0, delta_1.mergeTranslations)(existingTarget, translated);
            fs_1.default.writeFileSync(targetFile, JSON.stringify(merged, null, 2), 'utf8');
            spinner.succeed(`JSON → ${targetLang} done.`);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            spinner.fail(`JSON → ${targetLang} failed: ${message}`);
            process.exit(1);
        }
    }
    fs_1.default.writeFileSync(lockFile, JSON.stringify(currentSource, null, 2), 'utf8');
}
// ---------------------------------------------------------------------------
// Markdown translation phase
// ---------------------------------------------------------------------------
async function runMarkdownTranslation(config, apiKey, spinner, translationContext) {
    const markdownPath = path_1.default.resolve(process.cwd(), config.markdownPath);
    const sourceLangDir = path_1.default.join(markdownPath, config.sourceLanguage);
    if (!fs_1.default.existsSync(sourceLangDir)) {
        spinner.warn(`Markdown source directory not found: ${sourceLangDir}\n` +
            `  Create it and place your .md files there.`);
        return;
    }
    const mdFiles = fs_1.default.readdirSync(sourceLangDir).filter((f) => f.endsWith('.md'));
    if (mdFiles.length === 0) {
        spinner.info('Markdown: no .md files found in source directory.');
        return;
    }
    // Load per-language translation cache
    const cacheFile = (0, markdown_1.getCachePath)(markdownPath);
    let cache = {};
    if (fs_1.default.existsSync(cacheFile)) {
        try {
            cache = JSON.parse(fs_1.default.readFileSync(cacheFile, 'utf8'));
        }
        catch {
            spinner.warn('Could not parse Markdown cache — starting fresh.');
        }
    }
    let totalFilesProcessed = 0;
    for (const filename of mdFiles) {
        const sourcePath = path_1.default.join(sourceLangDir, filename);
        let sourceContent;
        try {
            sourceContent = fs_1.default.readFileSync(sourcePath, 'utf8');
        }
        catch {
            spinner.warn(`Could not read ${filename} — skipping.`);
            continue;
        }
        const blocks = (0, markdown_1.parseMarkdownBlocks)(sourceContent);
        for (const targetLang of config.targetLanguages) {
            // Language cache for this file: { [blockHash]: translatedText }
            const fileCache = cache[targetLang]?.[filename] ?? {};
            const deltaItems = (0, markdown_1.getMarkdownDelta)(blocks, fileCache);
            if (deltaItems.length === 0) {
                spinner.info(`Markdown: ${filename} → ${targetLang}: up to date.`);
                continue;
            }
            const estimatedWords = (0, markdown_1.estimateMarkdownWords)(deltaItems);
            const totalSentences = deltaItems.reduce((acc, item) => acc + item.uncachedSentences.length, 0);
            spinner.start(`Markdown: ${filename} → ${targetLang} (${totalSentences} sentence(s) in ${deltaItems.length} block(s), ~${estimatedWords} words)...`);
            // Build sentence-level delta payload: { [sentenceHash]: sentenceText }
            // Only uncached sentences are sent — unchanged sentences reuse the cache.
            const deltaPayload = {};
            for (const item of deltaItems) {
                for (const sentence of item.uncachedSentences) {
                    deltaPayload[sentence.hash] = sentence.content;
                }
            }
            let translatedMap;
            try {
                const response = await callTranslateApi(apiKey, deltaPayload, config.sourceLanguage, targetLang, 'markdown', { context: translationContext, tone: config.tone, glossary: config.glossary });
                translatedMap = response.translated;
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                spinner.fail(`Markdown: ${filename} → ${targetLang} failed: ${message}`);
                // Do not update cache or write file on failure
                process.exit(1);
            }
            // Merge new translations into the language cache
            if (!cache[targetLang])
                cache[targetLang] = {};
            if (!cache[targetLang][filename])
                cache[targetLang][filename] = {};
            for (const [hash, translatedText] of Object.entries(translatedMap)) {
                if (typeof translatedText === 'string') {
                    cache[targetLang][filename][hash] = translatedText;
                }
            }
            // Reconstruct the full translated Markdown and write to target directory
            const targetDir = path_1.default.join(markdownPath, targetLang);
            fs_1.default.mkdirSync(targetDir, { recursive: true });
            const targetPath = path_1.default.join(targetDir, filename);
            const reconstructed = (0, markdown_1.reconstructMarkdown)(blocks, cache[targetLang][filename]);
            fs_1.default.writeFileSync(targetPath, reconstructed, 'utf8');
            spinner.succeed(`Markdown: ${filename} → ${targetLang} done (${targetPath}).`);
            totalFilesProcessed++;
        }
    }
    // Persist updated cache
    fs_1.default.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), 'utf8');
    if (totalFilesProcessed > 0) {
        console.log(chalk_1.default.cyan(`\nMarkdown cache saved to ${cacheFile}`));
    }
}
// ---------------------------------------------------------------------------
// ARB translation phase
// ---------------------------------------------------------------------------
async function runArbTranslation(config, apiKey, spinner, translationContext) {
    const prefix = config.arbPrefix ?? 'app';
    const arbPath = path_1.default.resolve(process.cwd(), config.arbPath);
    const sourceFile = path_1.default.join(arbPath, `${prefix}_${config.sourceLanguage}.arb`);
    const lockFile = path_1.default.join(arbPath, '.polycli-arb-lock.json');
    if (!fs_1.default.existsSync(sourceFile)) {
        spinner.fail(`ARB source file not found: ${sourceFile}`);
        process.exit(1);
    }
    let source;
    try {
        source = (0, arb_1.parseArb)(fs_1.default.readFileSync(sourceFile, 'utf8'));
    }
    catch {
        spinner.fail(`Failed to parse ARB source file: ${sourceFile}`);
        process.exit(1);
    }
    let lockData = {};
    if (fs_1.default.existsSync(lockFile)) {
        try {
            lockData = JSON.parse(fs_1.default.readFileSync(lockFile, 'utf8'));
        }
        catch {
            spinner.warn('Could not parse ARB lock file — treating all keys as new.');
        }
    }
    const delta = (0, arb_1.buildArbDelta)(source.translatableKeys, lockData);
    const wordsInDelta = Object.values(delta).join(' ').split(/\s+/).filter(Boolean).length;
    const newLanguages = config.targetLanguages.filter((lang) => !fs_1.default.existsSync(path_1.default.join(arbPath, `${prefix}_${lang}.arb`)));
    if (wordsInDelta === 0 && newLanguages.length === 0) {
        spinner.succeed('ARB: no new strings to translate.');
        return;
    }
    if (wordsInDelta > 0 && newLanguages.length > 0) {
        spinner.succeed(`ARB: ~${wordsInDelta} changed word(s) for ${config.targetLanguages.length - newLanguages.length} language(s) + full source for ${newLanguages.length} new language(s): ${newLanguages.join(', ')}.`);
    }
    else if (wordsInDelta > 0) {
        spinner.succeed(`ARB: found ~${wordsInDelta} word(s) × ${config.targetLanguages.length} language(s).`);
    }
    else {
        spinner.succeed(`ARB: full translation needed for ${newLanguages.length} new language(s): ${newLanguages.join(', ')}.`);
    }
    const descriptions = config.translateArbDescriptions
        ? (0, arb_1.extractDescriptions)(source.metadata)
        : {};
    for (const targetLang of config.targetLanguages) {
        const targetFile = path_1.default.join(arbPath, `${prefix}_${targetLang}.arb`);
        const isNewLang = newLanguages.includes(targetLang);
        if (!isNewLang && wordsInDelta === 0)
            continue;
        spinner.start(`ARB → ${targetLang}...`);
        try {
            let existingTranslated = {};
            if (!isNewLang && fs_1.default.existsSync(targetFile)) {
                try {
                    existingTranslated = (0, arb_1.parseArb)(fs_1.default.readFileSync(targetFile, 'utf8')).translatableKeys;
                }
                catch {
                    spinner.warn(`Could not parse existing ${prefix}_${targetLang}.arb — will overwrite.`);
                }
            }
            const stringsPayload = isNewLang ? { ...source.translatableKeys } : { ...delta };
            if (config.translateArbDescriptions) {
                for (const [key, desc] of Object.entries(descriptions)) {
                    stringsPayload[`@__desc__${key}`] = desc;
                }
            }
            const { translated } = await callTranslateApi(apiKey, stringsPayload, config.sourceLanguage, targetLang, 'json', { context: translationContext, tone: config.tone, glossary: config.glossary });
            const newTranslations = {};
            const translatedDescriptions = {};
            for (const [key, value] of Object.entries(translated)) {
                if (typeof value !== 'string')
                    continue;
                if (key.startsWith('@__desc__')) {
                    translatedDescriptions[key.slice('@__desc__'.length)] = value;
                }
                else {
                    newTranslations[key] = value;
                }
            }
            const output = (0, arb_1.reconstructArb)(existingTranslated, newTranslations, source.metadata, targetLang, source.keyOrder, config.translateArbDescriptions ? translatedDescriptions : null);
            fs_1.default.mkdirSync(arbPath, { recursive: true });
            fs_1.default.writeFileSync(targetFile, output, 'utf8');
            spinner.succeed(`ARB → ${targetLang} done.`);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            spinner.fail(`ARB → ${targetLang} failed: ${message}`);
            process.exit(1);
        }
    }
    fs_1.default.writeFileSync(lockFile, JSON.stringify(source.translatableKeys, null, 2), 'utf8');
}
// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function runCommand(options) {
    const apiKey = options.key ?? process.env.POLYCLI_API_KEY;
    if (!apiKey) {
        console.error(chalk_1.default.red('Error: API key is required.\n') +
            chalk_1.default.dim('  Pass it with --key <key> or set the POLYCLI_API_KEY environment variable.'));
        process.exit(1);
    }
    const spinner = (0, ora_1.default)('Loading configuration...').start();
    const configPath = path_1.default.resolve(process.cwd(), 'buildtranslator.json');
    if (!fs_1.default.existsSync(configPath)) {
        spinner.fail('"buildtranslator.json" not found. Run "polycli init" first.');
        process.exit(1);
    }
    let config;
    try {
        config = JSON.parse(fs_1.default.readFileSync(configPath, 'utf8'));
    }
    catch {
        spinner.fail('Failed to parse "buildtranslator.json". Ensure it is valid JSON.');
        process.exit(1);
    }
    const { sourceLanguage, targetLanguages } = config;
    if (!sourceLanguage || !Array.isArray(targetLanguages) || targetLanguages.length === 0) {
        spinner.fail('"buildtranslator.json" is missing required fields: sourceLanguage, targetLanguages.');
        process.exit(1);
    }
    if (!config.localesPath && !config.arbPath && !config.markdownPath) {
        spinner.fail('"buildtranslator.json" must have at least one of: localesPath, arbPath, markdownPath.');
        process.exit(1);
    }
    spinner.succeed('Configuration loaded.');
    // Validate tone length
    if (config.tone && config.tone.length > 200) {
        console.error(`Error: "tone" in buildtranslator.json exceeds 200 characters (found ${config.tone.length}). Please shorten it and re-run.`);
        process.exit(1);
    }
    // Call /api/analyze once before translation loops
    let translationContext = '';
    try {
        spinner.start('Analyzing content for translation context...');
        const jsonSourcePath = config.localesPath
            ? path_1.default.resolve(process.cwd(), config.localesPath, `${config.sourceLanguage}.json`)
            : '';
        if (jsonSourcePath && fs_1.default.existsSync(jsonSourcePath)) {
            const sourceForAnalysis = JSON.parse(fs_1.default.readFileSync(jsonSourcePath, 'utf8'));
            translationContext = await callAnalyzeApi(apiKey, sourceForAnalysis, config.sourceLanguage, 'json');
        }
        else if (config.markdownPath) {
            const mdSourceDir = path_1.default.resolve(process.cwd(), config.markdownPath, config.sourceLanguage);
            const mdFiles = fs_1.default.existsSync(mdSourceDir)
                ? fs_1.default.readdirSync(mdSourceDir).filter((f) => f.endsWith('.md'))
                : [];
            if (mdFiles.length > 0) {
                const firstMd = fs_1.default.readFileSync(path_1.default.join(mdSourceDir, mdFiles[0]), 'utf8');
                translationContext = await callAnalyzeApi(apiKey, firstMd, config.sourceLanguage, 'markdown');
            }
        }
        else if (config.arbPath) {
            const prefix = config.arbPrefix ?? 'app';
            const arbSourcePath = path_1.default.resolve(process.cwd(), config.arbPath, `${prefix}_${config.sourceLanguage}.arb`);
            if (fs_1.default.existsSync(arbSourcePath)) {
                const parsed = (0, arb_1.parseArb)(fs_1.default.readFileSync(arbSourcePath, 'utf8'));
                translationContext = await callAnalyzeApi(apiKey, parsed.translatableKeys, config.sourceLanguage, 'json');
            }
        }
        if (translationContext)
            spinner.succeed('Context analysis done.');
        else
            spinner.info('No source content found for context analysis — skipping.');
    }
    catch {
        spinner.warn('Context analysis failed — proceeding without context.');
    }
    // ── Phase 1: JSON files ──────────────────────────────────────────────────
    await runJsonTranslation(config, apiKey, spinner, translationContext);
    // ── Phase 2: Markdown files (optional) ──────────────────────────────────
    if (config.markdownPath) {
        await runMarkdownTranslation(config, apiKey, spinner, translationContext);
    }
    // ── Phase 3: Flutter ARB files (optional) ────────────────────────────────
    if (config.arbPath) {
        await runArbTranslation(config, apiKey, spinner, translationContext);
    }
    console.log(chalk_1.default.bold.green('\nAll translations completed successfully.'));
    // ── Phase 4: AI Review (optional) ─────────────────────────────────────────
    const shouldReview = options.review || config.aiReviewer;
    if (shouldReview) {
        console.log(chalk_1.default.cyan('\nStarting AI Review phase...'));
        await (0, review_1.reviewCommand)({ key: apiKey });
    }
}
