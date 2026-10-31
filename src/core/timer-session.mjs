import { createCycleSession, CYCLE_HOLD_MS, LOOP_CYCLE_POLICY } from './cycle-session.mjs';

export const TIMER_HOLD_MS = CYCLE_HOLD_MS;

/** Compatibility facade: Loop retains its public state and completion-paced scheduling contract. */
export function createTimerSession(dependencies) {
  return createCycleSession(dependencies, LOOP_CYCLE_POLICY);
}
