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
import { credentialStatusService } from "../core/credential-status-service";
import {
  findingsQueueService,
  RemediationQueueQueryError,
} from "../core/findings-queue-service";
import { operationsOverviewService } from "../core/operations-overview-service";
import { outboundSlackSettingsService } from "../core/outbound-slack-settings-service";
import { runtimeSandboxStatusService } from "../core/runtime-sandbox-status-service";
import {
  notificationListService,
  NotificationInputError,
} from "../core/notification-list-service";
import { notificationPreferencesService } from "../core/notification-preferences-service";
import { profileListService } from "../core/profile-list-service";
import { repoListService } from "../core/repo-list-service";
import {
  repoProfileService,
  RepoProfileNotFoundError,
} from "../core/repo-profile-service";
import {
  repoPullsService,
  RepoPullsRequestError,
} from "../core/repo-pulls-service";
import {
  repoTemplatesService,
  RepoTemplatesNotFoundError,
} from "../core/repo-templates-service";
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
  BackupValidationError,
  stateBackupValidateService,
} from "../core/state-backup-validate-service";
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
  loadTaskCi: typeof taskCiService.load;
  loadTaskPr: typeof taskPrService.load;
  loadTaskSandboxPolicy: typeof taskSandboxPolicyService.load;
  loadTaskRuntimePolicy: typeof taskRuntimePolicyService.load;
  loadProfileList: typeof profileListService.load;
  loadRepoList: typeof repoListService.load;
  loadCredentialStatus: typeof credentialStatusService.load;
  loadNotifications: typeof notificationListService.load;
  loadFindingsQueue: typeof findingsQueueService.load;
  loadOperationsOverview: typeof operationsOverviewService.load;
  loadDashboardTasks: typeof dashboardTasksService.load;
  loadRuntimeSandboxStatus: typeof runtimeSandboxStatusService.load;
  loadNotificationPreferences: typeof notificationPreferencesService.load;
  loadRetentionPolicy: typeof retentionPolicyService.load;
  applyRetentionPolicyMutation: typeof retentionPolicyMutationService.apply;
  loadCleanupCandidates: typeof cleanupCandidatesService.load;
  loadRepoProfile: typeof repoProfileService.load;
  loadRepoTemplates: typeof repoTemplatesService.load;
  loadRepoPulls: typeof repoPullsService.load;
  issueHumanSession: typeof humanSessionService.issue;
  rejectHumanMutation: typeof humanMutationGateService.reject;
  applyMaintenanceMutation: typeof maintenanceMutationService.apply;
  initializeTaskRecovery: typeof taskCreateMutationService.initialize;
  createTaskFromBody: typeof taskCreateMutationService.createFromBody;
  initializeTaskDeleteRecovery: typeof taskDeleteMutationService.initialize;
  parseTaskDeleteBody: typeof taskDeleteMutationService.parseDeleteBody;
  removeTask: typeof taskDeleteMutationService.removeTask;
  loadOutboundSlackSettings: typeof outboundSlackSettingsService.load;
  loadMaintenanceState: typeof maintenanceStateService.load;
  loadStateBackups: typeof stateBackupsService.load;
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
    loadTaskCi: (id) => taskCiService.load(id),
    loadTaskPr: (id) => taskPrService.load(id),
    loadTaskSandboxPolicy: (id) => taskSandboxPolicyService.load(id),
    loadTaskRuntimePolicy: (id) => taskRuntimePolicyService.load(id),
    loadProfileList: () => profileListService.load(),
    loadRepoList: () => repoListService.load(),
    loadCredentialStatus: () => credentialStatusService.load(),
    loadNotifications: (url) => notificationListService.load(url),
    loadFindingsQueue: (url) => findingsQueueService.load(url),
    loadOperationsOverview: () => operationsOverviewService.load(),
    loadDashboardTasks: (url) => dashboardTasksService.load(url),
    loadRuntimeSandboxStatus: () => runtimeSandboxStatusService.load(),
    loadNotificationPreferences: () => notificationPreferencesService.load(),
    loadRetentionPolicy: () => retentionPolicyService.load(),
    applyRetentionPolicyMutation: (body) =>
      retentionPolicyMutationService.apply(body),
    loadCleanupCandidates: () => cleanupCandidatesService.load(),
    loadRepoProfile: (repoId) => repoProfileService.load(repoId),
    loadRepoTemplates: (repoId) => repoTemplatesService.load(repoId),
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
    loadOutboundSlackSettings: () => outboundSlackSettingsService.load(),
    loadMaintenanceState: () => maintenanceStateService.load(),
    loadStateBackups: () => stateBackupsService.load(),
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
      if (request.method !== "GET") {
        writeJson(response, 404, { error: "Not found" });
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

    if (request.method === "GET" && url.pathname === "/state/backups") {
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

    if (request.method === "GET" && url.pathname === "/outbound/slack/settings") {
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
      if (request.method !== "GET") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

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

    const repoTemplatesId = matchRepoLeafPath(url.pathname, "templates");
    if (repoTemplatesId) {
      if (request.method !== "GET") {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

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

    if (request.method === "GET" && url.pathname === "/notification-preferences") {
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

function matchRepoLeafPath(pathname: string, leaf: "profile" | "templates" | "pulls") {
  const match = /^\/repos\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!match || match[2] !== leaf) return;
  return decodePathSegment(match[1]);
}

function matchTaskIdPath(pathname: string) {
  return decodePathSegment(/^\/tasks\/([^/]+)$/.exec(pathname)?.[1]);
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
