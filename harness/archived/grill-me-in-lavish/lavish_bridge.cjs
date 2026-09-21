/* Run within npx's package environment; translate the public CLI's TOON output. */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

(async () => {
  const bins = (process.env.PATH || '').split(path.delimiter);
  const packageDir = bins.map(bin => path.resolve(bin, '..', 'lavish-axi'))
    .find(dir => fs.existsSync(path.join(dir, 'package.json')));
  if (!packageDir) throw new Error('Lavish package not found in npx environment');
  const resolver = createRequire(path.join(packageDir, 'package.json'));
  const { decode } = await import(pathToFileURL(resolver.resolve('@toon-format/toon')).href);
  const [mode, file] = process.argv.slice(2);
  if (!['open', 'poll'].includes(mode) || !file) throw new Error('Expected open|poll and an artifact path');
  const args = mode === 'open' ? [file] : [mode, file];
  const result = spawnSync(process.execPath, [path.join(packageDir, 'dist', 'cli.mjs'), ...args], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    // Lavish owns its server; the CLI stays attached to the hook while polling.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr || result.stdout || `Lavish exited ${result.status}`);
  }
  const output = decode(result.stdout.trim());
  process.stdout.write(JSON.stringify(output));
})().catch(error => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});
