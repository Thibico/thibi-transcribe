import { renderAsrReport, writeAsrReport } from '../report/asr.js';
import type { AsrRunResult } from '../runner.js';
import {
  buildTiersFile,
  diffTiers,
  loadHumanReviews,
  readTiersFile,
  writeTiersFile,
  type TierChange,
  type TiersFile,
} from './tiers.js';

/**
 * Turn a finished run into the two files anyone else reads, and decide whether it is
 * allowed to.
 *
 * One function, two callers — a live run and `thibi eval report --run` — because the
 * alternative is two answers to "what tier is this", which is the drift the whole harness
 * exists to prevent. It makes no network calls at all: everything it needs is the run
 * result, the previous file and whatever sign-offs are on disk.
 */

export interface PublishResult {
  tiers: TiersFile;
  changes: TierChange[];
  reportPath: string;
  /** Null when the baseline is suspect and the file was deliberately not written. */
  tiersPath: string | null;
  /** 0, or 4 when a suspect baseline blocked the write. */
  exitCode: 0 | 4;
}

export async function publishRun(
  resultsDir: string,
  run: AsrRunResult,
  engineVersion: string,
): Promise<PublishResult> {
  const previous = await readTiersFile(resultsDir);
  const { current, stale } = await loadHumanReviews(resultsDir, run.runId);
  const tiers = buildTiersFile({ run, engineVersion, previous, humanReviews: current });
  const changes = diffTiers(previous, tiers);

  /**
   * The report is written either way, and that is deliberate.
   *
   * A suspect baseline blocks `tiers.json` because every ratio in it is against a number
   * that moved. It is not a reason to withhold the numbers themselves — the person who has
   * to investigate the baseline needs to see it, and the report carries the banner saying
   * the tiers were not published.
   */
  const date = tiers.generatedAt.slice(0, 10);
  const reportPath = await writeAsrReport(
    resultsDir,
    date,
    renderAsrReport({ tiers, previous, changes, staleReviews: stale }),
  );

  if (tiers.baseline.suspect) {
    return { tiers, changes, reportPath, tiersPath: null, exitCode: 4 };
  }
  return {
    tiers,
    changes,
    reportPath,
    tiersPath: await writeTiersFile(resultsDir, tiers),
    exitCode: 0,
  };
}
