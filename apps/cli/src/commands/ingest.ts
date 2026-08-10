import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import {
  ALLOWED_EXTENSIONS,
  DEFAULT_URL_POLICY,
  IngestError,
  ingestBatch,
  ingestStream,
  resolveUrl,
  Semaphore,
  signResolveToken,
  downloadUrl,
  type BatchItem,
  type IngestBatchResult,
} from '@thibi/engine';
import { resolveRate } from '@thibi/db';
import { buildContext } from '../context.js';
import { readEnv } from '../config.js';
import { createYtDlpPort } from '../ytdlp.js';

const ENGINE_VERSION = 'phase-8';

interface Candidate {
  path: string;
  filename: string;
  bytes: number;
  /** Null means "not a supported media file" — listed and skipped, never silently dropped. */
  skipReason: string | null;
}

export function ingestCommand(): Command {
  return new Command('ingest')
    .description('Bring media into the system: a file, a directory, a manifest, or a URL')
    .argument('[paths...]', 'files or directories to ingest')
    .option('--url <url>', 'import from a URL via yt-dlp')
    .option('--manifest <csv>', 'a CSV of path,title,language,provider,model')
    .option('--project <name>', 'project name; created if it does not exist')
    .option('-l, --lang <code>', 'language for every file, unless a manifest overrides it')
    .option('-p, --provider <id>', 'provider id', 'google')
    .option('-m, --model <id>', 'provider model', 'chirp_2')
    .option('--dry-run', 'print the table and the estimate, create nothing')
    .option('-y, --yes', 'skip the confirmation prompt')
    .option('--recursive', 'walk subdirectories; without it, one level')
    .option('-c, --concurrency <n>', 'parallel uploads', (v) => Number.parseInt(v, 10), 3)
    .option('--resolve-only', 'with --url: print the metadata as JSON and exit')
    .action(async (paths: string[], opts: Record<string, unknown>) => {
      const env = readEnv();
      const cli = await buildContext({ engineVersion: ENGINE_VERSION });
      try {
        if (opts['url']) {
          await runUrlImport(cli, env, String(opts['url']), opts);
          return;
        }
        await runFileIngest(cli, env, paths, opts);
      } catch (err) {
        // IngestError codes exist so a caller can respond to the *kind* of failure. Letting
        // one reach the default handler prints a stack trace at a journalist, and loses the
        // distinction the taxonomy was built for: exit 3 is "your file or URL", exit 4 is
        // "this server is misconfigured" and no amount of retrying will change it.
        if (err instanceof IngestError) {
          process.stderr.write(`\nerror [${err.code}]: ${err.message}\n`);
          if (err.hint) process.stderr.write(`  ${err.hint}\n`);
          if (err.isOperatorFault) {
            process.stderr.write('  This is a server configuration problem, not a problem with your file.\n');
          }
          process.exitCode = err.isOperatorFault ? 4 : 3;
          return;
        }
        throw err;
      } finally {
        await cli.close();
      }
    });
}

// ---------------------------------------------------------------------------- file / directory

async function runFileIngest(
  cli: Awaited<ReturnType<typeof buildContext>>,
  env: ReturnType<typeof readEnv>,
  paths: string[],
  opts: Record<string, unknown>,
): Promise<void> {
  const manifest = opts['manifest'] ? await readManifest(String(opts['manifest'])) : null;
  const roots = manifest ? manifest.map((m) => m.path) : paths;
  if (roots.length === 0) {
    fail('Nothing to ingest. Give a file, a directory, --manifest, or --url.');
  }

  const candidates = await collect(roots, Boolean(opts['recursive']));
  if (candidates.length === 0) fail('No files found.');

  const lang = String(opts['lang'] ?? '');
  if (!lang) fail('--lang is required (or give every manifest row a language).');

  const usable = candidates.filter((c) => c.skipReason === null);
  const skipped = candidates.filter((c) => c.skipReason !== null);

  // Uploaded first, then priced, then confirmed: the estimate needs the durations, and the
  // durations come from probing what was actually stored.
  process.stderr.write(`  scanning … ${candidates.length} candidates\n\n`);
  const uploaded = await uploadAll(cli, env, usable, Number(opts['concurrency'] ?? 3));

  const allItems: BatchItem[] = uploaded.map((u) => {
    const row = manifest?.find((m) => basename(m.path) === u.filename);
    return {
      assetId: u.assetId,
      title: row?.title ?? u.filename,
      ...(row?.language ? { languageCode: row.language } : {}),
      ...(row?.provider ? { providerId: row.provider } : {}),
      ...(row?.model ? { model: row.model } : {}),
    };
  });

  // Two files with identical bytes are one recording, so they are one asset and — because the
  // batch index is unique on (project, batch, asset) — one job. Collapsing here rather than
  // letting the index silently drop the second keeps the table and the job count honest:
  // otherwise the CLI lists four files, promises four jobs, and creates three.
  const seen = new Set<string>();
  const items = allItems.filter((i) => !seen.has(i.assetId) && seen.add(i.assetId));
  const collapsed = allItems.length - items.length;

  const batchKey = randomUUID();
  const project = opts['project']
    ? { name: String(opts['project']) }
    : null;

  const preview = await ingestBatch(cli.ctx, {
    batchKey,
    project: project ?? { name: 'Inbox' },
    defaults: {
      languageCode: lang,
      providerId: String(opts['provider']),
      model: String(opts['model']),
    },
    items,
    confirm: false,
  });

  printTable(preview, uploaded, skipped, opts);
  if (collapsed > 0) {
    process.stderr.write(
      `  ${collapsed} file${collapsed === 1 ? '' : 's'} had identical content to another and ` +
        `will share its job\n`,
    );
  }

  if (opts['dryRun']) {
    process.stderr.write('\n  --dry-run: no jobs created.\n');
    return;
  }
  if (!opts['yes'] && !(await confirm(`  Create ${items.length} jobs?`))) {
    process.stderr.write('  cancelled.\n');
    process.exitCode = 1;
    return;
  }

  const created = await ingestBatch(cli.ctx, {
    batchKey,
    project: project ?? { name: 'Inbox' },
    defaults: {
      languageCode: lang,
      providerId: String(opts['provider']),
      model: String(opts['model']),
    },
    items,
    confirm: true,
  });

  process.stderr.write(`\n  created ${created.jobs.filter((j) => j.created).length} jobs\n`);
  for (const job of created.jobs) process.stdout.write(`${job.id}\t${job.title}\n`);
}

