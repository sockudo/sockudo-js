export interface MessageExtras {
  headers?: Record<string, string | number | boolean>;
  ephemeral?: boolean;
  idempotency_key?: string;
  echo?: boolean;
}

interface SockudoEvent {
  event: string;
  channel?: string;
  data?: any;
  user_id?: string;
  extras?: MessageExtras;
  rawMessage?: string; // Raw WebSocket message for delta compression
  sequence?: number; // Delta compression sequence number
  conflation_key?: string; // Delta compression conflation key
}

export { SockudoEvent };
