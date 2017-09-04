//
// Copyright (c) 2017 Cisco Systems
// Licensed under the MIT License 
//

/* 
 * A reverse proxy that:
 *   - looks for the actorId in a Cisco Spark Webhook event
 *   - injects it as an 'ActorId' HTTP header 
 *   - then forwards the incoming POST request to a target URL (generally a cluster of Cisco Spark Bots sitting behind a load balancer)
 *
 * The typical use case is to enable Load Balancing affinity for Bots, based on the Cisco Spark interacting with the bot.
 * 
 * Code started from node-http-proxy sample: https://github.com/nodejitsu/node-http-proxy/blob/master/examples/middleware/bodyDecoder-middleware.js
 *
 */

var http = require('http'),
    connect = require('connect'),
    httpProxy = require('http-proxy'),
    bodyParser = require('body-parser'),
    cookieParser = require("cookie"),
    assert = require('assert');

var debug = require("debug")("injector");
var fine = require("debug")("injector:fine");


//
//  Http Proxy
//
var proxy = httpProxy.createProxyServer();
var proxyOptions = {
    // HTTP or HTTPS endpoint where the bot or buster cluster is listening
    target: process.env.TARGET_URL || "http://127.0.0.1:8080",

    // Sets the Host HTTP header (mandatory for Heroku)
    changeOrigin: true,

    // Check SSL at target
    secure: true
};


// Used to filter out affinity if it's the bot who generated the notification
var botPersonId = process.env.BOT_PERSONID;

var app = connect()
    .use(bodyParser.json())
    .use(function (req, res) {

        // If anything but POST, simply forward
        if (req.method != "POST") {
            fine("this is not a post, passing the request...");
        }
        else { // POST

            // If there's no body, no use spending time forwarding to Cisco Spark
            if (!req.body) {
                debug("no body found in request, arborting...");
                res.writeHead(400, {
                    'Content-Type': 'application/json'
                });

                var message = JSON.stringify({ status: 400, description: "Client Error", error: "no data posted" });
                res.end(message);
                return;
            }
        }

        // All good, let's proxy
        proxy.web(req, res, proxyOptions);
    });

var proxyPort = process.env.PORT || 9090;
http.createServer(app).listen(proxyPort, function () {
    console.log('listening at: http://localhost:' + proxyPort);
    console.log('proxying to: ' + proxyOptions.target);
});

// Invoked when the connection is established to the target
proxy.on('proxyReq', function (proxyReq, req, res, options) {

    // if POST request, check actorId from HTTP header
    if (req.method == 'POST') {
        assert(req.body !== undefined);

        // [TODO] Add option to check secret

        // Check actorId is present, and our bot is not the actor
        var actorId = req.body.actorId;
        if (!actorId || (actorId === botPersonId)) {
            // No affinity to setup for incoming request
            if (actorId) {
                fine("no affinity task: our bot is the actor");                
            }
            else {
                fine("no affinity task: actorId not present in incoming request");
            }
        }
        else {
            // Inject ActorId
            fine("injecting 'ActorId' HTTP header: " + actorId)
            proxyReq.setHeader('ActorId', actorId);

            // Is there an affinity registered for the Spark user
            var cookie = this.fetchCookie(actorId);
            if (cookie) {
                fine("injecting 'heroku-session-affinity' cookie for actor: " + actorId);
                proxyReq.setHeader('cookie', "heroku-session-affinity=" + cookie['heroku-session-affinity']);
            }
            else {
                fine("no cookie found for actorId: " + actorId);                
            }
        }
    }

    // Restream body if contents got parsed by JSON body parser
    if (req.body) {
        // [TODO] Watchout: we are certainly not altering the secret !!! 
        // Better memorize raw data and rewrite those

        var bodyData = JSON.stringify(req.body);
        // Override content length as we have de/reserialized the body
        proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
        proxyReq.write(bodyData);
    }
});

// Invoked when the response is received from the target
proxy.on('proxyRes', function (proxyRes, req, res) {

    // Is there an actorId to associate the cookie to
    var actorId = req.body.actorId;
    if (!actorId) {
        fine("no actorId in current request => no affinity to store");
        return;
    }

    // It is the bot talking, no affinity to memorize
    if (actorId === botPersonId) {
        fine("bot is talking => no affinity to store");
        return;
    }

    // Looking for Cookie Affinity setup
    // - example: heroku-session-affinity=ACyDaANoA24IARCYXdj///8HYgAIEpdiAA0DpmEBbAAAAAFtAAAABXdlYi4xaqGFOCQUx+sAz805r29nOj/0jxJ5; Version=1; Expires=Tue, 05-Sep-2017 12:44:07 GMT; Max-Age=86400; Domain=webhook-affinity-bot.herokuapp.com; Path=/
    var newCookiesHeader = proxyRes.headers["set-cookie"];
    if (!newCookiesHeader) {
        fine("no affinity cookie to store for actorId: " + actorId);
        return;
    }

    // Trying to associate cookie to current actorId
    var self = this;
    newCookiesHeader.forEach(function (cookieHeader) {
        var cookie = cookieParser.parse(cookieHeader);
        if (cookie['heroku-session-affinity']) {
            fine("found set-cookie 'heroku-session-affinity'");

            // Associate cookie to request ActorId
            debug("storing 'heroku-session-affinity' cookie for actorId: " + actorId);
            self.storeCookie(actorId, cookie)
        }
    });
});

// Inovked if the incoming or outgoing connection break or time out
proxy.on('error', function (err, req, res) {
    // No service listening
    if (err.code == 'ECONNREFUSED') {
        debug("no service listening, err: " + err.message);

        res.writeHead(502, {
            'Content-Type': 'application/json'
        });

        var message = JSON.stringify({ status: 502, description: "Bad Gateway", error: err.message });
        res.end(message);
        return;
    }

    // Other errors
    debug("proxying failed, err: " + err.message);
    res.writeHead(500, {
        'Content-Type': 'application/json'
    });

    var message = JSON.stringify({ status: 500, description: "Internal Server Error", error: err.message });
    res.end(message);
});


//
//
//

// Hashmap of actorId / cookies
proxy.storage = {};
proxy.storeCookie = function (actorId, cookie) {
    this.storage[actorId] = cookie;
}

proxy.fetchCookie = function (actorId) {
    return this.storage[actorId];
}



