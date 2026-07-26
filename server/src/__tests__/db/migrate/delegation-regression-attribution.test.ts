import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { up as createHistory } from '../../../db/migrations/20260727_000001_delegation_history.js';
import {
  down,
  up,
} from '../../../db/migrations/20260727_000002_delegation_regression_attribution.js';

function columns(db: Database.Database): string[] {
  return (db.prepare('PRAGMA table_info(delegation_history)').all() as Array<{ name: string }>)
    .map(column => column.name);
}

describe('delegation regression attribution migration', () => {
  it('round-trips compact attribution columns and constraints', () => {
    const db = new Database(':memory:');
    try {
      createHistory(db);
      up(db);
      expect(columns(db)).toContain('regression_attribution');
      expect(columns(db)).toContain('regression_confidence');

      const base = `
        INSERT INTO delegation_history (
          task_id, repository_hash, category, size, risk, selection_mode,
          status, quality_gate, latency_ms, context_receipt_hash,
          schema_version, prompt_version, policy_version,
          regression_attribution, regression_confidence
        ) VALUES (?, 'repo', 'testing', 'small', 'low', 'adaptive',
          'completed', 'pass', 1, 'receipt', '1', '1', '1', ?, ?)
      `;
      expect(() => db.prepare(base).run('bad-kind', 'certain', 0.5)).toThrow();
      expect(() => db.prepare(base).run('bad-confidence', 'possible', 1.1)).toThrow();
      expect(() => db.prepare(base).run('valid', 'possible', 0.4)).not.toThrow();

      down(db);
      expect(columns(db)).not.toContain('regression_attribution');
      expect(columns(db)).not.toContain('regression_confidence');
      up(db);
      expect(columns(db)).toContain('regression_attribution');
    } finally {
      db.close();
    }
  });
});
