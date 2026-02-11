import { default as EventsDispatcher } from "../events/dispatcher";
import * as Errors from "../errors";
import Logger from "../logger";
import Pusher from "../pusher";
import { PusherEvent } from "../connection/protocol/message-types";
import Metadata from "./metadata";
import UrlStore from "../utils/url_store";
import {
  ChannelAuthorizationData,
  ChannelAuthorizationCallback,
} from "../auth/options";
import { HTTPAuthError } from "../errors";
import { FilterNode } from "./filter";
import { DeltaAlgorithm } from "../delta/types";

/**
 * Per-subscription delta compression settings
 * Allows clients to negotiate delta compression on a per-channel basis
 */
export interface ChannelDeltaSettings {
  /**
   * Enable/disable delta compression for this channel subscription
   * - true: Enable delta compression
   * - false: Disable delta compression
   * - undefined: Use server default (global pusher:enable_delta_compression)
   */
  enabled?: boolean;
  /**
   * Preferred algorithm for this subscription
   * - 'fossil': Use Fossil delta algorithm
   * - 'xdelta3': Use Xdelta3/VCDIFF algorithm
   * - undefined: Use server default algorithm
   */
  algorithm?: DeltaAlgorithm;
}

/**
 * Serialize delta settings for the subscription message
 * Supports multiple formats for server compatibility:
 * - Simple string: "fossil", "xdelta3", "disabled"
 * - Boolean: true/false
 * - Object: { enabled: boolean, algorithm: string }
 */
function serializeDeltaSettings(
  settings: ChannelDeltaSettings,
): string | boolean | { enabled?: boolean; algorithm?: string } {
  // If only algorithm is specified, use simple string format
  if (settings.enabled === undefined && settings.algorithm) {
    return settings.algorithm;
  }
  // If only enabled is specified as false, use "disabled" string
  if (settings.enabled === false && settings.algorithm === undefined) {
    return false;
  }
  // If only enabled is specified as true, use boolean
  if (settings.enabled === true && settings.algorithm === undefined) {
    return true;
  }
  // Otherwise use full object format
  return {
    enabled: settings.enabled,
    algorithm: settings.algorithm,
  };
}

/** Provides base public channel interface with an event emitter.
 *
 * Emits:
 * - pusher:subscription_succeeded - after subscribing successfully
 * - other non-internal events
 *
 * @param {String} name
 * @param {Pusher} pusher
 */
export default class Channel extends EventsDispatcher {
  name: string;
  pusher: Pusher;
  subscribed: boolean;
  subscriptionPending: boolean;
  subscriptionCancelled: boolean;
  subscriptionCount: null;
  tagsFilter: FilterNode | null;
  /**
   * Per-subscription delta compression settings
   * Set via subscribe() options or setDeltaSettings()
   */
  deltaSettings: ChannelDeltaSettings | null;

  constructor(name: string, pusher: Pusher) {
    super(function (event, _data) {
      Logger.debug("No callbacks on " + name + " for " + event);
    });

    this.name = name;
    this.pusher = pusher;
    this.subscribed = false;
    this.subscriptionPending = false;
    this.subscriptionCancelled = false;
    this.tagsFilter = null;
    this.deltaSettings = null;
  }

  /**
   * Set per-subscription delta compression settings
   *
   * Call this before subscribing to negotiate delta compression for this channel.
   * Alternatively, pass delta settings to the subscribe() method.
   *
   * @param settings Delta compression settings for this channel
   *
   * @example
   * // Enable delta compression with Fossil algorithm
   * channel.setDeltaSettings({ enabled: true, algorithm: 'fossil' });
   *
   * @example
   * // Disable delta compression for this channel
   * channel.setDeltaSettings({ enabled: false });
   *
   * @example
   * // Use server default but prefer xdelta3
   * channel.setDeltaSettings({ algorithm: 'xdelta3' });
   */
  setDeltaSettings(settings: ChannelDeltaSettings | null): void {
    this.deltaSettings = settings;
    Logger.debug(
      `Delta settings for channel ${this.name}: ${JSON.stringify(settings)}`,
    );
  }

