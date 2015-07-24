var Hapi = require('hapi');
var Boom = require('boom');
var path = require('path');
var request = require('request');


module.exports = function (capot, cb) {

  var config = capot.config;
  var log = capot.log.child({ scope: 'capot.www' });

  var server = capot.www = new Hapi.Server({
    connections: {
      routes: {
        payload: {
          maxBytes: 1048576 * 5 // 5Mb
        }
      }
    }
  });

  server.connection({ port: config.port });


  server.auth.scheme('couchdb', function (server, options) {
    return {
      authenticate: function (req, reply) {
        request({
          method: 'GET',
          url: config.couchdb.url + '/_session',
          headers: { cookie: req.headers.cookie },
          json: true
        }, function (err, resp) {
          if (err) { return reply(err); }
          if (resp.statusCode !== 200) {
            return reply(Boom.create(resp.statusCode));
          }
          reply.continue({ credentials: resp.body });
        });
      }
    };
  });

  server.auth.strategy('capot', 'couchdb', {
    validateFunc: function (user, pass, cb) {
      console.log(user, pass, cb);
    }
  });


  var apiHandler = {
    proxy: {
      passThrough: true,
      mapUri: function (req, cb) {
        cb(null, config.couchdb.url + req.url.path.substr(7), req.headers);
      }
    }
  };

  // Register `_couch` methods as individual routes, otherwise proxy doesn't seem
  // to work as expected.
  [ 'GET', 'POST', 'PUT', 'DELETE' ].forEach(function (method) {
    server.route({ method: method, path: '/_couch/{p*}', handler: apiHandler });
  });


  server.route({
    method: 'GET',
    path: '/_admin/{p*}',
    handler: {
      directory: {
        path: path.join(config.cwd, 'node_modules', 'capot', 'admin')
      }
    }
  });

  server.route({
    method: 'GET',
    path: '/{p*}',
    handler: {
      directory: {
        path: config.www || 'www'
      }
    }
  });


  // Redirect 404s for HTML docs to index.
  server.ext('onPostHandler', function (req, reply) {
    var resp = req.response;

    if (!resp.isBoom) { return reply.continue(); }

    var is404 = (resp.output.statusCode === 404);
    var isHTML = /text\/html/.test(req.headers.accept);

    // We only care about 404 for html requests...
    if (!is404 || !isHTML) { return reply.continue(); }

    var path = req.url.path.replace(/^\//, '');
    var prefix = '/';
    if (/^_admin/.test(path)) {
      prefix = '/_admin/';
      path = path.replace(/^_admin\//, '');
    }

    reply.redirect(prefix + '#' + path);
  });


  server.start(function () {
    log.info('Web server started on port ' + config.port);
    cb();
  });

};

