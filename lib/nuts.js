process.env.NODE_ENV || (process.env.NODE_ENV = 'development')
if (process.env.NODE_ENV != 'production') {
  require('dotenv').load()
}

var fs = require('fs');

var _ = require('lodash');
var Q = require('q');
var Feed = require('feed');
var urljoin = require('urljoin.js');
var Understudy = require('understudy');
var express = require('express');
var useragent = require('express-useragent');

if (process.env.POSTMARK_API_KEY) {
  var multiparty = require('multiparty');
  var nodemailer = require('nodemailer');
  var postmarkTransport = require('nodemailer-postmark-transport')({ auth: { apiKey: process.env.POSTMARK_API_KEY } });
  var postmark = nodemailer.createTransport(postmarkTransport);
}

var BACKENDS = require('./backends');
var Versions = require('./versions');
var notes = require('./utils/notes');
var platforms = require('./utils/platforms');
var winReleases = require('./utils/win-releases');
var API_METHODS = require('./api');

function getFullUrl(req) {
    return req.protocol + '://' + req.get('host') + req.originalUrl;
}

function Nuts(opts) {
    if (!(this instanceof Nuts)) return new Nuts(opts);
    var that = this;

    Understudy.call(this);
    _.bindAll(this);

    this.opts = _.defaults(opts || {}, {
        // Backend to use
        backend: 'github',

        // Timeout for releases cache (seconds)
        timeout: 60*60*1000,

        // Pre-fetch list of releases at startup
        preFetch: true,

        // Secret for GitHub webhook
        refreshSecret: 'secret'
    });

    // .init() is now a memoized version of ._init()
    this.init = _.memoize(this._init);

    // Create router
    this.router = express.Router();

    // Create backend
    this.backend = new (BACKENDS(this.opts.backend))(this, this.opts);
    this.versions = new Versions(this.backend);

    // Bind routes
    this.router.use(useragent.express());

    this.router.get('/', this.onDownload);
    this.router.get('/download/channel/:channel/:platform?', this.onDownload);
    this.router.get('/download/version/:tag/:platform?', this.onDownload);
    this.router.get('/download/:tag/:filename', this.onDownload);
    this.router.get('/download/:platform?', this.onDownload);

    this.router.get('/feed/channel/:channel.atom', this.onServeVersionsFeed);

    this.router.get('/update', this.onUpdateRedirect);
    this.router.get('/update/:platform/:version', this.onUpdate);
    this.router.get('/update/channel/:channel/:platform/:version', this.onUpdate);
    this.router.get('/update/:platform/:version/RELEASES', this.onUpdateWin);
    this.router.get('/update/channel/:channel/:platform/:version/RELEASES', this.onUpdateWin);

    this.router.get('/electron-updater/:channel/:platform/:filename', this.onElectronUpdater);

    this.router.get('/notes/:version?', this.onServeNotes);

    this.router.post('/crash', this.onCrashReport);

    // Bind API
    this.router.use('/api', this.onAPIAccessControl);
    _.each(API_METHODS, function(method, route) {
        this.router.get('/api/' + route, function(req, res, next) {
            return Q()
            .then(function() {
                return method.call(that, req);
            })
            .then(function(result) {
                res.send(result);
            }, next);
        });
    }, this);
}

// _init does the real init work, initializing backend and prefetching versions
Nuts.prototype._init = function() {
    var that = this;
    return Q()
    .then(function() {
        return that.backend.init();
    })
    .then(function() {
        if (!that.opts.preFetch) return
        return that.versions.list();
    });
}


// Perform a hook using promised functions
Nuts.prototype.performQ = function(name, arg, fn) {
    var that = this;
    fn = fn || function() { };

    return Q.nfcall(this.perform, name, arg, function (next) {
        Q()
        .then(function() {
            return fn.call(that, arg);
        })
        .then(function() {
            next();
        }, next);
    })
};

// Serve an asset to the response
Nuts.prototype.serveAsset = function(req, res, version, asset) {
    var that = this;

    return that.init()
    .then(function() {
        return that.performQ('download', {
            req: req,
            version: version,
            platform: asset
        }, function() {
            return that.backend.serveAsset(asset, req, res)
        });
    });
};

