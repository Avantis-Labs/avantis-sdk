/**
 * Typed error taxonomy for the Avantis SDK.
 *
 * Every failure surface (tx-builder envelope errors, relayer failures, RPC
 * errors, signing mismatches, local validation) maps to one of these classes
 * so callers can handle them programmatically.
 */

/** Base class for all SDK errors. */
export class AvantisError extends Error {
  override name = "AvantisError";
}

/** Invalid or incomplete SDK configuration. */
export class ConfigError extends AvantisError {
  override name = "ConfigError";
}

export interface ApiErrorOptions {
  code?: string;
  status?: number;
  details?: unknown;
  url?: string;
}

/**
 * An Avantis HTTP API returned an error envelope or bad status.
 *
 * Fields mirror the tx-builder error envelope:
 * `{ ok: false, error: { code, message, details } }`.
 */
export class ApiError extends AvantisError {
  override name = "ApiError";
  readonly code: string;
  readonly status?: number;
  readonly details?: unknown;
  readonly url?: string;

  constructor(message: string, options: ApiErrorOptions = {}) {
    super(message);
    this.code = options.code ?? "UNKNOWN";
    this.status = options.status;
    this.details = options.details;
    this.url = options.url;
  }
}

/** 400 VALIDATION_ERROR / BAD_REQUEST: pre-trade or request-shape failure. */
export class ValidationError extends ApiError {
  override name = "ValidationError";
}

/** 429 RATE_LIMITED. */
export class RateLimitedError extends ApiError {
  override name = "RateLimitedError";
}

/** 451 GEO_RESTRICTED. */
export class GeoRestrictedError extends ApiError {
  override name = "GeoRestrictedError";
}

/** Relay simulation reverted; `details` may carry the decoded error. */
export class SimulationFailedError extends ApiError {
  override name = "SimulationFailedError";
}

/** 502 UPSTREAM_ERROR / RPC_ERROR from the API side. */
export class UpstreamError extends ApiError {
  override name = "UpstreamError";
}

/** Local signing failure. */
export class SigningError extends AvantisError {
  override name = "SigningError";
}

/**
 * Locally computed EIP-712 digest differs from the API-provided digest.
 *
 * NEVER submit after this error: it means encoding drift between the SDK
 * and the API/contracts.
 */
export class DigestMismatchError extends SigningError {
  override name = "DigestMismatchError";
}

/**
 * Operator relayer rejected or failed a queued request.
 *
 * `code` is the machine-readable failure code when the batched-market stream
 * terminated with an `Error` event: a bare Avantis contract error name
 * (`WrongSl`, `HighSlippage`, ...) when execution decoded to a specific
 * revert, or a synthetic backend code (`NO_PRICE`, `SPREAD_UNAVAILABLE`,
 * `ATTEMPTS_EXHAUSTED`, `ENQUEUE_FAILED`, ...). Branch on it instead of
 * parsing the message; treat unknown codes as generic failures.
 */
export class RelayError extends AvantisError {
  override name = "RelayError";
  readonly requestId?: string;
  readonly code?: string;

  constructor(message: string, options: { requestId?: string; code?: string } = {}) {
    super(message);
    this.requestId = options.requestId;
    this.code = options.code;
  }
}

/** Relayer did not settle the request within the polling window. */
export class RelayTimeoutError extends RelayError {
  override name = "RelayTimeoutError";
}

/** JSON-RPC failure when using the direct route. */
export class RpcError extends AvantisError {
  override name = "RpcError";
  readonly code?: number;
  readonly data?: unknown;

  constructor(message: string, options: { code?: number; data?: unknown } = {}) {
    super(message);
    this.code = options.code;
    this.data = options.data;
  }
}

/** An on-chain transaction was mined but reverted. */
export class TransactionRevertedError extends AvantisError {
  override name = "TransactionRevertedError";
  readonly txHash?: string;

  constructor(message: string, options: { txHash?: string } = {}) {
    super(message);
    this.txHash = options.txHash;
  }
}

/** Delegation is missing, disabled, or expired for the configured signer. */
export class DelegationError extends AvantisError {
  override name = "DelegationError";
}

const ERROR_CODE_MAP: Record<string, new (message: string, options?: ApiErrorOptions) => ApiError> =
  {
    VALIDATION_ERROR: ValidationError,
    BAD_REQUEST: ValidationError,
    TX_REJECTED: ValidationError,
    SIMULATION_FAILED: SimulationFailedError,
    RATE_LIMITED: RateLimitedError,
    GEO_RESTRICTED: GeoRestrictedError,
    UPSTREAM_ERROR: UpstreamError,
    RPC_ERROR: UpstreamError,
  };

/** Build the right ApiError subclass from a tx-builder error envelope. */
export function apiErrorFromEnvelope(
  error: { code?: unknown; message?: unknown; details?: unknown },
  options: { status?: number; url?: string } = {},
): ApiError {
  const code = String(error?.code ?? "UNKNOWN");
  const message = String(error?.message ?? "unknown API error");
  const Cls = ERROR_CODE_MAP[code] ?? ApiError;
  return new Cls(message, {
    code,
    status: options.status,
    details: error?.details,
    url: options.url,
  });
}
