import { describe, expect, it } from 'vitest';
import {
  rankChainForSelection,
  type ChainRow,
  type TaskSelectionContext,
} from '../../services/router.js';

function row(id: number, size: string, context: number, tools = 0): ChainRow {
  return {
    model_db_id: id,
    priority: id,
    enabled: 1,
    platform: 'mock',
    model_id: `model-${id}`,
    display_name: `Model ${id}`,
    intelligence_rank: id,
    size_label: size,
    monthly_token_budget: '1M',
    rpm_limit: null,
    rpd_limit: null,
    tpm_limit: null,
    tpd_limit: null,
    supports_vision: 0,
    supports_tools: tools,
    context_window: context,
    key_id: null,
  };
}

const baseSelection: TaskSelectionContext = {
  mode: 'task_aware',
  category: 'implementation',
  size: 'small',
  risk: 'low',
  estimatedTokens: 2_000,
};

describe('delegation selection modes', () => {
  it('standard mode preserves the exact strategy-ranked chain', () => {
    const chain = [row(1, 'Small', 8_000), row(2, 'Frontier', 128_000)];
    expect(rankChainForSelection(chain, { ...baseSelection, mode: 'standard' })).toBe(chain);
  });

  it('task-aware mode can promote capability for a high-risk large task', () => {
    const fastSmall = row(1, 'Small', 16_000);
    const strongLarge = row(2, 'Large', 64_000, 1);
    const ranked = rankChainForSelection(
      [fastSmall, strongLarge],
      { ...baseSelection, size: 'large', risk: 'high' },
    );
    expect(ranked[0].model_db_id).toBe(2);
  });

  it('task-aware mode considers context headroom without discarding standard rank', () => {
    const tight = row(1, 'Medium', 4_100, 1);
    const roomy = row(2, 'Medium', 64_000, 1);
    const ranked = rankChainForSelection(
      [tight, roomy],
      { ...baseSelection, size: 'medium', estimatedTokens: 4_000 },
    );
    expect(ranked[0].model_db_id).toBe(1);
    expect(ranked.map(item => item.model_db_id)).toEqual([1, 2]);
  });

  it('adaptive mode safely uses the task-aware foundation when no history is supplied', () => {
    const chain = [row(1, 'Small', 8_000), row(2, 'Large', 64_000)];
    const ranked = rankChainForSelection(
      chain,
      { ...baseSelection, mode: 'adaptive', size: 'large', risk: 'high' },
    );
    expect(ranked[0].model_db_id).toBe(2);
  });
});

