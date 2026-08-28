// tests/sms/keywords.test.ts — inbound keyword classification (pure string logic).
//
// The load-bearing assertions here are the NEGATIVE ones. Over-matching JOIN manufactures a
// CASL express-consent record that was never given, so "does not match" is the property under
// test, not an afterthought.
import { describe, expect, it } from 'vitest';
import { classifyInboundKeyword, isJoinKeyword, normalizeInboundBody } from '@/lib/sms/keywords';

describe('inbound keyword classification', () => {
  it('matches JOIN through case, whitespace and punctuation', () => {
    for (const body of ['JOIN', 'join', ' Join ', 'join!', 'JOIN.', '  join???  ', 'Join,']) {
      expect(isJoinKeyword(body)).toBe(true);
    }
  });

  it('does NOT match JOIN inside a sentence', () => {
    // "I don't want to join" contains JOIN and means the opposite of JOIN. A substring match
    // here would record express consent that was never given.
    for (const body of [
      "I don't want to join",
      'join the weekly thing please',
      'why did you make me join',
      'rejoin',
      'joined',
    ]) {
      expect(isJoinKeyword(body)).toBe(false);
      expect(classifyInboundKeyword(body)).toBe('unknown');
    }
  });

  it('does NOT fuzzy-match a near miss', () => {
    // lib/search/text/trigram.ts would happily score JOIM against JOIN. That tolerance is right
    // for search and wrong for consent — see lib/sms/keywords.ts.
    for (const body of ['JOIM', 'JOI', 'JOINN', 'J0IN']) {
      expect(classifyInboundKeyword(body)).toBe('unknown');
    }
  });

  it('classifies the carrier opt-out vocabulary so the DB mirror can follow it', () => {
    for (const body of ['STOP', 'stopall', 'Unsubscribe', 'CANCEL', 'end', 'quit!']) {
      expect(classifyInboundKeyword(body)).toBe('stop');
    }
    for (const body of ['START', 'yes', 'UNSTOP']) {
      expect(classifyInboundKeyword(body)).toBe('start');
    }
    for (const body of ['HELP', 'info']) {
      expect(classifyInboundKeyword(body)).toBe('help');
    }
  });

  it('treats empty, missing and emoji-only bodies as unknown', () => {
    expect(classifyInboundKeyword('')).toBe('unknown');
    expect(classifyInboundKeyword(null)).toBe('unknown');
    expect(classifyInboundKeyword(undefined)).toBe('unknown');
    expect(classifyInboundKeyword('   ')).toBe('unknown');
    expect(classifyInboundKeyword('👍')).toBe('unknown');
  });

  it('does NOT let a DECOMPOSED accent be deleted into a bare keyword', () => {
    // THE REGRESSION THIS FILE ACTUALLY CAUGHT. Phone keyboards emit decomposed text: "i-acute"
    // can arrive as a plain "i" followed by a separate combining acute (U+0301). The first draft
    // of normalizeInboundBody deleted everything that was not a letter/digit/space, which
    // deleted the combining accent and turned a decomposed "Join" (with an accent) into a clean
    // "JOIN" -- a reply that does not say JOIN, promoted into a CASL consent confirmation.
    // Both Unicode forms must classify as 'unknown'.
    const decomposed = 'Joi\u0301n';  // i + U+0301
    const precomposed = 'Jo\u00edn';   // single precomposed i-acute
    expect(decomposed.normalize('NFC')).toBe(precomposed.normalize('NFC'));
    for (const body of [decomposed, precomposed, ` ${decomposed}! `]) {
      expect(normalizeInboundBody(body)).not.toBe('JOIN');
      expect(classifyInboundKeyword(body)).toBe('unknown');
    }
  });

  it('normalisation keeps non-Latin text as text rather than shredding it to a keyword', () => {
    expect(normalizeInboundBody('\u52a0\u5165')).toBe('\u52a0\u5165');
    expect(classifyInboundKeyword('\u52a0\u5165')).toBe('unknown');
  });
});
