/**
 * Shared protocol layer: the single source of truth for concepts BOTH the
 * Gate and the Driver consume (docs/plans/v1_hardening_decisions.md).
 *
 *  - plan.ts     — frozen Plan canonicalization + plan_sha256;
 *  - epoch.ts    — workflow epoch identity;
 *  - records.ts  — Gate-issued records (epoch / approval / feedback_accepted)
 *                  and Operation IDs.
 *
 * Everything here is pure (no I/O, no Octokit) so the action bundle can import
 * it without pulling Node-only modules into unexpected places.
 */
export * from './plan';
export * from './epoch';
export * from './records';
