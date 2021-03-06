/*
 *   Copyright 2014-2015 Guy Bedford (http://guybedford.com)
 *
 *   Licensed under the Apache License, Version 2.0 (the "License");
 *   you may not use this file except in compliance with the License.
 *   You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 *   Unless required by applicable law or agreed to in writing, software
 *   distributed under the License is distributed on an "AS IS" BASIS,
 *   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *   See the License for the specific language governing permissions and
 *   limitations under the License.
 */

var Promise = require('rsvp').Promise;
var path = require('path');
var nodeSemver = require('semver');
var ui = require('./ui');
var config = require('./config');
var ep = require('./endpoint');
var build = require('./build');
var PackageName = require('./config/package-name');
var fs = require('graceful-fs');
var mkdirp = require('mkdirp');
var rimraf = require('rimraf');
var ncp = require('ncp');
var asp = require('rsvp').denodeify;
var System = require('systemjs');
var install = require('./install');


var core = module.exports;

// we always download the latest semver compatible version
var lVersions = {
  esml: '^0.14.0',
  system: '^0.14.0'
};

var tPackages = {
  babel: 'npm:babel@^4.7.12',
  'babel-runtime': 'npm:babel-runtime@^4.7.12',
  traceur: 'github:jmcriffey/bower-traceur@0.0.87',
  'traceur-runtime': 'github:jmcriffey/bower-traceur-runtime@0.0.87'
};

exports.run = function(moduleName) {
  return config.load()
  .then(function() {
    var cfg = config.loader.getConfig();
    delete cfg.bundles;
    cfg.baseURL = config.pjson.baseURL;
    System.config(cfg);

    return System.import(moduleName);
  })
  .catch(function(e) {
    ui.log('err', e.stack || e);
  });
};

exports.build = function() {
  var saveConfig = false;

  return config.load()
  .then(function() {
    if (config.pjson.buildConfig.transpileES6 === undefined) {
      saveConfig = true;
      return ui.confirm('Transpile ES6?', true);
    }
  })
  .then(function(doTranspile) {
    if (doTranspile)
      config.pjson.buildConfig.transpileES6 = true;

    if (!config.pjson.buildConfig || config.pjson.buildConfig.minify === undefined) {
      saveConfig = true;
      return ui.confirm('Minify?', true);
    }
  })
  .then(function(doMinify) {
    if (doMinify)
      config.pjson.buildConfig.minify = true;

    if (saveConfig)
      return config.save();
  })
  .then(function() {
    return asp(rimraf)(config.pjson.dist);
  })
  .then(function() {
    return asp(ncp)(config.pjson.lib, config.pjson.dist);
  })
  .then(function() {
    return build.compileDir(config.pjson.dist, {
      format: config.pjson.format,
      map: config.pjson.map,
      transpile: config.pjson.buildConfig.transpileES6,
      minify: config.pjson.buildConfig.minify,
      removeJSExtensions: config.pjson.useJSExtensions
    });
  })
  .then(function(compileErrors) {
    if (compileErrors)
      ui.log('warn', 'Compile Errors:\n' + compileErrors);
    else
      ui.log('ok', 'Build Completed');
  }, function(err) {
    ui.log('err', err.stack || err);
  });
};

exports.setMode = function(modes) {
  if (!(modes instanceof Array))
    modes = [modes];

  var msg = '';

  return config.load()
  .then(function() {
    if (modes.indexOf('local') === -1)
      return true;

    // set local
    Object.keys(config.loader.endpoints).forEach(function(e) {
      config.loader.endpoints[e].setLocal();
    });

    msg += 'Loader set to local library sources\n';
  })
  .then(function(unmatched) {
    if (modes.indexOf('remote') === -1)
      return unmatched;

    // set remote
    Object.keys(config.loader.endpoints).forEach(function(e) {
      config.loader.endpoints[e].setRemote();
    });

    msg += 'Loader set to CDN library sources\n';
  })
  .then(function(unmatched) {
    if (unmatched)
      return ui.log('warn', 'Invalid mode');

    return config.save()
    .then(function() {
      return msg;
    });
  });
};

exports.dlTranspiler = function(transpilerName, update) {
  return config.load()
  .then(function() {
    var installObj = {};

    transpilerName = transpilerName || config.loader.transpiler || 'traceur';

    // read existing transpiler from package.json install
    var target = config.pjson.devDependencies[transpilerName] || config.pjson.dependencies[transpilerName];
    if (target)
      installObj[transpilerName] = target.exactName;
    else
      installObj[transpilerName] = transpilerName === 'traceur' ? tPackages.traceur : tPackages.babel;

    target = config.pjson.devDependencies[transpilerName + '-runtime'] || config.pjson.dependencies[transpilerName + '-runtime'];
    if (target)
      installObj[transpilerName + '-runtime'] = target.exactName;
    else
      installObj[transpilerName + '-runtime'] = transpilerName === 'traceur' ? tPackages['traceur-runtime'] : tPackages['babel-runtime'];

    // just do a quick install which checks basic existence
    return install.install(installObj, { quick: !update, dev: true, summary: false });
  })
  .then(function() {
    if (config.loader.transpiler !== transpilerName) {
      config.loader.transpiler = transpilerName;
      ui.log('ok', 'ES6 transpiler set to %' + transpilerName + '%.');
    }
    if (transpilerName === 'babel')
      if (!config.loader.babelOptions.optional)
        config.loader.babelOptions.optional = ['runtime'];
    return config.save();
  });
};

