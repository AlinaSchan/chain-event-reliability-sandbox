/**
 * Failure vocabulary shared by providers, the scanner and the API.
 * `RpcError.retryable` is the only thing the retry policy looks at.
 */

export type RpcErrorCode = 'TIMEOUT' | 'SERVER_ERROR' | 'INCONSISTENT';

export class RpcError extends Error {
  override readonly name = 'RpcError';
  constructor(
    readonly code: RpcErrorCode,
    message: string,
    readonly retryable = true,
  ) {
    super(message);
  }
}

/** Retries ran out. No state was changed; the next scan cycle starts from the stored checkpoint. */
export class RpcExhaustedError extends Error {
  override readonly name = 'RpcExhaustedError';
  constructor(
    readonly operation: string,
    readonly attempts: number,
    readonly last: RpcError,
  ) {
    super(`${operation} failed after ${attempts} attempts: ${last.message}`);
  }
}

/** The scanner refuses to write while halted; an operator has to look first. */
export class ScannerHaltedError extends Error {
  override readonly name = 'ScannerHaltedError';
}

/** A replay found a block whose hash differs from the stored canonical block: a reorg is pending, run a normal scan. */
export class ReplayMismatchError extends Error {
  override readonly name = 'ReplayMismatchError';
}

/** A batch did not attach to the stored chain. The scanner checks this before writing; the transaction checks it again. */
export class LinkageError extends Error {
  override readonly name = 'LinkageError';
}
