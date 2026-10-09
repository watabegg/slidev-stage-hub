import { CliFailure } from './errors.js';
import type { DoctorCheck } from './errors.js';
import type { Product } from './args.js';

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function emitSuccess(command: string, data: unknown, json: boolean, human: string): void {
  if (json) writeJson({ ok: true, command, data });
  else process.stdout.write(`${human}\n`);
}

export function emitDoctorResult(
  command: string,
  ready: boolean,
  checks: DoctorCheck[],
  json: boolean,
): void {
  if (json) {
    writeJson(
      ready
        ? { ok: true, command, data: { ready, checks } }
        : {
            ok: false,
            command,
            error: { code: 'NOT_READY', message: 'Stage runtime checks failed', checks },
          },
    );
  } else {
    for (const check of checks)
      process.stdout.write(`${check.ok ? 'ok' : 'fail'} ${check.name}: ${check.message}\n`);
  }
}

export function emitFailure(
  product: Product,
  command: string | undefined,
  error: unknown,
  json: boolean,
): void {
  const failure =
    error instanceof CliFailure ? error : new CliFailure('RUNTIME_ERROR', 'command failed', 1);
  const label = command ? `${product} ${command}` : product;
  if (json) {
    writeJson({
      ok: false,
      command: label,
      error: {
        code: failure.code,
        message: failure.message,
        ...(failure.checks === undefined ? {} : { checks: failure.checks }),
      },
    });
  } else {
    process.stderr.write(`${label}: ${failure.message}\n`);
  }
  process.exitCode = failure.exitCode;
}
