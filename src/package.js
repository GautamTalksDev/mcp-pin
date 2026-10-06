'use strict';
/*
 * Which package a server command runs, and whether that is pinned.
 *
 * A server's definitions can stay identical while its code changes:
 * `npx -y some-server` runs whatever version is newest on every start. The
 * definition check cannot see that, so mcp-pin lock also records the exact
 * version and the registry's digest of it, lock --check reports when either
 * moves, and the proxy runs the locked version.
 *
 *   npm:  npx, npm exec, pnpm dlx, yarn dlx, bunx   (name, name@1.2.3, @scope/name@tag)
 *   PyPI: uvx, uv tool run, pipx run                (name, name@1.2.3, name==1.2.3)
 *   OCI:  docker run, podman run                    (pinned only by @sha256: digest)
 */
const path = require('path');

const EXACT = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PY_EXACT = /^\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?$/;

// A version taken from a registry answer or a lock file ends up on a command
// line, so it must be a plain version number (or an image digest): never a
// tag, range, path, URL or git spec, which a runner would fetch from
// somewhere else.
const NPM_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/;

function plainVersion(ecosystem, version) {
  const v = String(version);
  if (ecosystem === 'npm') return NPM_VERSION.test(v);
  if (ecosystem === 'pypi') return PY_EXACT.test(v);
  if (ecosystem === 'oci') return OCI_DIGEST.test(v);
  return false;
}

function base(command) {
  return path.basename(String(command || '')).toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, '');
}

// Flags that take a value, per runner. Anything else starting with "-" is a switch.
const NPM_VALUE = new Set(['--prefix', '--registry', '--cache', '--userconfig', '-w', '--workspace', '--loglevel', '--node-options', '--call', '-c']);
const UV_VALUE = new Set(['--from', '--with', '--with-requirements', '--with-editable', '-p', '--python', '--index', '--index-url', '--default-index',
  '--extra-index-url', '-i', '--find-links', '-f', '--refresh-package', '--reinstall-package', '--upgrade-package', '-P', '--constraints', '-c',
  '--overrides', '--build-constraints', '-b', '--env-file', '--cache-dir', '--directory', '--project', '--config-file', '--color', '--python-preference']);
const PIPX_VALUE = new Set(['--spec', '--python', '--index-url', '-i', '--pip-args', '--backend', '--fetch-missing-python']);
const DOCKER_VALUE = new Set(['-e', '--env', '--env-file', '-v', '--volume', '--mount', '--name', '--network', '--net', '-p', '--publish', '--entrypoint',
  '-w', '--workdir', '-u', '--user', '-l', '--label', '--label-file', '--platform', '--pull', '--cpus', '-m', '--memory', '--add-host', '--cap-add',
  '--cap-drop', '--security-opt', '--device', '--gpus', '-h', '--hostname', '--ipc', '--pid', '--runtime', '--shm-size', '--tmpfs', '--ulimit', '--dns',
  '--restart', '--log-driver', '--log-opt', '-a', '--attach', '--cidfile', '--group-add', '--expose', '--stop-signal', '--stop-timeout', '--userns',
  '--uts', '--volumes-from', '--health-cmd', '--isolation', '--memory-swap', '--cpu-shares', '-c', '--cgroupns', '--cgroup-parent', '--network-alias']);

// The first positional argument from `start`, skipping switches and the
// values of flags that take one. Returns its index, or -1.
function positional(args, start, valueFlags) {
  for (let i = start; i < args.length; i++) {
    const a = String(args[i]);
    if (a === '--') return i + 1 < args.length ? i + 1 : -1;
    if (a.startsWith('-')) {
      if (!a.includes('=') && valueFlags.has(a)) i++;
      continue;
    }
    return i;
  }
  return -1;
}

function flagValue(args, names) {
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    for (const n of names) {
      if (a === n && i + 1 < args.length) return { index: i + 1, value: String(args[i + 1]) };
      if (a.startsWith(n + '=')) return { index: i, value: a.slice(n.length + 1), prefix: n + '=' };
    }
  }
  return null;
}

