import {
  findingSeverities,
  findingStatuses,
  humanPriorities,
  remediationStages,
  type FindingSeverity,
  type FindingStatus,
  type HumanPriority,
  type RemediationPresenceFilter,
  type RemediationQueueResponse,
  type RemediationQueueSort,
  type RemediationStage,
} from "../findings/types";
import { getStateStore, type RemediationQueueQuery } from "./state-store";

export const MAX_REMEDIATION_QUEUE_LIMIT = 100;
export const DEFAULT_REMEDIATION_QUEUE_LIMIT = 50;
const sortValues = new Set<RemediationQueueSort>(["recommended", "severity", "age", "updated", "repo"]);
const presenceValues = new Set<RemediationPresenceFilter>(["any", "yes", "no"]);

export function parseRemediationQueueQuery(url: URL): RemediationQueueQuery {
  const repo = url.searchParams.get("repo")?.trim() || undefined;
  if (repo && !/^[A-Za-z0-9._-]{1,100}$/.test(repo)) throw new RemediationQueueQueryError("Invalid repository filter");
  const severity = optionalAllowed(url, "severity", findingSeverities, "severity") as FindingSeverity | undefined;
  const priority = optionalAllowed(url, "priority", humanPriorities, "priority") as HumanPriority | undefined;
  const status = optionalAllowed(url, "status", findingStatuses, "finding status") as FindingStatus | undefined;
  const stage = optionalAllowed(url, "stage", remediationStages, "remediation stage") as RemediationStage | undefined;
  const pr = presence(url, "pr");
  const converted = presence(url, "converted");
  const sort = (url.searchParams.get("sort") || "recommended") as RemediationQueueSort;
  if (!sortValues.has(sort)) throw new RemediationQueueQueryError("Invalid sort order");
  const includeDismissed = booleanParameter(url, "includeDismissed");
  const includeResolved = booleanParameter(url, "includeResolved");
  const search = url.searchParams.get("search")?.trim() || undefined;
  if (search && search.length > 120) throw new RemediationQueueQueryError("Search is limited to 120 characters");
  const limit = integerParameter(url, "limit", DEFAULT_REMEDIATION_QUEUE_LIMIT, 1, MAX_REMEDIATION_QUEUE_LIMIT);
  const offset = integerParameter(url, "offset", 0, 0, 100_000);
  return { repo, severity, priority, status, stage, pr, converted, sort, includeDismissed, includeResolved, search, limit, offset };
}

export function getRemediationQueue(query: RemediationQueueQuery, now = new Date()): RemediationQueueResponse {
  const result = getStateStore().queryRemediationQueue(query, now);
  return { findings: result.rows, counts: result.counts, limit: query.limit, offset: query.offset };
}

export function getRemediationFinding(findingId: string, now = new Date()) {
  if (!/^[0-9a-f-]{36}$/i.test(findingId)) throw new Error("Finding ID is invalid");
  const query: RemediationQueueQuery = {
    pr: "any", converted: "any", sort: "recommended", includeDismissed: true, includeResolved: true,
    limit: 1, offset: 0, findingId,
  };
  const row = getStateStore().queryRemediationQueue(query, now).rows[0];
  if (!row) throw new Error("Finding not found");
  return row;
}

function optionalAllowed(url: URL, key: string, allowed: readonly string[], label: string) {
  const value = url.searchParams.get(key)?.trim() || undefined;
  if (value && !allowed.includes(value)) throw new RemediationQueueQueryError(`Invalid ${label} filter`);
  return value;
}

function presence(url: URL, key: string): RemediationPresenceFilter {
  const value = (url.searchParams.get(key) || "any") as RemediationPresenceFilter;
  if (!presenceValues.has(value)) throw new RemediationQueueQueryError(`Invalid ${key} filter`);
  return value;
}

function booleanParameter(url: URL, key: string) {
  const value = url.searchParams.get(key);
  if (value !== null && value !== "true" && value !== "false") throw new RemediationQueueQueryError(`Invalid ${key} value`);
  return value === "true";
}

function integerParameter(url: URL, key: string, fallback: number, minimum: number, maximum: number) {
  const raw = url.searchParams.get(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RemediationQueueQueryError(`${key} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

export class RemediationQueueQueryError extends Error {}
