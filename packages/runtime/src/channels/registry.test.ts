import { describe, expect, it } from "vitest";
import type { Channel, ChannelConfig, ChannelProvider } from "@data-agent/contracts";
import type { ChannelHub, ChannelOwner } from "./hub.js";
import { ChannelRegistry, type ChannelConfigStore } from "./registry.js";

function fakeHub(options: { refuse?: boolean } = {}) {
  const registered = new Map<string, Channel>();
  const owners = new Map<string, ChannelOwner | undefined>();
  const forgotten: string[] = [];
  const hub = {
    async register(channel: Channel, owner?: ChannelOwner) {
      if (options.refuse) throw new Error("connect failed");
      registered.set(channel.id, channel);
      owners.set(channel.id, owner);
    },
    async unregister(channelId: string) { registered.delete(channelId); },
    async forgetAccess(channelId: string) { forgotten.push(channelId); },
    details: new Map<string, string>(),
    setReplyDetail(channelId: string, detail: string) { this.details.set(channelId, detail); },
    onReplyDetailChange: undefined as undefined | ((channelId: string, detail: "summary" | "standard" | "full") => Promise<void>),
  };
  return { hub: hub as unknown as ChannelHub, registered, owners, forgotten, details: hub.details, fromChat: (channelId: string, detail: "summary" | "standard" | "full") => hub.onReplyDetailChange!(channelId, detail) };
}

