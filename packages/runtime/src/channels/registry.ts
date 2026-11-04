import type { ChannelConfig, ChannelProvider, ChannelStatus, ReplyDetail } from "@data-agent/contracts";
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

/** A bot's own settings, kept apart from its credentials so a fallback from the environment is never written to the store. */
export interface ChannelSettings {
  readonly enabled: boolean;
  readonly replyDetail: ReplyDetail;
}

const DEFAULT_SETTINGS: ChannelSettings = { enabled: true, replyDetail: "standard" };

/** Where every channel's settings live in the store, beside the channels' own entries. */
const SETTINGS_KEY = "$settings";

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
  private readonly settings = new Map<string, ChannelSettings>();

  constructor(
    private readonly hub: ChannelHub,
    private readonly store: ChannelConfigStore,
    private readonly providers: readonly ChannelProvider[],
    private readonly options: ChannelRegistryOptions = {},
  ) {
    for (const provider of providers) {
      this.entries.set(provider.id, { status: { id: provider.id, label: provider.label, state: "unconfigured", provisionable: provider.provision !== undefined } });
    }
    // A level changed from a chat is saved like one changed on the settings page.
    hub.onReplyDetailChange = async (channelId, replyDetail) => { await this.saveSettings(channelId, { replyDetail }); };
  }

  async start(): Promise<void> {
    const saved = await this.store.load();
    const settings = (saved[SETTINGS_KEY] ?? {}) as Readonly<Record<string, Partial<ChannelSettings>>>;
    for (const provider of this.providers) {
      const own = { ...DEFAULT_SETTINGS, ...settings[provider.id] };
      this.settings.set(provider.id, own);
      this.hub.setReplyDetail(provider.id, own.replyDetail);
      const config = saved[provider.id] ?? this.options.fallback?.[provider.id];
      if (!config) continue;
      if (own.enabled) await this.connect(provider, config);
      else this.set(provider.id, { state: "paused" });
    }
  }

  list(): ChannelStatus[] {
    return this.providers.map((provider) => {
      const { status } = this.entry(provider.id);
      // Settings belong to a bot that exists; a platform not set up has none to show.
      if (status.state === "unconfigured" || status.state === "provisioning") return status;
      return { ...status, settings: { ...this.settingsOf(provider.id) } };
    });
  }

  /**
   * Switches a set-up bot on or off, or changes how much of a run it sends.
   * Off stops the bot but keeps its credentials and who may use it.
   */
  async configure(channelId: string, patch: Partial<ChannelSettings>): Promise<ChannelStatus[]> {
    const provider = this.provider(channelId);
    const config = await this.configOf(channelId);
    if (!config) throw new Error(`CHANNEL_NOT_CONFIGURED: ${channelId}`);
    const before = this.settingsOf(channelId);
    const after = await this.saveSettings(channelId, patch);
    if (after.enabled !== before.enabled) {
      if (after.enabled) await this.connect(provider, config);
      else {
        await this.hub.unregister(channelId);
        this.set(channelId, { state: "paused" });
      }
    }
    return this.list();
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
      // Scanning again means the user wants the bot running.
      if (!this.settingsOf(channelId).enabled) await this.saveSettings(channelId, { enabled: true });
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
    const { [channelId]: _removed, [SETTINGS_KEY]: allSettings, ...rest } = await this.store.load();
    const { [channelId]: _settings, ...otherSettings } = (allSettings ?? {}) as Record<string, ChannelConfig>;
    await this.store.save({ ...rest, ...(Object.keys(otherSettings).length > 0 ? { [SETTINGS_KEY]: otherSettings } : {}) });
    this.settings.set(channelId, DEFAULT_SETTINGS);
    this.hub.setReplyDetail(channelId, DEFAULT_SETTINGS.replyDetail);
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

  private settingsOf(channelId: string): ChannelSettings {
    return this.settings.get(channelId) ?? DEFAULT_SETTINGS;
  }

  private async configOf(channelId: string): Promise<ChannelConfig | undefined> {
    return (await this.store.load())[channelId] ?? this.options.fallback?.[channelId];
  }

  private async saveSettings(channelId: string, patch: Partial<ChannelSettings>): Promise<ChannelSettings> {
    const next: ChannelSettings = { ...this.settingsOf(channelId), ...patch };
    this.settings.set(channelId, next);
    this.hub.setReplyDetail(channelId, next.replyDetail);
    const saved = await this.store.load();
    const all = (saved[SETTINGS_KEY] ?? {}) as Record<string, ChannelConfig>;
    await this.store.save({ ...saved, [SETTINGS_KEY]: { ...all, [channelId]: { ...next } } });
    return next;
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
