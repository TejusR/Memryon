export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

const PATH_SEPARATOR = "\u001f";

function isPlainObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableSortObject(input: JsonObject): JsonObject {
  const sortedEntries = Object.entries(input)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, sortJsonValue(value)] as const);

  return Object.fromEntries(sortedEntries);
}

function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }

  if (isPlainObject(value)) {
    return stableSortObject(value);
  }

  return value;
}

function formatScalar(value: JsonPrimitive): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

function collectJsonLines(
  value: JsonValue,
  path: string[],
  lines: string[]
): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${path.join(".") || "$"}: []`);
      return;
    }

    value.forEach((entry, index) => {
      collectJsonLines(entry, [...path, `[${index}]`], lines);
    });
    return;
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right)
    );

    if (entries.length === 0) {
      lines.push(`${path.join(".") || "$"}: {}`);
      return;
    }

    for (const [key, entry] of entries) {
      collectJsonLines(entry, [...path, key], lines);
    }

    return;
  }

  lines.push(`${path.join(".") || "$"}: ${formatScalar(value)}`);
}

/**
 * Stringifies JSON deterministically so equivalent objects produce identical text.
 */
export function stableJsonStringify(value: JsonValue): string {
  return JSON.stringify(sortJsonValue(value));
}

/**
 * Flattens a JSON object into newline-delimited search text.
 */
export function flattenJsonToSearchText(value: JsonObject): string {
  const lines: string[] = [];
  collectJsonLines(value, [], lines);
  return lines.join("\n");
}

/**
 * Joins a namespace tuple into the canonical internal path representation.
 */
export function namespaceToPath(namespace: readonly string[]): string {
  return namespace.join(PATH_SEPARATOR);
}

/**
 * Returns true when a namespace path exactly matches or starts with a prefix path.
 */
export function pathHasPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}${PATH_SEPARATOR}`);
}

/**
 * Returns true when a namespace path exactly matches or ends with a suffix path.
 */
export function pathHasSuffix(path: string, suffix: string): boolean {
  return path === suffix || path.endsWith(`${PATH_SEPARATOR}${suffix}`);
}

/**
 * Truncates a namespace to the requested maximum depth.
 */
export function truncateNamespace(
  namespace: readonly string[],
  maxDepth?: number
): string[] {
  if (maxDepth === undefined || maxDepth >= namespace.length) {
    return [...namespace];
  }

  return namespace.slice(0, maxDepth);
}

/**
 * Returns true when every top-level filter field exactly matches the candidate object.
 */
export function jsonObjectMatchesFilter(
  candidate: JsonObject,
  filter: JsonObject | undefined
): boolean {
  if (filter === undefined) {
    return true;
  }

  return Object.entries(filter).every(([key, expected]) => {
    const actual = candidate[key];
    if (actual === undefined) {
      return false;
    }

    return stableJsonStringify(actual) === stableJsonStringify(expected);
  });
}
