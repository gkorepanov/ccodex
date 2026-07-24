import type { ActivePermissionProfile } from "../codex/generated/v2/ActivePermissionProfile.js";
import type { SandboxPolicy } from "../codex/generated/v2/SandboxPolicy.js";
import type { ThreadSettings } from "../codex/generated/v2/ThreadSettings.js";
import type { ClaudeThreadRecord } from "../store/HybridStore.js";

function activePermissionProfile(policy: SandboxPolicy): ActivePermissionProfile | null {
  if (policy.type === "readOnly") return { id: ":read-only", extends: null };
  if (policy.type === "workspaceWrite") return { id: ":workspace", extends: null };
  if (policy.type === "dangerFullAccess") return { id: ":danger-full-access", extends: null };
  return null;
}

export function syncedCollaborationMode(
  value: unknown | null | undefined,
  model: string,
  effort: ThreadSettings["effort"],
): ThreadSettings["collaborationMode"] {
  const mode = (value ?? {
    mode: "default",
    settings: { model, reasoning_effort: effort, developer_instructions: null },
  }) as ThreadSettings["collaborationMode"];
  return { ...mode, settings: { ...mode.settings, model, reasoning_effort: effort } };
}

export function threadSettings(record: ClaudeThreadRecord): ThreadSettings {
  const sandboxPolicy = record.sandboxPolicy as ThreadSettings["sandboxPolicy"];
  return {
    cwd: record.thread.cwd,
    approvalPolicy: record.approvalPolicy as ThreadSettings["approvalPolicy"],
    approvalsReviewer: record.approvalsReviewer,
    sandboxPolicy,
    activePermissionProfile: activePermissionProfile(sandboxPolicy),
    model: record.modelPickerId,
    modelProvider: "claude",
    serviceTier: record.serviceTier,
    effort: record.reasoningEffort as ThreadSettings["effort"],
    summary: record.reasoningSummary as ThreadSettings["summary"],
    collaborationMode: syncedCollaborationMode(
      record.collaborationMode,
      record.modelPickerId,
      record.reasoningEffort as ThreadSettings["effort"],
    ),
    multiAgentMode: "explicitRequestOnly",
    personality: record.personality as ThreadSettings["personality"],
  };
}
