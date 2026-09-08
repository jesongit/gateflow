/**
 * DispatchIntent type and derivation — PURE functions, no I/O (docs/
 * architecture-v1.md §5: "GitHub Canonical State → DispatchIntent").
 *
 * SCHEMA 2 FROZEN CONSTRAINTS (docs/plans/v1_hardening_decisions.md §4-§5):
 * - Every dispatch binds the issue's CURRENT workflow epoch (the
 *   highest-comment-id Gate/Driver-issued epoch record). No epoch record →
 *   no intent (the Driver bootstraps one for planning issues elsewhere).
 * - Consumer revision = 1 + Gate-ACCEPTED feedback events of the current
 *   epoch (feedback_accepted records whose command comment still exists and
 *   parses). Raw command counts are NEVER used: rejected, duplicated,
 *   foreign-epoch and plain-text comments don't count.
 * - Executor dispatches bind the Gate-issued approval RECORD: epoch match,
 *   plan-comment-id match AND plan_sha256 equality against the CURRENT plan
 *   body. A plan edited after its approval produces a hash mismatch → no
 *   intent (the stale approval cannot execute).
 * - Any suspect record (unparsable, or authored outside the gate-logins
 *   allowlist) fails the whole issue closed: no intents.
 *
 * THIS IS WHERE ATTACKS DIE: a fake `ai:ready` label, a hand-copied
 * `/approve` comment, or an approval from a rejected/old round all produce
 * NO intent, because none of them is a valid Gate-issued record bound to
 * the current epoch and the exact current plan bytes.
 *
 * The Driver NEVER calls an LLM and NEVER transitions labels; it only turns
 * canonical GitHub state into dispatch intents for the dispatch layer.
 */
import type { CommentDetail, IssueDetail } from '../github/client';
import {
  acceptedFeedbackEvents,
  findPlanComments,
  readIssueRecordsForIssue,
  type IssueRecordView,
} from '../github/issue-sync';
import { validateApprovalBinding } from '../protocol/workflow-chain';
import type { Role } from '../workspace/protocol';
import type { HumanFeedbackEntry } from '../github/issue-sync';

/** Inputs the intent derivation reads from canonical state + config. */
export interface IntentContext {
  repositoryId: number;
  repoOwner: string;
  /** Trusted humans (config + repo owner) for feedback anchoring. */
  trustedHumans: ReadonlySet<string>;
  /** Driver-side allowlist of Gate record identities. */
  gateLogins: ReadonlySet<string>;
  /**
   * V1.1 Phase 2: explicit allowlist for `driver_bootstrap` epoch records
   * (config default: the owner of a personal repository).
   */
  bootstrapIssuers: ReadonlySet<string>;
}

