import type { IncomingMessage, ServerResponse } from "node:http";
import {
  taskCiService,
  TaskCiNotFoundError,
} from "../core/task-ci-service";
import {
  taskDetailService,
  TaskDetailNotFoundError,
} from "../core/task-detail-service";
import {
  taskFindingsService,
  TaskFindingsLoadError,
} from "../core/task-findings-service";
import {
  FindingAcceptInputError,
  findingAcceptMutationService,
} from "../core/finding-accept-mutation-service";
import {
  FindingConvertInputError,
  findingConvertMutationService,
} from "../core/finding-convert-mutation-service";
import {
  FindingPriorityInputError,
  findingPriorityMutationService,
} from "../core/finding-priority-mutation-service";
import {
  FindingResolveInputError,
  findingResolveMutationService,
} from "../core/finding-resolve-mutation-service";
import {
  FindingDismissInputError,
  findingDismissMutationService,
} from "../core/finding-dismiss-mutation-service";
import {
  TaskFindingsExtractInputError,
  taskFindingsExtractMutationService,
} from "../core/task-findings-extract-mutation-service";
import {
  taskHistoryService,
  TaskHistoryNotFoundError,
} from "../core/task-history-service";
import {
  taskPrService,
  TaskPrConflictError,
  TaskPrNotFoundError,
} from "../core/task-pr-service";
import {
  taskProfileService,
  TaskProfileInvalidError,
  TaskProfileNotFoundError,
} from "../core/task-profile-service";
import {
  taskRuntimePolicyService,
  TaskRuntimePolicyNotFoundError,
  TaskRuntimePolicyUnavailableError,
} from "../core/task-runtime-policy-service";
import {
  taskSandboxPolicyService,
  TaskSandboxPolicyNotFoundError,
  TaskSandboxPolicyUnavailableError,
} from "../core/task-sandbox-policy-service";
import {
  dashboardTasksService,
  DashboardQueryError,
} from "../core/dashboard-tasks-service";
import { cleanupCandidatesService } from "../core/cleanup-candidates-service";
import { cleanupExecuteMutationService } from "../core/cleanup-execute-mutation-service";
import { cleanupPreviewMutationService } from "../core/cleanup-preview-mutation-service";
import { credentialStatusService } from "../core/credential-status-service";
import {
  findingsQueueService,
  RemediationQueueQueryError,
} from "../core/findings-queue-service";
import { operationsOverviewService } from "../core/operations-overview-service";
import { outboundSlackSettingsService } from "../core/outbound-slack-settings-service";
import {
  OutboundInputError,
  outboundSlackSettingsMutationService,
} from "../core/outbound-slack-settings-mutation-service";
import { runtimeSandboxStatusService } from "../core/runtime-sandbox-status-service";
import {
  notificationListService,
  NotificationInputError,
} from "../core/notification-list-service";
import { notificationPreferencesService } from "../core/notification-preferences-service";
import {
  NotificationInputError as NotificationPreferencesInputError,
  notificationPreferencesMutationService,
} from "../core/notification-preferences-mutation-service";
import { notificationDismissMutationService } from "../core/notification-dismiss-mutation-service";
import { notificationReadAllMutationService } from "../core/notification-read-all-mutation-service";
import { notificationReadMutationService } from "../core/notification-read-mutation-service";
import {
  OutboundInputError as NotificationSlackDeliveryDismissInputError,
  notificationSlackDeliveryDismissMutationService,
} from "../core/notification-slack-delivery-dismiss-mutation-service";
import {
  OutboundInputError as NotificationSlackMarkDeliveredInputError,
  notificationSlackMarkDeliveredMutationService,
} from "../core/notification-slack-mark-delivered-mutation-service";
import {
  OutboundInputError as NotificationSlackRetryInputError,
  notificationSlackRetryMutationService,
} from "../core/notification-slack-retry-mutation-service";
import { profileListService } from "../core/profile-list-service";
import { repoListService } from "../core/repo-list-service";
import {
  repoProfileService,
  RepoProfileNotFoundError,
} from "../core/repo-profile-service";
import { repoProfileMutationService } from "../core/repo-profile-mutation-service";
import {
  repoPullsService,
  RepoPullsRequestError,
} from "../core/repo-pulls-service";
import {
  repoTemplatesService,
  RepoTemplatesNotFoundError,
} from "../core/repo-templates-service";
import { repoTemplatesMutationService } from "../core/repo-templates-mutation-service";
import { humanSessionService } from "../core/human-session-service";
import { humanMutationGateService } from "../core/human-mutation-gate-service";
import {
  maintenanceMutationErrorStatus,
  maintenanceMutationService,
} from "../core/maintenance-mutation-service";
import {
  TaskRequestError,
  taskCreateMutationService,
} from "../core/task-create-mutation-service";
import {
  ApprovalError,
  TaskApproveInputError,
  taskApproveMutationService,
} from "../core/task-approve-mutation-service";
import {
  ApprovalError as TaskApproveReworkApprovalError,
  TaskApproveReworkInputError,
  taskApproveReworkMutationService,
} from "../core/task-approve-rework-mutation-service";
import {
  ApprovalError as TaskApplyReviewApprovalError,
  TaskApplyReviewInputError,
  taskApplyReviewMutationService,
} from "../core/task-apply-review-mutation-service";
import {
  ApprovalError as TaskCreatePrApprovalError,
  taskCreatePrMutationService,
} from "../core/task-create-pr-mutation-service";
import {
  ApprovalError as TaskFetchReviewApprovalError,
  taskFetchReviewMutationService,
} from "../core/task-fetch-review-mutation-service";
import {
  ApprovalError as TaskRefreshPrApprovalError,
  taskRefreshPrMutationService,
} from "../core/task-refresh-pr-mutation-service";
import {
  DependencyRecoveryTaskNotFoundError,
  DependencyRecoveryUnavailableError,
  taskDependencyRecoveryInstructionsMutationService,
} from "../core/task-dependency-recovery-instructions-mutation-service";
import {
  TaskReassociateInputError,
  taskReassociateMutationService,
} from "../core/task-reassociate-mutation-service";
import { taskReassociatePreviewMutationService } from "../core/task-reassociate-preview-mutation-service";
import { taskResumeMutationService } from "../core/task-resume-mutation-service";
import { taskPrepareApprovalMutationService } from "../core/task-prepare-approval-mutation-service";
import {
  TaskCleanupRequestError,
  taskDeleteMutationService,
} from "../core/task-delete-mutation-service";
import { maintenanceStateService } from "../core/maintenance-state-service";
import { toWebRequestWithBody } from "./incoming-request";
import { retentionPolicyService } from "../core/retention-policy-service";
import {
  RetentionPresetInvalidError,
  retentionPolicyMutationService,
} from "../core/retention-policy-mutation-service";
import { stateBackupsService } from "../core/state-backups-service";
import {
  StateBackupUnavailableError,
  stateBackupCreateMutationService,
} from "../core/state-backup-create-mutation-service";
import {
  BackupValidationError,
  stateBackupValidateService,
} from "../core/state-backup-validate-service";
import {
  AgentRunInputError,
  AgentRunUnknownAgentError,
  agentRunMutationService,
} from "../core/agent-run-mutation-service";
import { agentParallelRunMutationService } from "../core/agent-parallel-run-mutation-service";
import {
  ReviewRequestError,
  reviewFlowMutationService,
} from "../core/review-flow-mutation-service";
import { reviewRerunMutationService } from "../core/review-rerun-mutation-service";
import { reviewFlowStreamMutationService } from "../core/review-flow-stream-mutation-service";
import { taskService } from "../core/task-service";
import {
  healthReadiness,
  ReadinessError,
} from "../server/operational-health";

