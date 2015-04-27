var View = require('../../client/ui/view');
var Couch = require('../../client/couch');


module.exports = View.extend({

  className: 'container',
  templateName: 'signin',

  initialize: function (opt) {
    View.prototype.initialize.call(this, opt);
    this.render();
  },

  events: {
    'submit #signin-form': 'submit'
  },

  submit: function (e) {
    e.preventDefault();
    var app = this.app;
    var credentials = { name: 'admin', password: $('#pass').val() };

    Couch('/_api').post('/_session', credentials).then(function (data) {
      //app.navigate('', { trigger: true });
      window.location.href = '/_admin/';
    }, function (err) {
      alert(err.reason);
    });

    return false;
  }

});
