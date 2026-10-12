import type { Pool } from 'pg';
import type { PublicationStore } from '@slidock/server';
import {
  POSTGRES_PUBLICATION_JOBS_SCHEMA,
  POSTGRES_PUBLICATION_JOB_CLEANUP_SCHEMA,
} from './jobs.js';

export const POSTGRES_PUBLICATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS hub_publications (
  deck_id text PRIMARY KEY,
  generation bigint NOT NULL CHECK (generation >= 0),
  current_manifest jsonb NULL
)
`;

const BIGINT_MAX = 9_223_372_036_854_775_807n;

async function initializeSchemas(pool: Pool, schemas: string[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // API and worker processes can initialize together, so serialize their idempotent DDL.
    await client.query('SELECT pg_advisory_xact_lock(5461132, 2)');
    for (const schema of schemas) await client.query(schema);
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* Preserve the schema error. */
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Creates the required table without taking ownership of the caller's pool. */
export async function initializePostgresPublicationStore(pool: Pool): Promise<void> {
  await initializeSchemas(pool, [POSTGRES_PUBLICATIONS_SCHEMA]);
}

/** Creates both tables while leaving ownership of the caller's pool unchanged. */
export async function initializePostgresPublicationJobStore(pool: Pool): Promise<void> {
  await initializeSchemas(pool, [
    POSTGRES_PUBLICATIONS_SCHEMA,
    POSTGRES_PUBLICATION_JOBS_SCHEMA,
    POSTGRES_PUBLICATION_JOB_CLEANUP_SCHEMA,
  ]);
}

function validToken(token: string): boolean {
  if (!/^(0|[1-9]\d*)$/u.test(token)) return false;
  try {
    return BigInt(token) <= BIGINT_MAX;
  } catch {
    return false;
  }
}

export function createPostgresPublicationStore(options: { pool: Pool }): PublicationStore {
  const { pool } = options;
  return {
    async begin(deckId): Promise<string> {
      const result = await pool.query<{ generation: string }>(
        `INSERT INTO hub_publications (deck_id, generation, current_manifest)
         VALUES ($1, 1, NULL)
         ON CONFLICT (deck_id) DO UPDATE
         SET generation = hub_publications.generation + 1
         RETURNING generation::text AS generation`,
        [deckId],
      );
      const generation = result.rows[0]?.generation;
      if (generation === undefined) throw new Error('PostgreSQL begin returned no generation');
      return generation;
    },

    async current(deckId): Promise<unknown | null> {
      const result = await pool.query<{ current_manifest: unknown | null }>(
        'SELECT current_manifest FROM hub_publications WHERE deck_id = $1',
        [deckId],
      );
      return result.rows[0]?.current_manifest ?? null;
    },

    async commit(deckId, token, manifest): Promise<boolean> {
      if (!validToken(token)) return false;
      const result = await pool.query(
        `UPDATE hub_publications
         SET current_manifest = $3::jsonb
         WHERE deck_id = $1 AND generation = $2::bigint`,
        [deckId, token, JSON.stringify(manifest)],
      );
      return result.rowCount === 1;
    },
  };
}

export {
  createPostgresPublicationJobStore,
  POSTGRES_PUBLICATION_JOBS_SCHEMA,
  POSTGRES_PUBLICATION_JOB_CLEANUP_SCHEMA,
} from './jobs.js';