// Handler for download routes
Nuts.prototype.onDownload = function(req, res, next) {
    var that = this;
    var channel = req.params.channel;
    var platform = req.params.platform;
    var tag = req.params.tag || 'latest';
    var filename = req.params.filename;
    var filetypeWanted = req.query.filetype;

    // When serving a specific file, platform is not required
    if (!filename) {
        // Detect platform from useragent
        if (!platform) {
            if (req.useragent.isMac) platform = platforms.OSX;
            if (req.useragent.isWindows) platform = platforms.WINDOWS;
            if (req.useragent.isLinux) platform = platforms.LINUX;
            if (req.useragent.isLinux64) platform = platforms.LINUX_64;
        }

        if (!platform) return next(new Error('No platform specified and impossible to detect one'));
    } else {
        platform = null;
    }

    // If specific version, don't enforce a channel
    if (tag != 'latest') channel = '*';

    this.versions.resolve({
        channel: channel,
        platform: platform,
        tag: tag
    })

    // Serve downloads
    .then(function(version) {
        var asset;

        if (filename) {
            asset = _.find(version.platforms, {
                filename: filename
            });
        } else {
            asset = platforms.resolve(version, platform, {
                wanted: filetypeWanted? '.'+filetypeWanted : null
            });
        }

        if (!asset) throw new Error("No download available for platform "+platform+" for version "+version.tag+" ("+(channel || "beta")+")");

        // Call analytic middleware, then serve
        return that.serveAsset(req, res, version, asset);
    })
    .fail(next);
};


// Request to update
Nuts.prototype.onUpdateRedirect = function(req, res, next) {
    Q()
    .then(function() {
        if (!req.query.version) throw new Error('Requires "version" parameter');
        if (!req.query.platform) throw new Error('Requires "platform" parameter');

        return res.redirect('/update/'+req.query.platform+'/'+req.query.version);
    })
    .fail(next);
};

// Updater used by OSX (Squirrel.Mac) and others
Nuts.prototype.onUpdate = function(req, res, next) {
    var that = this;
    var fullUrl = getFullUrl(req);
    var platform = req.params.platform;
    var channel = req.params.channel || '*';
    var tag = req.params.version.split('-')[0];
    var filetype = req.query.filetype ? req.query.filetype : "zip";

    Q()
    .then(function() {
        if (!tag) throw new Error('Requires "version" parameter');
        if (!platform) throw new Error('Requires "platform" parameter');

        platform = platforms.detect(platform);

        return that.versions.filter({
            tag: '>='+tag,
            platform: platform,
            channel: channel
        });
    })
    .then(function(versions) {
        var latest = _.first(versions);
        if (!latest || latest.tag == tag) return res.status(204).send('No updates');

        var notesSlice = versions.slice(0, -1);
        if (versions.length === 1) {
            notesSlice = [versions[0]];
        }
        var releaseNotes = notes.merge(notesSlice, { includeTag: false });
        console.error(latest.tag);
        var gitFilePath = (channel === '*' ? '/../../../' : '/../../../../../');
        res.status(200).send({
            "url": urljoin(fullUrl, gitFilePath, '/download/channel/'+channel+'/'+platform+'?filetype='+filetype),
            "name": latest.tag,
            "notes": releaseNotes,
            "channel": channel,
            "pub_date": latest.published_at.toISOString()
        });
    })
    .fail(next);
};

// Updater used by electron-updater
Nuts.prototype.onElectronUpdater = function(req, res, next) {
    var that = this;
    var fullUrl = getFullUrl(req);
    var platform = req.params.platform;
    var channel = req.params.channel || '*';
    var filename = req.params.filename;
    var filetype = req.query.filetype ? req.query.filetype : "zip";

    Q()
    .then(function() {
        if (!platform) throw new Error('Requires "platform" parameter');

        platform = platforms.detect(platform);

        return that.versions.resolve({
            platform: platform,
            channel: channel
        });
    })
    .then(function(latest) {
        var contentType = _.last(filename.split('.'));
        var gitFilePath = '/../../../../';
        var downloadURL = urljoin(fullUrl, gitFilePath, '/download/channel/'+channel+'/'+platform+'?filetype='+filetype);

        Q()
        .then(function() {
          var content = '';

          if (contentType == 'json') {
            return {
              version: latest.version,
              releaseDate: latest.published_at.toISOString(),
              url: downloadURL,
            }
          }

          if (contentType == 'yml') {
            var asset = _.find(latest.platforms, { filename: filename });
            if (!asset) { return null }

            return that.backend.readAsset(asset)
            .then(function(content) {
              content = content.toString();
              return content.toString();
            });
          }

          if (contentType == 'exe' || contentType == 'zip' || contentType == 'blockmap') {
            var asset = _.find(latest.platforms, { filename: filename });
            if (!asset) { return null }

            return that.serveAsset(req, res, latest, asset);
          }

          return content
        })
        .then(function(content) {
          if (content) {
            res.status(200).send(content);
          } else {
            res.status(404).send('Not Found')
          }
        })
    })
    .fail(next);
};

