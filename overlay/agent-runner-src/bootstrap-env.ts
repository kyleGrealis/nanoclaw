/**
 * Container startup bootstrap.
 *
 * Replaces the work formerly done in /app/entrypoint.sh, which never runs
 * because the host overrides ENTRYPOINT with `bash -c "exec bun ..."`. Each
 * block is wrapped in try/catch so a single failure doesn't block startup.
 *
 *   1. Register this container's uid in /etc/passwd. SSH's getpwuid() needs
 *      a passwd entry to resolve $HOME / ~/.ssh; Docker's user-namespace
 *      mapping can hand us an arbitrary uid that isn't pre-listed.
 *   2. Wire SSH credentials from the read-only andy-ssh mount into ~/.ssh/.
 *   3. Set git identity so `git commit` doesn't fail "Author identity unknown."
 */
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';

function log(msg: string): void {
  console.error(`[bootstrap-env] ${msg}`);
}

function registerUidInPasswd(): void {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    log('skipping /etc/passwd registration — no uid/gid available');
    return;
  }
  const passwd = readFileSync('/etc/passwd', 'utf8');
  const alreadyRegistered = passwd
    .split('\n')
    .some((line) => line.split(':')[2] === String(uid));
  if (alreadyRegistered) return;
  appendFileSync('/etc/passwd', `node:x:${uid}:${gid}:node:/home/node:/bin/bash\n`);
  log(`registered uid ${uid} in /etc/passwd`);
}

function wireSshCredentials(): void {
  const src = '/workspace/extra/andy-ssh';
  if (!existsSync(src)) return;
  const home = process.env.HOME || '/home/node';
  const dst = `${home}/.ssh`;
  mkdirSync(dst, { recursive: true, mode: 0o700 });
  const files: { name: string; mode: number }[] = [
    { name: 'config',         mode: 0o600 },
    { name: 'id_ed25519',     mode: 0o600 },
    { name: 'id_ed25519.pub', mode: 0o644 },
    { name: 'andy-github',    mode: 0o600 },
    { name: 'known_hosts',    mode: 0o644 },
  ];
  let copied = 0;
  for (const { name, mode } of files) {
    const srcFile = `${src}/${name}`;
    const dstFile = `${dst}/${name}`;
    if (!existsSync(srcFile)) continue;
    copyFileSync(srcFile, dstFile);
    chmodSync(dstFile, mode);
    copied++;
  }
  chmodSync(dst, 0o700);
  log(`wired ${copied} ssh files into ${dst}`);
}

function configureGitIdentity(): void {
  spawnSync('git', ['config', '--global', 'user.email', 'kyl3gr3alis@gmail.com']);
  spawnSync('git', ['config', '--global', 'user.name', 'Kyle Grealis']);
  log('git identity configured');
}

const STEPS = [
  ['registerUidInPasswd', registerUidInPasswd],
  ['wireSshCredentials', wireSshCredentials],
  ['configureGitIdentity', configureGitIdentity],
] as const;

for (const [name, fn] of STEPS) {
  try {
    fn();
  } catch (e) {
    log(`${name} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
