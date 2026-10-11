// Spec 001 / issue #17: the deployed Worker bundle must not contain Node-only or removed upstream code.
// Usage: node scripts/check-bundle.mjs <bundle directory>  (after `wrangler deploy --dry-run --outdir <dir>`)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN = [
  [/\bmd5\s*\(/, 'md5 hashing'],
  [/node-rsa|NodeRSA/, 'node-rsa encryption'],
  [/require\(["'](crypto|fs|request|request-promise)["']\)|from ["']node:(crypto|fs)["']/, 'Node built-in or request'],
  [/rest\.akismet\.com|google\.com\/recaptcha|api\.mailgun\.net/i, 'removed upstream service endpoint'],
  [/staticman\.net/i, 'staticman.net link'],
];

const directory = process.argv[2];
if (!directory) throw new Error('Usage: node scripts/check-bundle.mjs <bundle directory>');

const files = [];
const walk = (path) => {
  for (const name of readdirSync(path)) {
    const full = join(path, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(m?js)$/.test(name)) files.push(full);
  }
};
walk(directory);
if (!files.length) throw new Error(`No JavaScript found in ${directory}`);

const problems = files.flatMap((file) => {
  const text = readFileSync(file, 'utf8');
  return FORBIDDEN.filter(([pattern]) => pattern.test(text)).map(([, label]) => `${file}: ${label}`);
});
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`Bundle clean: ${files.length} file(s) checked.`);
