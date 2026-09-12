import { connect } from 'cloudflare:sockets';

function isValidVlessUser(idBytes, uuidString) {
  if (!uuidString || typeof uuidString !== 'string') return false;
  const expectedHex = uuidString.replace(/-/g, '').toLowerCase();
  if (expectedHex.length !== 32 || !/^[0-9a-f]{32}$/.test(expectedHex))
    return false;
  if (!idBytes || idBytes.length !== 16) return false;

  for (let i = 0; i < 16; i++) {
    const expectedByte = parseInt(expectedHex.substr(i * 2, 2), 16);
    if (idBytes[i] !== expectedByte) return false;
  }
  return true;
}

function parseVlessHeader(buffer, uuidString) {
  if (!buffer || buffer.byteLength < 24) {
    return {
      hasError: true,
      message: 'Header too short to be a valid VLESS request',
    };
  }

  const bytes = new Uint8Array(buffer);
  const version = bytes.slice(0, 1);
  const idBytes = bytes.slice(1, 17);

  if (!isValidVlessUser(idBytes, uuidString)) {
    return {
      hasError: true,
      message: 'Invalid user (UUID mismatch) — connection rejected',
    };
  }

  const optionsLength = bytes[17];
  let index = 18 + optionsLength;

  if (index >= bytes.length) {
    return { hasError: true, message: 'Header truncated after addons section' };
  }

  const command = bytes[index];
  index += 1;

  if (command !== 1 && command !== 2) {
    return { hasError: true, message: `Unsupported VLESS command: ${command}` };
  }
  const isUDP = command === 2;

  if (index + 2 > bytes.length) {
    return { hasError: true, message: 'Header truncated before port' };
  }
  const portRemote = (bytes[index] << 8) + bytes[index + 1];
  index += 2;

  if (index + 1 > bytes.length) {
    return { hasError: true, message: 'Header truncated before address type' };
  }
  const addressType = bytes[index];
  index += 1;

  let addressRemote = '';
  let addressLength = 0;

  if (addressType === 1) {
    addressLength = 4;
    if (index + addressLength > bytes.length) {
      return { hasError: true, message: 'Header truncated in IPv4 address' };
    }
    addressRemote = Array.from(bytes.slice(index, index + addressLength)).join(
      '.',
    );
  } else if (addressType === 2) {
    if (index + 1 > bytes.length) {
      return {
        hasError: true,
        message: 'Header truncated before domain length',
      };
    }
    addressLength = bytes[index];
    index += 1;
    if (index + addressLength > bytes.length) {
      return { hasError: true, message: 'Header truncated in domain name' };
    }
    addressRemote = new TextDecoder().decode(
      bytes.slice(index, index + addressLength),
    );
  } else if (addressType === 3) {
    addressLength = 16;
    if (index + addressLength > bytes.length) {
      return { hasError: true, message: 'Header truncated in IPv6 address' };
    }
    const groups = [];
    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset + index,
      addressLength,
    );
    for (let i = 0; i < 8; i++) {
      groups.push(view.getUint16(i * 2).toString(16));
    }
    addressRemote = groups.join(':');
  } else {
    return {
      hasError: true,
      message: `Unsupported address type: ${addressType}`,
    };
  }

  if (!addressRemote) {
    return { hasError: true, message: 'Empty destination address' };
  }

  return {
    hasError: false,
    version,
    isUDP,
    addressRemote,
    portRemote,
    rawDataIndex: index + addressLength,
  };
}

function base64UrlToArrayBuffer(base64Url) {
  if (!base64Url) return { earlyData: null, error: null };
  try {
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { earlyData: bytes.buffer, error: null };
  } catch (error) {
    return { earlyData: null, error };
  }
}

function buildVlessShareLink(uuid, hostname, remark) {
  const params = new URLSearchParams({
    encryption: 'none',
    security: 'tls',
    sni: hostname,
    fp: 'chrome',
    type: 'ws',
    host: hostname,
    path: '/?ed=2048',
  });
  return `vless://${uuid}@${hostname}:443?${params.toString()}#${encodeURIComponent(remark)}`;
}

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

