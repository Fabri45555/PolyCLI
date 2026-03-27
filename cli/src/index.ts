#!/usr/bin/env node

import { Command } from 'commander';
import { initCommand } from './commands/init';
import { runCommand } from './commands/run';
import { languagesCommand } from './commands/languages';
import { reviewCommand } from './commands/review';

const program = new Command();

program
  .name('polycli')
  .description('A CLI for automating frontend JSON localizations using provider and delta comparisons.')
  .version('1.0.0');

program
  .command('init')
  .description('Initialize a buildtranslator.json configuration file.')
  .action(() => {
    initCommand().catch((err) => {
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
    runCommand(options).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  });

program
  .command('review')
  .description('Run the AI Reviewer Agent on existing translations.')
  .option('-k, --key <key>', 'Your PolyCLI API Key (or set POLYCLI_API_KEY env var).')
  .action((options) => {
    reviewCommand(options).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  });

program
  .command('languages')
  .description('List all supported languages and their ISO 639-1 codes.')
  .action(() => languagesCommand());

program.parse();
