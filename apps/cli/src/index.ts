#!/usr/bin/env node
import { Command } from 'commander';
import { GENERATED_AT } from '@thibi/languages';
import { loadDotEnv } from './config.js';
import { langCommand } from './commands/lang.js';
import { probeLanguagesCommand } from './commands/probe-languages.js';
import { transcribeCommand } from './commands/transcribe.js';
import { dbCommand } from './commands/db.js';
import { runsCommand } from './commands/runs.js';
import { speakersCommand } from './commands/speakers.js';
import { diarizeCommand } from './commands/diarize.js';
import { ingestCommand } from './commands/ingest.js';
import { providersCommand } from './commands/providers.js';
import { settingsCommand } from './commands/settings.js';
import { ProbeAbort } from './probe/types.js';
import { JobAssetMismatchError, JobNotFoundError } from '@thibi/engine';

loadDotEnv();

const program = new Command('thibi')
  .description('thibi-transcribe — multi-language transcription engine')
  .version(`registry generated ${GENERATED_AT}`)
  .showHelpAfterError();

program.addCommand(dbCommand());
program.addCommand(langCommand());
program.addCommand(transcribeCommand());
program.addCommand(runsCommand());
program.addCommand(speakersCommand());
program.addCommand(diarizeCommand());
program.addCommand(ingestCommand());
program.addCommand(providersCommand());
program.addCommand(settingsCommand());
program.addCommand(new Command('probe').description('Measure provider capabilities').addCommand(probeLanguagesCommand()));

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (
    err instanceof ProbeAbort ||
    err instanceof JobNotFoundError ||
    err instanceof JobAssetMismatchError
  ) {
    // The user got something wrong and the message says what. A stack trace here is noise
    // in front of the one line that helps — `--job` pointed at another recording, or at a
    // job that does not exist. Nothing has been written in any of these cases.
    //
    // Three of these now. A fourth should become a shared marker rather than a longer
    // condition.
    process.stderr.write(`\n${err.message}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  }
}