  /**
   * Get current delta compression settings for this channel
   */
  getDeltaSettings(): ChannelDeltaSettings | null {
    return this.deltaSettings;
  }

  /** Skips authorization, since public channels don't require it.
   *
   * @param {(...args: any[]) => any} callback
   */
  authorize(socketId: string, callback: ChannelAuthorizationCallback) {
    return callback(null, { auth: "" });
  }

  /** Triggers an event */
  trigger(event: string, data: any) {
    if (event.indexOf("client-") !== 0) {
      throw new Errors.BadEventName(
        "Event '" + event + "' does not start with 'client-'",
      );
    }
    if (!this.subscribed) {
      const suffix = UrlStore.buildLogSuffix("triggeringClientEvents");
      Logger.warn(
        `Client event triggered before channel 'subscription_succeeded' event . ${suffix}`,
      );
    }
    return this.pusher.send_event(event, data, this.name);
  }

  /** Signals disconnection to the channel. For internal use only. */
  disconnect() {
    this.subscribed = false;
    this.subscriptionPending = false;
  }

  /** Handles a PusherEvent. For internal use only.
   *
   * @param {PusherEvent} event
   */
  handleEvent(event: PusherEvent) {
    const eventName = event.event;
    const data = event.data;
    if (eventName === "pusher_internal:subscription_succeeded") {
      this.handleSubscriptionSucceededEvent(event);
    } else if (eventName === "pusher_internal:subscription_count") {
      this.handleSubscriptionCountEvent(event);
    } else if (eventName.indexOf("pusher_internal:") !== 0) {
      const metadata: Metadata = {};
      this.emit(eventName, data, metadata);
    }
  }

  handleSubscriptionSucceededEvent(event: PusherEvent) {
    this.subscriptionPending = false;
    this.subscribed = true;
    if (this.subscriptionCancelled) {
      this.pusher.unsubscribe(this.name);
    } else {
      this.emit("pusher:subscription_succeeded", event.data);
    }
  }

  handleSubscriptionCountEvent(event: PusherEvent) {
    if (event.data.subscription_count) {
      this.subscriptionCount = event.data.subscription_count;
    }

    this.emit("pusher:subscription_count", event.data);
  }

  /** Sends a subscription request. For internal use only. */
  subscribe() {
    if (this.subscribed) {
      return;
    }
    this.subscriptionPending = true;
    this.subscriptionCancelled = false;
    this.authorize(
      this.pusher.connection.socket_id,
      (error: Error | null, data: ChannelAuthorizationData) => {
        if (error) {
          this.subscriptionPending = false;
          // Why not bind to 'pusher:subscription_error' a level up, and log there?
          // Binding to this event would cause the warning about no callbacks being
          // bound (see constructor) to be suppressed, that's not what we want.
          Logger.error(error.toString());
          this.emit(
            "pusher:subscription_error",
            Object.assign(
              {},
              {
                type: "AuthError",
                error: error.message,
              },
              error instanceof HTTPAuthError ? { status: error.status } : {},
            ),
          );
        } else {
          const subscribeData: any = {
            auth: data.auth,
            channel_data: data.channel_data,
            channel: this.name,
          };

          // Add tags filter if present
          if (this.tagsFilter) {
            subscribeData.tags_filter = this.tagsFilter;
          }

          // Add per-subscription delta settings if present
          // This enables per-channel delta negotiation
          if (this.deltaSettings) {
            subscribeData.delta = serializeDeltaSettings(this.deltaSettings);
            Logger.debug(
              `Subscribing to ${this.name} with delta settings: ${JSON.stringify(subscribeData.delta)}`,
            );
          }

          this.pusher.send_event("pusher:subscribe", subscribeData);
        }
      },
    );
  }

  /** Sends an unsubscription request. For internal use only. */
  unsubscribe() {
    this.subscribed = false;
    this.pusher.send_event("pusher:unsubscribe", {
      channel: this.name,
    });
  }

  /** Cancels an in progress subscription. For internal use only. */
  cancelSubscription() {
    this.subscriptionCancelled = true;
  }

  /** Reinstates an in progress subscripiton. For internal use only. */
  reinstateSubscription() {
    this.subscriptionCancelled = false;
  }
}
