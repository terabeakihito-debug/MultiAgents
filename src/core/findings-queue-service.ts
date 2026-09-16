import {
  getRemediationQueue,
  parseRemediationQueueQuery,
  RemediationQueueQueryError,
} from "../server/remediation-queue";

type FindingsQueueDependencies = {
  parseQuery: typeof parseRemediationQueueQuery;
  loadQueue: typeof getRemediationQueue;
};

export function createFindingsQueueService(dependencies: FindingsQueueDependencies = {
  parseQuery: parseRemediationQueueQuery,
  loadQueue: getRemediationQueue,
}) {
  return {
    load(url: URL) {
      const query = dependencies.parseQuery(url);
      return dependencies.loadQueue(query);
    },
  };
}

/** Framework-independent remediation queue read boundary used by transport adapters. */
export const findingsQueueService = createFindingsQueueService();

export { RemediationQueueQueryError };
