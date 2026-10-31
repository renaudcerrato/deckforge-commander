import type { TimerSession, TimerSessionDependencies } from './timer-session.mjs';

export declare const CYCLE_HOLD_MS: 1000;
declare const loopPolicy: unique symbol;
declare const oncePolicy: unique symbol;
/** Internal trusted identities: callers cannot supply arbitrary policy callbacks. */
export declare const LOOP_CYCLE_POLICY: Readonly<{ readonly [loopPolicy]: true }>;
export declare const ONCE_CYCLE_POLICY: Readonly<{ readonly [oncePolicy]: true }>;
export declare function createCycleSession(dependencies: TimerSessionDependencies, policy: typeof LOOP_CYCLE_POLICY): TimerSession;
/** The Once facade translates Loading and removes all scheduling/request slots from public state. */
export declare function createCycleSession(dependencies: TimerSessionDependencies, policy: typeof ONCE_CYCLE_POLICY): TimerSession;