interface Uploaded {
  assetId: string;
  filename: string;
  deduped: boolean;
  durationMs: number | null;
}

async function uploadAll(
  cli: Awaited<ReturnType<typeof buildContext>>,
  env: ReturnType<typeof readEnv>,
  candidates: Candidate[],
  concurrency: number,
): Promise<Uploaded[]> {
  const out: Uploaded[] = [];
  const queue = [...candidates];
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      // Always pre-hash: the file is local, reading it twice is cheap next to uploading it
      // once, and a duplicate then costs a lookup instead of a transfer.
      const sha = await sha256File(item.path);
      const asset = await ingestStream(cli.ctx, {
        stream: createReadStream(item.path),
        filename: item.filename,
        contentType: mimeFor(item.filename),
        declaredSha: sha,
        source: 'batch',
        maxBytes: env.maxUploadBytes,
      });
      out.push({
        assetId: asset.id,
        filename: item.filename,
        deduped: asset.deduped,
        durationMs: asset.durationMs,
      });
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------------------------- URL import

async function runUrlImport(
  cli: Awaited<ReturnType<typeof buildContext>>,
  env: ReturnType<typeof readEnv>,
  url: string,
  opts: Record<string, unknown>,
): Promise<void> {
  if (!env.ingestUrlEnabled) fail('URL import is disabled on this instance.');
  if (!env.appSecretKey) {
    fail(
      'APP_SECRET_KEY is not set. URL import signs the estimate you approve so the cost cannot\n' +
        '  change between resolving and downloading. Generate one with:\n\n' +
        '    openssl rand -base64 48\n',
    );
  }

  const policy = {
    ...DEFAULT_URL_POLICY,
    enabled: env.ingestUrlEnabled,
    allowedHosts: env.ingestUrlAllowedHosts,
  };
  const ytdlp = createYtDlpPort(env.ytDlpPath);

  process.stderr.write('  resolving metadata (no media downloaded) …\n\n');
  const resolved = await resolveUrl({ ytdlp, policy, clock: cli.ctx.clock }, url);

  if (opts['resolveOnly']) {
    process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
    return;
  }

  const lang = String(opts['lang'] ?? '');
  const rate = cli.db
    ? await resolveRate(cli.db, {
        providerId: String(opts['provider']),
        model: String(opts['model']),
        unit: 'minute',
      })
    : null;
  const estimateUsd = rate ? (resolved.durationMs / 60_000) * rate.usdPerUnit : null;

  process.stderr.write(`  title     ${resolved.title}\n`);
  process.stderr.write(`  uploader  ${resolved.uploader ?? '—'}\n`);
  process.stderr.write(`  uploaded  ${resolved.uploadDate ?? '—'}\n`);
  process.stderr.write(`  duration  ${hms(resolved.durationMs)}\n`);
  process.stderr.write(`  source    ${resolved.extractor} · ${resolved.webpageUrl}\n\n`);
  process.stderr.write(
    `  estimate  ${String(opts['provider'])}/${String(opts['model'])} · ${lang || '—'} · ` +
      `${estimateUsd === null ? 'unpriced' : `$${estimateUsd.toFixed(2)}`}\n`,
  );
  process.stderr.write(
    '  note      transcription is NOT started; run `thibi transcribe --job <id>` when ready\n\n',
  );

  if (opts['dryRun']) {
    process.stderr.write('  --dry-run: nothing downloaded.\n');
    return;
  }
  // `--yes` skips the prompt but never the resolve: there is no path that downloads before
  // knowing the duration.
  if (!opts['yes'] && !(await confirm(`  Download ${hms(resolved.durationMs)} of audio?`))) {
    process.stderr.write('  cancelled.\n');
    process.exitCode = 1;
    return;
  }

  const token = signResolveToken(
    { url, durationMs: resolved.durationMs, estimateUsd },
    env.appSecretKey,
    cli.ctx.clock.now().getTime(),
  );

  const asset = await downloadUrl(
    cli.ctx,
    { ytdlp, policy, appSecret: env.appSecretKey, semaphore: new Semaphore(2) },
    { resolveToken: token, resolved },
  );

  if (!lang) {
    process.stderr.write(`\n  asset ${asset.id} stored. Give --lang to create a job.\n`);
    return;
  }
  const created = await ingestBatch(cli.ctx, {
    batchKey: randomUUID(),
    project: opts['project'] ? { name: String(opts['project']) } : { name: 'Imports' },
    defaults: {
      languageCode: lang,
      providerId: String(opts['provider']),
      model: String(opts['model']),
    },
    items: [{ assetId: asset.id, title: resolved.title }],
    confirm: true,
  });
  process.stderr.write(`\n  created job ${created.jobs[0]?.id ?? '—'} (no run started)\n`);
}

// ----------------------------------------------------------------------------------- utilities

async function collect(roots: string[], recursive: boolean): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const root of roots) {
    const abs = resolvePath(root);
    const info = await stat(abs).catch(() => null);
    if (!info) {
      out.push({ path: abs, filename: basename(abs), bytes: 0, skipReason: 'not found' });
      continue;
    }
    if (info.isDirectory()) {
      for (const entry of await readdir(abs, { withFileTypes: true })) {
        const child = join(abs, entry.name);
        if (entry.isDirectory()) {
          if (recursive) out.push(...(await collect([child], true)));
          continue;
        }
        out.push(await describe(child));
      }
      continue;
    }
    out.push(await describe(abs));
  }
  return out;
}

