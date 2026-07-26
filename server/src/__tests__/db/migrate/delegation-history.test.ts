import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  down,
  up,
} from '../../../db/migrations/20260727_000001_delegation_history.js';

function hasTable(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name));
}

describe('delegation history migration', () => {
  it('round-trips its schema and never creates raw-content columns', () => {
    const db = new Database(':memory:');
    try {
      up(db);
      expect(hasTable(db, 'delegation_history')).toBe(true);
      const columns = db.prepare('PRAGMA table_info(delegation_history)')
        .all() as Array<{ name: string }>;
      const names = columns.map(column => column.name);
      expect(names).toContain('context_receipt_hash');
      expect(names).toContain('repository_hash');
      expect(names).not.toContain('objective');
      expect(names).not.toContain('context');
      expect(names).not.toContain('patch');
      expect(names).not.toContain('response');

      down(db);
      expect(hasTable(db, 'delegation_history')).toBe(false);
      up(db);
      expect(hasTable(db, 'delegation_history')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('enforces feedback outcome values', () => {
    const db = new Database(':memory:');
    try {
      up(db);
      const insert = db.prepare(`
        INSERT INTO delegation_history (
          task_id, repository_hash, category, size, risk, selection_mode,
          status, quality_gate, latency_ms, context_receipt_hash,
          schema_version, prompt_version, policy_version, outcome
        ) VALUES (?, 'repo', 'testing', 'small', 'low', 'task_aware',
          'completed', 'pass', 1, 'receipt', '1', '1', '1', ?)
      `);
      expect(() => insert.run('bad', 'invented')).toThrow();
      expect(() => insert.run('good', 'accepted')).not.toThrow();
    } finally {
      db.close();
    }
  });
});
