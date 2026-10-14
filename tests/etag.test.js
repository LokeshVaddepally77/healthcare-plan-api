const { generateETag, etagMatches } = require('../utils/etag');
const { samplePlan } = require('./fixtures');

describe('generateETag', () => {
  test('returns a quoted MD5 hash', () => {
    expect(generateETag(samplePlan())).toMatch(/^"[0-9a-f]{32}"$/);
  });

  test('is the same for the same data', () => {
    expect(generateETag(samplePlan())).toBe(generateETag(samplePlan()));
  });

  test('changes when the data changes', () => {
    const changed = samplePlan();
    changed.planCostShares.copay += 1;

    expect(generateETag(changed)).not.toBe(generateETag(samplePlan()));
  });
});

describe('etagMatches', () => {
  test('matches with or without quotes', () => {
    expect(etagMatches('"abc123"', '"abc123"')).toBe(true);
    expect(etagMatches('abc123', '"abc123"')).toBe(true);
  });

  test('does not match a different tag', () => {
    expect(etagMatches('"abc123"', '"def456"')).toBe(false);
  });

  test('is false when either tag is missing', () => {
    expect(etagMatches(undefined, '"abc123"')).toBe(false);
    expect(etagMatches('"abc123"', null)).toBe(false);
  });
});
