export interface IntentWeights {
  causal: number;
  temporal: number;
  entity: number;
  semantic: number;
}

const CAUSAL_PATTERN =
  /\b(why|because|caused?|causal|reason|due to|led to|resulted in)\b/i;
const TEMPORAL_PATTERN =
  /\b(when|before|after|during|timeline|last|next|yesterday|today|tomorrow|earlier|later)\b/i;
const DATE_PATTERN =
  /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const ENTITY_PATTERN =
  /\b(who|whom|whose|which|what is|what are|who is|name of)\b/i;
const TITLE_CASE_PATTERN = /\b(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+|[A-Z]{2,})\b/;

function normaliseScores(scores: IntentWeights): IntentWeights {
  const total =
    scores.causal + scores.temporal + scores.entity + scores.semantic;

  if (total === 0) {
    return {
      causal: 0.25,
      temporal: 0.25,
      entity: 0.25,
      semantic: 0.25,
    };
  }

  return {
    causal: scores.causal / total,
    temporal: scores.temporal / total,
    entity: scores.entity / total,
    semantic: scores.semantic / total,
  };
}

export function classifyIntent(query: string): IntentWeights {
  const trimmed = query.trim();

  if (trimmed.length === 0) {
    return {
      causal: 0.1,
      temporal: 0.1,
      entity: 0.1,
      semantic: 0.7,
    };
  }

  const scores: IntentWeights = {
    causal: 1,
    temporal: 1,
    entity: 1,
    semantic: 2,
  };

  if (CAUSAL_PATTERN.test(trimmed)) {
    scores.causal += 3;
  }

  if (TEMPORAL_PATTERN.test(trimmed) || DATE_PATTERN.test(trimmed)) {
    scores.temporal += 3;
  }

  if (ENTITY_PATTERN.test(trimmed) || TITLE_CASE_PATTERN.test(trimmed)) {
    scores.entity += 3;
  }

  if (
    !CAUSAL_PATTERN.test(trimmed) &&
    !TEMPORAL_PATTERN.test(trimmed) &&
    !DATE_PATTERN.test(trimmed) &&
    !ENTITY_PATTERN.test(trimmed) &&
    !TITLE_CASE_PATTERN.test(trimmed)
  ) {
    scores.semantic += 2;
  } else if (trimmed.split(/\s+/).length > 4) {
    scores.semantic += 1;
  }

  return normaliseScores(scores);
}
