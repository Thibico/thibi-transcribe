#!/usr/bin/env node
import { Command } from 'commander';
import { GENERATED_AT } from '@thibi/languages';
import { loadDotEnv } from './config.js';
import { langCommand } from './commands/lang.js';
import { probeLanguagesCommand } from './commands/probe-languages.js';
import { transcribeCommand } from './commands/transcribe.js';
import { dbCommand } from './commands/db.js';
import { runsCommand } from './commands/runs.js';
import { ingestCommand } from './commands/ingest.js';
import { settingsCommand } from './commands/settings.js';
import { ProbeAbort } from './probe/types.js';

loadDotEnv();

const program = new Command('thibi')
  .description('thibi-transcribe — multi-language transcription engine')
  .version(`registry generated ${GENERATED_AT}`)
  .showHelpAfterError();

program.addCommand(dbCommand());
program.addCommand(langCommand());
program.addCommand(transcribeCommand());
program.addCommand(runsCommand());
program.addCommand(ingestCommand());
program.addCommand(settingsCommand());
program.addCommand(new Command('probe').description('Measure provider capabilities').addCommand(probeLanguagesCommand()));

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof ProbeAbort) {
    // A configuration or credentials failure. Nothing has been written.
    process.stderr.write(`\n${err.message}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  }
}
