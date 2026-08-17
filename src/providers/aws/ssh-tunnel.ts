import { Client, type ClientChannel } from "ssh2";

export interface SshTunnel {
  localPort: number;
  close: () => Promise<void>;
}

const CONNECT_TIMEOUT_MS = 15_000;

interface TunnelSocketData {
  channel?: ClientChannel;
  buffered: Buffer[];
}

/**
 * Opens an SSH port-forward tunnel to `remoteHost:remotePort`, reached
 * through `host` (a bastion already inside the target VPC). Returns a local
 * loopback port that relays raw bytes to/from the remote host — each local
 * TCP client gets its own SSH channel via `forwardOut`, so (unlike the old
 * SSM-based tunnel) multiple simultaneous connections are fine.
 *
 * The local listener uses Bun's native `Bun.listen()` rather than
 * `node:net`'s `createServer` — a client (e.g. Bun's own `SQL`) connecting
 * loopback to a `node:net`-compat server in the same process silently never
 * exchanges a byte with it, hanging until the client's own timeout gives up.
 * Native `Bun.listen()` on both ends of the loopback hop doesn't have that
 * problem.
 *
 * No host-key verification is performed (ssh2 accepts whatever key the
 * bastion presents unless a `hostVerifier` is supplied) — the channel is
 * still encrypted, what's skipped is confirming which host is on the other
 * end, mirroring the same tradeoff already made for the RDS TLS hop in
 * `api.ts`.
 */
export async function openSshPortForwardTunnel(options: {
  host: string;
  port?: number;
  username: string;
  privateKey: string;
  passphrase?: string;
  remoteHost: string;
  remotePort: number;
}): Promise<SshTunnel> {
  const client = new Client();

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error(`Timed out connecting over SSH to "${options.host}".`));
    }, CONNECT_TIMEOUT_MS);

    client.once("ready", () => {
      clearTimeout(timer);
      resolve();
    });
    client.once("error", (err) => {
      clearTimeout(timer);
      reject(
        new Error(`SSH connection to "${options.host}" failed: ${err.message}`),
      );
    });

    client.connect({
      host: options.host,
      port: options.port ?? 22,
      username: options.username,
      privateKey: options.privateKey,
      passphrase: options.passphrase,
      readyTimeout: CONNECT_TIMEOUT_MS,
    });
  });

  const server = Bun.listen<TunnelSocketData>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { buffered: [] };
        client.forwardOut(
          "127.0.0.1",
          0,
          options.remoteHost,
          options.remotePort,
          (err, channel) => {
            if (err) {
              socket.end();
              return;
            }
            socket.data.channel = channel;
            for (const chunk of socket.data.buffered) channel.write(chunk);
            socket.data.buffered = [];

            channel.on("data", (chunk: Buffer) => {
              socket.write(chunk);
            });
            channel.once("close", () => socket.end());
            channel.once("error", () => socket.end());
          },
        );
      },
      data(socket, data) {
        const { channel } = socket.data;
        if (channel) {
          channel.write(data);
        } else {
          socket.data.buffered.push(Buffer.from(data));
        }
      },
      close(socket) {
        socket.data.channel?.close();
      },
      error(socket) {
        socket.data.channel?.close();
      },
    },
  });

  return {
    localPort: server.port,
    close: async () => {
      server.stop(true);
      client.end();
    },
  };
}
