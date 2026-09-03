#!/usr/bin/env node
// Runs as `prestart`, before anything from dist/ is loaded. dist/ is built for Node 22,
// so on an older Node the first thing a person would see is a syntax error from deep
// inside a bundle. Keep this file to syntax every Node since 12 can parse.
var major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  process.stderr.write(
    'Walnut needs Node.js 22 or newer, and this is Node ' + process.versions.node + '.\n\n' +
    '  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash\n' +
    '  nvm install 22\n\n' +
    'Then run the same command again.\n',
    function () { process.exit(1); },
  );
}
