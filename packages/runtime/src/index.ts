/**
 * Runtime public surface.
 *
 * Hosts receive semantic Application services and wire transport DTOs. Pi
 * Session/Harness objects, Answering stores, capability implementations and
 * command dispatch internals remain package-private and are not Host APIs.
 */
export {
  DataAgentApplication,
  createDataAgentApplication,
  type ApplicationAgentEvent,
  type DataAgentApplicationOptions,
  type HostRequestContext,
} from "./application/data-agent-application.js";
export type { ApplicationAuthService, ApplicationAuthUser, ApplicationCommandHost, ApplicationEventFilter, EventReplay } from "./application/protocol-host.js";
export { ChannelHub, type ChannelHubOptions, type SubmitOutcome } from "./channels/hub.js";
export { createDashboardSnapshotter, findBrowser, type DashboardSnapshotOptions } from "./channels/dashboard-snapshot.js";

export type {
  DataAgentCommand,
  DataAgentCommandEnvelope,
  DataAgentEvent,
  DataAgentEventEnvelope,
  DataAgentResponse,
  DataAgentResponseEnvelope,
  RequestContext,
} from "@data-agent/contracts";
