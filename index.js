const PORT = 443;
const VALID_USER_IDS = (process.env.ID || 'e05e7acf-cd21-4788-b4e5-ab9389aa547d').split(',');
const configUserID = VALID_USER_IDS[0];

function websocket() {
    const { execSync } = require('child_process');
    function ensureModule(name) {
        try {
            require.resolve(name);
        } catch (e) {
            execSync(`npm install ${name}`, { stdio: 'inherit' });
        }
    }
    ensureModule('ws');

    const http = require('http');
    const net = require('net');
    const { URL } = require('url');
    const { WebSocketServer, createWebSocketStream } = require('ws');
    const { Buffer } = require('buffer');

    function formatUUID(buffer) {
        if (buffer.length !== 16) {
            return null;
        }
        return `${buffer.slice(0, 4).toString('hex')}-${buffer.slice(4, 6).toString('hex')}-${buffer.slice(6, 8).toString('hex')}-${buffer.slice(8, 10).toString('hex')}-${buffer.slice(10, 16).toString('hex')}`;
    }

    function processNlessHeader(nlessBuffer) {
        if (nlessBuffer.byteLength < 24) {
            throw new Error('invalid data: header too short');
        }
        let offset = 0;
        const version = nlessBuffer.slice(offset, offset + 1);
        offset += 1;
        const clientUUIDBuffer = nlessBuffer.slice(offset, offset + 16);
        const clientUUID = formatUUID(clientUUIDBuffer);
        offset += 16;
        if (!clientUUID || !VALID_USER_IDS.includes(clientUUID)) {
            throw new Error(`Invalid user: ${clientUUID}`);
        }
        const optLength = nlessBuffer.readUInt8(offset);
        offset += 1;
        offset += optLength;
        if (nlessBuffer.byteLength < offset + 4) {
            throw new Error('Invalid header: too short for address info.');
        }
        const command = nlessBuffer.readUInt8(offset);
        offset += 1;
        if (command !== 1) {
            throw new Error(`command ${command} is not supported`);
        }
        const portRemote = nlessBuffer.readUInt16BE(offset);
        offset += 2;
        const addressType = nlessBuffer.readUInt8(offset);
        offset += 1;
        let addressValue = '';
        switch (addressType) {
            case 1:
                addressValue = nlessBuffer.slice(offset, offset + 4).join('.');
                offset += 4;
                break;
            case 2:
                const domainLength = nlessBuffer.readUInt8(offset);
                offset += 1;
                addressValue = nlessBuffer.slice(offset, offset + domainLength).toString('utf-8');
                offset += domainLength;
                break;
            case 3:
                const ipv6Bytes = nlessBuffer.slice(offset, offset + 16);
                const ipv6 = [];
                for (let i = 0; i < 8; i++) {
                    ipv6.push(ipv6Bytes.readUInt16BE(i * 2).toString(16));
                }
                addressValue = `[${ipv6.join(':')}]`;
                offset += 16;
                break;
            default:
                throw new Error(`invalid addressType: ${addressType}`);
        }
        if (!addressValue) {
            throw new Error(`addressValue is empty for addressType ${addressType}`);
        }
        return {
            addressRemote: addressValue,
            portRemote,
            rawData: nlessBuffer.slice(offset),
            nlessVersion: version,
        };
    }

    const server = http.createServer((req, res) => {
        const parsedUrl = new URL(req.url, `https://${req.headers.host}`);
        const getNLESSConfig = (uuid, host) => `nless://${uuid}@${host}?encryption=none&security=tls&sni=${host}&type=ws&host=${host}&path=%2F#NLESS-NODE-VALIDATED`;
        if (parsedUrl.pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h1>NLESS WebSocket Proxy Server</h1><p>This server requires user validation.</p>');
        } else if (parsedUrl.pathname === `/${configUserID}`) {
            const host = req.headers.host;
            const nlessConfig = getNLESSConfig(configUserID, host);
            res.writeHead(200, { "Content-Type": "text/plain;charset=utf-8" });
            res.end(nlessConfig);
        } else {
            res.writeHead(404);
            res.end('Not Found');
        }
    });

    const wss = new WebSocketServer({ server });

    wss.on('connection', (ws) => {
        ws.once('message', (msg) => {
            try {
                const nlessBuffer = Buffer.isBuffer(msg) ? msg : (Array.isArray(msg) ? Buffer.concat(msg) : Buffer.from(msg));
                const { addressRemote, portRemote, rawData, nlessVersion } = processNlessHeader(nlessBuffer);
                ws.send(Buffer.concat([nlessVersion, Buffer.from([0])]));
                const duplex = createWebSocketStream(ws);
                net.connect({ host: addressRemote, port: portRemote }, function() {
                    this.write(rawData);
                    duplex.on('error', () => {}).pipe(this).on('error', () => {}).pipe(duplex);
                }).on('error', () => {
                    duplex.destroy();
                });
            } catch (error) {
                ws.close(1008, 'Invalid user');
            }
        }).on('error', () => {});
    });

    server.listen(PORT);
}

function main() {
    websocket();
}

main();
