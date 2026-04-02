import { beforeAll, describe, expect, it } from "vitest";
import { createHash, createHmac, randomUUID } from "node:crypto";

let Sockudo: typeof import("../src/index").default;

const liveTestsEnabled = () => process.env.SOCKUDO_LIVE_TESTS === "1";

const liveWireFormat = (): "json" | "messagepack" | "protobuf" => {
  switch (process.env.SOCKUDO_WIRE_FORMAT?.toLowerCase()) {
    case "messagepack":
    case "msgpack":
      return "messagepack";
    case "protobuf":
    case "proto":
      return "protobuf";
    default:
      return "json";
  }
};

const waitForValue = async <T>(
  supplier: () => T | undefined,
  timeoutMs = 8000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = supplier();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for value");
};

const publishToLocalSockudo = async ({
  channel,
  eventName,
  payload,
  idempotencyKey,
}: {
  channel: string;
  eventName: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
}): Promise<void> => {
  const path = "/apps/app-id/events";
  const body = JSON.stringify({
    name: eventName,
    channels: [channel],
    data: JSON.stringify(payload),
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
  });
  const bodyMd5 = createHash("md5").update(body).digest("hex");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const params = new URLSearchParams({
    auth_key: "app-key",
    auth_timestamp: timestamp,
    auth_version: "1.0",
    body_md5: bodyMd5,
  });
  const canonicalQuery = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const authSignature = createHmac("sha256", "app-secret")
    .update(`POST\n${path}\n${canonicalQuery}`)
    .digest("hex");
  const response = await fetch(
    `http://127.0.0.1:6001${path}?${canonicalQuery}&auth_signature=${authSignature}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    },
  );

  expect([200, 202]).toContain(response.status);
};

const createLiveClient = (overrides: Record<string, unknown> = {}) =>
  new Sockudo("app-key", {
    cluster: "local",
    forceTLS: false,
    protocolVersion: 2,
    enabledTransports: ["ws"],
    wsHost: "127.0.0.1",
    wsPort: 6001,
    wssPort: 6001,
    wireFormat: liveWireFormat(),
    ...overrides,
  });

const connectAndWaitForSubscription = async (
  client: InstanceType<typeof Sockudo>,
  channelName: string,
) => {
  let connected = false;
  let subscribed = false;
  const stateChanges: Array<Record<string, unknown>> = [];
  const connectionErrors: Array<Record<string, unknown>> = [];
  const subscriptionErrors: Array<Record<string, unknown>> = [];

  const channel = client.subscribe(channelName);
  client.connection.bind("state_change", (state) => {
    stateChanges.push(state as Record<string, unknown>);
  });
  client.connection.bind("error", (error) => {
    connectionErrors.push(error as Record<string, unknown>);
  });
  client.connection.bind("connected", () => {
    connected = true;
  });
  channel.bind("sockudo:subscription_succeeded", () => {
    subscribed = true;
  });
  channel.bind("sockudo:subscription_error", (error) => {
    subscriptionErrors.push(error as Record<string, unknown>);
  });

  client.connect();
  try {
    await waitForValue(() => (connected || subscribed ? true : undefined));
    await waitForValue(() => (subscribed ? true : undefined));
  } catch (error) {
    client.disconnect();
    throw new Error(
      `${(error as Error).message}; channel=${channelName}; states=${JSON.stringify(stateChanges)}; connectionErrors=${JSON.stringify(connectionErrors)}; subscriptionErrors=${JSON.stringify(subscriptionErrors)}`,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 100));

  return channel;
};

beforeAll(async () => {
  Object.assign(globalThis, {
    VERSION: "test-version",
    CDN_HTTP: "",
    CDN_HTTPS: "",
    DEPENDENCY_SUFFIX: "",
  });

  ({ default: Sockudo } = await import("../src/index"));
});

describe("live wire format integration", () => {
  it("connects with the selected wire format and receives a published event", async () => {
    if (!liveTestsEnabled()) {
      return;
    }

    let connected = false;
    let subscribed = false;
    let received: Record<string, unknown> | undefined;
    const stateChanges: Array<Record<string, unknown>> = [];
    const errors: Array<Record<string, unknown>> = [];

    const client = createLiveClient();

    const channel = client.subscribe("public-updates");
    client.connection.bind("state_change", (state) => {
      stateChanges.push(state as Record<string, unknown>);
    });
    client.connection.bind("connected", () => {
      connected = true;
    });
    client.connection.bind("error", (error) => {
      errors.push(error as Record<string, unknown>);
    });
    channel.bind("sockudo:subscription_succeeded", () => {
      subscribed = true;
    });
    channel.bind("integration-event", (data) => {
      received = data as Record<string, unknown>;
    });

    client.connect();

    try {
      await waitForValue(() => (connected || subscribed ? true : undefined));
      await waitForValue(() => (subscribed ? true : undefined));
    } catch (error) {
      client.disconnect();
      throw new Error(
        `${(error as Error).message}; states=${JSON.stringify(stateChanges)}; errors=${JSON.stringify(errors)}`,
      );
    }

    await publishToLocalSockudo({
      channel: "public-updates",
      eventName: "integration-event",
      payload: {
        message: "hello from js",
        item_id: "js-client",
        padding: "x".repeat(140),
      },
    });

    const payload = await waitForValue(() => received);
    expect(payload.message).toBe("hello from js");
    client.disconnect();
  }, 15000);

  it("delivers wildcard subscriptions only for matching channels", async () => {
    if (!liveTestsEnabled()) {
      return;
    }

    const id = randomUUID();
    const matchingChannel = `wildcard-${id}-match`;
    const nonMatchingChannel = `other-${id}-miss`;
    const client = createLiveClient();
    const receivedMarkers: string[] = [];

    await connectAndWaitForSubscription(client, `wildcard-${id}-*`);
    client.bind("wildcard-event", (data) => {
      const marker = (data as Record<string, unknown>)?.marker;
      if (typeof marker === "string") {
        receivedMarkers.push(marker);
      }
    });

    await publishToLocalSockudo({
      channel: matchingChannel,
      eventName: "wildcard-event",
      payload: { marker: "match" },
    });
    await publishToLocalSockudo({
      channel: nonMatchingChannel,
      eventName: "wildcard-event",
      payload: { marker: "miss" },
    });

    await waitForValue(() =>
      receivedMarkers.includes("match") ? true : undefined,
    );
    expect(receivedMarkers).toContain("match");
    expect(receivedMarkers).not.toContain("miss");
    client.disconnect();
  }, 15000);

  it("emits metachannel lifecycle events", async () => {
    if (!liveTestsEnabled()) {
      return;
    }

    const id = randomUUID();
    const baseChannel = `meta-room-${id}`;
    const metaClient = createLiveClient();
    const memberClient = createLiveClient();
    const metaEvents: Array<{
      event: string;
      data: Record<string, unknown> | undefined;
    }> = [];

    await connectAndWaitForSubscription(metaClient, `[meta]${baseChannel}`);
    metaClient.connection.bind("message", (event) => {
      const message = event as Record<string, unknown>;
      if (
        message.channel === `[meta]${baseChannel}` &&
        typeof message.event === "string"
      ) {
        metaEvents.push({
          event: message.event as string,
          data: message.data as Record<string, unknown> | undefined,
        });
      }
    });

    await connectAndWaitForSubscription(memberClient, baseChannel);

    const occupied = await waitForValue(() =>
      metaEvents.find(
        (entry) => entry.event === "sockudo_internal:channel_occupied",
      ),
    );
    expect(occupied.data?.channel).toBe(baseChannel);

    const countUpdate = await waitForValue(() =>
      metaEvents.find(
        (entry) =>
          entry.event === "sockudo_internal:subscription_count" &&
          entry.data?.channel === baseChannel &&
          typeof entry.data.subscription_count === "number" &&
          Number(entry.data.subscription_count) >= 1,
      ),
    );
    expect(Number(countUpdate.data?.subscription_count)).toBeGreaterThanOrEqual(
      1,
    );

    memberClient.disconnect();
    metaClient.disconnect();
  }, 15000);

  it("deduplicates HTTP publishes with the same idempotency key", async () => {
    if (!liveTestsEnabled()) {
      return;
    }

    const id = randomUUID();
    const channelName = `idempotency-${id}`;
    const idempotencyKey = `live-${id}`;
    const client = createLiveClient();
    const received: Array<Record<string, unknown>> = [];

    const channel = await connectAndWaitForSubscription(client, channelName);
    channel.bind("idempotent-event", (data) => {
      received.push(data as Record<string, unknown>);
    });

    const payload = { marker: id, count: 1 };
    await publishToLocalSockudo({
      channel: channelName,
      eventName: "idempotent-event",
      payload,
      idempotencyKey,
    });
    await publishToLocalSockudo({
      channel: channelName,
      eventName: "idempotent-event",
      payload,
      idempotencyKey,
    });

    await waitForValue(() => (received.length >= 1 ? true : undefined));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(received).toHaveLength(1);
    expect(received[0].marker).toBe(id);
    client.disconnect();
  }, 15000);
});
