/**
 * TaskIntent type and derivation — PURE functions, no I/O.
 *
 * FROZEN CONSTRAINTS (schema 2 hardening, kept intact):
 * - Every task binds the issue's CURRENT workflow epoch (the
 *   highest-comment-id Gate-issued epoch record). No epoch record → no task.
 * - Plan revision = 1 + Gate-ACCEPTED feedback events of the current epoch
 *   (feedback_accepted records whose command comment still exists and
 *   parses). Raw command counts are NEVER used: rejected, duplicated,
 *   foreign-epoch and plain-text comments don't count.
 * - Execute tasks bind the Gate-issued approval RECORD: epoch match,
 *   plan-comment-id match AND plan_sha256 equality against the CURRENT plan
 *   body. A plan edited after its approval produces a hash mismatch → no
 *   task (the stale approval cannot execute).
 * - Any suspect record (unparsable, or authored outside the gate-logins
 *   allowlist) fails the whole issue closed: no tasks.
 *
 * THIS IS WHERE ATTACKS DIE: a fake `ai:ready` label, a hand-copied
 * `/approve` comment, or an approval from a rejected/old round all produce
 * NO task, because none of them is a valid Gate-issued record bound to the
 * current epoch and the exact current plan bytes.
 *
 * The Driver NEVER calls an LLM and NEVER transitions labels; it only turns
 * canonical GitHub state into task intents for the preparation layer.
 */
import type { CommentDetail, IssueDetail } from '../github/client';
import {
  acceptedFeedbackEvents,
  approvalRecordAnchorFailure,
  findPlanComments,
  readIssueRecords,
  type IssueRecordView,
} from '../github/issue-sync';
import { planSha256 } from '../protocol/plan';
import { approvalRecordsConflict } from '../protocol/records';
import type { Mode } from '../workspace/protocol';
import type { HumanFeedbackEntry } from '../github/issue-sync';

/** Inputs the intent derivation reads from canonical state + config. */
export interface IntentContext {
  repositoryId: number;
  repoOwner: string;
  /** Trusted humans (config + repo owner) for feedback anchoring. */
  trustedHumans: ReadonlySet<string>;
  /** Driver-side allowlist of Gate record identities. */
  gateLogins: ReadonlySet<string>;
}

/** One to-be-prepared unit of work derived from canonical GitHub state. */
export interface TaskIntent {
  mode: Mode;
  issueNumber: number;
  reason: 'planning' | 'feedback_applied' | 'approved_plan';
  /** Plan mode: zero-padded round (`'01'`). Execute mode: `'p<plan_comment_id>'`. */
  revision: string;
  /** The workflow epoch this task belongs to (always present). */
  epoch: string;
  /** Execute mode only: the approved Plan comment id. */
  planCommentId: number | null;
  /** Execute mode only: the Gate-issued approval RECORD comment id. */
  approvalCommentId: number | null;
  /** Execute mode only: the approval-bound plan content hash. */
  planSha256: string | null;
}

/**
 * Label prefix that marks AI workflow states. Exactly ONE `ai:*` label must
 * be present for any intent to exist (0 = not in the workflow; >1 = corrupt
 * state, refuse to guess).
 */
export function aiLabels(labels: readonly string[]): string[] {
  return labels.filter((label) => label.startsWith('ai:'));
}

function planRound(feedbackCount: number): string {
  return String(1 + feedbackCount).padStart(2, '0');
}

/**
 * Derive task intents for one issue from canonical state.
 *
 * - closed issue, or 0 / >1 `ai:*` labels → [] (caller logs).
 * - no epoch record, or ANY suspect record → [] (fail closed).
 * - `ai:planning` → plan task (reason `feedback_applied` when accepted
 *   feedback exists in this epoch).
 * - `ai:review` → plan task ONLY when an accepted feedback event is NEWER
 *   than the latest Plan comment (a plan comment newer than all feedback
 *   means the plan already incorporates it).
 * - `ai:ready` → execute task, gated by the independent approval-record
 *   re-validation (epoch + plan id + plan hash).
 * - `ai:working` | `ai:blocked` | `ai:done` → [] (sync-only states: the
 *   Driver's job here is result syncing, not preparation).
 */
