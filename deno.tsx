interface DenoConn {
  readonly readable: ReadableStream<Uint8Array>;
  write(p: Uint8Array): Promise<number>;
  close(): void;
}

declare const Deno: {
  serve(
    options: { port: number },
    handler: (req: Request) => Response | Promise<Response>
  ): { shutdown: () => Promise<void> };
  upgradeWebSocket(req: Request): {
    socket: WebSocket;
    response: Response;
  };
  connect(options: { hostname: string; port: number }): Promise<DenoConn>;
};

const ID = "2ea73714-138e-4cc7-8cab-d7caf476d51b";
const PORT = 443;
const id = ID.replace(/-/g, "");

Deno.serve({ port: PORT }, (req: Request) => {
  if (req.headers.get("upgrade") !== "websocket") {
    return new Response("Not Found", { status: 404 });
  }

  const { socket, response } = Deno.upgradeWebSocket(req);
  socket.binaryType = "arraybuffer";

  const handleHandshake = async (event: MessageEvent) => {
    try {
      const msg = new Uint8Array(event.data);
      const dataView = new DataView(event.data);
      const VERSION = msg[0];
      const messageIdBytes = msg.slice(1, 17);

      let idMatch = true;
      for (let i = 0; i < messageIdBytes.length; i++) {
        if (messageIdBytes[i] !== parseInt(id.substr(i * 2, 2), 16)) {
          idMatch = false;
          break;
        }
      }
      if (!idMatch) {
        socket.close();
        return;
      }

      let i = dataView.getUint8(17) + 19;
      const port = dataView.getUint16(i, false);
      i += 2;
      const ATYP = dataView.getUint8(i);
      i += 1;

      let host = "";
      switch (ATYP) {
        case 1:
          host = `${msg[i]}.${msg[i + 1]}.${msg[i + 2]}.${msg[i + 3]}`;
          i += 4;
          break;
        case 2: {
          const domainLength = dataView.getUint8(i);
          i += 1;
          host = new TextDecoder().decode(msg.slice(i, i + domainLength));
          i += domainLength;
          break;
        }
        case 3: {
          const parts: string[] = [];
          for (let j = 0; j < 8; j++) {
            parts.push(dataView.getUint16(i + j * 2, false).toString(16));
          }
          host = parts.join(":");
          i += 16;
          break;
        }
        default:
          socket.close();
          return;
      }

      const remoteConn = await Deno.connect({ hostname: host, port });
      socket.send(new Uint8Array([VERSION, 0]));
      const initialPayload = msg.slice(i);
      if (initialPayload.length > 0) {
        await remoteConn.write(initialPayload);
      }

      socket.onmessage = (e: MessageEvent) => {
        remoteConn.write(new Uint8Array(e.data)).catch(() => {});
      };

      remoteConn.readable
        .pipeTo(
          new WritableStream({
            write: (chunk) => {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(chunk);
              }
            },
          })
        )
        .catch(() => {})
        .finally(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.close();
          }
        });

      socket.onclose = () => {
        try {
          remoteConn.close();
        } catch {}
      };
    } catch {
      socket.close();
    }
  };

  socket.onmessage = handleHandshake;
  return response;
});
