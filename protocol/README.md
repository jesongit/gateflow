# Protocol Schemas

This directory holds machine-readable schema documents for GateFlow V1.

## `workspace-schema-v1.json`

JSON Schema (draft 2020-12) mirror of the frozen Workspace Protocol machine
files described in `docs/workspace-protocol.md` (§2 and §9). The root schema
matches exactly one machine file; each file type is a `$defs` entry:

| `$defs` entry      | File                                   |
| ------------------ | -------------------------------------- |
| `dispatch`         | `inbox/<dispatch_id>/dispatch.json`    |
| `context`          | `inbox/<dispatch_id>/context.json`     |
| `status`           | `outbox/<dispatch_id>/status.json`     |
| `result`           | `outbox/<dispatch_id>/result.json`     |
| `current`          | `current.json`                         |
| `receipt`          | `receipts/<dispatch_id>.json`          |
| `submitRequest`    | `submit/submit.json`                   |

Long content (`TASK.md`, `FEEDBACK.md`, `PLAN.md`, `PROGRESS.md`,
`REPORT.md`) is Markdown and intentionally not described here: the protocol
keeps strict JSON Schemas for state and actions, while Markdown payloads are
never semantically parsed.

## Executable source of truth

**`src/workspace/schemas.ts` is the executable source of truth.** It contains
hand-written validators (no ajv, no runtime dependencies) that enforce the
full frozen contract, including rules a JSON Schema cannot express cleanly:

- human-only actions (`approve`, `ready`, `cancel`, `human-close`) are
  rejected in any casing variant, with an error naming the value;
- per-role whitelists for `state` and `result` (§4);
- dispatch_id ↔ role agreement and the frozen dispatch_id grammar (§3);
- cross-field "iff" constraints of `result.json` (§2.4) applied together with
  the expected dispatch identity in `src/workspace/validation.ts`.

`validation.ts` additionally enforces the outbox acceptance rules of §5
(dispatch_id/role agreement with the dispatch being processed, per-file
512 KB cap, directory-name grammar).

Any change to the protocol is a protocol upgrade: bump the schema version,
update `docs/workspace-protocol.md`, `src/workspace/` and this mirror
together.

## `github-schema-v2.json`

The GitHub-side protocol object schema (markers, tracker and approval
comments) lives next to this file and is owned by the Driver/GitHub
workstream; it is independent of the workspace runtime.
