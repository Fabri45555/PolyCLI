"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initCommand = initCommand;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const readline_1 = __importDefault(require("readline"));
const chalk_1 = __importDefault(require("chalk"));
async function initCommand() {
    const rl = readline_1.default.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    const question = (query) => new Promise((resolve) => rl.question(chalk_1.default.blueBright(query), resolve));
    console.log(chalk_1.default.bold('\nWelcome to PolyCLI! Let\'s set up your translation config.\n'));
    // ── Merge behavior: read existing config as defaults ──────────────────────
    const configPath = path_1.default.resolve(process.cwd(), 'buildtranslator.json');
    let existingConfig = {};
    if (fs_1.default.existsSync(configPath)) {
        try {
            existingConfig = JSON.parse(fs_1.default.readFileSync(configPath, 'utf8'));
            console.log(chalk_1.default.yellow('Existing config found — press Enter to keep current values.\n'));
        }
        catch {
            console.log(chalk_1.default.yellow('Could not read existing config — starting fresh.\n'));
        }
    }
    // ── Core prompts ──────────────────────────────────────────────────────────
    const defaultSource = existingConfig.sourceLanguage || 'it';
    const sourceLangRaw = await question(`Source language [default: ${defaultSource}]: `);
    const sourceLang = sourceLangRaw.trim() || defaultSource;
    const defaultTargets = existingConfig.targetLanguages?.join(',') || 'en,es';
    const targetLangsRaw = await question(`Target languages, comma-separated [default: ${defaultTargets}]: `);
    const targetLangsStr = targetLangsRaw.trim() || defaultTargets;
    const defaultLocales = existingConfig.localesPath || './locales';
    const localesFolderRaw = await question(`JSON locales folder path [default: ${defaultLocales}]: `);
    const localesFolder = localesFolderRaw.trim() || defaultLocales;
    // ── Markdown support ──────────────────────────────────────────────────────
    const defaultMarkdown = existingConfig.markdownPath;
    const wantsMarkdown = await question(`\nDo you want to translate Markdown files?${defaultMarkdown ? ` (current: ${defaultMarkdown})` : ''} (y/N): `);
    let markdownFolder = defaultMarkdown;
    if (wantsMarkdown.trim().toLowerCase() === 'y') {
        const mdPath = await question(`Markdown files folder path [default: ${defaultMarkdown || './docs'}]\n` +
            chalk_1.default.gray('  Expected structure: <path>/<sourceLanguage>/*.md\n' +
                '  Output:            <path>/<targetLanguage>/*.md\n') +
            chalk_1.default.blueBright('  Path: '));
        markdownFolder = mdPath.trim() || defaultMarkdown || './docs';
    }
    // ── ARB support ───────────────────────────────────────────────────────────
    const defaultArbPath = existingConfig.arbPath;
    const defaultArbPrefix = existingConfig.arbPrefix ?? 'app';
    const defaultTranslateDescriptions = existingConfig.translateArbDescriptions ?? false;
    const wantsArb = await question(`\nDo you want to translate Flutter .arb files?${defaultArbPath ? ` (current: ${defaultArbPath})` : ''} (y/N): `);
    let arbFolder = defaultArbPath;
    let arbPrefix = defaultArbPrefix;
    let translateArbDescriptions = defaultTranslateDescriptions;
    if (wantsArb.trim().toLowerCase() === 'y') {
        const arbPathRaw = await question(`ARB files folder path [default: ${defaultArbPath || './lib/l10n'}]\n` +
            chalk_1.default.gray(`  Expected file: <path>/${defaultArbPrefix}_<sourceLanguage>.arb\n` +
                `  Output:        <path>/${defaultArbPrefix}_<targetLanguage>.arb\n`) +
            chalk_1.default.blueBright('  Path: '));
        arbFolder = arbPathRaw.trim() || defaultArbPath || './lib/l10n';
        const arbPrefixRaw = await question(`ARB filename prefix [default: ${defaultArbPrefix}]: `);
        arbPrefix = arbPrefixRaw.trim() || defaultArbPrefix;
        const descRaw = await question(`Translate @key descriptions? Costs extra credits — descriptions are developer notes, not user-facing. (y/N): `);
        translateArbDescriptions = descRaw.trim().toLowerCase() === 'y';
    }
    // ── PHP variables prompt ──────────────────────────────────────────────────
    const defaultPhpVariables = existingConfig.phpVariables ?? false;
    const phpVariablesHint = defaultPhpVariables ? '(Y/n)' : '(y/N)';
    const phpVariablesRaw = await question(`\nEnable PHP/Laravel :variable protection? Protects :name, :count, :attribute, etc. ${phpVariablesHint}: `);
    const phpVariablesInput = phpVariablesRaw.trim().toLowerCase();
    const phpVariables = phpVariablesInput === ''
        ? defaultPhpVariables
        : phpVariablesInput === 'y';
    // ── Tone prompt ───────────────────────────────────────────────────────────
    let toneInput = '';
    const defaultTone = existingConfig.tone || '';
    while (true) {
        const currentHint = defaultTone
            ? `, current: "${defaultTone.length > 40 ? defaultTone.slice(0, 40) + '...' : defaultTone}"`
            : '';
        const raw = await question(`\nTranslation tone/style (optional, max 200 chars${currentHint}, press Enter to skip): `);
        const typed = raw.trim();
        // Only fall back to defaultTone if it is itself valid (≤ 200 chars)
        const val = typed || (defaultTone.length <= 200 ? defaultTone : '');
        if (val.length > 200) {
            console.log(chalk_1.default.red(`  Tone is ${val.length} characters. Please keep it under 200.`));
            continue;
        }
        toneInput = val;
        break;
    }
    // ── doNotTranslate prompt ─────────────────────────────────────────────────
    const defaultDNT = (existingConfig.glossary?.doNotTranslate || []).join(', ');
    const dntRaw = await question(`Terms to never translate, comma-separated (e.g. MyBrand,Init,Run — press Enter to skip)${defaultDNT ? `\n  [current: ${defaultDNT}]` : ''}: `);
    const doNotTranslate = (dntRaw.trim() || defaultDNT)
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
    // ── preferredTranslations prompt ──────────────────────────────────────────
    let preferredTranslations = existingConfig.glossary?.preferredTranslations;
    const defaultPT = preferredTranslations ? JSON.stringify(preferredTranslations) : '';
    console.log(chalk_1.default.gray('\n  Preferred translations: JSON object, e.g. {"Early Bird":"use local idiom"}'));
    let retries = 0;
    while (retries < 3) {
        const raw = await question(`Preferred translations as JSON${defaultPT ? ' (Enter to keep current)' : ' (Enter to skip)'}: `);
        const val = raw.trim();
        if (!val && defaultPT)
            break; // keep existing
        if (!val)
            break; // skip
        try {
            preferredTranslations = JSON.parse(val);
            break;
        }
        catch {
            retries++;
            console.log(chalk_1.default.red(`  Invalid JSON. ${3 - retries} attempt(s) left.`));
        }
    }
    if (retries === 3) {
        console.log(chalk_1.default.yellow('  Skipping preferredTranslations after 3 failed attempts.'));
    }
    // ── Cloud Glossary Sync prompt ─────────────────────────────────────────────
    const defaultGlossarySync = existingConfig.glossarySync ?? false;
    const defaultTeamId = existingConfig.teamId ?? '';
    const glossarySyncHint = defaultGlossarySync ? '(Y/n)' : '(y/N)';
    const glossarySyncRaw = await question(`\nEnable cloud glossary sync? Fetches shared team glossary before translating. ${glossarySyncHint}: `);
    const glossarySyncInput = glossarySyncRaw.trim().toLowerCase();
    const glossarySync = glossarySyncInput === ''
        ? defaultGlossarySync
        : glossarySyncInput === 'y';
    let teamId = defaultTeamId;
    if (glossarySync) {
        const teamIdRaw = await question(`Team ID (UUID from your PolyCLI dashboard)${defaultTeamId ? ` [current: ${defaultTeamId}]` : ''}: `);
        teamId = teamIdRaw.trim() || defaultTeamId;
        if (!teamId) {
            console.log(chalk_1.default.yellow('  No team ID provided — glossary sync will be disabled.'));
        }
    }
    rl.close();
    // ── Build config ──────────────────────────────────────────────────────────
    const targetLangs = targetLangsStr
        .split(',')
        .map((l) => l.trim())
        .filter((l) => l !== '');
    const config = {
        ...existingConfig,
        sourceLanguage: sourceLang,
        targetLanguages: targetLangs.length ? targetLangs : ['en', 'es'],
        localesPath: localesFolder,
    };
    if (markdownFolder) {
        config.markdownPath = markdownFolder;
    }
    if (arbFolder) {
        config.arbPath = arbFolder;
        config.arbPrefix = arbPrefix;
        config.translateArbDescriptions = translateArbDescriptions;
    }
    if (phpVariables) {
        config.phpVariables = true;
    }
    else {
        delete config.phpVariables;
    }
    if (toneInput)
        config.tone = toneInput;
    if (doNotTranslate.length || preferredTranslations) {
        config.glossary = {};
        if (doNotTranslate.length)
            config.glossary.doNotTranslate = doNotTranslate;
        if (preferredTranslations)
            config.glossary.preferredTranslations = preferredTranslations;
    }
    if (glossarySync && teamId) {
        config.glossarySync = true;
        config.teamId = teamId;
    }
    else {
        delete config.glossarySync;
        delete config.teamId;
    }
    fs_1.default.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    console.log(chalk_1.default.green(`\nConfiguration saved to ${configPath}`));
    // Print a summary of what was configured
    console.log(chalk_1.default.gray(`  Source:  ${config.sourceLanguage}`));
    console.log(chalk_1.default.gray(`  Targets: ${config.targetLanguages.join(', ')}`));
    console.log(chalk_1.default.gray(`  JSON:    ${config.localesPath}`));
    if (config.markdownPath) {
        console.log(chalk_1.default.gray(`  Markdown: ${config.markdownPath}/${config.sourceLanguage}/*.md`));
    }
    if (config.arbPath) {
        console.log(chalk_1.default.gray(`  ARB:      ${config.arbPath}/${config.arbPrefix}_${config.sourceLanguage}.arb`));
    }
    if (config.phpVariables) {
        console.log(chalk_1.default.gray(`  PHP variables: enabled (:name, :count, etc. are protected)`));
    }
    if (config.tone) {
        console.log(chalk_1.default.gray(`  Tone:    ${config.tone.slice(0, 60)}${config.tone.length > 60 ? '...' : ''}`));
    }
    if (config.glossary?.doNotTranslate?.length) {
        console.log(chalk_1.default.gray(`  No-translate: ${config.glossary.doNotTranslate.join(', ')}`));
    }
    if (config.glossarySync && config.teamId) {
        console.log(chalk_1.default.gray(`  Cloud sync:  enabled (team: ${config.teamId})`));
    }
    console.log(chalk_1.default.bold('\nRun ' + chalk_1.default.cyan('polycli run --key <YOUR_API_KEY>') + ' to sync translations.'));
}
