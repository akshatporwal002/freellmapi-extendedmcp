import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { up as createHistory } from '../../../db/migrations/20260727_000001_delegation_history.js';
import {
  down,
  up,
} from '../../../db/migrations/20260727_000003_delegation_usage_provenance.js';

function hasColumn(db: Database.Database): boolean {
  return (db.prepare('PRAGMA table_info(delegation_history)').all() as Array<{ name: string }>)
    .some(column => column.name === 'usage_estimated');
}

describe('delegation usage provenance migration', () => {
  it('round-trips an estimate marker constrained to booleans', () => {
    const db = new Database(':memory:');
    try {
      createHistory(db);
      up(db);
      expect(hasColumn(db)).toBe(true);
      const insert = db.prepare(`
        INSERT INTO delegation_history (
          task_id, repository_hash, category, size, risk, selection_mode,
          status, quality_gate, latency_ms, context_receipt_hash,
          schema_version, prompt_version, policy_version, usage_estimated
        ) VALUES (?, 'repo', 'testing', 'small', 'low', 'adaptive',
          'completed', 'pass', 1, 'receipt', '1', '1', '1', ?)
      `);
      expect(() => insert.run('bad', 2)).toThrow();
      expect(() => insert.run('actual', 0)).not.toThrow();
      down(db);
      expect(hasColumn(db)).toBe(false);
      up(db);
      expect(hasColumn(db)).toBe(true);
    } finally {
      db.close();
    }
  });
});
