const express = require('express');
const app = express();
const server = require('http').Server(app);
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const PixSimAPI = require('./src/multiplayer/index');
const limiter = rateLimit({
    windowMs: 250,
    max: 25,
    handler: function (req, res, options) {
        console.log('Rate limiting triggered by ' + req.ip ?? req.socket.remoteAddress);
        PixSimHandler.logger.warn(`Potential DOS attack from ${req.ip ?? req.socket.remoteAddress}!`);
    }
});
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'UPDATE', 'PUT', 'PATCH']
}));
app.use(limiter);
app.get('/coffee', (req, res) => res.sendStatus(418));
app.get('/', (req, res) => { res.writeHead(301, { location: 'http://pixelsimulator.repl.co' }); res.end(); });

if (process.env.PORT) {
    server.listen(process.env.PORT);
} else {
    server.listen(5000);
}

// TODO: make game rooms run on a separate thread from io (which is main thread)
const api = new PixSimAPI(app, server, { logEverything: process.argv.includes('--verbose'), allowCache: !process.argv.includes('--no-cache') });

function stop() {
    api.close();
    process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('SIGQUIT', stop);
process.on('SIGILL', stop);