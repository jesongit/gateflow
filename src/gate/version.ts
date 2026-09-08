/**
 * The Gate version recorded in every gate_transition record (V1.1 Phase 4)
 * and surfaced by the action entry. Single source of truth: src/gate/version.ts
 * (index.ts re-exports it; gate.ts must not import index.ts — cycle).
 */
export const GATE_VERSION = '1.1.0';