function memoryStore(initial: Record<string, ChannelConfig> = {}) {
  let saved: Record<string, ChannelConfig> = { ...initial };
  const store: ChannelConfigStore = { load: async () => saved, save: async (configs) => { saved = { ...configs }; } };
  return { store, saved: () => saved };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeProvider() {
  const built: ChannelConfig[] = [];
  const flows: { ready: ReturnType<typeof deferred<{ url: string; expiresAt: number }>>; done: ReturnType<typeof deferred<{ config: ChannelConfig; warnings: readonly string[]; owner?: { externalUserId: string } }>>; signal: AbortSignal }[] = [];
  const provider: ChannelProvider = {
    id: "im",
    label: "IM",
    create(config) {
      built.push(config);
      return { id: "im", capabilities: { editableMessages: false, actions: false, files: false }, start: async () => undefined, deliver: async () => undefined, stop: async () => undefined };
    },
    provision(signal) {
      const flow = { ready: deferred<{ url: string; expiresAt: number }>(), done: deferred<{ config: ChannelConfig; warnings: readonly string[]; owner?: { externalUserId: string } }>(), signal };
      flows.push(flow);
      return { ready: flow.ready.promise, done: flow.done.promise };
    },
  };
  return { provider, built, flows };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ChannelRegistry", () => {
  it("connects saved configuration on start, falling back to the environment, and never shows credentials", async () => {
    const { hub, registered } = fakeHub();
    const { provider, built } = fakeProvider();
    const registry = new ChannelRegistry(hub, memoryStore({ im: { appSecret: "saved" } }).store, [provider], { fallback: { im: { appSecret: "env" } } });
    await registry.start();
    expect(built).toEqual([{ appSecret: "saved" }]);
    expect(registered.has("im")).toBe(true);
    expect(registry.list()).toEqual([{ id: "im", label: "IM", state: "connected", provisionable: true, settings: { enabled: true, replyDetail: "standard" } }]);
    expect(JSON.stringify(registry.list())).not.toContain("saved");

    const fromEnv = fakeProvider();
    const other = new ChannelRegistry(fakeHub().hub, memoryStore().store, [fromEnv.provider], { fallback: { im: { appSecret: "env" } } });
    await other.start();
    expect(fromEnv.built).toEqual([{ appSecret: "env" }]);
  });

  it("shows the scan link, then saves and connects what the scan yields, with steps left", async () => {
    const { hub, registered } = fakeHub();
    const { provider, flows, built } = fakeProvider();
    const { store, saved } = memoryStore();
    const registry = new ChannelRegistry(hub, store, [provider]);
    await registry.start();
    expect(registry.list()[0]!.state).toBe("unconfigured");

    const listed = registry.provision("im");
    flows[0]!.ready.resolve({ url: "https://scan", expiresAt: 99 });
    expect((await listed)[0]).toMatchObject({ state: "provisioning", provisioning: { url: "https://scan", expiresAt: 99 } });

    flows[0]!.done.resolve({ config: { appSecret: "new" }, warnings: ["改成长连接"] });
    await settle();
    expect(saved()).toEqual({ im: { appSecret: "new" } });
    expect(built).toEqual([{ appSecret: "new" }]);
    expect(registered.has("im")).toBe(true);
    expect(registry.list()[0]).toEqual({ id: "im", label: "IM", state: "connected", provisionable: true, warnings: ["改成长连接"], settings: { enabled: true, replyDetail: "standard" } });
  });

  it("makes whoever scanned the owner of the new bot, forgetting the old bot's members, and keeps it across restarts", async () => {
    const { hub, owners, forgotten } = fakeHub();
    const { provider, flows, built } = fakeProvider();
    const { store, saved } = memoryStore();
    const registry = new ChannelRegistry(hub, store, [provider]);
    const listed = registry.provision("im", "user-1");
    flows[0]!.ready.resolve({ url: "https://scan", expiresAt: 99 });
    await listed;
    flows[0]!.done.resolve({ config: { appSecret: "new" }, warnings: [], owner: { externalUserId: "ou_me" } });
    await settle();
    expect(forgotten).toEqual(["im"]);
    expect(saved()).toEqual({ im: { appSecret: "new", $owner: { externalUserId: "ou_me", userId: "user-1" } } });
    expect(built).toEqual([{ appSecret: "new" }]);
    expect(owners.get("im")).toEqual({ externalUserId: "ou_me", userId: "user-1" });
    expect(JSON.stringify(registry.list())).not.toContain("ou_me");

    const restarted = fakeHub();
    await new ChannelRegistry(restarted.hub, store, [provider]).start();
    expect(restarted.owners.get("im")).toEqual({ externalUserId: "ou_me", userId: "user-1" });
  });

  it("reports a failed scan plainly, and a newer scan replaces an older one", async () => {
    const { provider, flows } = fakeProvider();
    const registry = new ChannelRegistry(fakeHub().hub, memoryStore().store, [provider]);
    const first = registry.provision("im");
    flows[0]!.ready.resolve({ url: "https://first", expiresAt: 1 });
    await first;
    const second = registry.provision("im");
    expect(flows[0]!.signal.aborted).toBe(true);
    flows[1]!.ready.resolve({ url: "https://second", expiresAt: 2 });
    await second;
    flows[0]!.done.reject(Object.assign(new Error("x"), { code: "abort" }));
    await settle();
    expect(registry.list()[0]).toMatchObject({ state: "provisioning", provisioning: { url: "https://second" } });

    flows[1]!.done.reject(Object.assign(new Error("x"), { code: "expired_token" }));
    await settle();
    expect(registry.list()[0]).toMatchObject({ state: "failed", message: "二维码已过期，请重新扫码。" });
  });

  it("disconnects by stopping the channel and forgetting its configuration and who may use it", async () => {
    const { hub, registered, forgotten } = fakeHub();
    const { provider } = fakeProvider();
    const { store, saved } = memoryStore({ im: { appSecret: "saved" } });
    const registry = new ChannelRegistry(hub, store, [provider]);
    await registry.start();
    expect((await registry.disconnect("im"))[0]!.state).toBe("unconfigured");
    expect(registered.has("im")).toBe(false);
    expect(forgotten).toEqual(["im"]);
    expect(saved()).toEqual({});
  });

  it("marks a channel failed when it cannot connect", async () => {
    const errors: unknown[] = [];
    const { provider } = fakeProvider();
    const registry = new ChannelRegistry(fakeHub({ refuse: true }).hub, memoryStore({ im: { appSecret: "x" } }).store, [provider], { onError: (error) => errors.push(error) });
    await registry.start();
    expect(registry.list()[0]).toMatchObject({ state: "failed", message: "connect failed" });
    expect(errors).toHaveLength(1);
  });

  it("pauses a bot without losing its credentials, and keeps it paused across restarts", async () => {
    const { hub, registered } = fakeHub();
    const { provider, built } = fakeProvider();
    const { store, saved } = memoryStore({ im: { appSecret: "saved" } });
    const registry = new ChannelRegistry(hub, store, [provider]);
    await registry.start();
    expect((await registry.configure("im", { enabled: false }))[0]).toMatchObject({ state: "paused", settings: { enabled: false } });
    expect(registered.has("im")).toBe(false);
    expect(saved().im).toEqual({ appSecret: "saved" });

    const restarted = fakeHub();
    const again = new ChannelRegistry(restarted.hub, store, [provider]);
    await again.start();
    expect(again.list()[0]!.state).toBe("paused");
    expect(restarted.registered.has("im")).toBe(false);

    expect((await again.configure("im", { enabled: true }))[0]!.state).toBe("connected");
    expect(restarted.registered.has("im")).toBe(true);
    expect(built).toEqual([{ appSecret: "saved" }, { appSecret: "saved" }]);
  });

  it("saves the reply detail from the page or the chat, restores it on start, and forgets it on disconnect", async () => {
    const first = fakeHub();
    const { provider } = fakeProvider();
    const { store, saved } = memoryStore({ im: { appSecret: "saved" } });
    const registry = new ChannelRegistry(first.hub, store, [provider]);
    await registry.start();
    await registry.configure("im", { replyDetail: "full" });
    expect(first.details.get("im")).toBe("full");
    await first.fromChat("im", "summary");
    expect(registry.list()[0]!.settings).toEqual({ enabled: true, replyDetail: "summary" });

    const second = fakeHub();
    await new ChannelRegistry(second.hub, store, [provider]).start();
    expect(second.details.get("im")).toBe("summary");

    await registry.disconnect("im");
    expect(saved()).toEqual({});
    expect(registry.list()[0]).not.toHaveProperty("settings");
  });

  it("refuses settings for a bot that is not set up", async () => {
    const { hub } = fakeHub();
    const registry = new ChannelRegistry(hub, memoryStore().store, [fakeProvider().provider]);
    await registry.start();
    await expect(registry.configure("im", { enabled: false })).rejects.toThrow("CHANNEL_NOT_CONFIGURED");
  });
});
