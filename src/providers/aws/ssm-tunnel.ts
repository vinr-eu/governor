import {
  StartSessionCommand,
  TerminateSessionCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { createServer, type Socket } from "node:net";
import type { AccessKeyCredential } from "../credentials";

// Native reimplementation of the SSM Session Manager port-forwarding data
// channel — the binary "AgentMessage" framing that `session-manager-plugin`
// speaks over the WebSocket StartSession returns. Governor needs to *be*
// the tool an agent calls, not a wrapper that requires the `aws` CLI and a
// separately-installed `session-manager-plugin` binary on the host, so this
// talks the protocol directly instead of shelling out. Reverse-engineered
// from https://github.com/aws/session-manager-plugin (Apache-2.0):
// src/message/clientmessage.go (wire layout), src/message/messageparser.go
// (serialize/deserialize), src/sessionmanagerplugin/session/portsession/
// basicportforwarding.go (the single-connection relay we mirror here — we
// only ever need one local TCP client per query, so there's no need for the
// TCP-multiplexed variant newer agents also support).

const HEADER_LENGTH = 116; // byte offset of the PayloadLength field
const PAYLOAD_OFFSET = HEADER_LENGTH + 4;

const MessageType = {
  Input: "input_stream_data",
  Output: "output_stream_data",
  Acknowledge: "acknowledge",
  ChannelClosed: "channel_closed",
} as const;

const PayloadType = {
  Output: 1,
  HandshakeRequest: 5,
  HandshakeResponse: 6,
  HandshakeComplete: 7,
} as const;

interface AgentMessage {
  messageType: string;
  sequenceNumber: bigint;
  messageId: string;
  payloadType: number;
  payload: Uint8Array;
  payloadDigestValid: boolean;
}

// The wire format packs the UUID's two 8-byte halves in swapped order
// relative to standard UUID byte layout (see putUuid/getUuid in
// messageparser.go) — not a typo, just how the Go implementation does it.
function uuidToWireBytes(uuidStr: string): Uint8Array {
  const hex = uuidStr.replace(/-/g, "");
  const std = new Uint8Array(16);
  for (let i = 0; i < 16; i++) std[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const wire = new Uint8Array(16);
  wire.set(std.subarray(8, 16), 0);
  wire.set(std.subarray(0, 8), 8);
  return wire;
}

function wireBytesToUuid(bytes: Uint8Array): string {
  const std = new Uint8Array(16);
  std.set(bytes.subarray(8, 16), 0);
  std.set(bytes.subarray(0, 8), 8);
  const hex = [...std].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(new Bun.CryptoHasher("sha256").update(data).digest());
}

function digestsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return a.every((byte, i) => byte === b[i]);
}

function serializeAgentMessage(msg: {
  messageType: string;
  sequenceNumber: bigint;
  flags: bigint;
  messageId: string;
  payloadType: number;
  payload: Uint8Array;
}): Uint8Array {
  const buf = new Uint8Array(PAYLOAD_OFFSET + msg.payload.length);
  const view = new DataView(buf.buffer);

  view.setUint32(0, HEADER_LENGTH);
  buf.set(new TextEncoder().encode(msg.messageType.padEnd(32, " ")).subarray(0, 32), 4);
  view.setUint32(36, 1); // schema version
  view.setBigUint64(40, BigInt(Date.now()));
  view.setBigInt64(48, msg.sequenceNumber);
  view.setBigUint64(56, msg.flags);
  buf.set(uuidToWireBytes(msg.messageId), 64);
  buf.set(sha256(msg.payload), 80);
  view.setUint32(112, msg.payloadType);
  view.setUint32(116, msg.payload.length);
  buf.set(msg.payload, PAYLOAD_OFFSET);

  return buf;
}

function deserializeAgentMessage(input: Uint8Array): AgentMessage {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const headerLength = view.getUint32(0);
  const messageType = new TextDecoder()
    .decode(input.subarray(4, 36))
    .replace(/\0/g, "")
    .trim();
  const sequenceNumber = view.getBigInt64(48);
  const messageId = wireBytesToUuid(input.subarray(64, 80));
  const payloadDigest = input.subarray(80, 112);
  const payloadType = view.getUint32(112);
  const payload = input.subarray(headerLength + 4);

  return {
    messageType,
    sequenceNumber,
    messageId,
    payloadType,
    payload,
    payloadDigestValid: digestsEqual(sha256(payload), payloadDigest),
  };
}

export interface SsmTunnel {
  localPort: number;
  close: () => Promise<void>;
}

const TUNNEL_READY_TIMEOUT_MS = 20_000;

/**
 * Opens an SSM Session Manager port-forwarding tunnel through `instanceId`
 * to `remoteHost:remotePort`, entirely over the AWS SDK and a native
 * WebSocket — no `aws` CLI or `session-manager-plugin` binary required.
 * Returns a local loopback port that relays raw bytes to/from the remote
 * host for exactly one local TCP client (mirrors the plugin's "Basic"
 * single-connection port forwarding, which is all a single DB query needs).
 */
export async function openSsmPortForwardTunnel(
  credential: AccessKeyCredential,
  options: { instanceId: string; remoteHost: string; remotePort: number; region: string },
): Promise<SsmTunnel> {
  const ssm = new SSMClient({ region: options.region, credentials: credential });
  const session = await ssm.send(
    new StartSessionCommand({
      Target: options.instanceId,
      DocumentName: "AWS-StartPortForwardingSessionToRemoteHost",
      Parameters: {
        host: [options.remoteHost],
        portNumber: [String(options.remotePort)],
      },
    }),
  );
  const { SessionId: sessionId, StreamUrl: streamUrl, TokenValue: tokenValue } = session;
  if (!sessionId || !streamUrl || !tokenValue) {
    throw new Error("SSM StartSession did not return a stream URL/session token.");
  }

  let expectedSequenceNumber = 0n;
  let outgoingSequenceNumber = 0n;
  const incomingBuffer = new Map<bigint, AgentMessage>();
  let localSocket: Socket | undefined;
  let fatalError: Error | undefined;
  const onFatal = (err: Error) => {
    fatalError = fatalError ?? err;
    localSocket?.destroy(err);
  };

  const ws = new WebSocket(streamUrl);

  function sendInputData(payloadType: number, payload: Uint8Array) {
    const frame = serializeAgentMessage({
      messageType: MessageType.Input,
      sequenceNumber: outgoingSequenceNumber,
      flags: 0n,
      messageId: crypto.randomUUID(),
      payloadType,
      payload,
    });
    outgoingSequenceNumber += 1n;
    ws.send(frame);
  }

  function sendAcknowledge(msg: AgentMessage) {
    const content = {
      AcknowledgedMessageType: msg.messageType,
      AcknowledgedMessageId: msg.messageId,
      AcknowledgedMessageSequenceNumber: Number(msg.sequenceNumber),
      IsSequentialMessage: true,
    };
    const frame = serializeAgentMessage({
      messageType: MessageType.Acknowledge,
      sequenceNumber: 0n,
      flags: 3n,
      messageId: crypto.randomUUID(),
      payloadType: 0,
      payload: new TextEncoder().encode(JSON.stringify(content)),
    });
    ws.send(frame);
  }

  function handleHandshakeRequest(msg: AgentMessage) {
    const request = JSON.parse(new TextDecoder().decode(msg.payload)) as {
      RequestedClientActions?: { ActionType: string }[];
    };
    const processedClientActions = (request.RequestedClientActions ?? []).map((action) => ({
      ActionType: action.ActionType,
      ActionStatus: 1, // Success — we don't need KMS encryption or mux, just ack every requested action.
      ActionResult: {},
      Error: "",
    }));
    const response = {
      ClientVersion: "1.2.500.0",
      ProcessedClientActions: processedClientActions,
      Errors: [],
    };
    sendInputData(
      PayloadType.HandshakeResponse,
      new TextEncoder().encode(JSON.stringify(response)),
    );
  }

  function handleInOrderMessage(msg: AgentMessage) {
    switch (msg.payloadType) {
      case PayloadType.HandshakeRequest:
        sendAcknowledge(msg);
        handleHandshakeRequest(msg);
        break;
      case PayloadType.HandshakeComplete:
        sendAcknowledge(msg);
        break;
      default:
        if (msg.payload.length > 0) localSocket?.write(Buffer.from(msg.payload));
        sendAcknowledge(msg);
        break;
    }
    expectedSequenceNumber += 1n;
  }

  function onOutputStreamMessage(msg: AgentMessage) {
    if (!msg.payloadDigestValid) {
      onFatal(new Error("SSM tunnel received a message with an invalid payload digest."));
      return;
    }
    if (msg.sequenceNumber === expectedSequenceNumber) {
      handleInOrderMessage(msg);
      while (incomingBuffer.has(expectedSequenceNumber)) {
        const buffered = incomingBuffer.get(expectedSequenceNumber) as AgentMessage;
        incomingBuffer.delete(expectedSequenceNumber);
        handleInOrderMessage(buffered);
      }
    } else if (msg.sequenceNumber > expectedSequenceNumber) {
      sendAcknowledge(msg);
      incomingBuffer.set(msg.sequenceNumber, msg);
    }
  }

  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") return;
    const msg = deserializeAgentMessage(new Uint8Array(event.data as ArrayBuffer));
    if (msg.messageType === MessageType.Output) onOutputStreamMessage(msg);
    else if (msg.messageType === MessageType.ChannelClosed) {
      onFatal(new Error("SSM session was closed by the agent."));
    }
  });
  ws.addEventListener("error", () => onFatal(new Error("SSM WebSocket connection failed.")));
  ws.addEventListener("close", () =>
    onFatal(new Error("SSM WebSocket connection closed unexpectedly.")),
  );

  const server = createServer((socket) => {
    localSocket = socket;
    socket.on("data", (chunk: Buffer) => sendInputData(PayloadType.Output, new Uint8Array(chunk)));
    socket.on("error", () => {});
  });

  const ready = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for the SSM tunnel to "${options.instanceId}" to come up.`)),
      TUNNEL_READY_TIMEOUT_MS,
    );

    server.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        clearTimeout(timer);
        reject(new Error("Could not allocate a local port."));
        return;
      }
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          ws.send(
            JSON.stringify({
              MessageSchemaVersion: "1.0",
              RequestId: crypto.randomUUID(),
              TokenValue: tokenValue,
              ClientId: crypto.randomUUID(),
              ClientVersion: "1.2.500.0",
            }),
          );
          resolve(address.port);
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("SSM WebSocket connection failed."));
        },
        { once: true },
      );
    });
  });

  let localPort: number;
  try {
    localPort = await ready;
  } catch (err) {
    server.close();
    ws.close();
    throw err;
  }

  return {
    localPort,
    close: async () => {
      server.close();
      localSocket?.destroy();
      ws.close();
      try {
        await ssm.send(new TerminateSessionCommand({ SessionId: sessionId }));
      } catch {
        // best-effort — the session also expires on its own once the socket closes.
      }
    },
  };
}
