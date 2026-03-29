import PrivateChannel from "./private_channel";
import Logger from "../logger";
import Members from "./members";
import Sockudo from "../sockudo";
import UrlStore from "core/utils/url_store";
import { SockudoEvent } from "../connection/protocol/message-types";
import Metadata from "./metadata";
import { ChannelAuthorizationData } from "../auth/options";
import {
  prefixedEvent,
  prefixedInternal,
  isInternalEvent,
} from "../protocol_prefix";

export default class PresenceChannel extends PrivateChannel {
  members: Members;

  /** Adds presence channel functionality to private channels.
   *
   * @param {String} name
   * @param {Sockudo} sockudo
   */
  constructor(name: string, sockudo: Sockudo) {
    super(name, sockudo);
    this.members = new Members();
  }

  /** Authorizes the connection as a member of the channel.
   *
   * @param  {String} socketId
   * @param  {(...args: any[]) => any} callback
   */
  authorize(socketId: string, callback: (...args: any[]) => any) {
    super.authorize(socketId, async (error, authData) => {
      if (!error) {
        authData = authData as ChannelAuthorizationData;
        if (authData.channel_data != null) {
          const channelData = JSON.parse(authData.channel_data);
          this.members.setMyID(channelData.user_id);
        } else {
          await this.sockudo.user.signinDonePromise;
          if (this.sockudo.user.user_data != null) {
            // If the user is signed in, get the id of the authenticated user
            // and allow the presence authorization to continue.
            this.members.setMyID(this.sockudo.user.user_data.id);
          } else {
            let suffix = UrlStore.buildLogSuffix("authorizationEndpoint");
            Logger.error(
              `Invalid auth response for channel '${this.name}', ` +
                `expected 'channel_data' field. ${suffix}, ` +
                `or the user should be signed in.`,
            );
            callback("Invalid auth response");
            return;
          }
        }
      }
      callback(error, authData);
    });
  }

  /** Handles presence and subscription events. For internal use only.
   *
   * @param {SockudoEvent} event
   */
  handleEvent(event: SockudoEvent) {
    const eventName = event.event;
    if (isInternalEvent(eventName)) {
      this.handleInternalEvent(event);
    } else {
      const data = event.data;
      const metadata: Metadata = {};
      if (event.user_id) {
        metadata.user_id = event.user_id;
      }
      this.emit(eventName, data, metadata);
    }
  }
  handleInternalEvent(event: SockudoEvent) {
    const eventName = event.event;
    const data = event.data;
    switch (eventName) {
      case prefixedInternal("subscription_succeeded"):
        this.handleSubscriptionSucceededEvent(event);
        break;
      case prefixedInternal("subscription_count"):
        this.handleSubscriptionCountEvent(event);
        break;
      case prefixedInternal("member_added"):
        const addedMember = this.members.addMember(data);
        this.emit(prefixedEvent("member_added"), addedMember);
        break;
      case prefixedInternal("member_removed"):
        const removedMember = this.members.removeMember(data);
        if (removedMember) {
          this.emit(prefixedEvent("member_removed"), removedMember);
        }
        break;
    }
  }

  handleSubscriptionSucceededEvent(event: SockudoEvent) {
    this.subscriptionPending = false;
    this.subscribed = true;
    if (this.subscriptionCancelled) {
      this.sockudo.unsubscribe(this.name);
    } else {
      this.members.onSubscription(event.data);
      this.emit(prefixedEvent("subscription_succeeded"), this.members);
    }
  }

  /** Resets the channel state, including members map. For internal use only. */
  disconnect() {
    this.members.reset();
    super.disconnect();
  }
}
