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
import { modelsCommand } from './commands/models.js';
import { ingestCommand } from './commands/ingest.js';
import { providersCommand } from './commands/providers.js';
import { settingsCommand } from './commands/settings.js';
import { evalCommand } from './commands/eval.js';
import { isUserFacing } from '@thibi/engine';

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
program.addCommand(modelsCommand());
program.addCommand(ingestCommand());
program.addCommand(providersCommand());
program.addCommand(settingsCommand());
program.addCommand(evalCommand());
program.addCommand(new Command('probe').description('Measure provider capabilities').addCommand(probeLanguagesCommand()));

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (isUserFacing(err)) {
    // The message says what went wrong and what to do about it. A stack trace here is noise
    // in front of the one line that helps — `--job` pointed at another recording, a key is
    // missing, `THIBI_TMP_DIR` points nowhere. Nothing has been written in any of these
    // cases.
    //
    // This was an `instanceof` chain of three with a note saying a fourth should become a
    // shared marker. The fourth was `NotConfiguredError` escaping from `buildContext`,
    // which is called *outside* every command's try block — so the errors that already had
    // careful per-command handling still reached here as traces whenever they were raised
    // while assembling the context. Marking the class fixes every such site at once.
    process.stderr.write(`\n${err.message}\n${err.hint ? `${err.hint}\n` : ''}`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  }
}