function npmSpec(spec) {
  const m = /^(@[a-z0-9][\w.-]*\/[\w.-]+|[a-z0-9][\w.-]*)(?:@(.*))?$/i.exec(spec);
  if (!m) return null; // a path, a URL, a git spec: not a registry package
  const ver = m[2] === undefined ? '' : m[2];
  return { name: m[1], requested: ver, version: EXACT.test(ver) ? ver.replace(/^v/, '') : null };
}

function pySpec(spec) {
  const m = /^([A-Za-z0-9][\w.-]*)(\[[^\]]*\])?(?:(@|==)(.*)|([<>=!~].*))?$/.exec(spec);
  if (!m) return null;
  const ver = m[4] !== undefined ? m[4] : '';
  const range = m[5] || '';
  return { name: m[1], extras: m[2] || '', requested: ver || range, version: !range && PY_EXACT.test(ver) ? ver : null };
}

// What package this command runs, or null when it is not one mcp-pin knows.
//   { ecosystem, runner, name, requested, version, pinned, index, registry? }
// `index` is where the spec sits in args, so the proxy can pin it.
function packageOf(command, args) {
  args = Array.isArray(args) ? args.map(String) : [];
  const b = base(command);
  let runner = null;
  let start = 0;
  if (b === 'npx' || b === 'bunx') runner = b;
  else if (b === 'npm' && (args[0] === 'exec' || args[0] === 'x')) { runner = 'npm exec'; start = 1; }
  else if ((b === 'pnpm' || b === 'yarn') && args.includes('dlx')) { runner = b + ' dlx'; start = args.indexOf('dlx') + 1; }
  else if (b === 'bun' && args[0] === 'x') { runner = 'bunx'; start = 1; }
  else if (b === 'uvx') runner = 'uvx';
  else if (b === 'uv' && args[0] === 'tool' && args[1] === 'run') { runner = 'uvx'; start = 2; }
  else if (b === 'pipx' && args[0] === 'run') { runner = 'pipx'; start = 1; }
  else if ((b === 'docker' || b === 'podman') && (args[0] === 'run' || (args[0] === 'container' && args[1] === 'run'))) {
    runner = b;
    start = args[0] === 'run' ? 1 : 2;
  }
  if (!runner) return null;

  if (runner === 'docker' || runner === 'podman') {
    const i = positional(args, start, DOCKER_VALUE);
    if (i === -1) return null;
    const image = args[i];
    const digest = /@(sha256:[0-9a-f]{64})$/.exec(image);
    return { ecosystem: 'oci', runner, name: image.replace(/@sha256:[0-9a-f]{64}$/, ''), requested: image, version: digest ? digest[1] : null, pinned: !!digest, index: i };
  }

  if (runner === 'uvx' || runner === 'pipx') {
    const from = flagValue(args.slice(start), runner === 'uvx' ? ['--from'] : ['--spec']);
    const i = from ? start + from.index : positional(args, start, runner === 'uvx' ? UV_VALUE : PIPX_VALUE);
    if (i === -1) return null;
    const raw = from ? from.value : args[i];
    const p = pySpec(raw);
    if (!p) return null;
    return { ecosystem: 'pypi', runner, name: p.name, extras: p.extras, requested: p.requested, version: p.version, pinned: !!p.version, index: i, viaFlag: !!from, prefix: from && from.prefix };
  }

  // npm family: an explicit --package wins over the first positional.
  const pkgFlag = flagValue(args.slice(start), ['--package', '-p']);
  const i = pkgFlag ? start + pkgFlag.index : positional(args, start, NPM_VALUE);
  if (i === -1) return null;
  const raw = pkgFlag ? pkgFlag.value : args[i];
  const p = npmSpec(raw);
  if (!p) return null;
  const reg = flagValue(args, ['--registry']);
  return Object.assign({ ecosystem: 'npm', runner, name: p.name, requested: p.requested, version: p.version, pinned: !!p.version, index: i, prefix: pkgFlag && pkgFlag.prefix },
    reg ? { registry: reg.value } : {});
}

