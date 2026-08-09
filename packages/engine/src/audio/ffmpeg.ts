import { execFile, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { FfmpegPort } from '../context.js';
import { AbortedError, FfmpegError } from '../errors.js';

export interface FfmpegPaths {
  ffmpeg: string;
  ffprobe: string;
}

/**
 * The real ffmpeg port.
 *
 * Constructed by the caller with explicit binary paths — the engine does not read
 * `FFMPEG_PATH` itself. Tests substitute a fake that replays recorded stdout and stderr,
 * which is what lets the whole pipeline be tested without audio.
 */
export function createFfmpegPort(paths: FfmpegPaths): FfmpegPort {
  const binaryFor = (bin: 'ffmpeg' | 'ffprobe'): string =>
    bin === 'ffmpeg' ? paths.ffmpeg : paths.ffprobe;

  return {
    run(bin, args, opts = {}) {
      return new Promise((resolve, reject) => {
        execFile(
          binaryFor(bin),
          args,
          {
            // silencedetect on a two-hour file produces a lot of stderr; the old code's
            // 10 MB was measured against real input and is kept.
            maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
            ...(opts.signal ? { signal: opts.signal } : {}),
          },
          (error, stdout, stderr) => {
            if (!error) {
              resolve({ stdout: String(stdout), stderr: String(stderr) });
              return;
            }
            if ((error as NodeJS.ErrnoException).code === 'ABORT_ERR' || opts.signal?.aborted) {
              reject(new AbortedError());
              return;
            }
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              reject(
                new FfmpegError(
                  `${binaryFor(bin)} not found. Install ffmpeg, or set FFMPEG_PATH/FFPROBE_PATH.`,
                  String(stderr),
                  null,
                ),
              );
              return;
            }
            // ffmpeg's own stderr is the only useful diagnostic; never replace it with a guess.
            reject(
              new FfmpegError(
                `${bin} exited ${(error as { code?: number }).code ?? '?'}`,
                String(stderr),
                (error as { code?: number }).code ?? null,
              ),
            );
          },
        );
      });
    },

    spawn(bin, args, opts = {}) {
      const child = spawn(binaryFor(bin), args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(opts.signal ? { signal: opts.signal } : {}),
      });

      // stderr is drained rather than left to fill its pipe buffer: an undrained stderr
      // deadlocks ffmpeg once the OS buffer fills, and the failure looks like a hang.
      let stderrText = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderrText += chunk;
      });

      const done = new Promise<void>((resolve, reject) => {
        child.on('error', (err) =>
          reject(
            (err as NodeJS.ErrnoException).code === 'ABORT_ERR'
              ? new AbortedError()
              : new FfmpegError(err.message, stderrText, null),
          ),
        );
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new FfmpegError(`${bin} exited ${code}`, stderrText, code));
        });
      });

      return { stdout: child.stdout as Readable, stderr: child.stderr as Readable, done };
    },
  };
}