export function deriveIntents(
  issue: IssueDetail,
  comments: CommentDetail[],
  ctx: IntentContext,
): TaskIntent[] {
  if (issue.state === 'closed') return [];
  const labels = aiLabels(issue.labels);
  if (labels.length !== 1) return [];
  const state = labels[0];
  if (state === undefined) return []; // unreachable given length check; keeps noUncheckedIndexedAccess honest

  const view: IssueRecordView = readIssueRecords(comments, ctx.gateLogins);
  // Fail closed: any record with a broken body or an untrusted author means
  // someone may be forging authorization facts on this issue.
  if (view.suspect.length > 0) return [];
  if (view.epoch === null) return [];
  const epoch = view.epoch.record.workflow_epoch;

  // Only Gate-accepted feedback events of the current epoch, still anchored
  // to a valid trusted-human command comment.
  const accepted = acceptedFeedbackEvents(view, comments, ctx.trustedHumans, ctx.repoOwner);
  const feedbackCount = accepted.length;

  switch (state) {
    case 'ai:planning': {
      return [
        {
          mode: 'plan',
          issueNumber: issue.number,
          reason: feedbackCount > 0 ? 'feedback_applied' : 'planning',
          revision: planRound(feedbackCount),
          epoch,
          planCommentId: null,
          approvalCommentId: null,
          planSha256: null,
        },
      ];
    }
    case 'ai:review': {
      const plans = findPlanComments(comments);
      const plan = plans[plans.length - 1];
      if (plan === undefined) return [];
      const newerFeedback = accepted.some((entry) => entry.comment.id > plan.id);
      if (!newerFeedback) return [];
      return [
        {
          mode: 'plan',
          issueNumber: issue.number,
          reason: 'feedback_applied',
          revision: planRound(feedbackCount),
          epoch,
          planCommentId: null,
          approvalCommentId: null,
          planSha256: null,
        },
      ];
    }
    case 'ai:ready': {
      const plans = findPlanComments(comments);
      const plan = plans[plans.length - 1];
      if (plan === undefined) return [];
      // Approval record binding: epoch + plan id + exact plan content hash,
      // PLUS the human anchor — the record must reference a still-existing
      // anchored /approve by a trusted human matching the recorded approver.
      const candidates = view.approvals.filter(
        (entry) =>
          entry.record.workflow_epoch === epoch &&
          entry.record.plan_comment_id === plan.id &&
          entry.record.plan_sha256 === planSha256(plan.body) &&
          approvalRecordAnchorFailure(entry.record, comments, ctx.trustedHumans, ctx.repoOwner) ===
            null,
      );
      if (candidates.length === 0) return [];
      const conflict = approvalRecordsConflict(candidates);
      if (conflict.conflict) return []; // fail closed on divergent records
      const approval = candidates[candidates.length - 1];
      if (approval === undefined) return [];
      return [
        {
          mode: 'execute',
          issueNumber: issue.number,
          reason: 'approved_plan',
          revision: `p${plan.id}`,
          epoch,
          planCommentId: plan.id,
          approvalCommentId: approval.commentId,
          planSha256: approval.record.plan_sha256,
        },
      ];
    }
    default:
      // ai:working / ai:blocked / ai:done — and any unknown ai:* label.
      return [];
  }
}

/** Fixed `## Goal` wording per mode. */
const GOAL_PLAN =
  '分析任务并产出可执行的执行计划（写入本目录 plan.md），完成后写 result.json（status=completed, report=plan.md）';
const GOAL_EXECUTE =
  '严格按照已批准的 plan.md 执行并通过真实验证，完成后写 report.md 与 result.json（status=completed, validation=passed）';

/**
 * Build the task.md projection of an issue: `# <title>`, the issue body
 * verbatim, then the MODE section and the fixed mode goal. The agent treats
 * this file as task data, never as instructions over the protocol.
 */
export function buildTaskMarkdown(issue: IssueDetail, mode: Mode): string {
  const body = issue.body.length > 0 ? issue.body : '(no body)';
  const goal = mode === 'execute' ? GOAL_EXECUTE : GOAL_PLAN;
  return `# ${issue.title}\n\n${body}\n\n## Mode\n\n${mode}\n\n## Goal\n\n${goal}\n`;
}

/** `YYYY-MM-DD HH:mm` in UTC for feedback.md section headers. */
function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '????-??-?? ??:??';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
  );
}

/** Extract the human-readable payload of one feedback command comment. */
function feedbackEntryText(entry: HumanFeedbackEntry): string {
  const trimmed = entry.comment.body.trim();
  const match = /^\/change (.+)$/.exec(trimmed);
  const text = match?.[1];
  return text !== undefined ? text : trimmed; // defensive: accepted events are anchored commands
}

/**
 * Build the feedback.md projection: numbered sections in ascending comment
 * order. Returns null when there is no feedback to project (the file is then
 * simply absent).
 */
export function buildFeedbackMarkdown(entries: HumanFeedbackEntry[]): string | null {
  if (entries.length === 0) return null;
  const sections = entries.map((entry, index) => {
    const n = index + 1;
    const when = formatTimestamp(entry.comment.createdAt);
    return `## ${n} — ${when} (/${entry.kind})\n${feedbackEntryText(entry)}`;
  });
  return `# Human Feedback\n\n${sections.join('\n\n')}\n`;
}
