import type { Database } from "../db/connection.js";
import type { MemoryRow } from "../db/queries/memories.js";
import {
  collectVisibleMemories,
  type ScoredMemoryRow,
} from "../scope/fan-out.js";
import {
  traverseGraphs,
  type GraphTraversalResult,
} from "./graph-traversal.js";
import type { IntentWeights } from "./router.js";

export interface HybridSearchInput {
  userId: string;
  agentId: string;
  projectId?: string;
  scope?: "agent" | "project" | "global";
  query: string;
  intentWeights: IntentWeights;
  limit: number;
}

export interface SearchSourceBreakdown {
  bm25: number;
  vector: number;
  graph: number;
}

export interface HybridSearchResult extends ScoredMemoryRow {
  score: number;
  source_breakdown: SearchSourceBreakdown;
}

interface GraphAggregate {
  row: ScoredMemoryRow;
  score: number;
  breakdown: GraphTraversalResult["breakdown"];
}

type SearchSource = "bm25" | "vector" | "graph";

const RRF_K = 60;
const SOURCE_WEIGHTS: Record<SearchSource, number> = {
  bm25: 1.0,
  vector: 1.0,
  graph: 1.2,
};

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "did",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "we",
  "what",
  "when",
  "why",
]);

function blankSources(): SearchSourceBreakdown {
  return {
    bm25: 0,
    vector: 0,
    graph: 0,
  };
}

function normaliseToken(token: string): string {
  return token.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "");
}

function tokenizeSearch(text: string): string[] {
  return text
    .split(/\s+/)
    .map(normaliseToken)
    .flatMap((token) => {
      if (token.length < 3 || STOP_WORDS.has(token)) {
        return [];
      }

      if (token.endsWith("s") && token.length > 4) {
        return [token, token.slice(0, -1)];
      }

      return [token];
    });
}

function tokenFrequency(text: string): Map<string, number> {
  const counts = new Map<string, number>();

  for (const token of tokenizeSearch(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return counts;
}

function cosineFromCounts(
  left: Map<string, number>,
  right: Map<string, number>
): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (const value of left.values()) {
    leftNorm += value * value;
  }

  for (const value of right.values()) {
    rightNorm += value * value;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  for (const [token, value] of left.entries()) {
    dot += value * (right.get(token) ?? 0);
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function sortRankedRows(rows: ScoredMemoryRow[]): ScoredMemoryRow[] {
  return [...rows].sort((left, right) => {
    if (left.scopePriority !== right.scopePriority) {
      return left.scopePriority - right.scopePriority;
    }
    return right.recorded_at.localeCompare(left.recorded_at);
  });
}

function sortSearchResults(rows: HybridSearchResult[]): HybridSearchResult[] {
  return [...rows].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (left.scopePriority !== right.scopePriority) {
      return left.scopePriority - right.scopePriority;
    }
    return right.recorded_at.localeCompare(left.recorded_at);
  });
}

function buildVisibilityClause(input: HybridSearchInput): {
  clause: string;
  params: unknown[];
} {
  if (input.scope === "project") {
    if (input.projectId === undefined) {
      return { clause: "1 = 0", params: [] };
    }

    return {
      clause: "(m.scope = 'project' AND m.project_id = ?)",
      params: [input.projectId],
    };
  }

  if (input.scope === "agent") {
    return {
      clause: "(m.scope = 'agent' AND m.agent_id = ?)",
      params: [input.agentId],
    };
  }

  if (input.scope === "global") {
    return {
      clause: "m.scope = 'global'",
      params: [],
    };
  }

  if (input.projectId !== undefined) {
    return {
      clause:
        "((m.scope = 'project' AND m.project_id = ?) OR (m.scope = 'agent' AND m.agent_id = ?) OR m.scope = 'global')",
      params: [input.projectId, input.agentId],
    };
  }

  return {
    clause: "((m.scope = 'agent' AND m.agent_id = ?) OR m.scope = 'global')",
    params: [input.agentId],
  };
}

function buildFtsQuery(query: string): string | undefined {
  const tokens = [...new Set(tokenizeSearch(query))];

  if (tokens.length === 0) {
    return undefined;
  }

  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
}

function runBm25Search(
  db: Database,
  input: HybridSearchInput,
  visibleRowsById: Map<string, ScoredMemoryRow>,
  limit: number
): ScoredMemoryRow[] {
  const ftsQuery = buildFtsQuery(input.query);
  if (ftsQuery === undefined) {
    return [];
  }

  const visibility = buildVisibilityClause(input);
  const rows = db
    .prepare<unknown[], MemoryRow>(
      `SELECT m.* FROM memories_fts
       JOIN memories m ON m.rowid = memories_fts.rowid
       WHERE memories_fts MATCH ?
         AND m.user_id = ?
         AND m.invalidated_at IS NULL
         AND m.valid_until IS NULL
         AND ${visibility.clause}
       ORDER BY bm25(memories_fts), m.recorded_at DESC
       LIMIT ?`
    )
    .all(ftsQuery, input.userId, ...visibility.params, limit);

  return rows
    .map((row) => visibleRowsById.get(row.id))
    .filter((row): row is ScoredMemoryRow => row !== undefined);
}

function runVectorSearch(
  visibleRows: ScoredMemoryRow[],
  query: string,
  limit: number
): ScoredMemoryRow[] {
  const queryCounts = tokenFrequency(query);
  if (queryCounts.size === 0) {
    return [];
  }

  return visibleRows
    .map((row) => ({
      row,
      similarity: cosineFromCounts(queryCounts, tokenFrequency(row.content)),
    }))
    .filter((candidate) => candidate.similarity > 0)
    .sort((left, right) => {
      if (right.similarity !== left.similarity) {
        return right.similarity - left.similarity;
      }
      if (left.row.scopePriority !== right.row.scopePriority) {
        return left.row.scopePriority - right.row.scopePriority;
      }
      return right.row.recorded_at.localeCompare(left.row.recorded_at);
    })
    .slice(0, limit)
    .map((candidate) => candidate.row);
}

function aggregateGraphResults(
  visibleRowsById: Map<string, ScoredMemoryRow>,
  traversedRows: GraphTraversalResult[]
): GraphAggregate[] {
  const aggregated = new Map<string, GraphAggregate>();

  for (const candidate of traversedRows) {
    const visibleRow = visibleRowsById.get(candidate.id);
    if (visibleRow === undefined) {
      continue;
    }

    const existing = aggregated.get(candidate.id);
    if (existing === undefined) {
      aggregated.set(candidate.id, {
        row: visibleRow,
        score: candidate.score,
        breakdown: { ...candidate.breakdown },
      });
      continue;
    }

    existing.score += candidate.score;
    existing.breakdown.causal += candidate.breakdown.causal;
    existing.breakdown.temporal += candidate.breakdown.temporal;
    existing.breakdown.entity += candidate.breakdown.entity;
    existing.breakdown.semantic += candidate.breakdown.semantic;
  }

  return [...aggregated.values()].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (left.row.scopePriority !== right.row.scopePriority) {
      return left.row.scopePriority - right.row.scopePriority;
    }
    return right.row.recorded_at.localeCompare(left.row.recorded_at);
  });
}

