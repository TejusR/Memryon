import type { Database } from "../db/connection.js";
import type { MemoryRow } from "../db/queries/memories.js";
import type { IntentWeights } from "./router.js";
import { withDbError } from "../utils/errors.js";

export interface GraphScoreBreakdown {
  causal: number;
  temporal: number;
  entity: number;
  semantic: number;
}

export interface GraphTraversalResult extends MemoryRow {
  score: number;
  hops: number;
  breakdown: GraphScoreBreakdown;
}

export interface TraverseGraphsOptions {
  visibleRows?: MemoryRow[];
  maxNodes?: number;
}

interface MutableTraversalResult {
  row: MemoryRow;
  score: number;
  hops: number;
  breakdown: GraphScoreBreakdown;
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "had",
  "has",
  "have",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "was",
  "we",
  "were",
  "with",
]);

function blankBreakdown(): GraphScoreBreakdown {
  return {
    causal: 0,
    temporal: 0,
    entity: 0,
    semantic: 0,
  };
}

function parseTags(tags: string): string[] {
  try {
    const parsed = JSON.parse(tags) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function normaliseToken(token: string): string {
  return token.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "");
}

function tokenize(text: string): string[] {
  return text
    .split(/\s+/)
    .map(normaliseToken)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function uniqueTokens(text: string): string[] {
  return [...new Set(tokenize(text))];
}

function extractEntityKeys(row: MemoryRow): string[] {
  const tags = parseTags(row.tags).map(normaliseToken).filter(Boolean);
  const titleCase = row.content.match(/\b(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+|[A-Z]{2,})\b/g) ?? [];
  const contentTokens = uniqueTokens(row.content).filter((token) => token.length >= 4);

  return [...new Set([...tags, ...titleCase.map(normaliseToken), ...contentTokens])];
}

function tokenFrequency(text: string): Map<string, number> {
  const counts = new Map<string, number>();

  for (const token of tokenize(text)) {
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

function loadCandidateRows(db: Database, visibleRows?: MemoryRow[]): MemoryRow[] {
  if (visibleRows !== undefined) {
    return visibleRows;
  }

  return db
    .prepare<unknown[], MemoryRow>(
      `SELECT * FROM memories
       WHERE invalidated_at IS NULL
         AND valid_until IS NULL`
    )
    .all();
}

function buildCausalAdjacency(rows: MemoryRow[]): Map<string, Set<string>> {
  const rowIds = new Set(rows.map((row) => row.id));
  const adjacency = new Map<string, Set<string>>();

  const connect = (fromId: string, toId: string) => {
    if (!rowIds.has(fromId) || !rowIds.has(toId)) {
      return;
    }

    if (!adjacency.has(fromId)) {
      adjacency.set(fromId, new Set<string>());
    }

    if (!adjacency.has(toId)) {
      adjacency.set(toId, new Set<string>());
    }

    adjacency.get(fromId)?.add(toId);
    adjacency.get(toId)?.add(fromId);
  };

  for (const row of rows) {
    if (row.caused_by !== null) {
      connect(row.id, row.caused_by);
    }
    if (row.supersedes !== null) {
      connect(row.id, row.supersedes);
    }
  }

  return adjacency;
}

function buildEntityIndex(rows: MemoryRow[]): Map<string, Set<string>> {
  const entityIndex = new Map<string, Set<string>>();

  for (const row of rows) {
    for (const key of extractEntityKeys(row)) {
      if (!entityIndex.has(key)) {
        entityIndex.set(key, new Set<string>());
      }
      entityIndex.get(key)?.add(row.id);
    }
  }

  return entityIndex;
}

/**
 * Traverses causal, temporal, entity, and semantic graph edges from a seed memory.
 */
export function traverseGraphs(
  db: Database,
  memoryId: string,
  intentWeights: IntentWeights,
  maxHops: number,
  options?: TraverseGraphsOptions
): GraphTraversalResult[] {
  return withDbError(`traversing graph neighbors for memory '${memoryId}'`, () => {
    const rows = loadCandidateRows(db, options?.visibleRows);
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    const seed = rowsById.get(memoryId);

    if (seed === undefined) {
      return [];
    }

    const maxNodes = options?.maxNodes ?? 50;
    const results = new Map<string, MutableTraversalResult>();
    const causalAdjacency = buildCausalAdjacency(rows);
    const temporalRows = [...rows].sort((left, right) => {
      const validFrom = left.valid_from.localeCompare(right.valid_from);
      if (validFrom !== 0) {
        return validFrom;
      }
      return left.recorded_at.localeCompare(right.recorded_at);
    });
    const temporalIndex = temporalRows.findIndex((row) => row.id === seed.id);
    const entityIndex = buildEntityIndex(rows);
    const entityKeysById = new Map(
      rows.map((row) => [row.id, extractEntityKeys(row)])
    );
    const tokenCountsById = new Map(
      rows.map((row) => [row.id, tokenFrequency(row.content)])
    );

    const addResult = (
      candidateId: string,
      dimension: keyof GraphScoreBreakdown,
      contribution: number,
      depth: number
    ): boolean => {
      if (candidateId === seed.id || contribution <= 0) {
        return results.size >= maxNodes;
      }

      const row = rowsById.get(candidateId);
      if (row === undefined) {
        return results.size >= maxNodes;
      }

      const existing = results.get(candidateId);

      if (existing === undefined) {
        if (results.size >= maxNodes) {
          return true;
        }

        const created: MutableTraversalResult = {
          row,
          score: contribution,
          hops: depth,
          breakdown: blankBreakdown(),
        };
        created.breakdown[dimension] = contribution;
        results.set(candidateId, created);
        return results.size >= maxNodes;
      }

      existing.score += contribution;
      existing.hops = Math.min(existing.hops, depth);
      existing.breakdown[dimension] += contribution;
      return results.size >= maxNodes;
    };

    const causalHopLimit = Math.min(Math.max(maxHops, 0), 2);
    if (intentWeights.causal > 0 && causalHopLimit > 0) {
      const queue: Array<{ id: string; depth: number }> = [
        { id: seed.id, depth: 0 },
      ];
      const visited = new Set<string>([seed.id]);

      while (queue.length > 0) {
        const current = queue.shift();
        if (current === undefined || current.depth >= causalHopLimit) {
          continue;
        }

        const neighbors = [...(causalAdjacency.get(current.id) ?? [])];
        for (const neighborId of neighbors) {
          if (visited.has(neighborId)) {
            continue;
          }

          visited.add(neighborId);
          const depth = current.depth + 1;
          const capped = addResult(
            neighborId,
            "causal",
            intentWeights.causal / depth,
            depth
          );
          if (capped) {
            break;
          }
          if (depth < causalHopLimit) {
            queue.push({ id: neighborId, depth });
          }
        }

        if (results.size >= maxNodes) {
          break;
        }
      }
    }

    const temporalHopLimit = Math.min(Math.max(maxHops, 0), 1);
    if (
      intentWeights.temporal > 0 &&
      temporalHopLimit > 0 &&
      temporalIndex >= 0
    ) {
      const previous = temporalRows[temporalIndex - 1];
      const next = temporalRows[temporalIndex + 1];

      if (previous !== undefined) {
        addResult(previous.id, "temporal", intentWeights.temporal, 1);
      }

      if (results.size < maxNodes && next !== undefined) {
        addResult(next.id, "temporal", intentWeights.temporal, 1);
      }
    }

    const entityHopLimit = Math.min(Math.max(maxHops, 0), 2);
    if (intentWeights.entity > 0 && entityHopLimit > 0) {
      const queue: Array<{ id: string; depth: number }> = [
        { id: seed.id, depth: 0 },
      ];
      const visited = new Set<string>([seed.id]);

      while (queue.length > 0) {
        const current = queue.shift();
        if (current === undefined || current.depth >= entityHopLimit) {
          continue;
        }

        const keys = entityKeysById.get(current.id) ?? [];
        const neighborWeights = new Map<string, number>();

        for (const key of keys) {
          for (const neighborId of entityIndex.get(key) ?? []) {
            if (neighborId === current.id) {
              continue;
            }
            neighborWeights.set(
              neighborId,
              (neighborWeights.get(neighborId) ?? 0) + 1
            );
          }
        }

        const rankedNeighbors = [...neighborWeights.entries()]
          .sort((left, right) => right[1] - left[1])
          .slice(0, 12);

        for (const [neighborId, overlap] of rankedNeighbors) {
          if (visited.has(neighborId)) {
            continue;
          }

          visited.add(neighborId);
          const depth = current.depth + 1;
          const overlapWeight = overlap / Math.max(keys.length, 1);
          const capped = addResult(
            neighborId,
            "entity",
            (intentWeights.entity * overlapWeight) / depth,
            depth
          );
          if (capped) {
            break;
          }
          if (depth < entityHopLimit) {
            queue.push({ id: neighborId, depth });
          }
        }

        if (results.size >= maxNodes) {
          break;
        }
      }
    }

    if (intentWeights.semantic > 0 && maxHops > 0 && results.size < maxNodes) {
      const seedTokens =
        tokenCountsById.get(seed.id) ?? new Map<string, number>();
      const semanticNeighbors = rows
        .filter((row) => row.id !== seed.id)
        .map((row) => ({
          row,
          similarity: cosineFromCounts(
            seedTokens,
            tokenCountsById.get(row.id) ?? new Map<string, number>()
          ),
        }))
        .filter((candidate) => candidate.similarity > 0)
        .sort((left, right) => right.similarity - left.similarity)
        .slice(0, maxNodes);

      for (const candidate of semanticNeighbors) {
        const capped = addResult(
          candidate.row.id,
          "semantic",
          intentWeights.semantic * candidate.similarity,
          1
        );
        if (capped) {
          break;
        }
      }
    }

    return [...results.values()]
      .map((entry) => ({
        ...entry.row,
        score: entry.score,
        hops: entry.hops,
        breakdown: entry.breakdown,
      }))
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        if (left.hops !== right.hops) {
          return left.hops - right.hops;
        }
        return right.recorded_at.localeCompare(left.recorded_at);
      });
  });
}
