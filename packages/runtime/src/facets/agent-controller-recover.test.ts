import { describe, expect, it } from "vitest";
import { AgentHarness } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { PiJsonlSessionStore, unwrapApplicationSession } from "../session-store.js";
import { createPiAgentController } from "./agent-controller.js";

const operationContext = { abortSignal: undefined, value: () => undefined, toString: () => "recover-test" };

async function harnessFor(store: PiJsonlSessionStore, faux: ReturnType<typeof fauxProvider>, create: boolean) {
  const attached = create ? await store.create({ sessionId: "session-1" }) : await store.openByAppSessionId("session-1");
  const models = createModels();
  models.setProvider(faux.provider);
  return AgentHarness.create({ session: unwrapApplicationSession(attached), models, model: faux.models[0], systemPrompt: "You are a test agent.", tools: [] }, operationContext);
}

/** A run accepted before a host stop, then the store reopened: what a server restart leaves behind. */
async function strandedRun(root: string, faux: ReturnType<typeof fauxProvider>) {
  let store = new PiJsonlSessionStore(root);
  const first = await harnessFor(store, faux, true);
  const lane = await first.harness.lane("main", operationContext);
  const accepted = await lane.accept({ kind: "prompt", prompt: "hello" }, operationContext);
  if (!accepted.ok) throw accepted.error;
  await first.harness.close(operationContext);
  await store.close();
  store = new PiJsonlSessionStore(root);
  const reopened = await harnessFor(store, faux, false);
  return { store, reopened, operationId: accepted.value.operationId };
}

describe("PiAgentController.recover", () => {
  it("drives an operation restored after a host stop until it settles, binding it like an accepted one", async () => {
    const root = await mkdtemp(path.join(process.cwd(), ".tmp-recover-"));
    const faux = fauxProvider({ provider: "data-agent-test", models: [{ id: "recover-test" }] });
    try {
      const { store, reopened, operationId } = await strandedRun(root, faux);
      faux.setResponses([fauxAssistantMessage("recovered")]);
      const bound: string[] = [];
      const controller = await createPiAgentController(reopened.harness, { pi: operationContext }, "main", [], undefined, (admission) => { bound.push(admission.operationId); });
      const outcome = await controller.recover(operationId, { pi: operationContext });
      expect(outcome).toMatchObject({ kind: "settled", outcome: { status: "completed" } });
      expect(bound).toEqual([operationId]);
      await reopened.harness.close(operationContext);
      await store.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("settles a Stop requested while nothing drove the restored operation", async () => {
    const root = await mkdtemp(path.join(process.cwd(), ".tmp-recover-"));
    const faux = fauxProvider({ provider: "data-agent-test", models: [{ id: "recover-test" }] });
    try {
      const { store, reopened, operationId } = await strandedRun(root, faux);
      const controller = await createPiAgentController(reopened.harness, { pi: operationContext }, "main");
      await controller.requestAbort(operationId, { pi: operationContext });
      const outcome = await controller.recover(operationId, { pi: operationContext });
      expect(outcome).toMatchObject({ kind: "settled", outcome: { status: "aborted" } });
      expect(faux.state.callCount).toBe(0);
      await reopened.harness.close(operationContext);
      await store.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
