export class GatewayError extends Error {
  rateHeaders?: Record<string, string>;
  rateLimitScope?: 'model' | 'provider';
  retryAfterSeconds?: number;
  upstreamStatus?: number;
  upstreamCode?: string;
  constructor(public status: number, public code: string, message: string, public retryable = false) {
    super(message);
    this.name = 'GatewayError';
  }
}

export function asGatewayError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) {
    return new GatewayError(504, 'request_timeout', 'Request cancelled or deadline exceeded.');
  }
  return new GatewayError(500, 'internal_error', 'An internal error occurred.');
}

export function errorBody(error: GatewayError) {
  return { error: { message: error.message, type: error.status < 500 ? 'invalid_request_error' : 'server_error', code: error.code, param: null } };
}
