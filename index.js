console.info('Starting PixSim Proxy API');
const express = require('express');
const app = express();
const server = require('http').Server(app);
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
    windowMs: 250,
    max: 25,
    handler: function (req, res, options) {
        console.log('Rate limiting triggered by ' + req.ip || req.socket.remoteAddress);
        PixSimAPIHandler.logger.warn(`Potential DOS attack from ${req.ip || req.socket.remoteAddress}!`);
    }
});
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'UPDATE', 'PUT', 'PATCH']
}));
app.use(limiter);

app.get('/', (req, res) => res.send({ active: true, time: Date.now() }));

const { PixSimAPIHandler } = require('./handlers');

if (process.env.PORT) {
    server.listen(process.env.PORT);
} else {
    server.listen(503);
}

const { subtle } = require('crypto').webcrypto;
const keys = subtle.generateKey({
    name: "RSA-OAEP",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256"
}, false, ['encrypt', 'decrypt']);

// set io
const recentConnections = [];
const recentConnectionKicks = [];
const io = new (require('socket.io')).Server(server, {
    path: '/pixsim-api/',
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    },
    pingTimeout: 10000,
    upgradeTimeout: 300000
});
io.on('connection', async function (socket) {
    // connection DOS detection
    const ip = socket.handshake.headers['x-forwarded-for'] ?? socket.handshake.address ?? socket.request.socket.remoteAddress ?? 'unknown';
    recentConnections[ip] = (recentConnections[ip] ?? 0) + 1;
    if (recentConnections[ip] > 3) {
        if (!recentConnectionKicks[ip]) {
            log(ip + ' was kicked for connection spam.');
            PixSimAPIHandler.logger.warn(`Potential DOS attack from ${ip}!`);
        }
        recentConnectionKicks[ip] = true;
        socket.emit('disconnection: ' + ip);
        socket.removeAllListeners();
        socket.onevent = function (packet) { };
        socket.disconnect();
        return;
    }
    console.log('connection: ' + ip);

    // create handler
    const handler = new PixSimAPIHandler(socket, RSAdecode, await subtle.exportKey('jwk', (await keys).publicKey));

    // manage disconnections
    socket.on('disconnect', async function () {
        console.log('disconnection: ' + ip);
        handler.destroy();
        clearInterval(timeoutcheck);
        clearInterval(packetcheck);
    });
    socket.on('timeout', async function () {
        console.log('disconnection: ' + ip);
        handler.destroy();
        clearInterval(timeoutcheck);
        clearInterval(packetcheck);
    });
    socket.on('error', async function () {
        console.log('disconnection: ' + ip);
        handler.destroy();
        clearInterval(timeoutcheck);
        clearInterval(packetcheck);
    });
    // timeout
    let timeout = 0;
    const timeoutcheck = setInterval(async function () {
        timeout++;
        if (timeout > 300) {
            clearInterval(timeoutcheck);
            clearInterval(packetcheck);
        }
    }, 1000);
    // performance metrics
    socket.on('ping', function () {
        socket.emit('pong');
    });
    // dos spam protection
    let packetCount = 0;
    const onevent = socket.onevent;
    socket.onevent = function (packet) {
        if (packet.data[0] == null) {
            socket.disconnect();
        }
        onevent.call(this, packet);
        timeout = 0;
        packetCount++;
    };
    const packetcheck = setInterval(async function () {
        packetCount = Math.max(packetCount - 250, 0);
        if (packetCount > 0) {
            clearInterval(timeoutcheck);
            clearInterval(packetcheck);
            console.log(ip + ' was kicked for packet spam');
            PixSimAPIHandler.logger.warn(`Potential DOS attack from ${handler.debugId}!`);
            socket.disconnect();
        }
    }, 1000);
});
setInterval(function () {
    for (let i in recentConnections) {
        recentConnections[i] = Math.max(recentConnections[i] - 1, 0);
    }
    for (let i in recentConnectionKicks) {
        delete recentConnectionKicks[i];
    }
}, 1000);

function stop() {
    io.emit('disconnceted')
    io.close();
    process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('SIGQUIT', stop);
process.on('SIGILL', stop);

async function RSAdecode(buf) {
    return new TextDecoder().decode(await subtle.decrypt({ name: "RSA-OAEP" }, (await keys).privateKey, buf));
};