type DaemonHttpDependencies = {
  health: typeof healthReadiness;
  listTasks: typeof taskService.list;
  loadTaskDetail: typeof taskDetailService.load;
  loadTaskHistory: typeof taskHistoryService.load;
  loadTaskProfile: typeof taskProfileService.load;
  loadTaskFindings: typeof taskFindingsService.load;
  applyTaskFindingsExtractMutation: typeof taskFindingsExtractMutationService.apply;
  applyFindingAcceptMutation: typeof findingAcceptMutationService.apply;
  applyFindingDismissMutation: typeof findingDismissMutationService.apply;
  applyFindingConvertMutation: typeof findingConvertMutationService.apply;
  applyFindingResolveMutation: typeof findingResolveMutationService.apply;
  applyFindingPriorityMutation: typeof findingPriorityMutationService.apply;
  loadTaskCi: typeof taskCiService.load;
  loadTaskPr: typeof taskPrService.load;
  loadTaskSandboxPolicy: typeof taskSandboxPolicyService.load;
  loadTaskRuntimePolicy: typeof taskRuntimePolicyService.load;
  loadProfileList: typeof profileListService.load;
  loadRepoList: typeof repoListService.load;
  loadCredentialStatus: typeof credentialStatusService.load;
  loadNotifications: typeof notificationListService.load;
  applyNotificationReadMutation: typeof notificationReadMutationService.apply;
  applyNotificationDismissMutation: typeof notificationDismissMutationService.apply;
  applyNotificationReadAllMutation: typeof notificationReadAllMutationService.apply;
  applyNotificationSlackRetryMutation: typeof notificationSlackRetryMutationService.apply;
  applyNotificationSlackMarkDeliveredMutation: typeof notificationSlackMarkDeliveredMutationService.apply;
  applyNotificationSlackDeliveryDismissMutation: typeof notificationSlackDeliveryDismissMutationService.apply;
  loadFindingsQueue: typeof findingsQueueService.load;
  loadOperationsOverview: typeof operationsOverviewService.load;
  loadDashboardTasks: typeof dashboardTasksService.load;
  loadRuntimeSandboxStatus: typeof runtimeSandboxStatusService.load;
  loadNotificationPreferences: typeof notificationPreferencesService.load;
  applyNotificationPreferencesMutation: typeof notificationPreferencesMutationService.apply;
  loadRetentionPolicy: typeof retentionPolicyService.load;
  applyRetentionPolicyMutation: typeof retentionPolicyMutationService.apply;
  loadCleanupCandidates: typeof cleanupCandidatesService.load;
  applyCleanupPreviewMutation: typeof cleanupPreviewMutationService.apply;
  applyCleanupExecuteMutation: typeof cleanupExecuteMutationService.apply;
  loadRepoProfile: typeof repoProfileService.load;
  applyRepoProfileMutation: typeof repoProfileMutationService.apply;
  loadRepoTemplates: typeof repoTemplatesService.load;
  applyRepoTemplatesMutation: typeof repoTemplatesMutationService.apply;
  applyAgentRunMutation: typeof agentRunMutationService.apply;
  applyAgentParallelRunMutation: typeof agentParallelRunMutationService.apply;
  applyReviewFlowMutation: typeof reviewFlowMutationService.apply;
  prepareReviewRerun: typeof reviewRerunMutationService.prepare;
  prepareReviewFlowStream: typeof reviewFlowStreamMutationService.prepare;
  loadRepoPulls: typeof repoPullsService.load;
  issueHumanSession: typeof humanSessionService.issue;
  rejectHumanMutation: typeof humanMutationGateService.reject;
  applyMaintenanceMutation: typeof maintenanceMutationService.apply;
  initializeTaskRecovery: typeof taskCreateMutationService.initialize;
  createTaskFromBody: typeof taskCreateMutationService.createFromBody;
  initializeTaskDeleteRecovery: typeof taskDeleteMutationService.initialize;
  parseTaskDeleteBody: typeof taskDeleteMutationService.parseDeleteBody;
  removeTask: typeof taskDeleteMutationService.removeTask;
  applyTaskApproveMutation: typeof taskApproveMutationService.apply;
  applyTaskApproveReworkMutation: typeof taskApproveReworkMutationService.apply;
  applyTaskApplyReviewMutation: typeof taskApplyReviewMutationService.apply;
  applyTaskPrepareApprovalMutation: typeof taskPrepareApprovalMutationService.apply;
  applyTaskCreatePrMutation: typeof taskCreatePrMutationService.apply;
  applyTaskFetchReviewMutation: typeof taskFetchReviewMutationService.apply;
  applyTaskRefreshPrMutation: typeof taskRefreshPrMutationService.apply;
  applyTaskResumeMutation: typeof taskResumeMutationService.apply;
  applyTaskReassociatePreviewMutation: typeof taskReassociatePreviewMutationService.apply;
  applyTaskReassociateMutation: typeof taskReassociateMutationService.apply;
  applyTaskDependencyRecoveryInstructionsMutation: typeof taskDependencyRecoveryInstructionsMutationService.apply;
  loadOutboundSlackSettings: typeof outboundSlackSettingsService.load;
  applyOutboundSlackSettingsMutation: typeof outboundSlackSettingsMutationService.apply;
  loadMaintenanceState: typeof maintenanceStateService.load;
  loadStateBackups: typeof stateBackupsService.load;
  createStateBackup: typeof stateBackupCreateMutationService.create;
  loadStateBackupValidate: typeof stateBackupValidateService.load;
};

