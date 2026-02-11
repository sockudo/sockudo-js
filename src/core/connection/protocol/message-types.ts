interface PusherEvent {
  event: string;
  channel?: string;
  data?: any;
  user_id?: string;
  rawMessage?: string; // Raw WebSocket message for delta compression
  sequence?: number; // Delta compression sequence number
  conflation_key?: string; // Delta compression conflation key
}

export { PusherEvent };
