"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.reviewCommand = reviewCommand;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const chalk_1 = __importDefault(require("chalk"));
const ora_1 = __importDefault(require("ora"));
const arb_1 = require("../utils/arb");
const POLYCLI_API_URL = process.env.POLYCLI_API_URL || 'https://www.polycli.dev';
const REVIEW_WORD_THRESHOLD = 15;
// ── Helpers ───────────────────────────────────────────────────────────────────
function countWords(text) {
    // CJK characters don't use spaces — count each as one word unit
    const cjkCount = (text.match(/[\u3040-\u9FFF\uAC00-\uD7AF]/g) ?? []).length;
    const nonCjkCount = text.replace(/[\u3040-\u9FFF\uAC00-\uD7AF]/g, ' ').split(/\s+/).filter(Boolean).length;
    return cjkCount + nonCjkCount;
}
function collectReviewCandidates(obj, threshold, prefix = '') {
    const results = [];
    for (const [key, val] of Object.entries(obj)) {
        const keyPath = prefix ? `${prefix}.${key}` : key;
        if (typeof val === 'string') {
            if (countWords(val) > threshold)
                results.push({ keyPath, value: val });
        }
        else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
            results.push(...collectReviewCandidates(val, threshold, keyPath));
        }
    }
    return results;
}
function setNestedValue(obj, keyPath, value) {
    const keys = keyPath.split('.');
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = value;
}
async function callReviewApi(apiKey, originalText, translatedText, sourceLang, targetLang, sourceType, extras = {}) {
    const res = await fetch(`${POLYCLI_API_URL}/api/translate/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({
            originalText, translatedText, sourceLang, targetLang, sourceType, ...extras
        }),
    });
    if (!res.ok) {
        let errorMsg = `Review API error: ${res.status}`;
        try {
            const data = JSON.parse(await res.text());
            if (data.error)
                errorMsg = data.error;
        }
        catch { /* not JSON */ }
        if (res.status === 402) {
            throw new Error(`${errorMsg}\n  Buy more credits at ${POLYCLI_API_URL}/dashboard`);
        }
        throw new Error(errorMsg);
    }
    return res.json();
}
// ── Main ──────────────────────────────────────────────────────────────────────
async function reviewCommand(options) {
    const apiKey = options.key ?? process.env.POLYCLI_API_KEY;
    if (!apiKey) {
        console.error(chalk_1.default.red('Error: API key required.\n') +
            chalk_1.default.dim('  Pass --key <key> or set POLYCLI_API_KEY.'));
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
        spinner.fail('Failed to parse "buildtranslator.json".');
        process.exit(1);
    }
    spinner.succeed('Configuration loaded.');
    const excluded = new Set((config.aiReviewerExclude ?? []).map(l => l.toLowerCase()));
    const langsToReview = config.targetLanguages.filter(l => !excluded.has(l.toLowerCase()));
    const skippedLangs = config.targetLanguages.filter(l => excluded.has(l.toLowerCase()));
    if (langsToReview.length === 0) {
        console.log(chalk_1.default.yellow('All target languages are excluded from review. Nothing to do.'));
        return;
    }
    if (skippedLangs.length > 0) {
        console.log(chalk_1.default.dim(`Review skipped for: ${skippedLangs.join(', ')}`));
    }
    // ── JSON phase ───────────────────────────────────────────────────────────────
    if (config.localesPath) {
        const localesPath = path_1.default.resolve(process.cwd(), config.localesPath);
        const sourceFile = path_1.default.join(localesPath, `${config.sourceLanguage}.json`);
        if (!fs_1.default.existsSync(sourceFile)) {
            console.log(chalk_1.default.yellow(`JSON source not found at ${sourceFile} — skipping JSON review.`));
        }
        else {
            const sourceJson = JSON.parse(fs_1.default.readFileSync(sourceFile, 'utf8'));
            for (const lang of langsToReview) {
                const targetFile = path_1.default.join(localesPath, `${lang}.json`);
                if (!fs_1.default.existsSync(targetFile)) {
                    console.log(chalk_1.default.dim(`  ${lang}.json not found — skipping.`));
                    continue;
                }
                const targetJson = JSON.parse(fs_1.default.readFileSync(targetFile, 'utf8'));
                const sourceCandidates = collectReviewCandidates(sourceJson, REVIEW_WORD_THRESHOLD);
                if (sourceCandidates.length === 0) {
                    console.log(chalk_1.default.dim(`  JSON → ${lang}: no strings exceed ${REVIEW_WORD_THRESHOLD} words — skipping.`));
                    continue;
                }
                let totalDeducted = 0;
                for (const { keyPath, value: sourceVal } of sourceCandidates) {
                    const keys = keyPath.split('.');
                    let cur = targetJson;
                    for (const k of keys)
                        cur = cur?.[k];
                    const translatedVal = typeof cur === 'string' ? cur : '';
                    if (!translatedVal) {
                        console.log(chalk_1.default.dim(`  → "${keyPath}" skipped (no translation found)`));
                        continue;
                    }
                    spinner.start(`  Reviewing "${keyPath}" → ${lang}...`);
                    try {
                        const result = await callReviewApi(apiKey, sourceVal, translatedVal, config.sourceLanguage, lang, 'json', { context: config.context, tone: config.tone });
                        setNestedValue(targetJson, keyPath, result.polishedText);
                        totalDeducted += result.wordsConsumed;
                        const afterScore = result.scoreAfter ?? result.qualityScore;
                        spinner.succeed(`  "${keyPath}" score ${result.qualityScore} → ${afterScore} (${result.issues.length} issue(s), ${result.wordsConsumed} credits)`);
                    }
                    catch (err) {
                        spinner.fail(`  "${keyPath}" failed: ${err instanceof Error ? err.message : String(err)}`);
                        process.exit(1);
                    }
                }
                fs_1.default.writeFileSync(targetFile, JSON.stringify(targetJson, null, 2), 'utf8');
                console.log(chalk_1.default.green(`  ${lang}.json updated. Total credits deducted: ${totalDeducted}`));
            }
        }
    }
    // ── Markdown phase ────────────────────────────────────────────────────────────
    if (config.markdownPath) {
        const mdPath = path_1.default.resolve(process.cwd(), config.markdownPath);
        const sourceLangDir = path_1.default.join(mdPath, config.sourceLanguage);
        if (!fs_1.default.existsSync(sourceLangDir)) {
            console.log(chalk_1.default.yellow(`Markdown source dir not found: ${sourceLangDir} — skipping markdown review.`));
        }
        else {
            const mdFiles = fs_1.default.readdirSync(sourceLangDir).filter(f => f.endsWith('.md'));
            for (const lang of langsToReview) {
                for (const filename of mdFiles) {
                    const sourcePath = path_1.default.join(sourceLangDir, filename);
                    const targetPath = path_1.default.join(mdPath, lang, filename);
                    if (!fs_1.default.existsSync(targetPath)) {
                        console.log(chalk_1.default.dim(`  ${lang}/${filename} not found — skipping.`));
                        continue;
                    }
                    const sourceContent = fs_1.default.readFileSync(sourcePath, 'utf8');
                    const translatedContent = fs_1.default.readFileSync(targetPath, 'utf8');
                    spinner.start(`  Reviewing ${lang}/${filename}...`);
                    try {
                        const result = await callReviewApi(apiKey, sourceContent, translatedContent, config.sourceLanguage, lang, 'markdown', { context: config.context, tone: config.tone });
                        fs_1.default.writeFileSync(targetPath, result.polishedText, 'utf8');
                        const afterScore = result.scoreAfter ?? result.qualityScore;
                        spinner.succeed(`  ${lang}/${filename} score ${result.qualityScore} → ${afterScore} (${result.issues.length} issue(s), ${result.wordsConsumed} credits)`);
                    }
                    catch (err) {
                        spinner.fail(`  ${lang}/${filename} failed: ${err instanceof Error ? err.message : String(err)}`);
                        process.exit(1);
                    }
                }
            }
        }
    }
    // ── ARB phase ─────────────────────────────────────────────────────────────────
    // parseArb returns: { locale, translatableKeys, metadata, keyOrder }
    // reconstructArb(existingTranslated, newTranslations, metadata, targetLocale, keyOrder, translatedDescriptions|null)
    if (config.arbPath) {
        const prefix = config.arbPrefix ?? 'app';
        const arbPath = path_1.default.resolve(process.cwd(), config.arbPath);
        const sourceFile = path_1.default.join(arbPath, `${prefix}_${config.sourceLanguage}.arb`);
        if (!fs_1.default.existsSync(sourceFile)) {
            console.log(chalk_1.default.yellow(`ARB source not found at ${sourceFile} — skipping ARB review.`));
        }
        else {
            const source = (0, arb_1.parseArb)(fs_1.default.readFileSync(sourceFile, 'utf8'));
            for (const lang of langsToReview) {
                const targetFile = path_1.default.join(arbPath, `${prefix}_${lang}.arb`);
                if (!fs_1.default.existsSync(targetFile)) {
                    console.log(chalk_1.default.dim(`  ${prefix}_${lang}.arb not found — skipping.`));
                    continue;
                }
                const targetArb = (0, arb_1.parseArb)(fs_1.default.readFileSync(targetFile, 'utf8'));
                const candidates = Object.entries(source.translatableKeys).filter(([, v]) => countWords(v) > REVIEW_WORD_THRESHOLD);
                if (candidates.length === 0) {
                    console.log(chalk_1.default.dim(`  ARB → ${lang}: no strings exceed ${REVIEW_WORD_THRESHOLD} words — skipping.`));
                    continue;
                }
                let totalDeducted = 0;
                for (const [key, sourceVal] of candidates) {
                    const translatedVal = targetArb.translatableKeys[key] ?? '';
                    if (!translatedVal) {
                        console.log(chalk_1.default.dim(`  → "${key}" skipped (no translation)`));
                        continue;
                    }
                    spinner.start(`  ARB reviewing "${key}" → ${lang}...`);
                    try {
                        const result = await callReviewApi(apiKey, sourceVal, translatedVal, config.sourceLanguage, lang, 'arb', { context: config.context, tone: config.tone });
                        targetArb.translatableKeys[key] = result.polishedText;
                        totalDeducted += result.wordsConsumed;
                        const afterScore = result.scoreAfter ?? result.qualityScore;
                        spinner.succeed(`  "${key}" score ${result.qualityScore} → ${afterScore} (${result.issues.length} issue(s), ${result.wordsConsumed} credits)`);
                    }
                    catch (err) {
                        spinner.fail(`  ARB "${key}" failed: ${err instanceof Error ? err.message : String(err)}`);
                        process.exit(1);
                    }
                }
                // Pass empty existingTranslated so all keys come from the updated targetArb.translatableKeys
                const output = (0, arb_1.reconstructArb)({}, targetArb.translatableKeys, targetArb.metadata, lang, targetArb.keyOrder, null);
                fs_1.default.writeFileSync(targetFile, output, 'utf8');
                console.log(chalk_1.default.green(`  ${prefix}_${lang}.arb updated. Total credits deducted: ${totalDeducted}`));
            }
        }
    }
    console.log(chalk_1.default.bold.green('\nReview complete.'));
}
