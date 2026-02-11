interface PusherEvent {
    event: string;
    channel?: string;
    data?: any;
    user_id?: string;
    rawMessage?: string;
    sequence?: number;
    conflation_key?: string;
}
export { PusherEvent };
