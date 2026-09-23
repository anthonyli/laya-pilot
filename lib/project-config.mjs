import fs from 'node:fs/promises';
import path from 'node:path';

// Shell variables take precedence. The file is local-only and is never
// evaluated as shell code or copied into reports.
export async function loadLocalEnvironment(root) {
  const file = path.join(root, '.env.local');
  let source;
  try { source = await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const allowed = new Set(['TEST_PASSWORD','LAYA_API_KEY','LAYA_API_BASE','LAYA_API_MODEL','LAYA_PYTHON','LAYA_MODEL','TEST_USER','TEST_URL','LAYA_PROVIDER','BROWSER_PROVIDER','BROWSER_CHANNEL','BROWSER_HEADLESS']);
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || !allowed.has(match[1])) throw Error(`Invalid .env.local entry on line ${index + 1}`);
    let value = match[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
    if (process.env[match[1]] === undefined && value) process.env[match[1]] = value;
  }
}

export async function loadProjectConfig(file) {
  if (!file) return {};
  const value = JSON.parse(await fs.readFile(path.resolve(file), 'utf8'));
  if (!value || Array.isArray(value) || typeof value !== 'object') throw Error('--config must contain a JSON object');
  const allowed = new Set(['url','excel','user','python','model','provider','apiBase','apiModel','apiTimeout','browserProvider','browserChannel','headless','templateExcel','caseFile','out','language']);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) throw Error('Unknown config keys: ' + unknown.join(', '));
  return value;
}

export function configured(arg, cli, env, file, fallback) {
  const cliValue = arg(cli, undefined);
  return cliValue ?? (env ? process.env[env] : undefined) ?? file ?? fallback;
}

export function configuredFlag(args, name, env, file, fallback = false) {
  if (args.includes(name)) return true;
  if (args.includes('--headed') && name === '--headless') return false;
  const value = (env ? process.env[env] : undefined) ?? file ?? fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw Error(`${name} must be true or false`);
}
