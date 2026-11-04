import type { ChannelConfig, ChannelProvider, ChannelStatus } from "@data-agent/contracts";
import type { ChannelHub, ChannelOwner } from "./hub.js";

/** Where saved channel configuration lives; it holds credentials and never leaves the core. */
export interface ChannelConfigStore {
  load(): Promise<Readonly<Record<string, ChannelConfig>>>;
  save(configs: Readonly<Record<string, ChannelConfig>>): Promise<void>;
}

export interface ChannelRegistryOptions {
  /** Used when nothing is saved for a channel, such as credentials from the environment. */
  readonly fallback?: Readonly<Record<string, ChannelConfig | undefined>>;
  readonly onError?: (error: unknown) => void;
}

type Entry = { status: ChannelStatus; abort?: AbortController };

/** Saved beside a scanned channel's own configuration: who scanned, in the bot's ids, and their account. */
const OWNER_KEY = "$owner";

function ownerOf(config: ChannelConfig): ChannelOwner | undefined {
  const owner = config[OWNER_KEY] as Partial<ChannelOwner> | undefined;
  return typeof owner?.externalUserId === "string" && typeof owner.userId === "string" ? { externalUserId: owner.externalUserId, userId: owner.userId } : undefined;
}

function failure(error: unknown): string {
  const record = error && typeof error === "object" ? error as { code?: unknown; description?: unknown; message?: unknown } : {};
  if (record.code === "access_denied") return "扫码后没有确认授权。";
  if (record.code === "expired_token") return "二维码已过期，请重新扫码。";
  if (record.code === "abort") return "已取消。";
  return String(record.description ?? record.message ?? error);
}

/**
 * Which channels run, from what configuration (ADR-0011). It registers saved
 * channels on start, runs scan-to-connect flows, and saves what they yield.
 * Statuses carry no credentials, so the settings page can show them as is.
 */
export class ChannelRegistry {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly hub: ChannelHub,
    private readonly store: ChannelConfigStore,
    private readonly providers: readonly ChannelProvider[],
    private readonly options: ChannelRegistryOptions = {},
  ) {
    for (const provider of providers) {
      this.entries.set(provider.id, { status: { id: provider.id, label: provider.label, state: "unconfigured", provisionable: provider.provision !== undefined } });
    }
  }

  async start(): Promise<void> {
    const saved = await this.store.load();
    for (const provider of this.providers) {
      const config = saved[provider.id] ?? this.options.fallback?.[provider.id];
      if (config) await this.connect(provider, config);
    }
  }

  list(): ChannelStatus[] {
    return this.providers.map((provider) => this.entry(provider.id).status);
  }

  /** Starts scan-to-connect and returns once the link is ready; the rest finishes in the background. */
  async provision(channelId: string, userId?: string): Promise<ChannelStatus[]> {
    const provider = this.provider(channelId);
    if (!provider.provision) throw new Error(`CHANNEL_NOT_PROVISIONABLE: ${channelId}`);
    const entry = this.entry(channelId);
    entry.abort?.abort();
    const abort = new AbortController();
    entry.abort = abort;
    const flow = provider.provision(abort.signal);
    const current = () => this.entry(channelId).abort === abort;
    void flow.done.then(async ({ config, warnings, owner }) => {
      if (!current()) return;
      delete this.entry(channelId).abort;
      // A new bot gives everyone new ids, so the old bot's members and requests mean nothing now.
      await this.hub.forgetAccess(channelId);
      const saved = owner && userId ? { ...config, [OWNER_KEY]: { externalUserId: owner.externalUserId, userId } } : config;
      await this.store.save({ ...(await this.store.load()), [channelId]: saved });
      await this.connect(provider, saved, warnings);
    }).catch((error: unknown) => {
      if (!current()) return;
      delete this.entry(channelId).abort;
      this.set(channelId, { state: "failed", message: failure(error) });
    });
    try {
      const link = await flow.ready;
      if (current()) this.set(channelId, { state: "provisioning", provisioning: link });
    } catch (error) {
      if (current()) {
        delete this.entry(channelId).abort;
        this.set(channelId, { state: "failed", message: failure(error) });
      }
    }
    return this.list();
  }

  /** Stops the channel and forgets its saved configuration. */
  async disconnect(channelId: string): Promise<ChannelStatus[]> {
    this.provider(channelId);
    const entry = this.entry(channelId);
    entry.abort?.abort();
    delete entry.abort;
    await this.hub.unregister(channelId);
    await this.hub.forgetAccess(channelId);
    const { [channelId]: _removed, ...rest } = await this.store.load();
    await this.store.save(rest);
    this.set(channelId, { state: "unconfigured" });
    return this.list();
  }

  close(): void {
    for (const entry of this.entries.values()) entry.abort?.abort();
  }

  private async connect(provider: ChannelProvider, config: ChannelConfig, warnings: readonly string[] = []): Promise<void> {
    try {
      await this.hub.unregister(provider.id);
      const { [OWNER_KEY]: _owner, ...own } = config;
      await this.hub.register(provider.create(own), ownerOf(config));
      this.set(provider.id, { state: "connected", ...(warnings.length > 0 ? { warnings: [...warnings] } : {}) });
    } catch (error) {
      this.options.onError?.(error);
      this.set(provider.id, { state: "failed", message: failure(error), ...(warnings.length > 0 ? { warnings: [...warnings] } : {}) });
    }
  }

  private set(channelId: string, status: Pick<ChannelStatus, "state"> & Partial<ChannelStatus>): void {
    const entry = this.entry(channelId);
    entry.status = { id: entry.status.id, label: entry.status.label, provisionable: entry.status.provisionable, ...status };
  }

  private entry(channelId: string): Entry {
    const entry = this.entries.get(channelId);
    if (!entry) throw new Error(`CHANNEL_UNKNOWN: ${channelId}`);
    return entry;
  }

  private provider(channelId: string): ChannelProvider {
    const provider = this.providers.find((item) => item.id === channelId);
    if (!provider) throw new Error(`CHANNEL_UNKNOWN: ${channelId}`);
    return provider;
  }
}
