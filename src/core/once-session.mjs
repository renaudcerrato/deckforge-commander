import { createCycleSession, CYCLE_HOLD_MS, ONCE_CYCLE_POLICY } from './cycle-session.mjs';

export const ONCE_HOLD_MS = CYCLE_HOLD_MS;

/** One release requests one attempt; availability never grants another launch. */
export function createOnceSession(dependencies) {
  const onPresentation = dependencies.onPresentation;
  const session = createCycleSession({ ...dependencies,
    ...(typeof onPresentation === 'function' ? { onPresentation: (kind, ...args) =>
      onPresentation(kind === 'waiting' ? 'loading' : kind, ...args) } : {}),
  }, ONCE_CYCLE_POLICY);
  const { getState, ...operations } = session;
  return { ...operations, getState() {
    const { enabled, dueMs, ...state } = getState();
    return { ...state, presentation: state.presentation === 'waiting' ? 'loading' : state.presentation };
  } };
}
