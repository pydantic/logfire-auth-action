// Tag a release from package.json's version.
//
// Creates an immutable `vX.Y.Z` tag and force-moves the major (`vX`) and minor
// (`vX.Y`) alias tags to it, then pushes them. Run `pnpm run release` after
// bumping `version` in package.json (and with a clean, CI-green tree).
//
//   pnpm run release            # tag + push
//   pnpm run release --dry-run  # print the git commands without running them
//
// Pushes to `origin` by default; override with RELEASE_REMOTE=<remote>.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const dryRun = process.argv.includes('--dry-run');
const remote = process.env.RELEASE_REMOTE || 'origin';

function git(args, { capture = false } = {}) {
  return execFileSync('git', args, {
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
  });
}

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`package.json version "${version}" is not a clean X.Y.Z`);
}

const [major, minor] = version.split('.');
const vFull = `v${version}`;
const vMajor = `v${major}`;
const vMinor = `v${major}.${minor}`;

// Refuse to release from a dirty tree (also ensures dist/ is committed).
if (git(['status', '--porcelain'], { capture: true }).trim()) {
  fail('working tree is not clean — commit or stash changes first');
}

// Never clobber an existing immutable version tag.
if (git(['tag', '--list', vFull], { capture: true }).trim()) {
  fail(`tag ${vFull} already exists — bump "version" in package.json first`);
}

console.log(`Releasing ${vFull}  (moving aliases ${vMajor}, ${vMinor})\n`);

const run = (args) => {
  console.log(`+ git ${args.join(' ')}`);
  if (!dryRun) git(args);
};

run(['tag', '-a', vFull, '-m', vFull]);
run(['tag', '-fa', vMajor, '-m', vFull]);
run(['tag', '-fa', vMinor, '-m', vFull]);
run(['push', remote, vFull]);
run(['push', remote, vMajor, vMinor, '--force']);

console.log(
  dryRun
    ? '\nDry run — nothing pushed.'
    : `\nPushed ${vFull}, ${vMajor}, ${vMinor} to ${remote}.\n` +
        `Publish notes with:  gh release create ${vFull} --generate-notes --title ${vFull}`,
);
