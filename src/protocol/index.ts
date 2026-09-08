/**
 * Shared protocol layer: the single source of truth for concepts BOTH the
 * Gate and the Driver consume (docs/plans/v1_hardening_decisions.md).
 *
 *  - plan.ts           — frozen Plan canonicalization + plan_sha256;
 *  - epoch.ts          — workflow epoch identity;
 *  - records.ts        — Gate-issued records (epoch / approval /
 *                        feedback_accepted / gate_transition), Operation IDs
 *                        and the Producer source-id anchor;
 *  - commands.ts       — the ONE frozen command grammar (Gate + Driver);
 *  - identity.ts       — the ONE identity resolver (humans / agents /
 *                        bootstrap drivers);
 *  - workflow-chain.ts — the ONE authorization-chain validator (current
 *                        epoch, current plan, approval binding, dispatch
 *                        binding) shared by Gate and Driver.
 *
 * Everything here is pure (no I/O, no Octokit) so the action bundle can import
 * it without pulling Node-only modules into unexpected places.
 */
export * from './plan';
export * from './epoch';
export * from './records';
export * from './commands';
export * from './identity';
export * from './workflow-chain';
