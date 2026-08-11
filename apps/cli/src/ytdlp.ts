import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { YtDlpPort } from '@thibi/engine';

const execFileP = promisify(execFile);

/**
 * The real yt-dlp, behind the engine's port.
 *
 * `execFile`/`spawn` with an argv array and never a shell: the URL is attacker-influenced by
 * definition, and a template string here would be a command injection with a newsroom's
 * server on the other end. There is no `shell: true` anywhere in this file, deliberately.
 *
 * The binary path is configuration rather than a constant so an image can pin a version, but
 * it is the *only* thing about the command a caller can influence — the port takes argv, not
 * a program name.
 */
export function createYtDlpPort(binPath: string): YtDlpPort {
  return {
    async run(args, opts) {
      const { stdout, stderr } = await execFileP(binPath, args, {
        ...(opts?.signal ? { signal: opts.signal } : {}),
        maxBuffer: opts?.maxBuffer ?? 8 << 20,
      });
      return { stdout, stderr };
    },

    spawn(args, opts) {
      const child = nodeSpawn(binPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
      const done = new Promise<void>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code, signal) => {
          if (code === 0) {
            resolve();
            return;
          }
          reject(
            new Error(
              signal
                ? `yt-dlp was killed by ${signal}`
                : `yt-dlp exited with code ${code ?? 'unknown'}`,
            ),
          );
        });
      });
      return { stdout: child.stdout, stderr: child.stderr, done };
    },
  };
}
