// Migration: privacy-safe delegation execution and feedback history
// Created: 2026-07-27
//
// DOWN: reversible
//
// Stores compact routing and quality signals only. Raw task objectives, source
// context, patches, provider credentials, and worker responses are deliberately
// excluded.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS delegation_history (
      task_id TEXT PRIMARY KEY,
      repository_hash TEXT NOT NULL,
      category TEXT NOT NULL,
      size TEXT NOT NULL,
      risk TEXT NOT NULL,
      selection_mode TEXT NOT NULL,
      selection_mode_fallback TEXT,
      model_id TEXT,
      provider TEXT,
      status TEXT NOT NULL,
      quality_gate TEXT NOT NULL,
      prompt_tokens INTEGER,
      output_tokens INTEGER,
      latency_ms INTEGER NOT NULL,
      shadow_mode INTEGER NOT NULL DEFAULT 0,
      context_receipt_hash TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      outcome TEXT CHECK (outcome IN ('accepted', 'revised', 'rejected')),
      edit_distance INTEGER,
      regression INTEGER,
      review_tokens INTEGER,
      feedback_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_delegation_history_model_category
      ON delegation_history(provider, model_id, category, created_at);
    CREATE INDEX IF NOT EXISTS idx_delegation_history_repository
      ON delegation_history(repository_hash, category, created_at);
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS delegation_history');
}
