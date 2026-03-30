export interface MessageExtras {
    headers?: Record<string, string | number | boolean>;
    ephemeral?: boolean;
    idempotency_key?: string;
    echo?: boolean;
}
interface PusherEvent {
    event: string;
    channel?: string;
    data?: any;
    user_id?: string;
    extras?: MessageExtras;
    rawMessage?: string;
    sequence?: number;
    conflation_key?: string;
}
export { PusherEvent };
