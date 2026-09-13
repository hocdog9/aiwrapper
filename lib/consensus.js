const STOP_WORDS = new Set([
  'a','about','above','after','again','against','all','also','am','an','and','any','are','as','at','be','because','been','before','being','below','between','both','but','by','can','could','did','do','does','doing','down','during','each','few','for','from','further','had','has','have','having','he','her','here','hers','herself','him','himself','his','how','i','if','in','into','is','it','its','itself','just','me','more','most','my','myself','no','nor','not','of','off','on','once','only','or','other','our','ours','ourselves','out','over','own','same','she','should','so','some','such','than','that','the','their','theirs','them','themselves','then','there','these','they','this','those','through','to','too','under','until','up','very','was','we','were','what','when','where','which','while','who','whom','why','will','with','you','your','yours','yourself','yourselves'
]);

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenise(value) {
  return normalizeText(value)
    .split(' ')
    .filter((token) => token && !STOP_WORDS.has(token));
}

function similarity(a, b) {
  const tokensA = new Set(tokenise(a));
  const tokensB = new Set(tokenise(b));

  if (!tokensA.size && !tokensB.size) {
    return 1;
  }

  const intersection = [...tokensA].filter((token) => tokensB.has(token)).length;
  const denominator = Math.max(tokensA.size, tokensB.size, 1);

  return intersection / denominator;
}

function extractClaims(content) {
  const cleaned = String(content || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return [];
  }

  const fragments = cleaned
    .split(/[.!?]+|\n+/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length > 20 && !/^\s*(analysis|summary|overall|in summary)\b/i.test(part));

  return fragments.length ? fragments : [cleaned.slice(0, 220)];
}

function buildConsensusClaims(responses) {
  if (!Array.isArray(responses) || responses.length === 0) {
    return [];
  }

  const totalModels = responses.length;
  const groups = [];

  for (const response of responses) {
    const claimList = extractClaims(response.content);

    for (const claim of claimList) {
      let matched = false;

      for (const group of groups) {
        const sameMeaning = similarity(group.claim, claim) >= 0.55 || group.claim.includes(claim.slice(0, 24)) || claim.includes(group.claim.slice(0, 24));

        if (sameMeaning) {
          group.support.add(response.provider);
          if (claim.length > group.claim.length) {
            group.claim = claim;
          }
          matched = true;
          break;
        }
      }

      if (!matched) {
        groups.push({
          claim,
          support: new Set([response.provider]),
        });
      }
    }
  }

  return groups
    .map((group) => {
      const supportCount = group.support.size;
      let status = 'disputed';

      if (supportCount === totalModels) {
        status = 'full';
      } else if (supportCount >= Math.ceil(totalModels / 2)) {
        status = 'majority';
      } else if (supportCount === 1) {
        status = 'unique';
      }

      return {
        claim: group.claim,
        supportCount,
        totalModels,
        status,
        notes: supportCount === 1 ? 'A single model surfaced this point.' : undefined,
      };
    })
    .sort((a, b) => {
      if (b.supportCount !== a.supportCount) return b.supportCount - a.supportCount;
      return a.claim.localeCompare(b.claim);
    })
    .slice(0, 6);
}

module.exports = {
  buildConsensusClaims,
};
