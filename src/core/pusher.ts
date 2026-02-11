import AbstractRuntime from "../runtimes/interface";
import Runtime from "runtime";
import * as Collections from "./utils/collections";
import Channels from "./channels/channels";
import Channel from "./channels/channel";
import { default as EventsDispatcher } from "./events/dispatcher";
import Timeline from "./timeline/timeline";
import TimelineSender from "./timeline/timeline_sender";
import TimelineLevel from "./timeline/level";
import { defineTransport } from "./strategies/strategy_builder";
import ConnectionManager from "./connection/connection_manager";
import { PeriodicTimer } from "./utils/timers";
import Defaults from "./defaults";
import Logger, { setLoggerConfig } from "./logger";
import Factory from "./utils/factory";
import { Options, validateOptions } from "./options";
import { Config, getConfig } from "./config";
import StrategyOptions from "./strategies/strategy_options";
import UserFacade from "./user";
import DeltaCompressionManager from "./delta/manager";
import { DeltaStats } from "./delta/types";
import { Filter, validateFilter, FilterExamples } from "./channels/filter";
import type { FilterNode } from "./channels/filter";

// Re-export filter types and utilities for easy access
export { Filter, validateFilter, FilterExamples };
export type { FilterNode };

export default class Pusher {
  /*  STATIC PROPERTIES */
  static instances: Pusher[] = [];
  static isReady: boolean = false;

  private static _logToConsole: boolean = false;
  private static _log: ((message: any) => void) | undefined;

  static get logToConsole(): boolean {
    return this._logToConsole;
  }

  static set logToConsole(value: boolean) {
    this._logToConsole = value;
    setLoggerConfig({ logToConsole: value, log: this._log });
  }

  static get log(): ((message: any) => void) | undefined {
    return this._log;
  }

  static set log(fn: ((message: any) => void) | undefined) {
    this._log = fn;
    setLoggerConfig({ logToConsole: this._logToConsole, log: fn });
  }

  static Runtime: AbstractRuntime = Runtime;

  static ready() {
    Pusher.isReady = true;
    for (let i = 0, l = Pusher.instances.length; i < l; i++) {
      Pusher.instances[i].connect();
    }
  }

  private static getClientFeatures(): string[] {
    return Collections.keys(
      Collections.filterObject({ ws: Runtime.Transports.ws }, function (t) {
        return t.isSupported({});
      }),
    );
  }

