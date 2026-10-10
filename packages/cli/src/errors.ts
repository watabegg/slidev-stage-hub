export type DoctorCheck = { name: string; ok: boolean; message: string };

export class CliFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: 1 | 2 | 130,
    readonly checks?: DoctorCheck[],
    readonly result?: unknown,
  ) {
    super(message);
    this.name = 'CliFailure';
  }
}

export function failInput(message: string, code = 'INVALID_ARGUMENTS'): never {
  throw new CliFailure(code, message, 2);
}

export function failRuntime(message: string, code = 'RUNTIME_ERROR', result?: unknown): never {
  throw new CliFailure(code, message, 1, undefined, result);
}