export function createDaemonHttpHandler(
  dependencies: DaemonHttpDependencies = {
    health: healthReadiness,
    listTasks: () => taskService.list(),
    loadTaskDetail: (id) => taskDetailService.load(id),
    loadTaskHistory: (id) => taskHistoryService.load(id),
    loadTaskProfile: (id) => taskProfileService.load(id),
    loadTaskFindings: (id) => taskFindingsService.load(id),
    applyTaskFindingsExtractMutation: (taskId, body) =>
      taskFindingsExtractMutationService.apply(taskId, body),
    applyFindingAcceptMutation: (findingId, body) =>
      findingAcceptMutationService.apply(findingId, body),
    applyFindingDismissMutation: (findingId, body) =>
      findingDismissMutationService.apply(findingId, body),
    applyFindingConvertMutation: (findingId, body) =>
      findingConvertMutationService.apply(findingId, body),
    applyFindingResolveMutation: (findingId, body) =>
      findingResolveMutationService.apply(findingId, body),
    applyFindingPriorityMutation: (findingId, body) =>
      findingPriorityMutationService.apply(findingId, body),
    loadTaskCi: (id) => taskCiService.load(id),
    loadTaskPr: (id) => taskPrService.load(id),
    loadTaskSandboxPolicy: (id) => taskSandboxPolicyService.load(id),
    loadTaskRuntimePolicy: (id) => taskRuntimePolicyService.load(id),
    loadProfileList: () => profileListService.load(),
    loadRepoList: () => repoListService.load(),
    loadCredentialStatus: () => credentialStatusService.load(),
    loadNotifications: (url) => notificationListService.load(url),
    applyNotificationReadMutation: (notificationId) =>
      notificationReadMutationService.apply(notificationId),
    applyNotificationDismissMutation: (notificationId) =>
      notificationDismissMutationService.apply(notificationId),
    applyNotificationReadAllMutation: () =>
      notificationReadAllMutationService.apply(),
    applyNotificationSlackRetryMutation: (notificationId) =>
      notificationSlackRetryMutationService.apply(notificationId),
    applyNotificationSlackMarkDeliveredMutation: (notificationId) =>
      notificationSlackMarkDeliveredMutationService.apply(notificationId),
    applyNotificationSlackDeliveryDismissMutation: (notificationId) =>
      notificationSlackDeliveryDismissMutationService.apply(notificationId),
    loadFindingsQueue: (url) => findingsQueueService.load(url),
    loadOperationsOverview: () => operationsOverviewService.load(),
    loadDashboardTasks: (url) => dashboardTasksService.load(url),
    loadRuntimeSandboxStatus: () => runtimeSandboxStatusService.load(),
    loadNotificationPreferences: () => notificationPreferencesService.load(),
    applyNotificationPreferencesMutation: (body) =>
      notificationPreferencesMutationService.apply(body),
    loadRetentionPolicy: () => retentionPolicyService.load(),
    applyRetentionPolicyMutation: (body) =>
      retentionPolicyMutationService.apply(body),
    loadCleanupCandidates: () => cleanupCandidatesService.load(),
    applyCleanupPreviewMutation: (body) =>
      cleanupPreviewMutationService.apply(body),
    applyCleanupExecuteMutation: (body) =>
      cleanupExecuteMutationService.apply(body),
    loadRepoProfile: (repoId) => repoProfileService.load(repoId),
    applyRepoProfileMutation: (repoId, body) =>
      repoProfileMutationService.apply(repoId, body),
    loadRepoTemplates: (repoId) => repoTemplatesService.load(repoId),
    applyRepoTemplatesMutation: (repoId, body) =>
      repoTemplatesMutationService.apply(repoId, body),
    applyAgentRunMutation: (agentId, body, options) =>
      agentRunMutationService.apply(agentId, body, options),
    applyAgentParallelRunMutation: (body, options) =>
      agentParallelRunMutationService.apply(body, options),
    applyReviewFlowMutation: (body, options) =>
      reviewFlowMutationService.apply(body, options),
    prepareReviewRerun: (body, signal) =>
      reviewRerunMutationService.prepare(body, signal),
    prepareReviewFlowStream: (body, signal) =>
      reviewFlowStreamMutationService.prepare(body, signal),
    loadRepoPulls: (repoId) => repoPullsService.load(repoId),
    issueHumanSession: (webRequest) => humanSessionService.issue(webRequest),
    rejectHumanMutation: (webRequest, action, options) =>
      humanMutationGateService.reject(webRequest, action, options),
    applyMaintenanceMutation: (body) => maintenanceMutationService.apply(body),
    initializeTaskRecovery: () => taskCreateMutationService.initialize(),
    createTaskFromBody: (body) => taskCreateMutationService.createFromBody(body),
    initializeTaskDeleteRecovery: () => taskDeleteMutationService.initialize(),
    parseTaskDeleteBody: (rawBody) =>
      taskDeleteMutationService.parseDeleteBody(rawBody),
    removeTask: (id, cleanupRequest) =>
      taskDeleteMutationService.removeTask(id, cleanupRequest),
    applyTaskApproveMutation: (taskId, body) =>
      taskApproveMutationService.apply(taskId, body),
    applyTaskApproveReworkMutation: (taskId, body) =>
      taskApproveReworkMutationService.apply(taskId, body),
    applyTaskApplyReviewMutation: (taskId, body) =>
      taskApplyReviewMutationService.apply(taskId, body),
    applyTaskPrepareApprovalMutation: (taskId) =>
      taskPrepareApprovalMutationService.apply(taskId),
    applyTaskCreatePrMutation: (taskId) =>
      taskCreatePrMutationService.apply(taskId),
    applyTaskFetchReviewMutation: (taskId) =>
      taskFetchReviewMutationService.apply(taskId),
    applyTaskRefreshPrMutation: (taskId) =>
      taskRefreshPrMutationService.apply(taskId),
    applyTaskResumeMutation: (taskId) =>
      taskResumeMutationService.apply(taskId),
    applyTaskReassociatePreviewMutation: (taskId) =>
      taskReassociatePreviewMutationService.apply(taskId),
    applyTaskReassociateMutation: (taskId, body) =>
      taskReassociateMutationService.apply(taskId, body),
    applyTaskDependencyRecoveryInstructionsMutation: (taskId) =>
      taskDependencyRecoveryInstructionsMutationService.apply(taskId),
    loadOutboundSlackSettings: () => outboundSlackSettingsService.load(),
    applyOutboundSlackSettingsMutation: (body) =>
      outboundSlackSettingsMutationService.apply(body),
    loadMaintenanceState: () => maintenanceStateService.load(),
    loadStateBackups: () => stateBackupsService.load(),
    createStateBackup: () => stateBackupCreateMutationService.create(),
    loadStateBackupValidate: (backupId) =>
      stateBackupValidateService.load(backupId),
  },
) {
  return async function handleDaemonHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const rejection = rejectNonLocalRequest(request);
    if (rejection) {
      writeJson(response, rejection.status, { error: rejection.error });
      return;
    }

    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host}`,
    );

    if (request.method === "GET" && url.pathname === "/health") {
      try {
        const result = await dependencies.health();
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 503, {
          status: "unavailable",
          database: "unavailable",
          errorCode:
            error instanceof ReadinessError
              ? error.message
              : "readiness_failed",
        });
      }
      return;
    }

    if (url.pathname === "/flows/review") {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "review-run",
        { label: "Review execution" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      let body: unknown;
      try {
        body = await webRequest.json();
      } catch {
        writeJson(response, 400, {
          error: "Request body must be valid JSON",
        });
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.applyReviewFlowMutation(body, {
            signal: webRequest.signal,
          }),
        );
      } catch (error) {
        if (error instanceof ReviewRequestError) {
          writeJson(response, 400, { error: error.message });
          return;
        }
        writeJson(response, 500, {
          error:
            error instanceof Error ? error.message : "Review execution failed",
        });
      }
      return;
    }

    if (url.pathname === "/flows/review/stream") {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "review-run",
        { label: "Review execution" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      let body: unknown;
      try {
        body = await webRequest.json();
      } catch {
        writeJson(response, 400, {
          error: "Request body must be valid JSON",
        });
        return;
      }

      const prepared = await dependencies.prepareReviewFlowStream(
        body,
        webRequest.signal,
      );
      if (prepared.kind === "error") {
        writeJson(response, prepared.status, prepared.body);
        return;
      }

      await writeEventStreamResponse(response, prepared.stream);
      return;
    }

    if (url.pathname === "/flows/review/rerun") {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "review-rerun",
        { label: "Review rerun" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      let body: unknown;
      try {
        body = await webRequest.json();
      } catch {
        writeJson(response, 400, {
          error: "Request body must be valid JSON",
        });
        return;
      }

      const prepared = await dependencies.prepareReviewRerun(
        body,
        webRequest.signal,
      );
      if (prepared.kind === "error") {
        writeJson(response, prepared.status, prepared.body);
        return;
      }

      await writeEventStreamResponse(response, prepared.stream);
      return;
    }

    if (url.pathname === "/agents/parallel") {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "agent-run",
        { label: "Parallel agent execution" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      let body: unknown;
      try {
        body = await webRequest.json();
      } catch {
        writeJson(response, 400, {
          error: "Request body must be valid JSON",
        });
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.applyAgentParallelRunMutation(body, {
            signal: webRequest.signal,
          }),
        );
      } catch (error) {
        if (error instanceof AgentRunInputError) {
          writeJson(response, 400, { error: error.message });
          return;
        }
        writeJson(response, 500, {
          error:
            error instanceof Error
              ? error.message
              : "Parallel agent execution failed",
        });
      }
      return;
    }

    const agentRunId = matchAgentRunPath(url.pathname);
    if (agentRunId) {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "agent-run",
        { label: "Agent execution" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      let body: unknown;
      try {
        body = await webRequest.json();
      } catch {
        writeJson(response, 400, {
          error: "Request body must be valid JSON",
        });
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.applyAgentRunMutation(agentRunId, body, {
            signal: webRequest.signal,
          }),
        );
      } catch (error) {
        if (error instanceof AgentRunUnknownAgentError) {
          writeJson(response, 404, { error: error.message });
          return;
        }
        if (error instanceof AgentRunInputError) {
          writeJson(response, 400, { error: error.message });
          return;
        }
        writeJson(response, 500, {
          error:
            error instanceof Error ? error.message : "Agent execution failed",
        });
      }
      return;
    }

    if (url.pathname === "/human-session") {
      if (request.method !== "GET") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      await writeWebResponse(
        response,
        dependencies.issueHumanSession(toWebRequest(request)),
      );
      return;
    }

    if (url.pathname === "/maintenance") {
      if (request.method === "GET") {
        try {
          writeJson(response, 200, dependencies.loadMaintenanceState());
        } catch (error) {
          console.error(
            "daemon_maintenance_state_failed",
            error instanceof Error ? error.message : "unknown",
          );
          writeJson(response, 500, { error: "maintenance_state_failed" });
        }
        return;
      }

      if (request.method === "POST") {
        const webRequest = await toWebRequestWithBody(request);
        const rejection = dependencies.rejectHumanMutation(
          webRequest,
          "maintenance-mode",
          { label: "Maintenance mode" },
        );
        if (rejection) {
          await writeWebResponse(response, rejection);
          return;
        }

        let body: unknown;
        try {
          body = await webRequest.json();
        } catch {
          writeJson(response, 400, {
            error: "Request body must be valid JSON",
          });
          return;
        }

        try {
          writeJson(
            response,
            200,
            await dependencies.applyMaintenanceMutation(body),
          );
        } catch (error) {
          const status = maintenanceMutationErrorStatus(error);
          writeJson(response, status, {
            error:
              error instanceof Error
                ? error.message
                : "Maintenance mode update failed",
          });
        }
        return;
      }

      writeJson(response, 404, { error: "Not found" });
      return;
    }

    const stateBackupValidateId = matchStateBackupValidatePath(url.pathname);
    if (stateBackupValidateId) {
      if (request.method === "GET") {
        try {
          writeJson(
            response,
            200,
            dependencies.loadStateBackupValidate(stateBackupValidateId),
          );
        } catch (error) {
          if (error instanceof BackupValidationError) {
            writeJson(response, 400, { error: error.message });
            return;
          }
          console.error(
            "daemon_state_backup_validate_failed",
            error instanceof Error ? error.message : "unknown",
          );
          writeJson(response, 500, {
            error:
              error instanceof Error
                ? error.message
                : "Backup validation failed",
          });
        }
        return;
      }

      if (request.method === "POST") {
        const webRequest = await toWebRequestWithBody(request);
        const rejection = dependencies.rejectHumanMutation(
          webRequest,
          "state-backup-validate",
          { label: "Backup validation" },
        );
        if (rejection) {
          await writeWebResponse(response, rejection);
          return;
        }

        try {
          writeJson(
            response,
            200,
            dependencies.loadStateBackupValidate(stateBackupValidateId),
          );
        } catch (error) {
          if (error instanceof BackupValidationError) {
            writeJson(response, 400, { error: error.message });
            return;
          }
          writeJson(response, 500, {
            error:
              error instanceof Error
                ? error.message
                : "Backup validation failed",
          });
        }
        return;
      }

      writeJson(response, 404, { error: "Not found" });
      return;
    }

    if (url.pathname === "/state/backups") {
      if (request.method === "GET") {
        try {
          writeJson(response, 200, dependencies.loadStateBackups());
        } catch (error) {
          console.error(
            "daemon_state_backups_failed",
            error instanceof Error ? error.message : "unknown",
          );
          writeJson(response, 500, { error: "state_backups_failed" });
        }
        return;
      }

      if (request.method === "POST") {
        const webRequest = await toWebRequestWithBody(request);
        const rejection = dependencies.rejectHumanMutation(
          webRequest,
          "state-backup",
          { label: "State backup" },
        );
        if (rejection) {
          await writeWebResponse(response, rejection);
          return;
        }

        try {
          writeJson(response, 201, await dependencies.createStateBackup());
        } catch (error) {
          if (error instanceof StateBackupUnavailableError) {
            writeJson(response, 409, { error: error.message });
            return;
          }
          writeJson(response, 500, {
            error:
              error instanceof Error ? error.message : "State backup failed",
          });
        }
        return;
      }

      writeJson(response, 404, { error: "Not found" });
      return;
    }

    if (url.pathname === "/outbound/slack/settings") {
      if (request.method === "GET") {
        try {
          writeJson(response, 200, dependencies.loadOutboundSlackSettings());
        } catch (error) {
          console.error(
            "daemon_outbound_slack_settings_failed",
            error instanceof Error ? error.message : "unknown",
          );
          writeJson(response, 500, { error: "outbound_slack_settings_failed" });
        }
        return;
      }

      if (request.method === "POST") {
        const webRequest = await toWebRequestWithBody(request);
        const rejection = dependencies.rejectHumanMutation(
          webRequest,
          "outbound-preferences",
          { label: "External notification" },
        );
        if (rejection) {
          await writeWebResponse(response, rejection);
          return;
        }

        let body: unknown;
        try {
          body = await webRequest.json();
        } catch {
          writeJson(response, 400, {
            error: "Request body must be valid JSON",
          });
          return;
        }

        try {
          writeJson(
            response,
            200,
            dependencies.applyOutboundSlackSettingsMutation(body),
          );
        } catch (error) {
          writeJson(response, error instanceof OutboundInputError ? 400 : 500, {
            error:
              error instanceof Error
                ? error.message
                : "Outbound preferences update failed",
          });
        }
        return;
      }

      writeJson(response, 404, { error: "Not found" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/profiles") {
      try {
        writeJson(response, 200, dependencies.loadProfileList());
      } catch (error) {
        console.error(
          "daemon_profile_list_failed",
          error instanceof Error ? error.message : "unknown",
        );
        writeJson(response, 500, { error: "profile_list_failed" });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/repos") {
      try {
        writeJson(response, 200, await dependencies.loadRepoList());
      } catch (error) {
        console.error(
          "daemon_repo_list_failed",
          error instanceof Error ? error.message : "unknown",
        );
        writeJson(response, 500, { error: "repo_list_failed" });
      }
      return;
    }

    const repoProfileId = matchRepoLeafPath(url.pathname, "profile");
    if (repoProfileId) {
      if (request.method === "GET") {
        try {
          writeJson(
            response,
            200,
            await dependencies.loadRepoProfile(repoProfileId),
          );
        } catch (error) {
          if (error instanceof RepoProfileNotFoundError) {
            writeJson(response, 404, { error: error.message });
            return;
          }
          console.error(
            "daemon_repo_profile_failed",
            error instanceof Error ? error.message : "unknown",
          );
          writeJson(response, 500, { error: "repo_profile_failed" });
        }
        return;
      }

      if (request.method === "POST") {
        const webRequest = await toWebRequestWithBody(request);
        const rejection = dependencies.rejectHumanMutation(
          webRequest,
          "profile-save",
          { label: "Profile" },
        );
        if (rejection) {
          await writeWebResponse(response, rejection);
          return;
        }

        let body: unknown;
        try {
          body = await webRequest.json();
        } catch {
          writeJson(response, 400, {
            error: "Request body must be valid JSON",
          });
          return;
        }

        try {
          writeJson(
            response,
            200,
            await dependencies.applyRepoProfileMutation(repoProfileId, body),
          );
        } catch (error) {
          writeJson(response, 400, {
            error:
              error instanceof Error ? error.message : "Profile update failed",
          });
        }
        return;
      }

      writeJson(response, 404, { error: "Not found" });
      return;
    }

    const repoTemplatesId = matchRepoLeafPath(url.pathname, "templates");
    if (repoTemplatesId) {
      if (request.method === "GET") {
        try {
          writeJson(
            response,
            200,
            await dependencies.loadRepoTemplates(repoTemplatesId),
          );
        } catch (error) {
          if (error instanceof RepoTemplatesNotFoundError) {
            writeJson(response, 404, { error: error.message });
            return;
          }
          console.error(
            "daemon_repo_templates_failed",
            error instanceof Error ? error.message : "unknown",
          );
          writeJson(response, 500, { error: "repo_templates_failed" });
        }
        return;
      }

      if (request.method === "POST") {
        const webRequest = await toWebRequestWithBody(request);
        const rejection = dependencies.rejectHumanMutation(
          webRequest,
          "template-save",
          { label: "Task template" },
        );
        if (rejection) {
          await writeWebResponse(response, rejection);
          return;
        }

        let body: unknown;
        try {
          body = await webRequest.json();
        } catch {
          writeJson(response, 400, {
            error: "Request body must be valid JSON",
          });
          return;
        }

        try {
          writeJson(
            response,
            200,
            await dependencies.applyRepoTemplatesMutation(repoTemplatesId, body),
          );
        } catch (error) {
          writeJson(response, 400, {
            error:
              error instanceof Error
                ? error.message
                : "Task template settings update failed",
          });
        }
        return;
      }

      writeJson(response, 404, { error: "Not found" });
      return;
    }

    const repoPullsId = matchRepoLeafPath(url.pathname, "pulls");
    if (repoPullsId) {
      if (request.method !== "GET") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.loadRepoPulls(repoPullsId),
        );
      } catch (error) {
        if (error instanceof RepoPullsRequestError) {
          writeJson(response, 400, { error: error.message });
          return;
        }
        console.error(
          "daemon_repo_pulls_failed",
          error instanceof Error ? error.message : "unknown",
        );
        writeJson(response, 500, { error: "repo_pulls_failed" });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/credentials/status") {
      try {
        writeJson(response, 200, dependencies.loadCredentialStatus());
      } catch (error) {
        console.error(
          "daemon_credential_status_failed",
          error instanceof Error ? error.message : "unknown",
        );
        writeJson(response, 500, { error: "credential_status_failed" });
      }
      return;
    }

    if (url.pathname === "/cleanup/preview") {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "cleanup-preview",
        { label: "Cleanup preview" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      let body: unknown;
      try {
        body = await webRequest.json();
      } catch {
        writeJson(response, 400, {
          error: "Cleanup selection must be valid JSON",
        });
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.applyCleanupPreviewMutation(body),
        );
      } catch (error) {
        writeJson(response, 409, {
          error:
            error instanceof Error ? error.message : "Cleanup preview failed",
        });
      }
      return;
    }

    if (url.pathname === "/cleanup/execute") {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "cleanup-execute",
        { label: "Cleanup" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      let body: unknown;
      try {
        body = await webRequest.json();
      } catch {
        writeJson(response, 400, {
          error: "Cleanup selection must be valid JSON",
        });
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.applyCleanupExecuteMutation(body),
        );
      } catch (error) {
        writeJson(response, 409, {
          error: error instanceof Error ? error.message : "Cleanup failed",
        });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/cleanup/candidates") {
      try {
        writeJson(response, 200, await dependencies.loadCleanupCandidates());
      } catch (error) {
        console.error(
          "daemon_cleanup_candidates_failed",
          error instanceof Error ? error.message : "unknown",
        );
        writeJson(response, 500, { error: "cleanup_candidates_failed" });
      }
      return;
    }

    if (url.pathname === "/retention-policy") {
      if (request.method === "GET") {
        try {
          writeJson(response, 200, dependencies.loadRetentionPolicy());
        } catch (error) {
          console.error(
            "daemon_retention_policy_failed",
            error instanceof Error ? error.message : "unknown",
          );
          writeJson(response, 500, { error: "retention_policy_failed" });
        }
        return;
      }

      if (request.method === "POST") {
        const webRequest = await toWebRequestWithBody(request);
        const rejection = dependencies.rejectHumanMutation(
          webRequest,
          "retention-policy",
          { label: "Retention policy" },
        );
        if (rejection) {
          await writeWebResponse(response, rejection);
          return;
        }

        let body: unknown;
        try {
          body = await webRequest.json();
        } catch {
          writeJson(response, 400, {
            error: "Retention policy must be valid JSON",
          });
          return;
        }

        try {
          writeJson(
            response,
            200,
            dependencies.applyRetentionPolicyMutation(body),
          );
        } catch (error) {
          if (error instanceof RetentionPresetInvalidError) {
            writeJson(response, 400, { error: error.message });
            return;
          }
          writeJson(response, 500, {
            error:
              error instanceof Error
                ? error.message
                : "retention_policy_update_failed",
          });
        }
        return;
      }

      writeJson(response, 404, { error: "Not found" });
      return;
    }

    if (url.pathname === "/notification-preferences") {
      if (request.method === "GET") {
        try {
          writeJson(response, 200, dependencies.loadNotificationPreferences());
        } catch (error) {
          console.error(
            "daemon_notification_preferences_failed",
            error instanceof Error ? error.message : "unknown",
          );
          writeJson(response, 500, { error: "notification_preferences_failed" });
        }
        return;
      }

      if (request.method === "POST") {
        const webRequest = await toWebRequestWithBody(request);
        const rejection = dependencies.rejectHumanMutation(
          webRequest,
          "notification-preferences",
          { label: "Notification" },
        );
        if (rejection) {
          await writeWebResponse(response, rejection);
          return;
        }

        let body: unknown;
        try {
          body = await webRequest.json();
        } catch {
          writeJson(response, 400, {
            error: "Request body must be valid JSON",
          });
          return;
        }

        try {
          writeJson(
            response,
            200,
            dependencies.applyNotificationPreferencesMutation(body),
          );
        } catch (error) {
          writeJson(response, error instanceof NotificationPreferencesInputError ? 400 : 500, {
            error:
              error instanceof Error
                ? error.message
                : "Preferences update failed",
          });
        }
        return;
      }

      writeJson(response, 404, { error: "Not found" });
      return;
    }

    const notificationSlackDeliveryDismissId =
      matchNotificationSlackDeliveryDismissPath(url.pathname);
    if (notificationSlackDeliveryDismissId) {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "outbound-dismiss",
        { label: "External notification" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      try {
        writeJson(
          response,
          200,
          dependencies.applyNotificationSlackDeliveryDismissMutation(
            notificationSlackDeliveryDismissId,
          ),
        );
      } catch (error) {
        writeJson(
          response,
          error instanceof NotificationSlackDeliveryDismissInputError
            ? 400
            : 500,
          {
            error:
              error instanceof Error
                ? error.message
                : "Slack delivery update failed",
          },
        );
      }
      return;
    }

    const notificationSlackMarkDeliveredId =
      matchNotificationSlackMarkDeliveredPath(url.pathname);
    if (notificationSlackMarkDeliveredId) {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "outbound-mark-delivered",
        { label: "External notification" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      try {
        writeJson(
          response,
          200,
          dependencies.applyNotificationSlackMarkDeliveredMutation(
            notificationSlackMarkDeliveredId,
          ),
        );
      } catch (error) {
        writeJson(
          response,
          error instanceof NotificationSlackMarkDeliveredInputError ? 400 : 500,
          {
            error:
              error instanceof Error
                ? error.message
                : "Slack delivery update failed",
          },
        );
      }
      return;
    }

    const notificationSlackRetryId = matchNotificationSlackRetryPath(url.pathname);
    if (notificationSlackRetryId) {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "outbound-retry",
        { label: "External notification" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.applyNotificationSlackRetryMutation(
            notificationSlackRetryId,
          ),
        );
      } catch (error) {
        writeJson(response, error instanceof NotificationSlackRetryInputError ? 400 : 500, {
          error:
            error instanceof Error ? error.message : "Slack retry failed",
        });
      }
      return;
    }

    if (url.pathname === "/notifications/read-all") {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "notification-read-all",
        { label: "Notification" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      writeJson(response, 200, dependencies.applyNotificationReadAllMutation());
      return;
    }

    const notificationReadId = matchNotificationReadPath(url.pathname);
    if (notificationReadId) {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "notification-read",
        { label: "Notification" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      try {
        const notification = dependencies.applyNotificationReadMutation(
          notificationReadId,
        );
        if (!notification) {
          writeJson(response, 404, { error: "Notification not found" });
          return;
        }
        writeJson(response, 200, { notification });
      } catch (error) {
        writeJson(response, 400, {
          error:
            error instanceof Error ? error.message : "Notification update failed",
        });
      }
      return;
    }

    const notificationDismissId = matchNotificationDismissPath(url.pathname);
    if (notificationDismissId) {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "notification-dismiss",
        { label: "Notification" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      try {
        const notification = dependencies.applyNotificationDismissMutation(
          notificationDismissId,
        );
        if (!notification) {
          writeJson(response, 404, { error: "Notification not found" });
          return;
        }
        writeJson(response, 200, { notification });
      } catch (error) {
        writeJson(response, 400, {
          error:
            error instanceof Error
              ? error.message
              : "Notification dismissal failed",
        });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/notifications") {
      try {
        writeJson(response, 200, dependencies.loadNotifications(url));
      } catch (error) {
        if (error instanceof NotificationInputError) {
          writeJson(response, 400, { error: error.message });
          return;
        }
        console.error(
          "daemon_notification_list_failed",
          error instanceof Error ? error.message : "unknown",
        );
        writeJson(response, 500, { error: "notification_list_failed" });
      }
      return;
    }

    const findingAcceptId = matchFindingAcceptPath(url.pathname);
    if (findingAcceptId) {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "finding-accept",
        { label: "Finding" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      let body: unknown;
      try {
        body = await webRequest.json();
      } catch {
        writeJson(response, 400, {
          error: "Request body must be valid JSON",
        });
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.applyFindingAcceptMutation(findingAcceptId, body),
        );
      } catch (error) {
        if (error instanceof FindingAcceptInputError) {
          writeJson(response, 400, { error: error.message });
          return;
        }
        writeJson(response, 409, {
          error:
            error instanceof Error ? error.message : "Finding acceptance failed",
        });
      }
      return;
    }

    const findingDismissId = matchFindingDismissPath(url.pathname);
    if (findingDismissId) {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "finding-dismiss",
        { label: "Finding" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      let body: unknown;
      try {
        body = await webRequest.json();
      } catch {
        writeJson(response, 400, {
          error: "Request body must be valid JSON",
        });
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.applyFindingDismissMutation(
            findingDismissId,
            body,
          ),
        );
      } catch (error) {
        if (error instanceof FindingDismissInputError) {
          writeJson(response, 400, { error: error.message });
          return;
        }
        writeJson(response, 409, {
          error:
            error instanceof Error ? error.message : "Finding dismissal failed",
        });
      }
      return;
    }

    const findingConvertId = matchFindingConvertPath(url.pathname);
    if (findingConvertId) {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "finding-convert",
        { label: "Finding" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      let body: unknown;
      try {
        body = await webRequest.json();
      } catch {
        writeJson(response, 400, {
          error: "Request body must be valid JSON",
        });
        return;
      }

      try {
        writeJson(
          response,
          201,
          await dependencies.applyFindingConvertMutation(
            findingConvertId,
            body,
          ),
        );
      } catch (error) {
        if (error instanceof FindingConvertInputError) {
          writeJson(response, 400, { error: error.message });
          return;
        }
        writeJson(response, 409, {
          error:
            error instanceof Error ? error.message : "Finding conversion failed",
        });
      }
      return;
    }

    const findingResolveId = matchFindingResolvePath(url.pathname);
    if (findingResolveId) {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "finding-resolve",
        { label: "Finding" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      let body: unknown;
      try {
        body = await webRequest.json();
      } catch {
        writeJson(response, 400, {
          error: "Request body must be valid JSON",
        });
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.applyFindingResolveMutation(
            findingResolveId,
            body,
          ),
        );
      } catch (error) {
        if (error instanceof FindingResolveInputError) {
          writeJson(response, 400, { error: error.message });
          return;
        }
        writeJson(response, 409, {
          error:
            error instanceof Error ? error.message : "Finding resolution failed",
        });
      }
      return;
    }

    const findingPriorityId = matchFindingPriorityPath(url.pathname);
    if (findingPriorityId) {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "finding-priority",
        { label: "Finding" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      let body: unknown;
      try {
        body = await webRequest.json();
      } catch {
        writeJson(response, 400, {
          error: "Request body must be valid JSON",
        });
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.applyFindingPriorityMutation(
            findingPriorityId,
            body,
          ),
        );
      } catch (error) {
        if (error instanceof FindingPriorityInputError) {
          writeJson(response, 400, { error: error.message });
          return;
        }
        writeJson(response, 409, {
          error:
            error instanceof Error
              ? error.message
              : "Finding priority update failed",
        });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/findings/queue") {
      try {
        writeJson(response, 200, dependencies.loadFindingsQueue(url));
      } catch (error) {
        if (error instanceof RemediationQueueQueryError) {
          writeJson(response, 400, { error: error.message });
          return;
        }
        console.error(
          "daemon_findings_queue_failed",
          error instanceof Error ? error.message : "unknown",
        );
        writeJson(response, 500, { error: "findings_queue_failed" });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/operations/overview") {
      try {
        writeJson(response, 200, await dependencies.loadOperationsOverview());
      } catch (error) {
        console.error(
          "daemon_operations_overview_failed",
          error instanceof Error ? error.message : "unknown",
        );
        writeJson(response, 500, { error: "operations_overview_failed" });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/dashboard/tasks") {
      try {
        writeJson(response, 200, await dependencies.loadDashboardTasks(url));
      } catch (error) {
        if (error instanceof DashboardQueryError) {
          writeJson(response, 400, { error: error.message });
          return;
        }
        console.error(
          "daemon_dashboard_tasks_failed",
          error instanceof Error ? error.message : "unknown",
        );
        writeJson(response, 500, { error: "dashboard_tasks_failed" });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/runtime/sandbox-status") {
      try {
        const result = await dependencies.loadRuntimeSandboxStatus();
        writeJson(response, result.statusCode, result.body);
      } catch (error) {
        console.error(
          "daemon_runtime_sandbox_status_failed",
          error instanceof Error ? error.message : "unknown",
        );
        writeJson(response, 500, { error: "runtime_sandbox_status_failed" });
      }
      return;
    }

    if (url.pathname === "/tasks") {
      if (request.method === "GET") {
        try {
          const tasks = await dependencies.listTasks();
          writeJson(response, 200, { tasks });
        } catch (error) {
          console.error(
            "daemon_task_list_failed",
            error instanceof Error ? error.message : "unknown",
          );
          writeJson(response, 500, { error: "task_list_failed" });
        }
        return;
      }

      if (request.method === "POST") {
        const webRequest = await toWebRequestWithBody(request);
        const rejection = dependencies.rejectHumanMutation(
          webRequest,
          "task-create",
          { label: "Task creation" },
        );
        if (rejection) {
          await writeWebResponse(response, rejection);
          return;
        }

        await dependencies.initializeTaskRecovery();

        let body: unknown;
        try {
          body = await webRequest.json();
        } catch {
          writeJson(response, 400, {
            error: "Request body must be valid JSON",
          });
          return;
        }

        try {
          writeJson(
            response,
            201,
            await dependencies.createTaskFromBody(body),
          );
        } catch (error) {
          if (error instanceof TaskRequestError) {
            writeJson(response, 400, { error: error.message });
            return;
          }
          writeJson(response, 400, {
            error:
              error instanceof Error ? error.message : "Task creation failed",
          });
        }
        return;
      }

      writeJson(response, 404, { error: "Not found" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/tasks/history") {
      try {
        const tasks = await dependencies.listTasks();
        writeJson(response, 200, { tasks });
      } catch (error) {
        console.error(
          "daemon_task_history_list_failed",
          error instanceof Error ? error.message : "unknown",
        );
        writeJson(response, 500, { error: "task_history_list_failed" });
      }
      return;
    }

    const historyTaskId = matchTaskLeafPath(url.pathname, "history");
    if (historyTaskId) {
      if (request.method !== "GET") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.loadTaskHistory(historyTaskId),
        );
      } catch (error) {
        if (error instanceof TaskHistoryNotFoundError) {
          writeJson(response, 404, { error: "Task not found" });
          return;
        }
        console.error(
          "daemon_task_history_failed",
          error instanceof Error ? error.message : "unknown",
        );
        writeJson(response, 500, { error: "task_history_failed" });
      }
      return;
    }

    const profileTaskId = matchTaskLeafPath(url.pathname, "profile");
    if (profileTaskId) {
      if (request.method !== "GET") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.loadTaskProfile(profileTaskId),
        );
      } catch (error) {
        if (error instanceof TaskProfileNotFoundError) {
          writeJson(response, 404, { error: "Task not found" });
          return;
        }
        if (error instanceof TaskProfileInvalidError) {
          writeJson(response, 409, { error: error.message });
          return;
        }
        console.error(
          "daemon_task_profile_failed",
          error instanceof Error ? error.message : "unknown",
        );
        writeJson(response, 500, { error: "task_profile_failed" });
      }
      return;
    }

    const findingsExtractTaskId = matchTaskFindingsExtractPath(url.pathname);
    if (findingsExtractTaskId) {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "finding-extract",
        { label: "Finding" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      let body: unknown;
      try {
        body = await webRequest.json();
      } catch {
        writeJson(response, 400, {
          error: "Request body must be valid JSON",
        });
        return;
      }

      try {
        writeJson(
          response,
          201,
          await dependencies.applyTaskFindingsExtractMutation(
            findingsExtractTaskId,
            body,
          ),
        );
      } catch (error) {
        if (error instanceof TaskFindingsExtractInputError) {
          writeJson(response, 400, { error: error.message });
          return;
        }
        writeJson(response, 409, {
          error:
            error instanceof Error ? error.message : "Finding extraction failed",
        });
      }
      return;
    }

    const findingsTaskId = matchTaskLeafPath(url.pathname, "findings");
    if (findingsTaskId) {
      if (request.method !== "GET") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.loadTaskFindings(findingsTaskId),
        );
      } catch (error) {
        if (error instanceof TaskFindingsLoadError) {
          writeJson(response, 404, { error: error.message });
          return;
        }
        console.error(
          "daemon_task_findings_failed",
          error instanceof Error ? error.message : "unknown",
        );
        writeJson(response, 500, { error: "task_findings_failed" });
      }
      return;
    }

    const prTaskId = matchTaskLeafPath(url.pathname, "pr");
    if (prTaskId) {
      if (request.method !== "GET") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      try {
        writeJson(response, 200, await dependencies.loadTaskPr(prTaskId));
      } catch (error) {
        if (error instanceof TaskPrNotFoundError) {
          writeJson(response, 404, { error: "Task not found" });
          return;
        }
        if (error instanceof TaskPrConflictError) {
          writeJson(response, 409, { error: error.message });
          return;
        }
        console.error(
          "daemon_task_pr_failed",
          error instanceof Error ? error.message : "unknown",
        );
        writeJson(response, 500, { error: "task_pr_failed" });
      }
      return;
    }

    const ciTaskId = matchTaskLeafPath(url.pathname, "ci");
    if (ciTaskId) {
      if (request.method !== "GET") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      try {
        writeJson(response, 200, await dependencies.loadTaskCi(ciTaskId));
      } catch (error) {
        if (error instanceof TaskCiNotFoundError) {
          writeJson(response, 404, { error: "Task not found" });
          return;
        }
        console.error(
          "daemon_task_ci_failed",
          error instanceof Error ? error.message : "unknown",
        );
        writeJson(response, 500, { error: "task_ci_failed" });
      }
      return;
    }

    const sandboxPolicyTaskId = matchTaskLeafPath(url.pathname, "sandbox-policy");
    if (sandboxPolicyTaskId) {
      if (request.method !== "GET") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.loadTaskSandboxPolicy(sandboxPolicyTaskId),
        );
      } catch (error) {
        if (error instanceof TaskSandboxPolicyNotFoundError) {
          writeJson(response, 404, { error: "Task not found" });
          return;
        }
        if (error instanceof TaskSandboxPolicyUnavailableError) {
          writeJson(response, 409, { error: error.message });
          return;
        }
        console.error(
          "daemon_task_sandbox_policy_failed",
          error instanceof Error ? error.message : "unknown",
        );
        writeJson(response, 500, { error: "task_sandbox_policy_failed" });
      }
      return;
    }

    const runtimePolicyTaskId = matchTaskLeafPath(url.pathname, "runtime-policy");
    if (runtimePolicyTaskId) {
      if (request.method !== "GET") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.loadTaskRuntimePolicy(runtimePolicyTaskId),
        );
      } catch (error) {
        if (error instanceof TaskRuntimePolicyNotFoundError) {
          writeJson(response, 404, { error: "Task not found" });
          return;
        }
        if (error instanceof TaskRuntimePolicyUnavailableError) {
          writeJson(response, 409, { error: error.message });
          return;
        }
        console.error(
          "daemon_task_runtime_policy_failed",
          error instanceof Error ? error.message : "unknown",
        );
        writeJson(response, 500, { error: "task_runtime_policy_failed" });
      }
      return;
    }

    const taskDependencyRecoveryId =
      matchTaskDependencyRecoveryInstructionsPath(url.pathname);
    if (taskDependencyRecoveryId) {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "task-dependency-recovery-instructions",
        { label: "Dependency recovery instructions" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.applyTaskDependencyRecoveryInstructionsMutation(
            taskDependencyRecoveryId,
          ),
        );
      } catch (error) {
        if (error instanceof DependencyRecoveryTaskNotFoundError) {
          writeJson(response, 404, { error: "Task not found" });
          return;
        }
        if (error instanceof DependencyRecoveryUnavailableError) {
          writeJson(response, 409, {
            error:
              "Dependency recovery instructions are unavailable for this task",
          });
          return;
        }
        throw error;
      }
      return;
    }

    const taskReassociatePreviewId = matchTaskReassociatePreviewPath(url.pathname);
    if (taskReassociatePreviewId) {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "task-reassociation-preview",
        { label: "Worktree reassociation preview" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.applyTaskReassociatePreviewMutation(
            taskReassociatePreviewId,
          ),
        );
      } catch (error) {
        writeJson(response, 409, {
          error:
            error instanceof Error ? error.message : "Reassociation preview failed",
        });
      }
      return;
    }

    const taskReassociateId = matchTaskReassociatePath(url.pathname);
    if (taskReassociateId) {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "task-reassociation-confirm",
        { label: "Worktree reassociation" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      let body: unknown;
      try {
        body = await webRequest.json();
      } catch {
        writeJson(response, 400, {
          error: "Request body must be valid JSON",
        });
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.applyTaskReassociateMutation(
            taskReassociateId,
            body,
          ),
        );
      } catch (error) {
        if (error instanceof TaskReassociateInputError) {
          writeJson(response, 400, { error: error.message });
          return;
        }
        writeJson(response, 409, {
          error: error instanceof Error ? error.message : "Reassociation failed",
        });
      }
      return;
    }

    const taskResumeId = matchTaskResumePath(url.pathname);
    if (taskResumeId) {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "task-resume",
        { label: "Task resume" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      const result = await dependencies.applyTaskResumeMutation(taskResumeId);
      writeJson(response, result.status, result.body);
      return;
    }

    const taskRefreshPrId = matchTaskRefreshPrPath(url.pathname);
    if (taskRefreshPrId) {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "task-refresh-pr",
        { label: "PR status refresh" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.applyTaskRefreshPrMutation(taskRefreshPrId),
        );
      } catch (error) {
        writeJson(
          response,
          error instanceof TaskRefreshPrApprovalError ? error.statusCode : 409,
          {
            error:
              error instanceof Error ? error.message : "PR status refresh failed",
          },
        );
      }
      return;
    }

    const taskFetchReviewId = matchTaskFetchReviewPath(url.pathname);
    if (taskFetchReviewId) {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "task-fetch-review",
        { label: "PR review fetch" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.applyTaskFetchReviewMutation(taskFetchReviewId),
        );
      } catch (error) {
        writeJson(
          response,
          error instanceof TaskFetchReviewApprovalError ? error.statusCode : 409,
          {
            error:
              error instanceof Error ? error.message : "PR review fetch failed",
          },
        );
      }
      return;
    }

    const taskCreatePrId = matchTaskCreatePrPath(url.pathname);
    if (taskCreatePrId) {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "task-create-pr",
        { label: "PR creation" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.applyTaskCreatePrMutation(taskCreatePrId),
        );
      } catch (error) {
        writeJson(response, error instanceof TaskCreatePrApprovalError ? error.statusCode : 409, {
          error: error instanceof Error ? error.message : "PR retry failed",
        });
      }
      return;
    }

    const taskPrepareApprovalId = matchTaskPrepareApprovalPath(url.pathname);
    if (taskPrepareApprovalId) {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "task-prepare-approval",
        { label: "Approval snapshot" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      const result = await dependencies.applyTaskPrepareApprovalMutation(
        taskPrepareApprovalId,
      );
      writeJson(response, result.status, result.body);
      return;
    }

    const taskApplyReviewId = matchTaskApplyReviewPath(url.pathname);
    if (taskApplyReviewId) {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "task-apply-review",
        { label: "Reviewed fixes" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      let body: unknown;
      try {
        body = await webRequest.json();
      } catch {
        writeJson(response, 400, {
          error: "Request body must be valid JSON",
        });
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.applyTaskApplyReviewMutation(
            taskApplyReviewId,
            body,
          ),
        );
      } catch (error) {
        if (error instanceof TaskApplyReviewInputError) {
          writeJson(response, 400, { error: error.message });
          return;
        }
        writeJson(
          response,
          error instanceof TaskApplyReviewApprovalError ? error.statusCode : 409,
          {
            error: error instanceof Error ? error.message : "PR rework failed",
          },
        );
      }
      return;
    }

    const taskApproveReworkId = matchTaskApproveReworkPath(url.pathname);
    if (taskApproveReworkId) {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "task-approve-rework",
        { label: "Rework approval" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      let body: unknown;
      try {
        body = await webRequest.json();
      } catch {
        writeJson(response, 400, {
          error: "Request body must be valid JSON",
        });
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.applyTaskApproveReworkMutation(
            taskApproveReworkId,
            body,
          ),
        );
      } catch (error) {
        if (error instanceof TaskApproveReworkInputError) {
          writeJson(response, 400, { error: error.message });
          return;
        }
        writeJson(
          response,
          error instanceof TaskApproveReworkApprovalError ? error.statusCode : 409,
          {
            error:
              error instanceof Error ? error.message : "Rework approval failed",
          },
        );
      }
      return;
    }

    const taskApproveId = matchTaskApprovePath(url.pathname);
    if (taskApproveId) {
      if (request.method !== "POST") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      const webRequest = await toWebRequestWithBody(request);
      const rejection = dependencies.rejectHumanMutation(
        webRequest,
        "task-approve",
        { label: "Task approval" },
      );
      if (rejection) {
        await writeWebResponse(response, rejection);
        return;
      }

      let body: unknown;
      try {
        body = await webRequest.json();
      } catch {
        writeJson(response, 400, {
          error: "Request body must be valid JSON",
        });
        return;
      }

      try {
        writeJson(
          response,
          200,
          await dependencies.applyTaskApproveMutation(taskApproveId, body),
        );
      } catch (error) {
        if (error instanceof TaskApproveInputError) {
          writeJson(response, 400, { error: error.message });
          return;
        }
        writeJson(response, error instanceof ApprovalError ? error.statusCode : 409, {
          error:
            error instanceof Error ? error.message : "Approve and create PR failed",
        });
      }
      return;
    }

    const taskId = matchTaskIdPath(url.pathname);
    if (taskId) {
      if (request.method === "GET") {
        try {
          const detail = await dependencies.loadTaskDetail(taskId);
          const body = detail.error
            ? { diff: detail.diff, task: detail.task, error: detail.error }
            : { diff: detail.diff, task: detail.task };
          writeJson(response, detail.conflict ? 409 : 200, body);
        } catch (error) {
          if (error instanceof TaskDetailNotFoundError) {
            writeJson(response, 404, { error: "Task not found" });
            return;
          }
          console.error(
            "daemon_task_detail_failed",
            error instanceof Error ? error.message : "unknown",
          );
          writeJson(response, 500, { error: "task_detail_failed" });
        }
        return;
      }

      if (request.method === "DELETE") {
        const webRequest = await toWebRequestWithBody(request);
        const rejection = dependencies.rejectHumanMutation(
          webRequest,
          "task-delete",
          { method: "DELETE", label: "Task cleanup" },
        );
        if (rejection) {
          await writeWebResponse(response, rejection);
          return;
        }

        await dependencies.initializeTaskDeleteRecovery();

        let cleanupRequest;
        try {
          const rawBody = await webRequest.text();
          cleanupRequest = dependencies.parseTaskDeleteBody(rawBody);
        } catch (error) {
          if (error instanceof TaskCleanupRequestError) {
            writeJson(response, 400, { error: "Invalid cleanup request" });
            return;
          }
          throw error;
        }

        try {
          await dependencies.removeTask(taskId, cleanupRequest);
          writeEmpty(response, 204);
        } catch (error) {
          writeJson(response, 409, {
            error: error instanceof Error ? error.message : "Cleanup failed",
          });
        }
        return;
      }

      writeJson(response, 404, { error: "Not found" });
      return;
    }

    writeJson(response, 404, { error: "Not found" });
  };
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(body));
}

function writeEmpty(response: ServerResponse, statusCode: number) {
  response.statusCode = statusCode;
  response.setHeader("Cache-Control", "no-store");
  response.end();
}

function toWebRequest(request: IncomingMessage) {
  const host = request.headers.host ?? "127.0.0.1";
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      headers.set(name, value);
    } else if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    }
  }

  return new Request(`http://${host}${request.url ?? "/"}`, {
    method: request.method ?? "GET",
    headers,
  });
}