export default {
  async fetch(request, env, ctx) {
    try {
      const userID = env.UUID;
      if (!userID) {
        return new Response('Server misconfigured: UUID secret is not set.', {
          status: 500,
        });
      }

      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader !== 'websocket') {
        return handlePlainHttp(request, userID);
      }

      return await handleVlessOverWebSocket(request, env, ctx, userID);
    } catch (err) {
      console.error('fetch handler error:', err && err.stack ? err.stack : err);
      return new Response('Internal error', { status: 500 });
    }
  },
};

function handlePlainHttp(request, userID) {
  const url = new URL(request.url);
  if (url.pathname === `/${userID}`) {
    const link = buildVlessShareLink(userID, url.hostname, 'personal-vless');
    return new Response(link + '\n', {
      headers: { 'content-type': 'text/plain;charset=utf-8' },
    });
  }
  return new Response('Not found', { status: 404 });
}

async function handleVlessOverWebSocket(request, env, ctx, userID) {
  const proxyIP = (env.PROXYIP || '').trim();

  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);
  server.accept();

  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableStream = makeReadableWebSocketStream(server, earlyDataHeader);

  const remoteSocketWrapper = { value: null };
  let isDns = false;
  let udpStreamWrite = null;

  const pipelinePromise = readableStream
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          if (isDns && udpStreamWrite) {
            udpStreamWrite(chunk);
            return;
          }

          if (remoteSocketWrapper.value) {
            const writer = remoteSocketWrapper.value.writable.getWriter();
            await writer.write(ensureArrayBuffer(chunk));
            writer.releaseLock();
            return;
          }

          const header = parseVlessHeader(chunk, userID);
          if (header.hasError) {
            throw new Error(header.message);
          }

          const vlessResponseHeader = new Uint8Array([header.version[0], 0]);
          const rawClientData = chunk.slice(header.rawDataIndex);

          if (header.isUDP) {
            if (header.portRemote !== 53) {
              throw new Error(
                'Only DNS (UDP port 53) is supported; other UDP is not proxied',
              );
            }
            isDns = true;
            udpStreamWrite = await handleUdpDns(server, vlessResponseHeader);
            udpStreamWrite(rawClientData);
            return;
          }

          await handleTcpOutbound(
            remoteSocketWrapper,
            header.addressRemote,
            header.portRemote,
            rawClientData,
            server,
            vlessResponseHeader,
            proxyIP,
          );
        },
        close() {},
        abort() {},
      }),
    )
    .catch(err => {
      console.error(
        'tunnel pipeline error:',
        err && err.stack ? err.stack : err,
      );
      safeCloseWebSocket(server);
    });

  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(pipelinePromise);
  }

  return new Response(null, { status: 101, webSocket: client });
}

async function handleTcpOutbound(
  remoteSocketWrapper,
  addressRemote,
  portRemote,
  rawClientData,
  server,
  vlessResponseHeader,
  proxyIP,
) {
  async function connectAndWrite(address, port) {
    const socket = connect({ hostname: address, port });
    remoteSocketWrapper.value = socket;
    const writer = socket.writable.getWriter();
    await writer.write(ensureArrayBuffer(rawClientData));
    writer.releaseLock();
    return socket;
  }

  async function retryThroughProxy() {
    if (!proxyIP) {
      safeCloseWebSocket(server);
      return;
    }
    const [proxyHost, proxyPortStr] = proxyIP.split(':');
    const proxyPort = proxyPortStr ? parseInt(proxyPortStr, 10) : portRemote;
    const socket = await connectAndWrite(proxyHost, proxyPort);
    pipeRemoteToWebSocket(socket, server, vlessResponseHeader, null);
  }

  const socket = await connectAndWrite(addressRemote, portRemote);
  pipeRemoteToWebSocket(socket, server, vlessResponseHeader, retryThroughProxy);
}

