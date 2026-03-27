#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const init_1 = require("./commands/init");
const run_1 = require("./commands/run");
const languages_1 = require("./commands/languages");
const review_1 = require("./commands/review");
const program = new commander_1.Command();
program
    .name('polycli')
    .description('A CLI for automating frontend JSON localizations using provider and delta comparisons.')
    .version('1.0.0');
program
    .command('init')
    .description('Initialize a buildtranslator.json configuration file.')
    .action(() => {
    (0, init_1.initCommand)().catch((err) => {
        console.error(err);
        process.exit(1);
    });
});
program
    .command('run')
    .description('Run the translation delta and sync changes.')
    .option('-k, --key <key>', 'Your PolyCLI API Key (or set POLYCLI_API_KEY env var).')
    .option('--review', 'Run AI Reviewer after translation (3× credit cost).')
    .action((options) => {
    (0, run_1.runCommand)(options).catch((err) => {
        console.error(err);
        process.exit(1);
    });
});
program
    .command('review')
    .description('Run the AI Reviewer Agent on existing translations.')
    .option('-k, --key <key>', 'Your PolyCLI API Key (or set POLYCLI_API_KEY env var).')
    .action((options) => {
    (0, review_1.reviewCommand)(options).catch((err) => {
        console.error(err);
        process.exit(1);
    });
});
program
    .command('languages')
    .description('List all supported languages and their ISO 639-1 codes.')
    .action(() => (0, languages_1.languagesCommand)());
program.parse();
