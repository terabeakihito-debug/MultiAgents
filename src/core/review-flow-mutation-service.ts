import {
  reviewService,
  ReviewRequestError,
  type ReviewRequest,
} from "./review-service";

type ReviewFlowMutationDependencies = {
  parse: typeof reviewService.parseRequest;
  run: typeof reviewService.run;
};

export function createReviewFlowMutationService(
  dependencies: ReviewFlowMutationDependencies = {
    parse: reviewService.parseRequest,
    run: (request, options) => reviewService.run(request, options),
  },
) {
  return {
    async apply(body: unknown, options: { signal?: AbortSignal } = {}) {
      let reviewRequest: ReviewRequest;
      try {
        reviewRequest = dependencies.parse(body);
      } catch (error) {
        if (error instanceof ReviewRequestError) throw error;
        throw error;
      }

      return dependencies.run(reviewRequest, {
        signal: options.signal,
        log: ({ flowId, stepId, agent, status, durationMs }) =>
          console.info(
            "review_flow",
            JSON.stringify({ flowId, stepId, agent, status, durationMs }),
          ),
      });
    },
  };
}

/** Framework-independent review flow mutation used by transport adapters. */
export const reviewFlowMutationService = createReviewFlowMutationService();

export { ReviewRequestError };
