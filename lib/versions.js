var _ = require('lodash');
var Q = require('q');
var semver = require('semver');

var platforms = require('./utils/platforms');

/**
 * Normalize the given tag
 * @param {string} tag The tag to normalize
 * @param {string | undefined} tagNameFilter a tag name filter which must be parsable as RegEx.
 * Possible format: /.*-v(?<version>.*)/;
 * @returns {string} the string of the normalized tag
 */
function normalizeTag(tag, tagNameFilter) {
    if (tagNameFilter) {
        const regex = new RegExp(tagNameFilter);

        const matches = tag.match(regex);
        if (matches.length < 0 || !matches.groups?.version) {
            return tag;
        }

        return matches.groups.version;
    }

    if (tag[0] == 'v') return tag.slice(1);
    return tag;
}

/**
 * 
 * @param {string} tag The tag to extract the cannel from.
 * @param {string | undefined} tagNameFilter a tag name filter which must be parsable as RegEx.
 * @returns {string}
 */
function extractChannel(tag, tagNameFilter) {
    function getSuffix(str) {
        const suffix = str.split('-')?.[1];
        if (!suffix) return 'stable';
    
        return suffix.split('.')[0];
    }

    if (!tagNameFilter) {
        return getSuffix(tag);
    }

    const regex = new RegExp(tagNameFilter);

    const matches = tag.match(regex);
    if (matches.length < 0 || !matches.groups?.version) {
        return 'stable';
    }

    return getSuffix(matches.groups.version);
}

// Normalize a release to a version
function normalizeVersion(release, tagNameFilter) {
    // Ignore draft
    if (release.draft) return null;

    if (tagNameFilter) {
        const regex = new RegExp(tagNameFilter);

        if (!regex.test(release.tag_name)) {
            return null;
        }
    }

    var downloadCount = 0;
    var releasePlatforms = _.chain(release.assets)
        .map(function(asset) {
            var platform = platforms.detect(asset.name);
            if (!platform) return null;

            downloadCount = downloadCount + asset.download_count;
            return {
                id: String(asset.id),
                type: platform,
                filename: asset.name,
                size: asset.size,
                content_type: asset.content_type,
                raw: asset
            };
        })
        .compact()
        .value();

    return {
        version: normalizeTag(release.tag_name, tagNameFilter),
        tag: normalizeTag(release.tag_name, tagNameFilter).split('-')[0],
        channel: extractChannel(release.tag_name, tagNameFilter),
        notes: release.body || "",
        published_at: new Date(release.published_at),
        platforms: releasePlatforms
    };
}

// Compare two version
function compareVersions(v1, v2) {
    if (semver.gt(v1.tag, v2.tag)) {
        return -1;
    }
    if (semver.lt(v1.tag, v2.tag)) {
        return 1;
    }
    return 0;
}
class Versions {
    constructor(backend, tagNameFilter) {
        this.backend = backend;
        this.tagNameFilter = tagNameFilter;
    }

    // List versions normalized
    list() {
        return this.backend.releases()
        .then((releases) => {
            return _.chain(releases)
                .map((r) => normalizeVersion(r, this.tagNameFilter))
                .compact()
                .sort(compareVersions)
                .value();
        });
    }

    //  Get a specific version by its tag
    get(tag) {
        return this.resolve({
            tag: tag
        });
    };

    // Filter versions with criterias
    filter(opts) {
        opts = _.defaults(opts || {}, {
            tag: 'latest',
            platform: null,
            channel: 'stable'
        });
        if (opts.platform) opts.platform = platforms.detect(opts.platform);

        return this.list()
        .then(function(versions) {
            return _.chain(versions)
                .filter(function(version) {
                    // Check channel
                    if (opts.channel != '*' && version.channel != opts.channel) return false;

                    // Not available for requested paltform
                    if (opts.platform && !platforms.satisfies(opts.platform, _.pluck(version.platforms, 'type'))) return false;

                    // Check tag satisfies request version
                    return opts.tag == 'latest' || semver.satisfies(version.tag, opts.tag);
                })
                .value();
        });
    };

    // Resolve a platform, by filtering then taking the first result
    resolve(opts) {
        return this.filter(opts)
        .then(function(versions) {
            var version = _.first(versions);
            if (!version) throw new Error('Version not found: '+opts.tag);

            return version;
        });
    };

    // List all channels from releases
    channels(opts) {
        return this.list()
        .then(function(versions) {
            var channels = {};

            _.each(versions, function(version) {
                if (!channels[version.channel]) {
                    channels[version.channel] = {
                        latest: null,
                        versions_count: 0,
                        published_at: 0
                    };
                }

                channels[version.channel].versions_count += 1;
                if (channels[version.channel].published_at < version.published_at) {
                    channels[version.channel].latest = version.tag;
                    channels[version.channel].published_at = version.published_at;
                }
            });

            return channels;
        });
    };
}

module.exports = Versions;