async function pipeRemoteToWebSocket(
  socket,
  server,
  vlessResponseHeader,
  onNoData,
) {
  let headerSent = false;
  let receivedAnyData = false;

  await socket.readable
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          receivedAnyData = true;
          if (server.readyState !== WS_READY_STATE_OPEN) {
            throw new Error('WebSocket closed while streaming from remote');
          }
          if (!headerSent) {
            const combined = new Uint8Array(
              vlessResponseHeader.length + chunk.byteLength,
            );
            combined.set(vlessResponseHeader, 0);
            combined.set(new Uint8Array(chunk), vlessResponseHeader.length);
            server.send(combined);
            headerSent = true;
          } else {
            server.send(chunk);
          }
        },
        close() {},
        abort() {},
      }),
    )
    .catch(() => {});

  if (!receivedAnyData && onNoData) {
    await onNoData();
  } else if (!receivedAnyData) {
    safeCloseWebSocket(server);
  }
}

async function handleUdpDns(server, vlessResponseHeader) {
  let headerSent = false;
  return async function write(chunk) {
    try {
      const bytes = new Uint8Array(chunk);
      let offset = 0;
      while (offset < bytes.length) {
        const length = (bytes[offset] << 8) + bytes[offset + 1];
        const dnsQuery = bytes.slice(offset + 2, offset + 2 + length);
        offset += 2 + length;

        const response = await fetch('https://cloudflare-dns.com/dns-query', {
          method: 'POST',
          headers: { 'content-type': 'application/dns-message' },
          body: dnsQuery,
        });
        const dnsAnswer = new Uint8Array(await response.arrayBuffer());
        const lengthPrefix = new Uint8Array([
          (dnsAnswer.length >> 8) & 0xff,
          dnsAnswer.length & 0xff,
        ]);

        if (server.readyState !== WS_READY_STATE_OPEN) return;

        if (!headerSent) {
          const combined = new Uint8Array(
            vlessResponseHeader.length + lengthPrefix.length + dnsAnswer.length,
          );
          combined.set(vlessResponseHeader, 0);
          combined.set(lengthPrefix, vlessResponseHeader.length);
          combined.set(
            dnsAnswer,
            vlessResponseHeader.length + lengthPrefix.length,
          );
          server.send(combined);
          headerSent = true;
        } else {
          const combined = new Uint8Array(
            lengthPrefix.length + dnsAnswer.length,
          );
          combined.set(lengthPrefix, 0);
          combined.set(dnsAnswer, lengthPrefix.length);
          server.send(combined);
        }
      }
    } catch (err) {
      console.error(
        'DNS-over-HTTPS relay error:',
        err && err.stack ? err.stack : err,
      );
      safeCloseWebSocket(server);
    }
  };
}

function makeReadableWebSocketStream(webSocket, earlyDataHeader) {
  let cancelled = false;
  return new ReadableStream({
    start(controller) {
      webSocket.addEventListener('message', event => {
        if (cancelled) return;
        normalizeMessageData(event.data)
          .then(data => {
            if (!cancelled) controller.enqueue(data);
          })
          .catch(err => controller.error(err));
      });
      webSocket.addEventListener('close', () => {
        if (cancelled) return;
        controller.close();
      });
      webSocket.addEventListener('error', err => {
        if (cancelled) return;
        controller.error(err);
      });

      const { earlyData, error } = base64UrlToArrayBuffer(earlyDataHeader);
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData);
      }
    },
    cancel() {
      cancelled = true;
      safeCloseWebSocket(webSocket);
    },
  });
}

function safeCloseWebSocket(socket) {
  try {
    if (
      socket.readyState === WS_READY_STATE_OPEN ||
      socket.readyState === WS_READY_STATE_CLOSING
    ) {
      socket.close();
    }
  } catch {}
}

async function normalizeMessageData(data) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data))
    return data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    );
  if (typeof data === 'string') return new TextEncoder().encode(data).buffer;
  if (typeof Blob !== 'undefined' && data instanceof Blob)
    return await data.arrayBuffer();
  throw new Error(
    `Unexpected WebSocket message data type: ${Object.prototype.toString.call(data)}`,
  );
}

function ensureArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    );
  }
  if (typeof value === 'string') return new TextEncoder().encode(value).buffer;
  throw new Error(
    `Cannot write value of type ${Object.prototype.toString.call(value)} to a TCP socket`,
  );
}