async function describe(path: string): Promise<Candidate> {
  const filename = basename(path);
  const ext = extname(filename).slice(1).toLowerCase();
  const info = await stat(path);
  return {
    path,
    filename,
    bytes: info.size,
    // A first filter only; ffprobe makes the real decision at ingest.
    skipReason: ALLOWED_EXTENSIONS.has(ext) ? null : 'unsupported type',
  };
}

interface ManifestRow {
  path: string;
  title?: string;
  language?: string;
  provider?: string;
  model?: string;
}

/** `path,title,language,provider,model` — path required, the rest inherit from the flags. */
async function readManifest(file: string): Promise<ManifestRow[]> {
  const text = await readFile(file, 'utf8');
  const rows: ManifestRow[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [path, title, language, provider, model] = trimmed.split(',').map((c) => c.trim());
    if (!path || path.toLowerCase() === 'path') continue;
    rows.push({
      path,
      ...(title ? { title } : {}),
      ...(language ? { language } : {}),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    });
  }
  return rows;
}

function printTable(
  preview: IngestBatchResult,
  uploaded: Uploaded[],
  skipped: Candidate[],
  opts: Record<string, unknown>,
): void {
  const w = Math.max(28, ...uploaded.map((u) => u.filename.length), ...skipped.map((s) => s.filename.length));
  process.stderr.write(`  ${'file'.padEnd(w)}  ${'duration'.padStart(9)}  ${'est. ASR'.padStart(10)}\n`);
  for (const item of preview.estimate.items) {
    const usd = item.usd === null ? (item.unpricedReason === 'no_rate' ? 'no rate' : '—') : `$${item.usd.toFixed(2)}`;
    process.stderr.write(
      `  ${item.filename.padEnd(w)}  ${hms(item.durationMs).padStart(9)}  ${usd.padStart(10)}\n`,
    );
  }
  // Listed, never silently dropped: a batch that quietly ingests 3 of 4 files is how a
  // newsroom loses an interview.
  for (const s of skipped) {
    process.stderr.write(`  ${s.filename.padEnd(w)}  ${'—'.padStart(9)}  ${s.skipReason!.padStart(10)}\n`);
  }
  process.stderr.write(`  ${'─'.repeat(w + 25)}\n`);
  process.stderr.write(
    `  ${String(preview.estimate.items.length).padEnd(w)}  ` +
      `${hms(preview.estimate.totalDurationMs).padStart(9)}  ` +
      `${`$${preview.estimate.totalUsd.toFixed(2)}`.padStart(10)}\n`,
  );
  const deduped = uploaded.filter((u) => u.deduped).length;
  if (deduped > 0) process.stderr.write(`  ${deduped} already stored (content matched)\n`);
  if (preview.estimate.unpriced.length > 0) {
    process.stderr.write(`  ${preview.estimate.unpriced.length} unpriced — not in the total\n`);
  }
  void opts;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function mimeFor(filename: string): string {
  const ext = extname(filename).slice(1).toLowerCase();
  return ALLOWED_EXTENSIONS.get(ext) ?? 'application/octet-stream';
}

function hms(ms: number | null): string {
  if (ms === null) return '—';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(2);
}

export { IngestError };
