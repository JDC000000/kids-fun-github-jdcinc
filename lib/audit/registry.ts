// lib/audit/registry.ts — the rule set, and the ONLY file a third pattern has to touch.
//
// Adding a pattern is: one file under rules/, one import, one array entry, one test. Nothing
// in the prefilter, the LLM stage, the report or the CLI knows how many rules exist or what
// they look for — they all iterate this list. That is the "design it so a third pattern can
// be added without rewriting it" requirement, made structural rather than aspirational.
import type { AuditRule } from './types';
import { outdoorIndoorRule } from './rules/outdoor-indoor';
import { adultAgeBandRule } from './rules/adult-age-band';

export const AUDIT_RULES: AuditRule[] = [outdoorIndoorRule, adultAgeBandRule];

export function ruleById(id: string): AuditRule | undefined {
  return AUDIT_RULES.find((r) => r.id === id);
}

/**
 * Short, custom_id-safe alias per rule. Anthropic's Message Batches `custom_id` must match
 * ^[a-zA-Z0-9_-]{1,64}$ and a UUID already spends 36 of those, so the rule id is abbreviated
 * rather than embedded. Kept as an explicit map, not a slice of the id, so renaming a rule
 * cannot silently collide two prefixes.
 */
export const RULE_CUSTOM_ID_PREFIX: Record<string, string> = {
  outdoor_source_indoor_tag: 'oi',
  adult_source_child_bands: 'ac',
};