export function reciprocalRankFuse(
  rowLookup: Map<string, ScoredMemoryRow>,
  rankedSources: Record<SearchSource, ScoredMemoryRow[]>
): HybridSearchResult[] {
  const fused = new Map<string, HybridSearchResult>();

  const addSource = (source: SearchSource) => {
    rankedSources[source].forEach((row, index) => {
      const baseRow = rowLookup.get(row.id) ?? row;
      const contribution = SOURCE_WEIGHTS[source] / (RRF_K + index + 1);
      const existing = fused.get(baseRow.id);

      if (existing === undefined) {
        const created: HybridSearchResult = {
          ...baseRow,
          score: contribution,
          source_breakdown: blankSources(),
        };
        created.source_breakdown[source] = contribution;
        fused.set(baseRow.id, created);
        return;
      }

      existing.score += contribution;
      existing.source_breakdown[source] += contribution;
    });
  };

  addSource("bm25");
  addSource("vector");
  addSource("graph");

  return sortSearchResults([...fused.values()]);
}

export function hybridSearch(
  db: Database,
  input: HybridSearchInput
): HybridSearchResult[] {
  const visibleRows = collectVisibleMemories(db, {
    userId: input.userId,
    agentId: input.agentId,
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
  });

  if (visibleRows.length === 0) {
    return [];
  }

  const visibleRowsById = new Map(visibleRows.map((row) => [row.id, row]));
  const trimmedQuery = input.query.trim();

  if (trimmedQuery.length === 0) {
    return sortRankedRows(visibleRows)
      .slice(0, input.limit)
      .map((row) => ({
        ...row,
        score: 0,
        source_breakdown: blankSources(),
      }));
  }

  const sourceLimit = Math.max(input.limit * 3, 10);
  const bm25Rows = runBm25Search(db, input, visibleRowsById, sourceLimit);
  const vectorRows = runVectorSearch(visibleRows, trimmedQuery, sourceLimit);

  const seedIds = new Set<string>();
  for (const row of [...bm25Rows.slice(0, 5), ...vectorRows.slice(0, 5)]) {
    seedIds.add(row.id);
  }

  const traversedRows: GraphTraversalResult[] = [];
  for (const seedId of seedIds) {
    traversedRows.push(
      ...traverseGraphs(db, seedId, input.intentWeights, 2, {
        visibleRows,
      })
    );
  }

  const graphRows = aggregateGraphResults(visibleRowsById, traversedRows)
    .slice(0, sourceLimit)
    .map((entry) => entry.row);

  const fused = reciprocalRankFuse(visibleRowsById, {
    bm25: bm25Rows,
    vector: vectorRows,
    graph: graphRows,
  });

  if (fused.length === 0) {
    return sortRankedRows(visibleRows)
      .slice(0, input.limit)
      .map((row) => ({
        ...row,
        score: 0,
        source_breakdown: blankSources(),
      }));
  }

  return fused.slice(0, input.limit);
}
