const test = require('node:test');
const assert = require('node:assert/strict');
const { buildConsensusClaims } = require('./consensus');

test('buildConsensusClaims groups overlapping claims and surfaces disputes', () => {
  const responses = [
    {
      provider: 'GPT',
      content: 'Diversification reduces idiosyncratic risk. Leveraged ETFs reset daily. Long-term holding is suitable for most investors.',
    },
    {
      provider: 'Gemini',
      content: 'Diversification reduces unsystematic risk. Leveraged ETFs reset daily. Long-term holding is suitable for most investors.',
    },
    {
      provider: 'Claude',
      content: 'Diversification reduces idiosyncratic risk. Leveraged ETFs reset daily. This strategy may be unsuitable for long-term holding.',
    },
  ];

  const claims = buildConsensusClaims(responses);

  assert.equal(claims.length, 3);
  assert.deepEqual(claims[0].status, 'full');
  assert.equal(claims[0].supportCount, 3);
  assert.equal(claims[1].supportCount, 3);
  assert.equal(claims[2].status, 'disputed');
  assert.ok(claims[2].supportCount <= 2);
});
