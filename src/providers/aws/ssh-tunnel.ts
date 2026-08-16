import { Client } from "ssh2";
import { createServer, type Socket } from "node:net";

export interface SshTunnel {
  localPort: number;
  close: () => Promise<void>;
}

const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Opens an SSH port-forward tunnel to `remoteHost:remotePort`, reached
 * through `host` (a bastion already inside the target VPC). Returns a local
 * loopback port that relays raw bytes to/from the remote host — each local
 * TCP client gets its own SSH channel via `forwardOut`, so (unlike the old
 * SSM-based tunnel) multiple simultaneous connections are fine.
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

  let localSocket: Socket | undefined;
  const server = createServer((socket) => {
    localSocket = socket;
    client.forwardOut(
      "127.0.0.1",
      0,
      options.remoteHost,
      options.remotePort,
      (err, channel) => {
        if (err) {
          socket.destroy(err);
          return;
        }
        socket.pipe(channel).pipe(socket);
        channel.once("close", () => socket.destroy());
        socket.once("close", () => channel.close());
      },
    );
  });

  const localPort = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        reject(new Error("Could not allocate a local port."));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    localPort,
    close: async () => {
      server.close();
      localSocket?.destroy();
      client.end();
    },
  };
}