  /* INSTANCE PROPERTIES */
  key: string;
  config: Config;
  channels: Channels;
  global_emitter: EventsDispatcher;
  sessionID: number;
  timeline: Timeline;
  timelineSender: TimelineSender;
  connection: ConnectionManager;
  timelineSenderTimer: PeriodicTimer;
  user: UserFacade;
  deltaCompression: DeltaCompressionManager;
  constructor(app_key: string, options: Options) {
    checkAppKey(app_key);
    validateOptions(options);
    this.key = app_key;
    this.config = getConfig(options, this);

    this.channels = Factory.createChannels();
    this.global_emitter = new EventsDispatcher();
    this.sessionID = Runtime.randomInt(1000000000);

    this.timeline = new Timeline(this.key, this.sessionID, {
      cluster: this.config.cluster,
      features: Pusher.getClientFeatures(),
      params: this.config.timelineParams || {},
      limit: 50,
      level: TimelineLevel.INFO,
      version: Defaults.VERSION,
    });
    if (this.config.enableStats) {
      this.timelineSender = Factory.createTimelineSender(this.timeline, {
        host: this.config.statsHost,
        path: "/timeline/v2/" + Runtime.TimelineTransport.name,
      });
    }

    const getStrategy = (options: StrategyOptions) => {
      return Runtime.getDefaultStrategy(this.config, options, defineTransport);
    };

    this.connection = Factory.createConnectionManager(this.key, {
      getStrategy: getStrategy,
      timeline: this.timeline,
      activityTimeout: this.config.activityTimeout,
      pongTimeout: this.config.pongTimeout,
      unavailableTimeout: this.config.unavailableTimeout,
      useTLS: Boolean(this.config.useTLS),
    });

    // Initialize delta compression manager if configured
    // Note: We always create the manager if deltaCompression option is present,
    // but only enable it automatically if enabled: true
    if (options.deltaCompression !== undefined) {
      this.deltaCompression = new DeltaCompressionManager(
        options.deltaCompression || {},
        (event: string, data: any) => this.send_event(event, data),
      );
    }

    this.connection.bind("connected", () => {
      this.subscribeAll();
      if (this.timelineSender) {
        this.timelineSender.send(this.connection.isUsingTLS());
      }
      // Enable delta compression after connection only if explicitly enabled
      if (this.deltaCompression && options.deltaCompression?.enabled === true) {
        this.deltaCompression.enable();
      }
    });

    this.connection.bind("message", (event) => {
      const eventName = event.event;
      const internal = eventName.indexOf("pusher_internal:") === 0;

      // Handle delta compression protocol events
      if (this.deltaCompression) {
        if (eventName === "pusher:delta_compression_enabled") {
          this.deltaCompression.handleEnabled(event.data);
          // Don't return - let it emit to global listeners
        } else if (eventName === "pusher:delta_cache_sync" && event.channel) {
          this.deltaCompression.handleCacheSync(event.channel, event.data);
          return;
        } else if (eventName === "pusher:delta" && event.channel) {
          // Check if channel still exists before processing delta
          // This prevents errors from in-flight delta messages after unsubscribe
          const channel = this.channel(event.channel);
          if (!channel) {
            // Channel was unsubscribed, silently ignore delta message
            return;
          }

          // Decode delta and emit reconstructed event
          const reconstructedEvent = this.deltaCompression.handleDeltaMessage(
            event.channel,
            event.data,
          );
          if (reconstructedEvent) {
            // Route to channel
            if (channel) {
              channel.handleEvent(reconstructedEvent);
            }
            // Emit globally
            this.global_emitter.emit(
              reconstructedEvent.event,
              reconstructedEvent.data,
            );
          }
          return;
        }
      }

      if (event.channel) {
        const channel = this.channel(event.channel);
        if (channel) {
          channel.handleEvent(event);
        }

        // Store full messages for delta compression
        if (
          this.deltaCompression &&
          event.event &&
          !event.event.startsWith("pusher:") &&
          !event.event.startsWith("pusher_internal:")
        ) {
          // Extract sequence number from message level (not from data)
          let sequence: number | undefined;
          if (typeof (event as any).sequence === "number") {
            sequence = (event as any).sequence;
          }

          // Extract conflation_key before we delete it
          let conflationKey: string | undefined;
          if (typeof (event as any).conflation_key === "string") {
            conflationKey = (event as any).conflation_key;
          }

          // Use RAW message and strip metadata fields using REGEX
          // This preserves exact byte representation (including float precision)
          // We MUST NOT use JSON.parse/stringify as it can change float representations
          let fullMessage = event.rawMessage || "";

          if (fullMessage && sequence !== undefined) {
            // Strip metadata fields using regex to preserve exact bytes
            // Pattern matches: ,"__delta_seq":NUMBER or "__delta_seq":NUMBER, at start
            fullMessage = fullMessage.replace(/,"__delta_seq":\d+/g, "");
            fullMessage = fullMessage.replace(/"__delta_seq":\d+,/g, "");
            // Pattern matches: ,"__conflation_key":"..." or "__conflation_key":"...", at start
            fullMessage = fullMessage.replace(
              /,"__conflation_key":"[^"]*"/g,
              "",
            );
            fullMessage = fullMessage.replace(
              /"__conflation_key":"[^"]*",/g,
              "",
            );
          }

          this.deltaCompression.handleFullMessage(
            event.channel,
            fullMessage,
            sequence,
            conflationKey,
          );
        }
      }
      // Emit globally [deprecated]
      if (!internal) {
        this.global_emitter.emit(event.event, event.data);
      }
    });
    this.connection.bind("connecting", () => {
      this.channels.disconnect();
    });
    this.connection.bind("disconnected", () => {
      this.channels.disconnect();
    });
    this.connection.bind("error", (err) => {
      Logger.warn(err);
    });

    Pusher.instances.push(this);
    this.timeline.info({ instances: Pusher.instances.length });

    this.user = new UserFacade(this);

    if (Pusher.isReady) {
      this.connect();
    }
  }

  channel(name: string): Channel {
    return this.channels.find(name);
  }

  allChannels(): Channel[] {
    return this.channels.all();
  }

  connect() {
    this.connection.connect();

    if (this.timelineSender) {
      if (!this.timelineSenderTimer) {
        const usingTLS = this.connection.isUsingTLS();
        const timelineSender = this.timelineSender;
        this.timelineSenderTimer = new PeriodicTimer(60000, function () {
          timelineSender.send(usingTLS);
        });
      }
    }
  }

  disconnect() {
    this.connection.disconnect();

    if (this.timelineSenderTimer) {
      this.timelineSenderTimer.ensureAborted();
      this.timelineSenderTimer = null;
    }
  }

  bind(
    event_name: string,
    callback: (...args: any[]) => any,
    context?: any,
  ): Pusher {
    this.global_emitter.bind(event_name, callback, context);
    return this;
  }

  unbind(
    event_name?: string,
    callback?: (...args: any[]) => any,
    context?: any,
  ): Pusher {
    this.global_emitter.unbind(event_name, callback, context);
    return this;
  }

  bind_global(callback: (...args: any[]) => any): Pusher {
    this.global_emitter.bind_global(callback);
    return this;
  }

  unbind_global(callback?: (...args: any[]) => any): Pusher {
    this.global_emitter.unbind_global(callback);
    return this;
  }

  unbind_all(_callback?: (...args: any[]) => any): Pusher {
    this.global_emitter.unbind_all();
    return this;
  }

  subscribeAll() {
    let channelName;
    for (channelName in this.channels.channels) {
      if (this.channels.channels.hasOwnProperty(channelName)) {
        this.subscribe(channelName);
      }
    }
  }

  /**
   * Subscribe to a channel with optional filters and delta compression settings
   *
   * @param channel_name - The name of the channel to subscribe to
   * @param options - Optional subscription options:
   *   - If a FilterNode: Used as tags filter (backward compatible)
   *   - If an object: { filter?: FilterNode, delta?: ChannelDeltaSettings }
   *
   * @example
   * // Simple subscription
   * pusher.subscribe('my-channel');
   *
   * @example
   * // Subscription with tags filter (backward compatible)
   * pusher.subscribe('my-channel', Filter.eq('type', 'important'));
   *
   * @example
   * // Subscription with delta compression
   * pusher.subscribe('my-channel', { delta: { enabled: true, algorithm: 'fossil' } });
   *
   * @example
   * // Subscription with both filter and delta settings
   * pusher.subscribe('my-channel', {
   *   filter: Filter.eq('type', 'important'),
   *   delta: { enabled: true, algorithm: 'xdelta3' }
   * });
   *
   * @example
   * // Disable delta compression for a specific channel
   * pusher.subscribe('my-channel', { delta: { enabled: false } });
   */
  subscribe(
    channel_name: string,
    options?:
      | any
      | {
          filter?: any;
          delta?: { enabled?: boolean; algorithm?: "fossil" | "xdelta3" };
        },
  ) {
    const channel = this.channels.add(channel_name, this);

    // Handle different option formats for backward compatibility
    if (options) {
      if (
        typeof options === "object" &&
        ("filter" in options || "delta" in options)
      ) {
        // New object format: { filter?: FilterNode, delta?: ChannelDeltaSettings }
        if (options.filter) {
          channel.tagsFilter = options.filter;
        }
        if (options.delta) {
          channel.setDeltaSettings(options.delta);
        }
      } else {
        // Legacy format: FilterNode directly (backward compatible)
        channel.tagsFilter = options;
      }
    }

    if (channel.subscriptionPending && channel.subscriptionCancelled) {
      channel.reinstateSubscription();
    } else if (
      !channel.subscriptionPending &&
      this.connection.state === "connected"
    ) {
      channel.subscribe();
    }
    return channel;
  }

  unsubscribe(channel_name: string) {
    let channel = this.channels.find(channel_name);
    if (channel && channel.subscriptionPending) {
      channel.cancelSubscription();
    } else {
      channel = this.channels.remove(channel_name);
      if (channel && channel.subscribed) {
        channel.unsubscribe();
      }
    }

    // Clear delta compression state for this channel to prevent stale base messages
    // on resubscribe. The server also clears its state, so both sides start fresh.
    if (this.deltaCompression) {
      this.deltaCompression.clearChannelState(channel_name);
    }
  }

  send_event(event_name: string, data: any, channel?: string) {
    return this.connection.send_event(event_name, data, channel);
  }

  shouldUseTLS(): boolean {
    return this.config.useTLS;
  }

  signin() {
    this.user.signin();
  }

  /**
   * Get delta compression statistics
   * @returns {DeltaStats} Statistics about delta compression bandwidth savings
   */
  getDeltaStats(): DeltaStats | null {
    if (!this.deltaCompression) {
      return null;
    }
    return this.deltaCompression.getStats();
  }

  /**
   * Reset delta compression statistics
   */
  resetDeltaStats(): void {
    if (this.deltaCompression) {
      this.deltaCompression.resetStats();
    }
  }
}

function checkAppKey(key) {
  if (key === null || key === undefined) {
    throw "You must pass your app key when you instantiate Pusher.";
  }
}

Runtime.setup(Pusher);
