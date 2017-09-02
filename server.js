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

let proxyPort = process.env.PORT || 9090;    
http.createServer(app).listen(proxyPort, function () {
    console.log('listening at: http://localhost:' + proxyPort);
    if (destinationType == "target") {
        console.log('targetting: ' + targetURL);
    }
    else {
        console.log('forwarding to proxy: ' + targetURL);
    }
});

// Invoked when the connection is established to the target
proxy.on('proxyReq', function (proxyReq, req, res, options) {

    // if POST request, add ActorId HTTP header
    if (req.method == 'POST') {
        assert(req.body !== undefined);

        // Inject ActorId
        if (req.body.actorId) {
            fine("actorId found: " + req.body.actorId);

            // Inject ActorId
            proxyReq.setHeader('ActorId', req.body.actorId);
        }
    }

    // Restream body if contents got parsed by JSON body parser
    if (req.body) {
        var bodyData = JSON.stringify(req.body);
        // Override content length as we have de/reserialzed the body
        proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
        proxyReq.write(bodyData);
    }
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
