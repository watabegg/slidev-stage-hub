export type ErrorPhase =
  | 'request'
  | 'auth'
  | 'compiler'
  | 'storage'
  | 'commit'
  | 'catalog'
  | 'discovery'
  | 'thumbnail'
  | 'worker';

export class WorkerError extends Error {
  readonly phase: ErrorPhase;
  readonly status: number;
  readonly publicMessage: string;

  constructor(status: number, phase: ErrorPhase, publicMessage: string) {
    super(publicMessage);
    this.name = 'WorkerError';
    this.status = status;
    this.phase = phase;
    this.publicMessage = publicMessage;
  }
}

export function errorResponse(error: unknown): Response {
  const normalized =
    error instanceof WorkerError ? error : new WorkerError(500, 'worker', 'Request failed');
  if (normalized.status >= 500) {
    console.error(
      JSON.stringify({
        event: 'worker-request-failed',
        phase: normalized.phase,
        status: normalized.status,
      }),
    );
  }
  return Response.json(
    { error: normalized.publicMessage, phase: normalized.phase },
    { status: normalized.status, headers: { 'cache-control': 'no-store' } },
  );
}
