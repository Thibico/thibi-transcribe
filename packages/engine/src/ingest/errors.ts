import { EngineError } from '../errors.js';

/**
 * Ingest failure codes.
 *
 * These are a contract, not log strings: the CLI maps them to exit codes and Phase 11 maps
 * them to copy, so renaming one is a breaking change. The split that matters is who can act
 * on the failure — `ffprobe_missing` and `store_failed` are the operator's, everything else
 * belongs to whoever submitted the file, and answering one with the other is the defect this
 * taxonomy exists to prevent.
 */
export type IngestErrorCode =
  // The submitter's problem — a 4xx, and the message names the file.
  | 'bad_filename'
  | 'unsupported_type'
  | 'file_too_large'
  | 'sha_mismatch'
  | 'no_audio_stream'
  | 'unreadable_media'
  | 'empty_body'
  // The operator's problem — a 5xx, and the message must not blame the file.
  | 'ffprobe_missing'
  | 'store_failed';

const OPERATOR_FAULT: ReadonlySet<IngestErrorCode> = new Set<IngestErrorCode>([
  'ffprobe_missing',
  'store_failed',
]);

export class IngestError extends EngineError {
  /**
   * Only a failed store write is worth trying again.
   *
   * Every other code describes something about the submission itself — its name, its type,
   * its size, its content hash, whether it contains audio — and none of that changes by
   * repeating the request. `ffprobe_missing` is excluded too: it is real and the operator must
   * fix it, but retrying the upload will not, and a retry loop against a missing binary just
   * uploads the file again.
   */
  readonly retryable: boolean;

  constructor(
    readonly code: IngestErrorCode,
    message: string,
    hint?: string,
  ) {
    super(message, hint !== undefined ? { hint } : undefined);
    this.retryable = code === 'store_failed';
  }

  /**
   * True when only an operator can fix this.
   *
   * The HTTP layer turns this into 5xx vs 4xx and the CLI into a different exit code. It is a
   * property of the code rather than a flag each throw site sets, because a throw site that
   * can forget it will.
   */
  get isOperatorFault(): boolean {
    return OPERATOR_FAULT.has(this.code);
  }
}
