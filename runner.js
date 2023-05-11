const express = require('express');
const app = express();
const server = require('http').Server(app);
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { PixSimAPI } = require('./index');
const limiter = rateLimit({
    windowMs: 250,
    max: 25,
    handler: function (req, res, options) {
        console.log('Rate limiting triggered by ' + req.ip || req.socket.remoteAddress);
        PixSimHandler.logger.warn(`Potential DOS attack from ${req.ip || req.socket.remoteAddress}!`);
    }
});
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'UPDATE', 'PUT', 'PATCH']
}));
app.use(limiter);

if (process.env.PORT) {
    server.listen(process.env.PORT);
} else {
    server.listen(5000);
}

const api = new PixSimAPI(app, server);

function stop() {
    api.close();
    process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('SIGQUIT', stop);
process.on('SIGILL', stop);