// Update Windows (Squirrel.Windows)
// Auto-updates: Squirrel.Windows: serve RELEASES from latest version
// Currently, it will only serve a full.nupkg of the latest release with a normalized filename (for pre-release)
Nuts.prototype.onUpdateWin = function(req, res, next) {
    var that = this;

    var fullUrl = getFullUrl(req);
    var platform = 'win_32';
    var channel = req.params.channel || '*';
    var tag = req.params.version;

    that.init()
    .then(function() {
        platform = platforms.detect(platform);

        return that.versions.filter({
            tag: '>='+tag,
            platform: platform,
            channel: channel
        });
    })
    .then(function(versions) {
        // Update needed?
        var latest = _.first(versions);
        if (!latest) throw new Error("Version not found");

        // File exists
        var asset = _.find(latest.platforms, {
            filename: 'RELEASES'
        });
        if (!asset) throw new Error("File not found");

       return that.backend.readAsset(asset)
       .then(function(content) {
            var releases = winReleases.parse(content.toString('utf-8'));

            releases = _.chain(releases)

                // Change filename to use download proxy
                .map(function(entry) {
                    var gitFilePath = (channel === '*' ? '../../../../' : '../../../../../../');
                    entry.filename = urljoin(fullUrl, gitFilePath, '/download/'+entry.semver+'/'+entry.filename);

                    return entry;
                })

                .value();

            var output = winReleases.generate(releases);

            res.header('Content-Length', output.length);
            res.attachment("RELEASES");
            res.send(output);
       });
    })
    .fail(next);
};

// Serve releases notes
Nuts.prototype.onServeNotes = function(req, res, next) {
    var that = this;
    var tag = req.params.version;

    Q()
    .then(function() {
        return that.versions.filter({
            tag: tag? '>='+tag : '*',
            channel: '*'
        });
    })
    .then(function(versions) {
        var latest = _.first(versions);

        if (!latest) throw new Error('No versions matching');

        res.format({
            'text/plain': function(){
                res.send(notes.merge(versions));
            },
            'application/json': function(){
                res.send({
                    "notes": notes.merge(versions, { includeTag: false }),
                    "pub_date": latest.published_at.toISOString()
                });
            },
            'default': function() {
                res.send(releaseNotes);
            }
        });
    })
    .fail(next);
};

// Handle crash reports
Nuts.prototype.onCrashReport = function(req, res, next) {
    if (!process.env.POSTMARK_API_KEY || !process.env.SEND_CRASH_REPORTS_FROM || !process.env.SEND_CRASH_REPORTS_TO) return
    var form = new multiparty.Form()

    form.parse(req, (err, fields, files) => {
      if (err) { return next(err) }

      if (files.upload_file_minidump && fields.email) {
        let file = files.upload_file_minidump[0]
        let email = fields.email ? fields.email[0] : ''
        let _process = fields.process ? fields.process[0] : ''
        let platform = fields.platform ? fields.platform[0] : ''

        postmark.sendMail({
          from: process.env.SEND_CRASH_REPORTS_FROM,
          to: process.env.SEND_CRASH_REPORTS_TO,
          subject: fields.email ? `New Crash Report | ${email}` : 'New Crash Report',
          headers: {
            References: fields.email ? `<electron/crash-reports/${email}@missiveapp.com>` : `<electron/crash-reports/${req.ip}@missiveapp.com>`
          },
          text: [
            `User: ${email}`,
            `Process: ${_process}`,
            `Platform: ${platform}`,
            `IP: ${req.ip}`,
            '',
            `${fields._productName ? fields._productName[0] : ''} (${fields._version ? fields._version[0] : ''})`,
            `${fields.prod ? fields.prod[0] : ''} (${fields.ver ? fields.ver[0] : ''})`,
          ].join('\n'),
          attachments: [{
            filename: file.originalFilename,
            content: fs.readFileSync(file.path),
          }]
        }, (err, result) => {
          if (err) return next(err)

          console.log('Sent to postmark for delivery:', result)
          res.send('OK')
        })
      } else {
        next(new Error('Invalid breakpad upload'))
      }
    })
};

// Serve versions list as RSS
Nuts.prototype.onServeVersionsFeed = function(req, res, next) {
    var that = this;
    var channel = req.params.channel || 'all';
    var channelId = channel === 'all'? '*' : channel;
    var fullUrl = getFullUrl(req);

    var feed = new Feed({
        id: 'versions/channels/'+channel,
        title: 'Versions (' + channel + ')',
        link: fullUrl
    });

    Q()
    .then(function() {
        return that.versions.filter({
            channel: channelId
        });
    })
    .then(function(versions) {
        _.each(versions, function(version) {
            feed.addItem({
                title: version.tag,
                link:  urljoin(fullUrl, '/../../../', '/download/version/'+version.tag),
                description: version.notes,
                date: version.published_at,
                author: []
            });
        });

        res.set('Content-Type', 'application/atom+xml; charset=utf-8');
        res.send(feed.render('atom-1.0'));
    })
    .fail(next);
};

// Control access to the API
Nuts.prototype.onAPIAccessControl = function(req, res, next) {
    this.performQ('api', {
        req: req,
        res: res
    })
    .then(function() {
        next();
    }, next);
};


module.exports = Nuts;