async function writeWebResponse(
  response: ServerResponse,
  webResponse: Response,
) {
  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value, name) => {
    response.setHeader(name, value);
  });
  response.end(Buffer.from(await webResponse.arrayBuffer()));
}

async function writeEventStreamResponse(
  response: ServerResponse,
  stream: ReadableStream<Uint8Array>,
) {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");

  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      const chunk = Buffer.from(value);
      if (typeof response.write === "function") {
        response.write(chunk);
      } else {
        response.end(chunk);
        return;
      }
    }
    response.end();
  } finally {
    reader.releaseLock();
  }
}


const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function rejectNonLocalRequest(
  request: IncomingMessage,
): { status: number; error: string } | undefined {
  const hostHeader = request.headers.host;
  if (!hostHeader || !isLoopbackHost(hostHeader)) {
    return { status: 403, error: "This API is available only on localhost" };
  }

  const origin = request.headers.origin;
  if (!origin) return;

  try {
    const originUrl = new URL(origin);
    const requestOrigin = new URL(`http://${hostHeader}`).origin;

    if (
      !LOOPBACK_HOSTS.has(originUrl.hostname) ||
      originUrl.origin !== requestOrigin
    ) {
      return { status: 403, error: "Cross-origin requests are not allowed" };
    }
  } catch {
    return { status: 403, error: "Invalid Origin header" };
  }
}