// The same arguments with the package pinned to `version`, or null when
// this form cannot be pinned in place (a pipx positional, uvx with extras).
function pinnedArgs(args, pkg, version) {
  if (!plainVersion(pkg.ecosystem, version)) return null;
  let spec = null;
  if (pkg.ecosystem === 'npm') spec = pkg.name + '@' + version;
  else if (pkg.ecosystem === 'oci') spec = pkg.name + '@' + version; // image[:tag]@sha256:...
  else if (pkg.ecosystem === 'pypi' && pkg.viaFlag) spec = pkg.name + (pkg.extras || '') + '==' + version; // --from, --spec: a requirement
  else if (pkg.ecosystem === 'pypi' && pkg.runner === 'uvx' && !pkg.extras) spec = pkg.name + '@' + version; // uvx name@version
  if (!spec) return null;
  const out = args.map(String);
  out[pkg.index] = (pkg.prefix || '') + spec;
  return out;
}

/* ------------------------------------------------------------ registries */

function npmRegistry(pkg) {
  return String(pkg.registry || process.env.MCP_PIN_NPM_REGISTRY || process.env.npm_config_registry || 'https://registry.npmjs.org').replace(/\/+$/, '');
}

function pypiIndex() {
  return String(process.env.MCP_PIN_PYPI_URL || 'https://pypi.org').replace(/\/+$/, '');
}

async function getJson(url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: ctl.signal });
    if (r.status === 404) throw Object.assign(new Error('not found in the registry'), { notFound: true });
    if (!r.ok) throw new Error('registry answered ' + r.status);
    return await r.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('registry did not answer in ' + timeoutMs / 1000 + ' s');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// The exact version a spec resolves to now, with the registry's digest of it.
//   npm:  { version, integrity }               (dist.integrity, sha512)
//   PyPI: { version, files: [{ filename, sha256 }] }
// A version range cannot be resolved without the semver rules of each
// runner, so it is refused: pin an exact version or a tag instead.
async function resolve(pkg, timeoutMs = 15000) {
  if (pkg.ecosystem === 'npm') {
    const want = pkg.version || pkg.requested || 'latest';
    if (!pkg.version && !/^[a-z][\w.-]*$/i.test(want)) throw new Error(`"${pkg.requested}" is a version range; pin an exact version`);
    const name = pkg.name.startsWith('@') ? '@' + encodeURIComponent(pkg.name.slice(1)) : encodeURIComponent(pkg.name);
    const m = await getJson(`${npmRegistry(pkg)}/${name}/${encodeURIComponent(want)}`, timeoutMs);
    if (!m || typeof m.version !== 'string') throw new Error('registry answer has no version');
    if (!NPM_VERSION.test(m.version)) throw new Error('the registry answered a version that is not a plain version number');
    return { version: m.version, integrity: (m.dist && m.dist.integrity) || null };
  }
  if (pkg.ecosystem === 'pypi') {
    if (!pkg.version && pkg.requested && pkg.requested !== 'latest') throw new Error(`"${pkg.requested}" is a version range; pin an exact version`);
    const m = await getJson(`${pypiIndex()}/pypi/${encodeURIComponent(pkg.name)}/${pkg.version ? encodeURIComponent(pkg.version) + '/' : ''}json`, timeoutMs);
    if (!m || !m.info || typeof m.info.version !== 'string') throw new Error('index answer has no version');
    if (!PY_EXACT.test(m.info.version)) throw new Error('the index answered a version that is not a plain version number');
    const files = (Array.isArray(m.urls) ? m.urls : [])
      .map((u) => ({ filename: String(u.filename), sha256: u.digests && u.digests.sha256 }))
      .filter((f) => f.sha256)
      .sort((a, b) => (a.filename < b.filename ? -1 : 1));
    return { version: m.info.version, files };
  }
  return null; // OCI: pinned by digest in the command, or not at all
}

// One line for a person: what runs, and whether it can change under them.
function describe(pkg) {
  if (pkg.pinned) return `${pkg.name} ${pkg.ecosystem === 'oci' ? pkg.version.slice(0, 19) : pkg.version} (pinned)`;
  const what = pkg.ecosystem === 'oci' ? 'image tag' : pkg.requested && pkg.requested !== 'latest' ? `"${pkg.requested}"` : 'newest version';
  return `${pkg.name}, ${what}: not pinned, so its code can change on any start`;
}

module.exports = { packageOf, pinnedArgs, plainVersion, resolve, describe };
