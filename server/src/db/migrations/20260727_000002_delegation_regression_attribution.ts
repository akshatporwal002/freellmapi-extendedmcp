// Migration: uncertainty-aware delegation regression attribution
// Created: 2026-07-27
//
// DOWN: reversible
//
// Adds only compact attribution evidence. Incident details, source, patches,
// and reviewer prose remain deliberately excluded.

import type { Db } from '../types.js';

function hasColumn(db: Db, column: string): boolean {
  const columns = db.prepare('PRAGMA table_info(delegation_history)').all() as { name: string }[];
  return columns.some(candidate => candidate.name === column);
}

export function up(db: Db): void {
  if (!hasColumn(db, 'regression_attribution')) {
    db.prepare(`
      ALTER TABLE delegation_history
      ADD COLUMN regression_attribution TEXT
      CHECK (regression_attribution IN ('possible', 'probable', 'confirmed', 'unrelated'))
    `).run();
  }
  if (!hasColumn(db, 'regression_confidence')) {
    db.prepare(`
      ALTER TABLE delegation_history
      ADD COLUMN regression_confidence REAL
      CHECK (regression_confidence >= 0 AND regression_confidence <= 1)
    `).run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'regression_confidence')) {
    db.prepare('ALTER TABLE delegation_history DROP COLUMN regression_confidence').run();
  }
  if (hasColumn(db, 'regression_attribution')) {
    db.prepare('ALTER TABLE delegation_history DROP COLUMN regression_attribution').run();
  }
}
