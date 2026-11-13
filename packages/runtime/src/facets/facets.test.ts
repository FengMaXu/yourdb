import { describe, expect, it } from "vitest";
import { ArtifactDirectory } from "./artifact-directory.js";
import { InMemoryResultStore } from "../answering/result-store.js";
import { ClarificationDialogs } from "./clarification-dialogs.js";
import { ClarificationManager } from "../clarification.js";
import type { AnswerTaskView, BusinessContext } from "../answering/model.js";

const context: BusinessContext = {
  principal: { id: "user-1" },
  sessionId: "session-1",
  lane: "main",
  operationId: "operation-1",
  invocationId: "invocation-1",
};

const view: AnswerTaskView = {
  task: {
    taskId: "task-1" as never,
    sessionId: "session-1",
    principalId: "user-1",
    requestMessageId: "message-1",
    requestId: "request-1",
    currentRevisionId: "revision-1" as never,
    latestCandidateId: "candidate-1" as never,
    publicationId: "publication-1" as never,
    lifecycle: "published",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  currentRevision: {} as never,
  unresolvedFacets: [],
  unresolvedHypotheses: [],
  unresolvedChoices: [],
  attempts: [],
  candidate: { candidateId: "candidate-1" as never, taskId: "task-1" as never, revisionId: "revision-1" as never, resultRef: "result-1" as never, resultSchema: ["value"], rowCount: 1, contentHash: "hash", queryHash: "query", findings: [], createdByInvocationId: "invocation-1", createdAt: "2026-01-01T00:00:00.000Z", status: "ready", publishable: true },
  publication: { receiptId: "publication-1" as never, taskId: "task-1" as never, principalId: "user-1", sessionId: "session-1", candidateId: "candidate-1" as never, revisionId: "revision-1" as never, resultRef: "result-1" as never, format: "inline", publicRef: "/api/runtime/publications/publication-1?session_id=session-1", contentHash: "hash", presentationContentHash: "presentation-hash", policyVersion: "answering-publication-v1", createdByInvocationId: "invocation-1", requestId: "publish-1", createdAt: "2026-01-01T00:00:00.000Z" },
};

describe("Session Facets", () => {
  it("resolves artifacts only through an authorized Receipt", async () => {
    let opened = false;
    const directory = new ArtifactDirectory({
      findPublication: async (publicationId) => publicationId === "publication-1" ? view.publication : undefined,
      readAuthorized: async (receipt) => { opened = receipt === view.publication; return { content: "published", contentHash: "presentation-hash" }; },
    });
    await expect(directory.resolve("guess", context)).rejects.toThrow("PUBLICATION_NOT_FOUND");
    const resolved = await directory.resolve("publication-1", context);
    expect(opened).toBe(true);
    expect(resolved.summary.publicRef).toContain("/api/runtime/publications/");
  });

  it("rejects guessed publication references and wrong principals with the concrete ResultStore", async () => {
    const resultStore = new InMemoryResultStore();
    const stored = await resultStore.createPrivate({ columns: ["value"], rows: [[1]], truncated: false }, context);
    const receipt = { ...view.publication!, resultRef: stored.resultRef, contentHash: stored.contentHash, principalId: "user-1", sessionId: "session-1" };
    const directory = new ArtifactDirectory({
      findPublication: async (publicationId, caller) => publicationId === "publication-1" && caller.principal.id === receipt.principalId && caller.sessionId === receipt.sessionId ? receipt : undefined,
      readAuthorized: async (authorized, caller) => {
        await resultStore.openAuthorized(authorized.resultRef, authorized, caller);
        const encoded = await resultStore.encodeCsv(authorized.resultRef, caller);
        return { ...encoded, contentHash: authorized.presentationContentHash ?? encoded.contentHash };
      },
    });
    await expect(directory.resolve("publication-1", { ...context, principal: { id: "user-2" } })).rejects.toThrow("PUBLICATION_NOT_FOUND");
    await expect(directory.resolve("result-1", context)).rejects.toThrow("PUBLICATION_NOT_FOUND");
    await expect(directory.resolve("publication-1", context)).resolves.toMatchObject({ summary: { contentHash: stored.contentHash } });
  });

  it("keeps clarification ownership in the Session facet", async () => {
    const dialogs = new ClarificationDialogs(new ClarificationManager(1000));
    const dialog = dialogs.ask("session-1", "Choose one", ["a", "b"]);
    expect(dialogs.list("session-1")).toHaveLength(1);
    expect(dialogs.answer(dialog.clarificationId, "a")).toBe(true);
    await expect(dialog.promise).resolves.toBe("a");
    expect(dialogs.list("session-1")).toHaveLength(0);
  });
});
