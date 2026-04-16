import type { Database } from "better-sqlite3";
import { ulid } from "ulid";
import { getDb } from "../db/connection.js";
import {
  ScopeViolationError,
  withDbError,
} from "../utils/errors.js";

export type CandidateScope = "agent" | "project" | "global";
export type CandidateType = "entity" | "fact" | "decision" | "preference";

export interface CandidateBufferRow {
  id: string;
  user_id: string | null;
  content: string;
  source_turn: string;
  candidate_type: CandidateType;
  agent_id: string;
  framework: string | null;
  session_id: string | null;
  scope: CandidateScope;
  project_id: string | null;
  status: "PENDING" | "ACCEPTED" | "REJECTED";
  review_required: 0 | 1;
  decision_action: "ACCEPT" | "UPDATE" | "REJECT" | null;
  decision_reason: string | null;
  decision_confidence: number | null;
  processed_at: string | null;
  created_at: string;
}

export interface ExtractCandidatesResult {
  candidates_buffered: number;
}

interface CandidateDraft {
  content: string;
  candidateType: CandidateType;
}

const ENTITY_STOPWORDS = new Set([
  "A",
  "An",
  "And",
  "But",
  "For",
  "He",
  "I",
  "It",
  "Our",
  "She",
  "That",
  "The",
  "Their",
  "There",
  "These",
  "They",
  "This",
  "We",
  "You",
]);

const FACTUAL_VERB_PATTERN =
  /\b(is|are|was|were|has|have|had|supports|requires|uses|means|equals|contains|runs|stores|keeps|returns|creates|ships|blocks|depends on)\b/i;
const DECISION_PATTERN =
  /\b(decided to|decision:|we should|we will|going with|choose|chosen|ship|shipping|move forward with|adopt|settled on)\b/i;
const PREFERENCE_PATTERN =
  /\b(prefer|preferred|preference|likes|wants|would rather|avoid|do not want|don't want|should avoid)\b/i;
const SCOPE_VALUES = new Set<CandidateScope>(["agent", "project", "global"]);

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeForDedup(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function splitTurn(turn: string): string[] {
  return turn
    .split(/[\r\n]+|(?<=[.!?])\s+/u)
    .map((fragment) => normalizeWhitespace(fragment))
    .filter((fragment) => fragment.length >= 4);
}

function extractNamedEntities(turn: string): CandidateDraft[] {
  const entityPattern =
    /\b(?:[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+){0,3}|[A-Z]{2,}(?:\s+[A-Z]{2,})*)\b/g;
  const matches = turn.match(entityPattern) ?? [];
  const drafts: CandidateDraft[] = [];

  for (const raw of matches) {
    const entity = normalizeWhitespace(raw);
    if (entity.length < 3 || ENTITY_STOPWORDS.has(entity)) {
      continue;
    }

    drafts.push({
      content: `Named entity mentioned: ${entity}`,
      candidateType: "entity",
    });
  }

  return drafts;
}

function extractSentenceCandidates(turn: string): CandidateDraft[] {
  const drafts: CandidateDraft[] = [];

  for (const fragment of splitTurn(turn)) {
    if (DECISION_PATTERN.test(fragment)) {
      drafts.push({ content: fragment, candidateType: "decision" });
    }

    if (PREFERENCE_PATTERN.test(fragment)) {
      drafts.push({ content: fragment, candidateType: "preference" });
    }

    if (FACTUAL_VERB_PATTERN.test(fragment) && fragment.length >= 12) {
      drafts.push({ content: fragment, candidateType: "fact" });
    }
  }

  return drafts;
}

function buildCandidateDrafts(turn: string): CandidateDraft[] {
  const drafts = [...extractNamedEntities(turn), ...extractSentenceCandidates(turn)];

  if (drafts.length > 0) {
    return drafts;
  }

  const fallback = splitTurn(turn)[0];
  return fallback
    ? [{ content: fallback, candidateType: "fact" }]
    : [];
}

function dedupeCandidates(drafts: CandidateDraft[]): CandidateDraft[] {
  const seen = new Set<string>();
  const result: CandidateDraft[] = [];

  for (const draft of drafts) {
    const content = normalizeWhitespace(draft.content);
    if (!content) {
      continue;
    }

    const key = `${draft.candidateType}:${normalizeForDedup(content)}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push({ ...draft, content });
  }

  return result;
}

function resolveDatabase(defaultPath?: string): Database {
  return getDb(defaultPath ?? process.env.MEMRYON_DB_PATH ?? "memryon.db");
}

/**
 * Extracts candidate facts from a turn and buffers them for slow-path consolidation.
 */
export function extractCandidates(
  turn: string,
  agentId: string,
  framework: string,
  sessionId: string,
  scope: CandidateScope,
  projectId?: string
): ExtractCandidatesResult;
/**
 * Extracts candidate facts from a turn with an explicit database handle.
 */
export function extractCandidates(
  db: Database,
  turn: string,
  agentId: string,
  framework: string,
  sessionId: string,
  scope: CandidateScope,
  projectId?: string
): ExtractCandidatesResult;
/**
 * Extracts candidate facts from a turn and persists them into the candidate buffer.
 */
export function extractCandidates(
  dbOrTurn: Database | string,
  turnOrAgentId: string,
  agentIdOrFramework: string,
  frameworkOrSessionId: string,
  sessionIdOrScope: string,
  scopeOrProjectId?: string,
  maybeProjectId?: string
): ExtractCandidatesResult {
  const hasDb = typeof dbOrTurn !== "string";
  const db = hasDb ? dbOrTurn : resolveDatabase();
  const turn = hasDb ? turnOrAgentId : dbOrTurn;
  const agentId = hasDb ? agentIdOrFramework : turnOrAgentId;
  const framework = hasDb ? frameworkOrSessionId : agentIdOrFramework;
  const sessionId = hasDb ? sessionIdOrScope : frameworkOrSessionId;
  const scope = (hasDb ? scopeOrProjectId : sessionIdOrScope) as CandidateScope;
  const projectId = hasDb ? maybeProjectId : scopeOrProjectId;

  if (!SCOPE_VALUES.has(scope)) {
    throw new ScopeViolationError(`Unsupported scope '${scope}'`);
  }
  if (scope === "project" && !projectId) {
    throw new ScopeViolationError("projectId is required when scope is 'project'");
  }

  const drafts = dedupeCandidates(buildCandidateDrafts(turn));
  if (drafts.length === 0) {
    return { candidates_buffered: 0 };
  }

  withDbError("buffering fast-path candidates", () => {
    const insertCandidate = db.prepare(
      `INSERT INTO candidate_buffer (
         id, user_id, content, source_turn, candidate_type,
         agent_id, framework, session_id, scope, project_id, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`
    );

    const insertMany = db.transaction((rows: CandidateDraft[]) => {
      for (const row of rows) {
        insertCandidate.run(
          ulid(),
          null,
          row.content,
          turn,
          row.candidateType,
          agentId,
          framework,
          sessionId,
          scope,
          scope === "project" ? projectId ?? null : null
        );
      }
    });

    insertMany(drafts);
  });

  return { candidates_buffered: drafts.length };
}