/** One to-be-dispatched unit of work derived from canonical GitHub state. */
export interface DispatchIntent {
  role: Role;
  issueNumber: number;
  reason: 'planning' | 'feedback_applied' | 'approved_plan';
  /** Consumer: zero-padded round (`'01'`). Executor: `'p<plan_comment_id>'`. */
  revision: string;
  /** The workflow epoch this dispatch belongs to (schema 2, always present). */
  epoch: string;
  /** Executor only: the approved Plan comment id. */
  planCommentId: number | null;
  /** Executor only: the Gate-issued approval RECORD comment id. */
  approvalCommentId: number | null;
  /** Executor only: the approval-bound plan content hash. */
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

function consumerRound(feedbackCount: number): string {
  return String(1 + feedbackCount).padStart(2, '0');
}

/**
 * Derive dispatch intents for one issue from canonical state.
 *
 * - closed issue, or 0 / >1 `ai:*` labels → [] (caller logs).
 * - no epoch record, or ANY suspect record → [] (fail closed).
 * - `ai:planning` → consumer planning round (reason `feedback_applied` when
 *   accepted feedback exists in this epoch).
 * - `ai:review` → consumer round ONLY when an accepted feedback event is
 *   NEWER than the latest Plan comment (a plan comment newer than all
 *   feedback means the plan already incorporates it).
 * - `ai:ready` → executor dispatch, gated by the independent approval-record
 *   re-validation (epoch + plan id + plan hash).
 * - `ai:working` | `ai:blocked` | `ai:done` → [] (sync-only states: the
 *   Driver's job here is outbox syncing, not dispatching).
 */
export function deriveIntents(
  issue: IssueDetail,
  comments: CommentDetail[],
  ctx: IntentContext,
): DispatchIntent[] {
  if (issue.state === 'closed') return [];
  const labels = aiLabels(issue.labels);
  if (labels.length !== 1) return [];
  const state = labels[0];
  if (state === undefined) return []; // unreachable given length check; keeps noUncheckedIndexedAccess honest

  const view: IssueRecordView = readIssueRecordsForIssue(comments, {
    repositoryId: ctx.repositoryId,
    issueNumber: issue.number,
    gateLogins: ctx.gateLogins,
    bootstrapIssuers: ctx.bootstrapIssuers,
  });
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
          role: 'consumer',
          issueNumber: issue.number,
          reason: feedbackCount > 0 ? 'feedback_applied' : 'planning',
          revision: consumerRound(feedbackCount),
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
          role: 'consumer',
          issueNumber: issue.number,
          reason: 'feedback_applied',
          revision: consumerRound(feedbackCount),
          epoch,
          planCommentId: null,
          approvalCommentId: null,
          planSha256: null,
        },
      ];
    }
    case 'ai:ready': {
      // V1.1: the executor intent exists only when the SHARED approval
      // binding holds — current plan + a Gate-issued approval record binding
      // (epoch, plan id, exact plan hash) with an intact human anchor and no
      // record conflict (src/protocol/workflow-chain.ts, Phase 1 §4.6).
      const binding = validateApprovalBinding({
        epoch,
        repositoryId: ctx.repositoryId,
        issueNumber: issue.number,
        comments,
        gateIssuers: ctx.gateLogins,
        trustedHumans: ctx.trustedHumans,
        repoOwner: ctx.repoOwner,
      });
      if (!binding.ok) return [];
      return [
        {
          role: 'executor',
          issueNumber: issue.number,
          reason: 'approved_plan',
          revision: `p${binding.planCommentId}`,
          epoch,
          planCommentId: binding.planCommentId,
          approvalCommentId: binding.approvalCommentId,
          planSha256: binding.planSha256,
        },
      ];
    }
    default:
      // ai:working / ai:blocked / ai:done — and any unknown ai:* label.
      return [];
  }
}

/** Fixed `## Goal` wording per role (docs/workspace-protocol.md §7, frozen). */
const GOAL_CONSUMER =
  '分析任务并产出可执行的 Execution Plan（写入 outbox/PLAN.md），完成后写 result.json（result=plan_ready）';
const GOAL_EXECUTOR =
  '严格按照 PLAN.md 执行并通过真实验证，完成后写 REPORT.md 与 result.json（result=completed）';

/**
 * Build the TASK.md projection of an issue (docs §7): `# <title>`, the issue
 * body verbatim (a Producer schema block stays in, it is context only), then
 * the fixed role goal. GateFlow-internal state is never exposed.
 */
export function buildTaskMarkdown(issue: IssueDetail, role: Role): string {
  const body = issue.body.length > 0 ? issue.body : '(no body)';
  const goal = role === 'executor' ? GOAL_EXECUTOR : GOAL_CONSUMER;
  return `# ${issue.title}\n\n${body}\n\n## Goal\n\n${goal}\n`;
}

/** `YYYY-MM-DD HH:mm` in UTC for FEEDBACK.md section headers (docs §7). */
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
  if (entry.kind === 'choose') {
    const match = /^\/choose (\S+) (\S+)$/.exec(trimmed);
    const question = match?.[1];
    const answer = match?.[2];
    if (question !== undefined && answer !== undefined) {
      return `Q: ${question} → A: ${answer}`;
    }
  } else {
    const match = /^\/change (.+)$/.exec(trimmed);
    const text = match?.[1];
    if (text !== undefined) {
      return text;
    }
  }
  return trimmed; // defensive: accepted events are anchored commands
}

/**
 * Build the FEEDBACK.md projection (docs §7, frozen layout): numbered
 * sections in ascending comment order. Returns null when there is no
 * feedback to project (the inbox file is then simply absent).
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
