/**
 * End-to-end integration helpers (plan Phase 13).
 *
 * Building blocks:
 *
 * 1. `GateSimulator` — a deterministic mirror of the V1 gate rules
 *    (src/gate/gate.ts + src/gate/markers.ts + src/gate/tracker.ts) that
 *    consumes the same comment stream the FakeDriverClient records
 *    (id, user, body) plus body edits, and applies T1-T6 exactly like the
 *    real GitHub Action: markers via detectCommentMarker, tracker Status
 *    values via parseTrackerStatus, commands via parseCommand, publisher
 *    identity = Trusted Agent (the Driver bot identity) ∪ Trusted Humans
 *    (repo owner + allowlist). The gate's own pure parsers are reused so the
 *    simulator cannot drift from the byte-level rules; only the policy
 *    orchestration (permission → state → transition) is mirrored.
 *
 * 2. Agent simulation — writes outbox files through the workspace module's
 *    atomic writers, exactly what a real client would do.
 *
 * 3. Test seams — a gateflow.config.yml writer (parsed through the real
 *    `loadConfig`, covering config parsing), an injectable manual clock, and
 *    process.stdout capture. NOTE on the activation seam: dispatch.ts builds
 *    adapters internally via resolveAdapterForAgent — there is no injection
 *    point — so the notices adapters print to stdout (manual banner, zcode
 *    suggestion line) are the observable activation channel end to end.
 */
import { writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';

import { vi } from 'vitest';

import { loadConfig } from '../../src/driver/config';
import type { DriverConfig } from '../../src/driver/config';
import type { DriverOnceResult } from '../../src/driver/driver';
import { parseCommand } from '../../src/gate/commands';
import type { ParsedCommand } from '../../src/gate/commands';
import { detectCommentMarker } from '../../src/gate/markers';
import { COMMANDS, LABELS, MARKERS } from '../../src/gate/protocol';
import type { Label } from '../../src/gate/protocol';
import { parseTrackerStatus } from '../../src/gate/tracker';
import { planSha256 } from '../../src/protocol/plan';
import {
  approvalOperationId,
  feedbackOperationId,
  parseRecord,
  type GateRecord,
} from '../../src/protocol/records';
import type { CommentDetail } from '../../src/github/client';
import { atomicWriteJson, atomicWriteText } from '../../src/workspace/inbox';
import type { WorkspacePaths } from '../../src/workspace/paths';
import type { ResultFile, Role, RunState, StatusFile } from '../../src/workspace/protocol';
import type { FakeDriverClient } from '../driver/helpers';

/** Repo owner login of the fixture repository (always a Trusted Human). */
export const REPO_OWNER = 'octo';

const ALL_LABELS: readonly string[] = Object.values(LABELS);

export interface GateSimulatorOptions {
  /** The registered Trusted Agent login (default: the fake's bot user). */
  trustedAgent?: string;
  /** Extra Trusted Humans besides the repo owner (config trusted_humans). */
  trustedHumans?: readonly string[];
}

type CommentAction = 'created' | 'edited';

/**
 * Deterministic Gate simulator over the fake's comment stream.
 *
 * `syncAll()` walks every issue (ascending) and every comment (ascending id)
 * and replays exactly the events a real gate would have received: a comment
 * never seen before is a `created` event, a comment whose body changed since
 * the last replay is an `edited` event (the T4/T5 channel). Rules are applied
 * in order with the same preconditions as src/gate/gate.ts.
 *
 * SCHEMA 2: accepting /choose, /change or /approve also PUBLISHES the
 * corresponding Gate-issued record comment (feedback_accepted / approval),
 * authored by the Gate identity — the durable facts the Driver's discovery
 * and preflight independently re-validate. Record comments themselves are
 * protocol plumbing: replaying them is a no-op (no marker, no command).
 */
export class GateSimulator {
  private readonly seen = new Map<number, string>();
  private readonly trustedAgent: string;
  private readonly trustedHumans: readonly string[];

  constructor(
    private readonly client: FakeDriverClient,
    options: GateSimulatorOptions = {},
  ) {
    this.trustedAgent = options.trustedAgent ?? client.botUser;
    this.trustedHumans = options.trustedHumans ?? [];
  }

  /** Current ai:* labels of an issue (copy, for assertions). */
  labels(issueNumber: number): string[] {
    return [...(this.client.issues.get(issueNumber)?.labels ?? [])];
  }

  /** The Gate identity that authors every record comment. */
  private get gateLogin(): string {
    return this.client.gateUser;
  }

  /** The current workflow epoch of an issue (latest epoch record); null if none. */
  private currentEpoch(issueNumber: number): string | null {
    const issue = this.client.issues.get(issueNumber);
    if (issue === undefined) return null;
    for (const comment of [...issue.comments].sort((a, b) => b.id - a.id)) {
      if (/<!-- gateflow:workflow:v2/.test(comment.body)) {
        const parsed = parseRecord(comment.id, comment.body);
        if (parsed.ok && parsed.record.kind === 'workflow_epoch') {
          return parsed.record.workflow_epoch;
        }
      }
    }
    return null;
  }

  private publishRecord(issueNumber: number, record: GateRecord): void {
    // Uses the client's own monotonic id sequence so comment ids stay in
    // true publication order across Driver comments and Gate records.
    this.client.addGateRecord(issueNumber, record);
  }

  /** Replay every unseen comment / unseen edit across all issues, in order. */
  syncAll(): void {
    for (const [number] of [...this.client.issues.entries()].sort(([a], [b]) => a - b)) {
      this.syncIssue(number);
    }
  }

  private syncIssue(issueNumber: number): void {
    const issue = this.client.issues.get(issueNumber);
    if (issue === undefined) return;
    for (const comment of [...issue.comments].sort((a, b) => a.id - b.id)) {
      const previous = this.seen.get(comment.id);
      if (previous !== undefined && previous === comment.body) continue;
      const action: CommentAction = previous === undefined ? 'created' : 'edited';
      this.seen.set(comment.id, comment.body);
      this.handleComment(issueNumber, comment, action);
    }
  }

  /** Mirrors gate.ts handleComment: strict command parse first, markers else. */
  private handleComment(issueNumber: number, comment: CommentDetail, action: CommentAction): void {
    const parsed = parseCommand(comment.body);
    if (parsed !== null) {
      this.handleCommand(issueNumber, comment, parsed);
      return;
    }
    this.handleMarkerComment(issueNumber, comment, action);
  }

  private isTrustedHuman(login: string): boolean {
    const candidate = login.toLowerCase();
    if (candidate === REPO_OWNER) return true;
    return this.trustedHumans.some((human) => human.toLowerCase() === candidate);
  }

  private isTrustedAgent(login: string): boolean {
    return login.toLowerCase() === this.trustedAgent.toLowerCase();
  }

  /** The single ai:* label, or null when outside the workflow / ambiguous. */
  private currentAiLabel(issueNumber: number): Label | null {
    const labels = this.labels(issueNumber).filter((name): name is Label => ALL_LABELS.includes(name));
    if (labels.length !== 1) return null;
    return labels[0] ?? null;
  }

  private handleCommand(issueNumber: number, comment: CommentDetail, parsed: ParsedCommand): void {
    switch (parsed.command) {
      case COMMANDS.approve: {
        // T2 — Trusted Human monopoly + REVIEW + the referenced comment must
        // be the CURRENT plan (the last valid plan-marker comment by id).
        if (!this.isTrustedHuman(comment.user)) return;
        if (this.currentAiLabel(issueNumber) !== LABELS.review) return;
        const issue = this.client.issues.get(issueNumber);
        if (issue === undefined) return;
        const epoch = this.currentEpoch(issueNumber);
        if (epoch === null) return; // no epoch record → fail closed
        const planComments = issue.comments.filter((c) => detectCommentMarker(c.body) === MARKERS.plan);
        const currentPlan = planComments.at(-1);
        if (currentPlan === undefined || currentPlan.id !== parsed.args.planCommentId) return;
        // SCHEMA 2: persist the approval RECORD (epoch + plan + hash binding)
        // BEFORE the label swap — the durable authorization fact.
        this.publishRecord(issueNumber, {
          schema: 2,
          kind: 'approval',
          repository_id: this.client.repository.id,
          issue_number: issueNumber,
          workflow_epoch: epoch,
          plan_comment_id: currentPlan.id,
          plan_sha256: planSha256(currentPlan.body),
          approval_command_comment_id: comment.id,
          approved_by_id: 0,
          approved_by_login: comment.user,
          gate_login: this.gateLogin,
          gate_user_id: 41898282,
          created_at: '2026-09-06T12:00:00Z',
          operation_id: approvalOperationId(this.client.repository.id, issueNumber, epoch, currentPlan.id),
        });
        this.swapLabel(issueNumber, LABELS.review, LABELS.ready);
        return;
      }
      case COMMANDS.change:
      case COMMANDS.choose: {
        // SCHEMA 2: acceptance = publishing the feedback_accepted record
        // (idempotent by operation id). Rejected commands never get one.
        if (!this.isTrustedHuman(comment.user)) return;
        if (this.currentAiLabel(issueNumber) !== LABELS.review) return;
        const epoch = this.currentEpoch(issueNumber);
        if (epoch === null) return;
        const issue = this.client.issues.get(issueNumber);
        if (issue === undefined) return;
        const feedbackKind = parsed.command === COMMANDS.choose ? 'choose' : 'change';
        const operationId = feedbackOperationId(this.client.repository.id, issueNumber, epoch, comment.id);
        const alreadyAccepted = issue.comments.some((c) => c.body.includes(`"operation_id": "${operationId}"`));
        if (alreadyAccepted) return;
        this.publishRecord(issueNumber, {
          schema: 2,
          kind: 'feedback_accepted',
          repository_id: this.client.repository.id,
          issue_number: issueNumber,
          workflow_epoch: epoch,
          event_id: `fe${comment.id}`,
          feedback_comment_id: comment.id,
          feedback_kind: feedbackKind,
          gate_login: this.gateLogin,
          gate_user_id: 41898282,
          created_at: '2026-09-06T12:00:00Z',
          operation_id: operationId,
        });
        return;
      }
      case COMMANDS.aiPlan:
      case COMMANDS.cancel:
        // T0 is out of scope (issues are seeded with their labels directly)
        // and /cancel is not exercised by this suite: intentional no-ops.
        return;
    }
  }

  /** Mirrors gate.ts handleMarkerComment (T1 / T3 / T4 / T5 / T6). */
  private handleMarkerComment(issueNumber: number, comment: CommentDetail, action: CommentAction): void {
    const marker = detectCommentMarker(comment.body);
    if (marker === null) return; // plain comment (or invalid marker) — ignored
    // Markers are structural hints, never permission: the publisher must be
    // Trusted Human ∪ Trusted Agent.
    if (!this.isTrustedHuman(comment.user) && !this.isTrustedAgent(comment.user)) return;

    const label = this.currentAiLabel(issueNumber);
    if (label === null) return; // outside / ambiguous: no marker transition

    if (marker === MARKERS.executionTracker) {
      // An EDIT of the tracker comment while WORKING / BLOCKED is the
      // T4 / T5 channel: parse the first outside-fence **Status:** value.
      if (action === 'edited' && (label === LABELS.working || label === LABELS.blocked)) {
        const inspection = parseTrackerStatus(comment.body);
        if (inspection.kind !== 'valid') return; // absent / unknown: logged no-op
        if (inspection.status === 'Blocked' && label === LABELS.working) {
          this.swapLabel(issueNumber, LABELS.working, LABELS.blocked); // T4
        } else if (inspection.status === 'In Progress' && label === LABELS.blocked) {
          this.swapLabel(issueNumber, LABELS.blocked, LABELS.working); // T5
        }
        // 'Completed' and same-value edits never transition (T6 is marker-only).
        return;
      }
      // Creation (or an edit while READY): the T3 path.
      if (label === LABELS.ready) {
        this.swapLabel(issueNumber, LABELS.ready, LABELS.working); // T3
      }
      return;
    }
    if (marker === MARKERS.plan && label === LABELS.planning) {
      this.swapLabel(issueNumber, LABELS.planning, LABELS.review); // T1
      return;
    }
    if (marker === MARKERS.completionReport && label === LABELS.working) {
      this.swapLabel(issueNumber, LABELS.working, LABELS.done); // T6
      return;
    }
    // append marker, and markers arriving in a non-matching state: no-op.
  }

  /** add-then-remove label swap, mirroring gate.ts ordering. */
  private swapLabel(issueNumber: number, from: Label, to: Label): void {
    const issue = this.client.issues.get(issueNumber);
    if (issue === undefined) return;
    if (!issue.labels.includes(to)) issue.labels.push(to);
    issue.labels = issue.labels.filter((name) => name !== from);
  }
}

// ---------------------------------------------------------------------------
// Agent simulation (outbox writes via the workspace module's atomic writers)
// ---------------------------------------------------------------------------

export function statusFileFor(
  dispatchId: string,
  role: Role,
  state: RunState,
  updatedAt: string,
  summary?: string,
): StatusFile {
  return {
    schema: 2,
    dispatch_id: dispatchId,
    role,
    state,
    updated_at: updatedAt,
    ...(summary !== undefined ? { summary } : {}),
  };
}

export function planReadyResult(dispatchId: string): ResultFile {
  return { schema: 2, dispatch_id: dispatchId, role: 'consumer', result: 'plan_ready', plan_file: 'PLAN.md' };
}

export function completedResult(dispatchId: string): ResultFile {
  return {
    schema: 2,
    dispatch_id: dispatchId,
    role: 'executor',
    result: 'completed',
    report_file: 'REPORT.md',
    validation: 'passed',
  };
}

export async function writeOutboxStatus(paths: WorkspacePaths, status: StatusFile): Promise<void> {
  await atomicWriteJson(nodePath.join(paths.outbox, status.dispatch_id, 'status.json'), status);
}

export async function writeOutboxResult(paths: WorkspacePaths, result: ResultFile): Promise<void> {
  await atomicWriteJson(nodePath.join(paths.outbox, result.dispatch_id, 'result.json'), result);
}

export async function writeOutboxMarkdown(
  paths: WorkspacePaths,
  dispatchId: string,
  name: 'PLAN.md' | 'PROGRESS.md' | 'REPORT.md',
  content: string,
): Promise<void> {
  await atomicWriteText(nodePath.join(paths.outbox, dispatchId, name), content);
}

// ---------------------------------------------------------------------------
// Config: write a gateflow.config.yml and parse it with the real loadConfig
// ---------------------------------------------------------------------------

export interface AgentEntry {
  activation: 'manual' | 'chatgpt' | 'zcode';
  command?: string;
  autoStart?: boolean;
}

/**
 * Write docs/workspace-protocol.md §10-shaped YAML into `projectRoot` and
 * return the DriverConfig parsed by the production loader (config parsing is
 * part of what the E2E exercises).
 */
export async function writeConfigYaml(
  projectRoot: string,
  opts: {
    routing?: { consumer?: string; executor?: string };
    agents?: Record<string, AgentEntry>;
    progressSyncSeconds?: number;
  } = {},
): Promise<DriverConfig> {
  const lines: string[] = [
    'version: 1',
    'repository: octo/repo',
    'driver:',
    '  poll_interval_seconds: 30',
    '  workspace_dir: .gateflow',
    `  progress_sync_seconds: ${opts.progressSyncSeconds ?? 60}`,
    '  max_attempts: 3',
    'trusted_humans: []',
    'routing:',
  ];
  if (opts.routing?.consumer !== undefined) lines.push(`  consumer: ${opts.routing.consumer}`);
  if (opts.routing?.executor !== undefined) lines.push(`  executor: ${opts.routing.executor}`);
  lines.push('agents:');
  for (const [name, agent] of Object.entries(opts.agents ?? {})) {
    const fields = [`activation: ${agent.activation}`];
    if (agent.command !== undefined) fields.push(`command: ${agent.command}`);
    if (agent.autoStart !== undefined) fields.push(`autoStart: ${agent.autoStart}`);
    lines.push(`  ${name}: { ${fields.join(', ')} }`);
  }
  lines.push('activation:', '  fallback: manual');
  await writeFile(nodePath.join(projectRoot, 'gateflow.config.yml'), `${lines.join('\n')}\n`, 'utf8');
  return loadConfig(projectRoot);
}

// ---------------------------------------------------------------------------
// Clock + runOnce outcome shaping
// ---------------------------------------------------------------------------

export interface ManualClock {
  now(): Date;
  iso(): string;
  advanceSeconds(seconds: number): void;
}

/** Injectable clock for deterministic debounce/timestamp control. */
export function manualClock(startIso = '2026-09-06T17:00:00Z'): ManualClock {
  let currentMs = new Date(startIso).getTime();
  return {
    now: () => new Date(currentMs),
    iso: () => new Date(currentMs).toISOString(),
    advanceSeconds: (seconds) => {
      currentMs += seconds * 1000;
    },
  };
}

/** Only the actually-dispatched intents of one cycle, shaped for toEqual. */
export function freshDispatches(result: DriverOnceResult): Array<{ dispatchId: string; reason: string }> {
  return result.dispatched
    .filter((outcome) => outcome.dispatched)
    .map((outcome) => ({ dispatchId: outcome.dispatchId ?? '', reason: outcome.reason }));
}

// ---------------------------------------------------------------------------
// Activation seam: process.stdout capture (see the module header for why)
// ---------------------------------------------------------------------------

export interface StdoutCapture {
  readonly lines: string[];
  text(): string;
  restore(): void;
}

/** Capture (and silence) everything adapters print to stdout. */
export function captureStdout(): StdoutCapture {
  const lines: string[] = [];
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(((chunk: unknown) => {
      lines.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write);
  return {
    lines,
    text: () => lines.join(''),
    restore: () => spy.mockRestore(),
  };
}

/** Make every stdout write THROW — simulates a dead activation channel. */
export function throwingStdout(): { restore(): void } {
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((() => {
      throw new Error('simulated stdout failure (activation channel down)');
    }) as typeof process.stdout.write);
  return { restore: () => spy.mockRestore() };
}

/** The ManualActivationAdapter banner line that carries a dispatch id. */
export function manualBannerLine(dispatchId: string): string {
  return `Dispatch   : ${dispatchId}`;
}

/**
 * The ZCodeActivationAdapter provider fingerprint (printed when autoStart is
 * off): the exact runnable command it suggests, embedding the dispatch id.
 */
export function zcodeSuggestion(dispatchId: string): string {
  return `GateFlow suggests (run it yourself to activate): zcode "GateFlow dispatch ${dispatchId} `;
}

// ---------------------------------------------------------------------------
// Audit trail classification
// ---------------------------------------------------------------------------

export type AuditKind =
  | 'plan'
  | 'human-feedback'
  | 'human-approval'
  | 'tracker'
  | 'completion'
  | 'other';

/** Classify a comment body the way the gate parses it (command vs marker). */
export function auditKind(body: string): AuditKind {
  const parsed = parseCommand(body);
  if (parsed !== null) {
    if (parsed.command === COMMANDS.change || parsed.command === COMMANDS.choose) return 'human-feedback';
    if (parsed.command === COMMANDS.approve) return 'human-approval';
    return 'other';
  }
  const marker = detectCommentMarker(body);
  if (marker === MARKERS.plan) return 'plan';
  if (marker === MARKERS.executionTracker) return 'tracker';
  if (marker === MARKERS.completionReport) return 'completion';
  return 'other';
}
