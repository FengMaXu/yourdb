import type {
  DataAgentCommandEnvelope,
  DataAgentEventEnvelope,
  DataAgentResponseEnvelope,
  RequestContext,
} from "@data-agent/contracts";

export interface ApplicationAuthUser {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
}

export interface ApplicationAuthService {
  userCount(): Promise<number>;
  register(username: string, password: string, displayName?: string): Promise<ApplicationAuthUser>;
  login(username: string, password: string): Promise<{ readonly user: ApplicationAuthUser; readonly token: string }>;
  authenticate(token: string | undefined): Promise<ApplicationAuthUser | undefined>;
  logout(token: string): Promise<void>;
}

/** Narrow command/event seam consumed by HTTP and Electron transports. */
export interface ApplicationEventFilter {
  readonly userId?: string;
  readonly sessionId?: string;
}

/**
 * Buffered events after a cursor; `complete` is false when some were already
 * evicted. `latestSequence` is the last event emitted so far: a client that
 * resynchronizes resumes after it.
 */
export interface EventReplay {
  readonly events: readonly DataAgentEventEnvelope[];
  readonly complete: boolean;
  readonly latestSequence: number;
}

export interface ApplicationCommandHost {
  dispatch(command: DataAgentCommandEnvelope, context: RequestContext): Promise<DataAgentResponseEnvelope>;
  subscribe(listener: (event: DataAgentEventEnvelope) => void, filter?: ApplicationEventFilter): () => void;
  replayAfter(sequence: number, filter?: ApplicationEventFilter): EventReplay;
  /**
   * Which process issues the event sequences, and the last one so far.
   * Sequences restart with the process, so a cursor is only meaningful for
   * the instance that issued it.
   */
  eventStreamPosition(): { readonly instanceId: string; readonly latestSequence: number };
  readonly authService: ApplicationAuthService;
  queryExecutor?: {
    run(sql: string, rowLimit: number, options?: { readonly idempotencyKey?: string }): Promise<{ readonly columns: string[]; readonly rows: unknown[][]; readonly truncated: boolean }>;
  };
}
