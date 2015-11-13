var Url = require('url');
var _ = require('lodash');
var Request = require('request');
var Follow = require('follow');


var internals = {};


internals.noop = function () {};


//
// CouchDB views created using `db.addIndex()` are all stored in the same
// design document: `_design/views`.
// https://github.com/hoodiehq/hoodie.js/issues/70#issuecomment-20506841
//
internals.viewsDdocId = '_design/views';


internals.wrapError = function (err) {

  err.statusCode = 0;
  err.error = 'Internal Server Error';
  return err;
};


internals.createError = function (resp) {

  var body = resp.body || {};
  var message = 'Internal server error';
  var error = message;

  if (body.error) {
    error = body.error;
  }

  if (body.reason) {
    message = body.reason;
  } else {
    message = error;
  }

  var err = new Error(message);
  err.statusCode = resp.statusCode || 500;
  err.error = error;
  err.req = {
    method: resp.request.method,
    href: resp.request.href,
    headers: resp.request.headers
  };

  return err;
};


internals.scopedRequest = function (options) {

  function req(/* method, path, params, data, cb */) {
    
    var args = _.toArray(arguments);
    var method = args.shift();
    var path = args.shift();
    var cb = (typeof args[args.length - 1] === 'function') ?
      args.pop() : internals.noop;

    // Add leading slash if needed.
    if (path.charAt(0) !== '/') { path = '/' + path; }

    var reqOpt = {
      method: method,
      baseUrl: options.url,
      url: path,
      json: true
    };

    if (options.user && options.pass) {
      reqOpt.auth = _.pick(options, [ 'user', 'pass' ]);
    }

    if ([ 'PUT', 'POST' ].indexOf(method) >= 0) {
      reqOpt.body = args.pop();
    }

    if (args.length) {
      reqOpt.qs = _.reduce(args.shift(), function (memo, v, k) {
        memo[k] = JSON.stringify(v);
        return memo;
      }, {});
    }

    return Request(reqOpt, function (err, resp) {

      if (err) { return cb(internals.wrapError(err)); }

      if (resp.statusCode >= 400) {
        return cb(internals.createError(resp));
      } 

      cb(null, resp.body, resp);
    });
  }

  return {
    get: req.bind(null, 'GET'),
    post: req.bind(null, 'POST'),
    put: req.bind(null, 'PUT'),
    del: req.bind(null, 'DELETE')
  };
};


module.exports = function (options) {

  var couch = internals.scopedRequest(options);
  var baseUrl = options.url;
  var uriObj = Url.parse(baseUrl);

  if (options.user && options.pass) {
    baseUrl = uriObj.protocol + '//' + options.user + ':' + options.pass + '@' +
      uriObj.host + uriObj.path;
  }

  couch.db = function (name) {

    var dbUrl = options.url + '/' + encodeURIComponent(name);
    var db = internals.scopedRequest(_.extend({}, options, { url: dbUrl }));


    db.exists = function (cb) {
      couch.get(encodeURIComponent(name), function (err, data) {
        if (err && err.statusCode === 404) {
          cb(null, false);
        } else if (err) {
          cb(err);
        } else {
          cb(null, true);
        }
      });
    };


    db.create = function (cb) {
      couch.put(encodeURIComponent(name), cb);
    };

    db.createIfNotExists = function (cb) {
      db.exists(function (err, exists) {
        if (err) { return cb(err); }
        if (exists) { return cb(); }
        db.create(cb);
      });
    };

    db.changes = function (params, cb) {

      params = params || {};
      cb = cb || function () {};

      if (params.feed === 'continuous') {
      
        return new Follow.Feed({
          db: baseUrl + '/' + encodeURIComponent(name),
          since: params.since || 'now',
          include_docs: params.include_docs === true
        });
      }

      db.get('/_changes', params, cb);
    };


    //
    // Creates new design doc with CouchDB view on db.
    //
    db.addIndex = function (name, mapReduce, cb) {

      if (!mapReduce || !_.isFunction(mapReduce.map)) {
        return cb(new Error('db.addIndex() expects mapReduce object to ' +
          'contain a map function.'));
      }

      db.get(internals.viewsDdocId, function (err, ddoc) {

        if (err && err.statusCode === 404) {
          // not found, so we use new object.
          ddoc = {
            _id: internals.viewsDdocId,
            language: 'javascript',
            views: {}
          };
        } else if (err) {
          return cb(err);
        }

        // View functions need to be serialised/stringified.
        var serialised = _.reduce(mapReduce, function (memo, v, k) {

          memo[k] = _.isFunction(v) ? v.toString() : v;
          return memo;
        }, {});

        // If view code has not changed we don't need to do anything else.
        // NOTE: Not sure if this is the best way to deal with this. This
        // saves work and avoids unnecessarily overwriting the
        // `_design/views` document when no actual changes have been made to
        // the view code (map/reduce).
        if (_.isEqual(serialised, ddoc.views[name])) {
          return cb(null, {
            ok: true,
            id: ddoc._id,
            rev: ddoc._rev
          });
        }

        ddoc.views[name] = serialised;
        db.put(internals.viewsDdocId, ddoc, cb);
      });
    };

    //
    // Removes couchdb view from db.
    //
    db.removeIndex = function (name, cb) {

      db.get(internals.viewsDdocId, function (err, ddoc) {

        if (err) { return cb(err); }

        if (ddoc.views && ddoc.views[name]) {
          delete ddoc.views[name];
        }

        db.put(internals.viewsDdocId, ddoc, cb);
      });
    };


    db.query = function (index, params, cb) {

      // `params` is optional, when only two args passed second is callback.
			if (arguments.length === 2) {
				cb = params;
				params = null;
			}

			var viewUrl = '/_design/views/_view/' + index;

			// If params have been passed we build the query string.
			if (params) {
				var qs = _.reduce(params, function (memo, v, k) {

					if (memo) { memo += '&'; }
					return memo + k + '=' + encodeURIComponent(JSON.stringify(v));
				}, '');

				if (qs) { viewUrl += '?' + qs; }
			}

			db.get(viewUrl, function (err, data) {

				if (err) { return cb(err); }
				cb(null, data.rows, _.omit(data, [ 'rows' ]));
			});
    };

      
    db.addSecurity = function (securityDoc, cb) {

      db.get('_security', function (err, data) {

        if (err) { return cb(err); }
        if (_.isEqual(data, securityDoc)) { return cb(); }
        // Use `couch` to update the security object as `db` is a PouchDB
        // client, and doesn't allow this.
        couch.put(encodeURIComponent(name) + '/_security', securityDoc, cb);
      });
    };

    db.removeSecurity = function (cb) {

      couch.put(encodeURIComponent(name) + '/_security', {}, cb);
    };

    return db;
  };


  couch.config = {
    get: function (key, cb) {

      return couch.get('/_config/' + key, cb);
    },
    set: function (key, val, cb) {

      var url = '/_config/' + key;
      couch.get(url, function (err, data) {

        if (err) { return cb(err); }
        if (data === val) { return cb(); }
        couch.put(url, val, cb);
      });
    },
    all: function (cb) {

      return couch.get('/_config', cb);
    }
  };


  couch.isAdminParty = function (cb) {
    this.get('/_users/_all_docs', function (err, data) {
      if (err && [ 401, 403 ].indexOf(err.statusCode) >= 0) {
        cb(null, false);
      } else if (err) {
        cb(err);
      } else {
        cb(null, true);
      }
    });
  };


  couch.dbUpdates = function (params) {

    return new Follow.Feed({
      db: baseUrl + '_db_updates',
    });
  };


  return couch;

};