// check and download module loader files
exports.checkDlLoader = function(transpilerName) {
  return config.load()
  .then(function() {
    return asp(fs.readFile)(path.resolve(config.pjson.packages, '.loaderversions'));
  })
  .catch(function(err) {
    if (err.code === 'ENOENT')
      return '';
    throw err;
  })
  .then(function(cacheVersions) {
    if (cacheVersions.toString() !== [lVersions.esml, lVersions.system].join(','))
      return exports.dlLoader(transpilerName);

    // even if version file is fresh, still check files exist
    return asp(fs.readdir)(config.pjson.packages)
    .catch(function(err) {
      if (err.code === 'ENOENT')
        return [];
      throw err;
    })
    .then(function(files) {
      if (files.indexOf('system.js') === -1 || files.indexOf('es6-module-loader.js') === -1)
        return exports.dlLoader(transpilerName);
      return exports.dlTranspiler(transpilerName);
    });
  });
};

// mini endpoint API usage implementation
var loaderFilesCacheDir = path.join(config.HOME, '.jspm', 'loader-files');

function dl(name, repo, version) {
  var pkg = new PackageName(repo);
  var endpoint = ep.load(pkg.endpoint);
  var vMatch, vMatchLookup;
  var dlDir = path.resolve(loaderFilesCacheDir, name);

  return endpoint.lookup(pkg.package)
  .then(function(lookup) {
    if (!(nodeSemver.validRange(version)))
      vMatch = version;
    else
      vMatch = Object.keys(lookup.versions)
      .filter(nodeSemver.valid)
      .sort(nodeSemver.compare).reverse()
      .filter(function(v) {
        return nodeSemver.satisfies(v, version);
      })[0];

    vMatchLookup = lookup.versions[vMatch];

    return asp(fs.readFile)(path.resolve(dlDir, '.hash'))
    .then(function(_hash) {
      return _hash.toString() === vMatchLookup.hash;
    }, function (e) {
      if (e.code === 'ENOENT')
        return;
      throw e;
    });
  })
  .then(function(cached) {
    if (cached)
      return;

    return endpoint.download(pkg.package, vMatch, vMatchLookup.hash, vMatchLookup.meta, dlDir)
    .then(function() {
      return fs.writeFile(path.resolve(dlDir, '.hash'), vMatchLookup.hash);
    });
  })
  .then(function() {
    return vMatch;
  });
}

// file copy implementation
function cp(file, name, transform) {
  return asp(fs.readFile)(path.resolve(loaderFilesCacheDir, file)).then(function(source) {
    if (transform)
      source = transform(source.toString());
    ui.log('info', '  `' + name + '`');
    return asp(fs.writeFile)(path.resolve(config.pjson.packages, name), source);
  });
}

exports.dlLoader = function(transpilerName, unminified, edge) {
  ui.log('info', 'Looking up loader files...');
  var min = unminified ? '.src' : '';

  var using = {};

  return config.load()
  .then(function() {
    return asp(mkdirp)(config.pjson.packages);
  })
  .then(function() {
    // delete old versions
    return asp(fs.readdir)(config.pjson.packages);
  })
  .then(function(files) {
    return Promise.all(files.filter(function(file) {
      return file.match(/^(system-csp|system|es6-module-loader|traceur|babel)/);
    }).map(function(file) {
      return asp(fs.unlink)(path.resolve(config.pjson.packages, file));
    }));
  })
  .then(function() {
    return Promise.all([
      dl('esml', 'github:ModuleLoader/es6-module-loader', !edge ? lVersions.esml : 'master')
      .then(function(version) {
        using.esml = version;
        return Promise.all([
          cp('esml/dist/es6-module-loader' + min + '.js', 'es6-module-loader.js'),
          unminified || cp('esml/dist/es6-module-loader.src.js', 'es6-module-loader.src.js'),
          unminified || cp('esml/dist/es6-module-loader.js.map', 'es6-module-loader.js.map')
        ]);
      }),
      dl('systemjs', 'github:systemjs/systemjs', !edge ? lVersions.system : 'master')
      .then(function(version) {
        using.system = version;
        return Promise.all([
          cp('systemjs/dist/system' + min + '.js', 'system.js'),
          unminified || cp('systemjs/dist/system.src.js', 'system.src.js'),
          unminified || cp('systemjs/dist/system.js.map', 'system.js.map')
        ]);
      })
    ]);
  })
  .then(function() {
    ui.log('info', '\nUsing loader versions:');
    ui.log('info', '  `es6-module-loader@' + using.esml + '`');
    ui.log('info', '  `systemjs@' + using.system + '`');

    return asp(fs.writeFile)(path.resolve(config.pjson.packages, '.loaderversions'), [lVersions.esml, lVersions.system].join(','));
  })
  .then(function() {
    return exports.dlTranspiler(transpilerName, true);
  })
  .then(function() {
    ui.log('ok', 'Loader files downloaded successfully');
  }, function(err) {
    ui.log('err', 'Error downloading loader files \n' + (err.stack || err));
  });
};

exports.init = function init(basePath, ask) {
  if (basePath)
    process.env.jspmConfigPath = path.resolve(basePath, 'package.json');
  var relBase = path.relative(process.cwd(), path.dirname(process.env.jspmConfigPath));
  if (relBase !== '')
    ui.log('info', 'Initializing package at `' + relBase + '/`\nUse %jspm init .% to intialize into the current folder.');
  return config.load(ask)
  .then(function() {
    return config.save();
  })
  .then(function() {
    ui.log('ok', 'Verified package.json at %' + path.relative(process.cwd(), config.pjsonPath) + '%\nVerified config file at %' + path.relative(process.cwd(), config.pjson.configFile) + '%');
  })
  .then(function() {
    return core.checkDlLoader();
  })
  .catch(function(err) {
    ui.log('err', err.stack || err);
  });
};
