/**
 * DispatchIntent type and derivation — PURE functions, no I/O (docs/
 * architecture-v1.md §5: "GitHub Canonical State → DispatchIntent").
 *
 * FROZEN CONSTRAINTS (docs/workspace-protocol.md §3, architecture-v1.md §3):
 * - Consumer revision (planning round) = 1 + TOTAL human feedback commands
 *   (/change, /choose) on the issue, zero-padded to two digits — ALL-TIME
 *   count, so a re-plan after feedback always yields a fresh dispatch_id.
 * - Executor revision = `p<plan_comment_id>`; the executor dispatch is bound
 *   to one specific approved Plan comment.
 *
 * THIS IS WHERE ATTACKS DIE (architecture-v1.md §3.3): a fake `ai:ready`
 * label (hand-set by anyone) produces an executor dispatch ONLY when ALL of
 * the following hold, checked independently here on every cycle:
 *   (a) a Plan comment exists (the Current Plan candidate),
 *   (b) a trusted-human `/approve <plan-comment-id>` record exists whose id
 *       equals the latest plan comment's id,
 *   (c) the Plan comment was NOT edited after the approval moment
 *       (plan.updatedAt <= approval.createdAt).
 * Any failed condition yields NO intent (logless — the caller logs at the
 * discovery level), never a degraded intent.
 *
 * The Driver NEVER calls an LLM and NEVER transitions labels; it only turns
 * canonical GitHub state into dispatch intents for the dispatch layer.
 */
import type { CommentDetail, IssueDetail } from '../github/client';
import {
  findApprovalRecords,
  findHumanFeedbackCommands,
  findLatestPlanComment,
} from '../github/issue-sync';
import type { HumanFeedbackEntry } from '../github/issue-sync';
import type { Role } from '../workspace/protocol';

/** One to-be-dispatched unit of work derived from canonical GitHub state. */
export interface DispatchIntent {
  role: Role;
  issueNumber: number;
  reason: 'planning' | 'feedback_applied' | 'approved_plan';
  /** Consumer: zero-padded round (`'01'`). Executor: `'p<plan_comment_id>'`. */
  revision: string;
  /** Executor only: the approved Plan comment id. */
  planCommentId: number | null;
  /** Executor only: the Approval Record comment id. */
  approvalCommentId: number | null;
}

/**
 * Label prefix that marks AI workflow states. Exactly ONE `ai:*` label must
 * be present for any intent to exist (0 = not in the workflow; >1 = corrupt
 * state, refuse to guess).
 */
export function aiLabels(labels: readonly string[]): string[] {
  return labels.filter((label) => label.startsWith('ai:'));
}

/** Mirrors issue-sync's anchored /change pattern (whole-comment matches). */
const CHANGE_PATTERN = /^\/change (.+)$/;
/** Mirrors issue-sync's anchored /choose pattern (whole-comment matches). */
const CHOOSE_PATTERN = /^\/choose (\S+) (\S+)$/;

function consumerRound(feedbackCount: number): string {
  return String(1 + feedbackCount).padStart(2, '0');
}

/**
 * Derive dispatch intents for one issue from canonical state.
 *
 * - closed issue, or 0 / >1 `ai:*` labels → [] (caller logs).
 * - `ai:planning` → consumer planning round (reason `feedback_applied` when
 *   any human feedback command exists — contract §3: round = 1 + total).
 * - `ai:review` → consumer round ONLY when a feedback command is NEWER than
 *   the latest Plan comment (comments arrive in ascending id order; a plan
 *   comment newer than all feedback means the plan already incorporates it).
 * - `ai:ready` → executor dispatch, gated by the independent Approval Record
 *   re-validation (a)–(c) in the file header.
 * - `ai:working` | `ai:blocked` | `ai:done` → [] (sync-only states: the
 *   Driver's job here is outbox syncing, not dispatching).
 */
export function deriveIntents(
  issue: IssueDetail,
  comments: CommentDetail[],
  trustedHumans: ReadonlySet<string>,
  repoOwner: string,
): DispatchIntent[] {
  if (issue.state === 'closed') return [];
  const labels = aiLabels(issue.labels);
  if (labels.length !== 1) return [];
  const state = labels[0];
  if (state === undefined) return []; // unreachable given length check; keeps noUncheckedIndexedAccess honest

  const feedback = findHumanFeedbackCommands(comments, trustedHumans, repoOwner);
  const feedbackCount = feedback.length;

  switch (state) {
    case 'ai:planning': {
      return [
        {
          role: 'consumer',
          issueNumber: issue.number,
          reason: feedbackCount > 0 ? 'feedback_applied' : 'planning',
          revision: consumerRound(feedbackCount),
          planCommentId: null,
          approvalCommentId: null,
        },
      ];
    }
    case 'ai:review': {
      const plan = findLatestPlanComment(comments);
      if (plan === null) return [];
      const newerFeedback = feedback.some((entry) => entry.comment.id > plan.id);
      if (!newerFeedback) return [];
      return [
        {
          role: 'consumer',
          issueNumber: issue.number,
          reason: 'feedback_applied',
          revision: consumerRound(feedbackCount),
          planCommentId: null,
          approvalCommentId: null,
        },
      ];
    }
    case 'ai:ready': {
      const plan = findLatestPlanComment(comments);
      if (plan === null) return [];
      const approvals = findApprovalRecords(comments, trustedHumans, repoOwner);
      const approval = approvals.find((record) => record.planCommentId === plan.id);
      if (approval === undefined) return [];
      const planEditedAt = Date.parse(plan.updatedAt);
      const approvedAt = Date.parse(approval.comment.createdAt);
      // (c) the plan must not have been edited after the approval moment.
      // NaN (unparseable timestamps) compares false → no dispatch: fail closed.
      if (!(planEditedAt <= approvedAt)) return [];
      return [
        {
          role: 'executor',
          issueNumber: issue.number,
          reason: 'approved_plan',
          revision: `p${plan.id}`,
          planCommentId: plan.id,
          approvalCommentId: approval.comment.id,
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
    const match = CHOOSE_PATTERN.exec(trimmed);
    const question = match?.[1];
    const answer = match?.[2];
    if (question !== undefined && answer !== undefined) {
      return `Q: ${question} → A: ${answer}`;
    }
  } else {
    const match = CHANGE_PATTERN.exec(trimmed);
    const text = match?.[1];
    if (text !== undefined) {
      return text;
    }
  }
  return trimmed; // defensive: findHumanFeedbackCommands already anchored these
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

/** Marker-shaped HTML comment lines dropped by extractPlanContent. */
const MARKER_LINE_PATTERN = /^<!--\s*ai-workflow:[a-z-]+:v\d+\s*-->$/;
/** The dispatch-id HTML comment embedded in every protocol comment. */
const DISPATCH_ID_LINE_PATTERN = /<!--\s*gateflow:dispatch-id:\s*\S+\s*-->/;

/**
 * Inverse of buildPlanCommentBody (docs §7): the executor's inbox PLAN.md is
 * the approved Plan comment MINUS the marker line and the
 * `<!-- gateflow:dispatch-id ... -->` comment line, trimmed. Everything else
 * — including any other HTML comments the plan author wrote — is preserved
 * verbatim.
 */
export function extractPlanContent(planCommentBody: string): string {
  const kept = planCommentBody
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return !MARKER_LINE_PATTERN.test(trimmed) && !DISPATCH_ID_LINE_PATTERN.test(trimmed);
    })
    .join('\n');
  return kept.trim();
}
