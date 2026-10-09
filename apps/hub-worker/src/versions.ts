import { DurableObject } from 'cloudflare:workers';
import type { WorkerEnv } from './types.js';

/** Coordinates only the current manifest pointer; compilation and R2 work stay in the Worker. */
export class DeckVersions extends DurableObject<WorkerEnv> {
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, generation INTEGER NOT NULL, current TEXT)',
    );
    ctx.storage.sql.exec('INSERT OR IGNORE INTO state VALUES (1, 0, NULL)');
  }

  begin(): number {
    this.ctx.storage.sql.exec('UPDATE state SET generation = generation + 1 WHERE id = 1');
    return this.ctx.storage.sql
      .exec<{ generation: number }>('SELECT generation FROM state WHERE id = 1')
      .one().generation;
  }

  current(): unknown | null {
    const value = this.ctx.storage.sql
      .exec<{ current: string | null }>('SELECT current FROM state WHERE id = 1')
      .one().current;
    return value ? JSON.parse(value) : null;
  }

  commit(generation: number, manifest: unknown): boolean {
    const row = this.ctx.storage.sql
      .exec<{ generation: number }>('SELECT generation FROM state WHERE id = 1')
      .one();
    if (row.generation !== generation) return false;
    this.ctx.storage.sql.exec(
      'UPDATE state SET current = ? WHERE id = 1',
      JSON.stringify(manifest),
    );
    return true;
  }
}