function isLoopbackHost(hostHeader: string) {
  try {
    return LOOPBACK_HOSTS.has(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}

function matchStateBackupValidatePath(pathname: string) {
  const match = /^\/state\/backups\/([^/]+)\/validate$/.exec(pathname);
  return decodePathSegment(match?.[1]);
}

function matchAgentRunPath(pathname: string) {
  return decodePathSegment(/^\/agents\/([^/]+)$/.exec(pathname)?.[1]);
}

function matchRepoLeafPath(pathname: string, leaf: "profile" | "templates" | "pulls") {
  const match = /^\/repos\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!match || match[2] !== leaf) return;
  return decodePathSegment(match[1]);
}

function matchTaskIdPath(pathname: string) {
  return decodePathSegment(/^\/tasks\/([^/]+)$/.exec(pathname)?.[1]);
}

function matchTaskApprovePath(pathname: string) {
  const match = /^\/tasks\/([^/]+)\/approve$/.exec(pathname);
  return decodePathSegment(match?.[1]);
}

function matchTaskApproveReworkPath(pathname: string) {
  const match = /^\/tasks\/([^/]+)\/approve-rework$/.exec(pathname);
  return decodePathSegment(match?.[1]);
}

function matchTaskApplyReviewPath(pathname: string) {
  const match = /^\/tasks\/([^/]+)\/apply-review$/.exec(pathname);
  return decodePathSegment(match?.[1]);
}

function matchTaskPrepareApprovalPath(pathname: string) {
  const match = /^\/tasks\/([^/]+)\/prepare-approval$/.exec(pathname);
  return decodePathSegment(match?.[1]);
}

function matchTaskCreatePrPath(pathname: string) {
  const match = /^\/tasks\/([^/]+)\/create-pr$/.exec(pathname);
  return decodePathSegment(match?.[1]);
}

function matchTaskFetchReviewPath(pathname: string) {
  const match = /^\/tasks\/([^/]+)\/fetch-review$/.exec(pathname);
  return decodePathSegment(match?.[1]);
}

function matchTaskRefreshPrPath(pathname: string) {
  const match = /^\/tasks\/([^/]+)\/refresh-pr$/.exec(pathname);
  return decodePathSegment(match?.[1]);
}

function matchTaskResumePath(pathname: string) {
  const match = /^\/tasks\/([^/]+)\/resume$/.exec(pathname);
  return decodePathSegment(match?.[1]);
}

function matchTaskReassociatePreviewPath(pathname: string) {
  const match = /^\/tasks\/([^/]+)\/reassociate\/preview$/.exec(pathname);
  return decodePathSegment(match?.[1]);
}

function matchTaskReassociatePath(pathname: string) {
  const match = /^\/tasks\/([^/]+)\/reassociate$/.exec(pathname);
  return decodePathSegment(match?.[1]);
}

function matchTaskDependencyRecoveryInstructionsPath(pathname: string) {
  const match =
    /^\/tasks\/([^/]+)\/dependency-recovery-instructions$/.exec(pathname);
  return decodePathSegment(match?.[1]);
}

function matchTaskFindingsExtractPath(pathname: string) {
  const match = /^\/tasks\/([^/]+)\/findings\/extract$/.exec(pathname);
  return decodePathSegment(match?.[1]);
}

function matchFindingAcceptPath(pathname: string) {
  const match = /^\/findings\/([^/]+)\/accept$/.exec(pathname);
  return decodePathSegment(match?.[1]);
}

function matchFindingDismissPath(pathname: string) {
  const match = /^\/findings\/([^/]+)\/dismiss$/.exec(pathname);
  return decodePathSegment(match?.[1]);
}

function matchFindingConvertPath(pathname: string) {
  const match = /^\/findings\/([^/]+)\/convert$/.exec(pathname);
  return decodePathSegment(match?.[1]);
}

function matchFindingResolvePath(pathname: string) {
  const match = /^\/findings\/([^/]+)\/resolve$/.exec(pathname);
  return decodePathSegment(match?.[1]);
}

function matchFindingPriorityPath(pathname: string) {
  const match = /^\/findings\/([^/]+)\/priority$/.exec(pathname);
  return decodePathSegment(match?.[1]);
}

function matchNotificationReadPath(pathname: string) {
  const match = /^\/notifications\/([^/]+)\/read$/.exec(pathname);
  return decodePathSegment(match?.[1]);
}

function matchNotificationDismissPath(pathname: string) {
  const match = /^\/notifications\/([^/]+)\/dismiss$/.exec(pathname);
  return decodePathSegment(match?.[1]);
}

function matchNotificationSlackRetryPath(pathname: string) {
  const match =
    /^\/notifications\/([^/]+)\/deliveries\/slack\/retry$/.exec(pathname);
  return decodePathSegment(match?.[1]);
}

function matchNotificationSlackMarkDeliveredPath(pathname: string) {
  const match =
    /^\/notifications\/([^/]+)\/deliveries\/slack\/mark-delivered$/.exec(
      pathname,
    );
  return decodePathSegment(match?.[1]);
}

function matchNotificationSlackDeliveryDismissPath(pathname: string) {
  const match =
    /^\/notifications\/([^/]+)\/deliveries\/slack\/dismiss$/.exec(pathname);
  return decodePathSegment(match?.[1]);
}

function matchTaskLeafPath(
  pathname: string,
  leaf:
    | "history"
    | "profile"
    | "findings"
    | "pr"
    | "ci"
    | "sandbox-policy"
    | "runtime-policy",
) {
  const match = /^\/tasks\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!match || match[2] !== leaf) return;
  return decodePathSegment(match[1]);
}

function decodePathSegment(rawId: string | undefined) {
  if (!rawId) return;

  try {
    const id = decodeURIComponent(rawId);
    return id || undefined;
  } catch {
    return;
  }
}
