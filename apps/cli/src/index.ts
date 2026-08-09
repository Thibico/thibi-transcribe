#!/usr/bin/env node
import { Command } from 'commander';
import { GENERATED_AT } from '@thibi/languages';
import { loadDotEnv } from './config.js';
import { langCommand } from './commands/lang.js';
import { probeLanguagesCommand } from './commands/probe-languages.js';
import { ProbeAbort } from './probe/types.js';

loadDotEnv();

const program = new Command('thibi')
  .description('thibi-transcribe — multi-language transcription engine')
  .version(`registry generated ${GENERATED_AT}`)
  .showHelpAfterError();

program.addCommand(langCommand());
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
