/*
 * Copyright 2026 The Buildish Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { validateAbsoluteExecutablePath } from '../../../util/fs';
import { buildMinimalChildEnv } from '../../../util/spawn';

/**
 * A pinned OpenPGP public key used to verify Gradle wrapper detached signatures.
 *
 * Key material is checked before import; verification also checks the actual signer
 * against the pinned primary and signing fingerprints.
 */
export interface TrustedOpenPgpPublicKey {
  /** ASCII-armored OpenPGP public key block. */
  readonly armoredKey: string;
  /** Expected full 40-hex-character fingerprint for the pinned key. */
  readonly expectedFingerprint: string;
  /** Expected signing subkey fingerprint; omitted when the primary key signs directly. */
  readonly expectedSigningFingerprint?: string;
}

/**
 * Trust allowlist for Gradle wrapper detached-signature verification.
 *
 * Rotation guidance:
 * - Only pin keys that are published at https://gradle.org/keys/.
 * - Keep old and new trusted keys here concurrently during Gradle key rotation.
 * - Remove a retired key only after it no longer signs supported wrapper versions.
 */
export const GRADLE_TRUSTED_SIGNING_KEY_ALLOWLIST: readonly TrustedOpenPgpPublicKey[] = [
  {
    // From: https://gradle.org/keys/
    expectedFingerprint: '1BD97A6A154E7810EE0BC832E2F38302C8075E3D',
    armoredKey: `-----BEGIN PGP PUBLIC KEY BLOCK-----

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
f7TkwC6aybc=
=B8WW
-----END PGP PUBLIC KEY BLOCK-----`,
  },
  {
    // From: https://gradle.org/keys/ (current primary key and dedicated signing subkey).
    expectedFingerprint: 'EA96F38569C044AAEF7FCF732887F479B0B9771A',
    expectedSigningFingerprint: 'F3FF33E96F18AA62DD580F9651FBF517CE6D6B80',
    armoredKey: `-----BEGIN PGP PUBLIC KEY BLOCK-----

mQINBGp/ZGMBEADM118E6S6vw+Wc/TZYZ4iQHnBESWhkEptRL6fLK2tJ9/jpEbz5
xfFiUGFmLzs9PaUhMbo8Uas+OZ9SSxiRPizzrpByvblfCSvDixaeFTZnwIMB9a4l
XlfedtzXr34KTmj4ww8ubRWAQ155von5QYB+txw/gN/3Dn2tVs8Ib6N+MYAVdKZ/
891JEk7wQgbwEmUMN7+fU1F0PL4R5Ye1k+vTTcq59Zw45NiScV9qS9S6v8U5Eujg
qlC8rs6Z7iKtus55FYKdY4Yybk0jltV23eXyGMHil5ZClPf5XFqQuDT7cAwjKW6i
tAsiA7OOZOXEfEHUF2L1ULCjDUi48EKDIxvWJN4HzE6cCaWuJPCF/3MDiag1YndG
gqkmsaWPUaQW3oeoLHQkmJTTxoA/iixyVKGRiYoAs0x1BDFwvE4WbOKRKGxPeN5m
VGROEISCJBGGLU1w4b8S5lBIK40pNb6nWVVWyQDoBSdntKKV/Id7y/MtD2elSg8a
1hqhQ5VGbYJ7tUO4YKPTFXRYuRGfTGN6RjeBPVp0GFA9CEr/fzlSLNEk3cf2mSJA
+Orjlsl/YAR7Wm1OUtsVKM8CvcWbnN8HUCWGl7+4HdRaOSMDxOf4j2E3Xdf3Nilv
xfVqgnlBPSGwhLVw3wfdbrdWI7dLSBRphHG0pHXR8BAK4Wff1rkdKcdNJwARAQAB
tClHcmFkbGUgSW5jLiA8bWF2ZW4tcHVibGlzaGluZ0BncmFkbGUuY29tPokCUQQT
AQgAOxYhBOqW84VpwESq73/PcyiH9HmwuXcaBQJqf2RjAhsBBQsJCAcCAiICBhUK
CQgLAgQWAgMBAh4HAheAAAoJECiH9HmwuXca1VgQAMtVDa32E42Hqpx191vjHwUu
o7vDrM1ue3hGEBDR/O5ysupmol11QRr17ocKn3D/YbSSwM/BucZrgMppvbbuFSR9
OxpfWbmLsqJjIci9bumoD3G3onjylPXvl5p1kcR+AgwCveBCknbhNhr9LlcmBP1Z
PgTx+GHBqKZp3ecKbA1Omer1zLW8rkIFSwRBFgBnIJPgE0uRx2kVcoqxs6lBwbjF
iPIpDDD0mGA/ihAd/GmhFw6pvYsJfQgGX7JN6n88b7a2pgyxNe4x4hB9ol5ZDMab
f7lC7436j6XYgN9m4Fl8dCaPl4df8zpZmz4tgv1pl6Yi9C2xycq4bDsvSkHK3Bky
yRN7TKaQUPAdJ3+6waB32GuiqiQEBOrxMn2uanh4PUBDJFmOQGXvsvZVRJ50FlwJ
x7XTbjbfu7yvLPH323lvKy5JsTgS8qVZyV2JacE01ZfcIZg30QMh/0xIMcHzK2/Y
1wbnmwZt9zd3in/jXKRzrwXTZDk3B5kxx/do7AL3SKrUTUnb5undSXLx1s0kCxHZ
vJtvIoXrssekVdzbxdnu5btqhuUCBNJqHCa16gV0PjnJYsTFgBd6IE4yi+Z8YzYZ
oAUq0yqeRXu/qIEdnN/3TE5SKVj+DcRGtRrdgvk5x1/zwGvd10BFvyP/G6Abehzi
U/YehWqZdUQEzSibYf3ZuQINBGp/ZGMBEADE2+MUFZJ1kzggFUFuPzAUij+AnSoE
SjhHQklhr8snxgVatBokLRAZBzF24/dvi93rXtERBBS6xmdO/7agyatWCHcqFitH
KG8zcK4jElkxAkBl22ZJ9J3XuUsiAVr1qyfCpd1BcX1DXYFBU1Ic8fl9oFaQFCKG
TfuRV/ecKv9Pu+yQmQM1Fe8O724fNL5t3e7P63ZGUh0B/uB93A+PluwPm1KkHHgj
wyARhlVLiFsc6oQjbq/Vy83j0mj1EFpED1Wi9KMVGfbjXsiqh/TwqoRw19UL3ZHm
giUK0SPl+QVVVP9JILQs24VEdqdN6FpVho4IVF3pORB016WXrn/lhzVE6c3g+xRo
+NrVIt7uGrDgRyYZLDBlGPmNiNFpt72Vdap1qr4hpZEylLl7lmpxQ6XUTbhC6/TT
WiKJuCOCdumt51Wj6McIqwh7i97F+HVbfol5vARHEg9yoO0Vz8XHgrwAHtqAn2WX
b1cNyT8vwmO7nmBjed5EnTxsatLUaag4rZm8aRjwrxXD20afiYdlZvp0H2LfEQ1U
QhdQjMzZ0FQkBo/okU27ra/C9d6q+NoIA6GVm/fNeAnHJCeFgPP2LH6wPM6oJTdn
gPEPzORBwqeQ/k/gPu7bngduUNOyMkNBdu581prUe9NWXAGT+zR6soGFBOO7oGEh
mL0x8QJm9fGq1wARAQABiQRsBBgBCAAgFiEE6pbzhWnARKrvf89zKIf0ebC5dxoF
Amp/ZGMCGwICQAkQKIf0ebC5dxrBdCAEGQEIAB0WIQTz/zPpbxiqYt1YD5ZR+/UX
zm1rgAUCan9kYwAKCRBR+/UXzm1rgBNoEACLQWyS7eLOpmvp0KgcKvzYSgGWDFt3
GcnEteUMEegqj/lejhwRun1FPX5Txa9VLP8gGw8X9l0OU+AhI8CFJdXjQIqaQhLv
ozMbKBoNXEgsAzX0Nk/g0suO9P5x2spuRY89A47lXlONNjJDK1Ko9cmgRI9SDkXu
oVl3Ad8Jec7HmTDVvCv6ieQF9hVsySGf9DKZVSKZ3qn442sc65YB2EYXXMet335s
HYt1xGFksD0vOJtyqvqosCj46kRRAXYXJ6U4fgeGn3aF+ZVjfEDlFFPUzOCMr7oK
ocJMJ3GjvA1ndxL+HqdsgLDG2C82SOhgvP0cQGlAjFqeomEq/hEJS/Jeu8UuiEn2
lYLA2K6OLVaE/LRro9RJ3JAQHoTRn3PYIee1UDydhZ5OunLvHsjFIkIxYFR2P+A9
I9Uu5pMRrHmh5Xka+ak003cmpNFxXKs3cWvYM7ayeLXrnLWBlzjFtqnkU3NerH3O
ntmMDMM/qfvLioet79rUzfUC5axydDYvLWD7ZwjreuBrseLZnrHGgsPYdsDOgNHB
I5EUs6fn0MucM+N1LwK14jHIhNeon/XiWvNI3W6QKzrgxwq/l5WE8NZN/gIkR+Yt
ldqPXSnOE5+VBjkCMjEnM/haOD7SEC+F0LDRIurH0mBKp3YWxYsn0B+4RoJ5cnq+
cNuhb9Z6s+77Xl14D/0Yr1bdhBMyjEw75CrKfPBxhEk1rank2LQqTGlKs6edFP3d
xMz/R6CJ6DcUZFkSKRHoGk+BaDttBs7cgPVkKs8O2zj/CyBH9TZyuYaB50qw8q16
o/SA1LpgMTlKdnKPWW8058qwy+LZBuFT3YBTQbUoNFUF3/sb1jXEgnTDGjweWBQS
ryJaY7vtxF+dVe+NLj62dr9PUOp/DPtJC0ckTHLY8VOSB1rhNyV0psJTEayDBK50
EOdxhbJhvDco4zRIct5rGE0lTu7E0ieYD1xnz+1w3vDnMufQkZx2yF7TlugH63sO
Oot1le1LnremhzDvDjOKXd/nFUq0yoRHADovdYW154Llcrfq+Zg05GVbonWfwET0
H+t2GQuvmbAWECH/t2p0AsY5sstoV3LQ2V/H78acMSLzsOO4uh7jgdNvxxihTvx8
eRxb9E9TG2X6IGSn1EdjqB3kV6RIHhIp9X/ugssV/G8RHK99SQ41tndpV7HqN5G7
SENI8UQ9NIImutzUvvSDbmZGLt0Rzlt6wCG3WRl9Kj5/NubDxcs5dK+yvormynxW
4GiL3zdQzq9/+Bxdjk5oRiYmwyKrCUhmqY4DIHHqmpSzOsyWBPWwcgo95eqWMAJZ
VVDIR2SSyRqMC81OGZmcAWuvMeQaLx9qJMairb3vUxvotHCypbz34pbT+YKyIQ==
=V8Ww
-----END PGP PUBLIC KEY BLOCK-----`,
  },
];

interface GpgCommandOptions {
  readonly command?: string;
  /** Environment variable map used for `RUNNER_TEMP` resolution; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

interface CompletedCommand {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^([A-Za-z]):[\\/](.*)$/u;

let gradleTrustedPublicKeysPromise: Promise<readonly TrustedOpenPgpPublicKey[]> | undefined;
let validatedGpgCommandPromise: Promise<string> | undefined;

/**
 * Resolves the GnuPG executable name used for detached-signature verification.
 *
 * On Windows, `BUILDISH_MAMMOTH_CACHE_GRADLE_GPG_COMMAND` may be set to an
 * absolute path when the CI runner has multiple GPG installations (e.g. Git for
 * Windows MSYS `gpg.exe` alongside Gpg4win). The override is **ignored on
 * non-Windows platforms** where `gpg` is reliably on `PATH` and the env-var
 * override would only add unnecessary attack surface.
 *
 * This function is synchronous and returns the raw string value. Use
 * {@link resolveValidatedGpgCommand} to also validate that a Windows override
 * points to an existing regular file before it is passed to `spawn()`.
 */
export function resolveDefaultGpgCommand(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === 'win32') {
    const override = env.BUILDISH_MAMMOTH_CACHE_GRADLE_GPG_COMMAND?.trim();
    if (override) {
      return override;
    }
  }

  return platform === 'win32' ? 'gpg.exe' : 'gpg';
}

/**
 * Resolves the Windows GnuPG executable to an absolute, validated path so path
 * conversion and execution use the same binary. An explicit override takes
 * precedence; otherwise the first regular gpg.exe on PATH is used.
 *
 * The result is cached for the real process environment. Non-Windows platforms
 * use 'gpg' and ignore the override.
 */
export async function resolveValidatedGpgCommand(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (platform !== 'win32') {
    return 'gpg';
  }

  if (env === process.env) {
    validatedGpgCommandPromise ??= resolveWindowsGpgCommand(env);
    return await validatedGpgCommandPromise;
  }
  return await resolveWindowsGpgCommand(env);
}

async function resolveWindowsGpgCommand(env: NodeJS.ProcessEnv): Promise<string> {
  const override = env.BUILDISH_MAMMOTH_CACHE_GRADLE_GPG_COMMAND?.trim();
  if (override) {
    return await validateAbsoluteExecutablePath(
      override,
      'BUILDISH_MAMMOTH_CACHE_GRADLE_GPG_COMMAND',
    );
  }

  const searchPath = Object.entries(env).find(([name]) => name.toUpperCase() === 'PATH')?.[1];
  for (const entry of (searchPath ?? '').split(';')) {
    const directory = entry.trim().replace(/^"(.*)"$/u, '$1');
    if (!directory) continue;
    const candidate = path.resolve(directory, 'gpg.exe');
    try {
      if (!(await stat(candidate)).isFile()) continue;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw error;
    }
    return await validateAbsoluteExecutablePath(candidate, 'GnuPG executable on PATH');
  }
  throw new Error(
    "GnuPG command 'gpg.exe' is required for Gradle wrapper detached-signature verification but was not found on PATH. Install GnuPG or set BUILDISH_MAMMOTH_CACHE_GRADLE_GPG_COMMAND to its absolute path.",
  );
}

/**
 * Git-for-Windows `usr/bin/gpg.exe` is an MSYS build that expects `/c/...`
 * style paths. Convert Windows absolute paths only for that binary.
 */
export function normalizePathForGpgCommand(
  filePath: string,
  command: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') {
    return filePath;
  }

  const resolvedCommand = command?.trim() || resolveDefaultGpgCommand(platform);
  const normalizedCommand = resolvedCommand.replaceAll('\\', '/').toLowerCase();
  if (!normalizedCommand.endsWith('/usr/bin/gpg.exe')) {
    return filePath;
  }

  const windowsPathMatch = filePath.match(WINDOWS_ABSOLUTE_PATH_PATTERN);
  if (!windowsPathMatch) {
    return filePath.replaceAll('\\', '/');
  }

  const [, driveLetter, remainder] = windowsPathMatch;
  return `/${driveLetter.toLowerCase()}/${remainder.replaceAll('\\', '/')}`;
}

/**
 * Validates and returns the entries in `trustedKeyAllowlist` after verifying that each
 * key's actual GnuPG fingerprint matches its declared `expectedFingerprint`.
 *
 * Throws when the allowlist is empty, any key has an invalid or mismatched fingerprint, or
 * any fingerprint appears more than once (duplicate-key guard).
 *
 * @param options - GnuPG command overrides for testing.
 * @returns The validated allowlist entries in their original order.
 */
export async function loadTrustedOpenPgpPublicKeys(
  trustedKeyAllowlist: readonly TrustedOpenPgpPublicKey[],
  options: GpgCommandOptions = {},
): Promise<readonly TrustedOpenPgpPublicKey[]> {
  if (trustedKeyAllowlist.length === 0) {
    throw new Error('At least one trusted OpenPGP public key must be configured.');
  }

  const fingerprints = new Set<string>();

  return await Promise.all(
    trustedKeyAllowlist.map(async (trustedKey, index) => {
      const expectedFingerprint = normalizeFingerprint(trustedKey.expectedFingerprint);
      if (expectedFingerprint.length !== 40) {
        throw new Error(`Trusted OpenPGP key ${index + 1} has an invalid expected fingerprint.`);
      }

      const { primaryFingerprint: actualFingerprint, subkeyFingerprints } =
        await readArmoredKeyFingerprints(trustedKey.armoredKey, options.command, options.env);

      if (actualFingerprint !== expectedFingerprint) {
        throw new Error(
          `Trusted OpenPGP key ${index + 1} fingerprint mismatch. Expected ${expectedFingerprint}, found ${actualFingerprint}.`,
        );
      }

      if (trustedKey.expectedSigningFingerprint !== undefined) {
        const signingFingerprint = normalizeFingerprint(trustedKey.expectedSigningFingerprint);
        if (signingFingerprint.length !== 40 || !subkeyFingerprints.includes(signingFingerprint)) {
          throw new Error(`Trusted OpenPGP key ${index + 1} signing fingerprint mismatch.`);
        }
      }

      if (fingerprints.has(actualFingerprint)) {
        throw new Error(
          `Trusted OpenPGP fingerprint ${actualFingerprint} was configured more than once.`,
        );
      }

      fingerprints.add(actualFingerprint);
      return {
        armoredKey: trustedKey.armoredKey,
        expectedFingerprint: trustedKey.expectedFingerprint,
        expectedSigningFingerprint: trustedKey.expectedSigningFingerprint,
      };
    }),
  );
}

/**
 * Verifies a detached OpenPGP signature against a set of trusted public keys using GnuPG.
 *
 * Creates an isolated ephemeral GnuPG home for each call so verification calls do not share
 * mutable keyring state. The temporary directory is removed in a `finally` block regardless of
 * whether verification succeeds or fails.
 *
 * @param payload - Raw bytes of the signed resource.
 * @param armoredSignature - ASCII-armored detached signature (`.asc` content).
 * @param verificationKeys - Validated trusted keys to import; must be non-empty.
 * @param resourceDescription - Human-readable label used in error messages.
 * @param options - GnuPG command overrides for testing.
 * @throws When the signature cannot be verified by any of the trusted keys.
 */
export async function verifyDetachedOpenPgpSignature(
  payload: Uint8Array,
  armoredSignature: string,
  verificationKeys: readonly TrustedOpenPgpPublicKey[],
  resourceDescription: string,
  options: GpgCommandOptions = {},
): Promise<void> {
  if (verificationKeys.length === 0) {
    throw new Error('At least one verification key is required for detached signature checks.');
  }

  await withTemporaryGpgHome(async (gpgHome) => {
    const trustedKeysPath = path.join(gpgHome, 'trusted-keys.asc');
    const payloadPath = path.join(gpgHome, 'payload.bin');
    const signaturePath = path.join(gpgHome, 'payload.asc');
    const resolvedCommand = options.command?.trim() || (await resolveValidatedGpgCommand());

    // Use a fresh GPG home per verification so wrapper checks do not share mutable
    // keyring/trustdb state across calls or concurrent action invocations.
    await Promise.all([
      writeFile(
        trustedKeysPath,
        `${verificationKeys.map((key) => key.armoredKey.trim()).join('\n\n')}\n`,
        { encoding: 'utf8', flag: 'wx' },
      ),
      writeFile(payloadPath, payload, { flag: 'wx' }),
      writeFile(signaturePath, `${armoredSignature.trim()}\n`, { encoding: 'utf8', flag: 'wx' }),
    ]);

    // Public-key import/verification needs no agent (including on Git for Windows).
    const importResult = await runCommand(resolvedCommand, [
      '--homedir',
      normalizePathForGpgCommand(gpgHome, resolvedCommand),
      '--batch',
      '--no-options',
      '--no-autostart',
      '--import',
      normalizePathForGpgCommand(trustedKeysPath, resolvedCommand),
    ]);
    if (importResult.exitCode !== 0) {
      throw new Error(
        `Unable to import trusted OpenPGP public keys: ${formatCommandDiagnostics(importResult, 'import failed.')}`,
      );
    }

    const verificationResult = await runCommand(resolvedCommand, [
      '--homedir',
      normalizePathForGpgCommand(gpgHome, resolvedCommand),
      '--batch',
      '--no-options',
      '--no-autostart',
      '--no-auto-key-retrieve',
      '--status-fd',
      '1',
      '--verify',
      normalizePathForGpgCommand(signaturePath, resolvedCommand),
      normalizePathForGpgCommand(payloadPath, resolvedCommand),
    ]);
    // VALIDSIG reports the signing fingerprint first and the primary fingerprint last.
    const trustedSignature = verificationResult.stdout.split(/\r?\n/u).some((line) => {
      const fields = line.split(' ');
      if (fields[0] !== '[GNUPG:]' || fields[1] !== 'VALIDSIG') {
        return false;
      }
      const signingFingerprint = normalizeFingerprint(fields[2] ?? '');
      const primaryFingerprint = normalizeFingerprint(fields[11] ?? fields[2] ?? '');
      return verificationKeys.some(
        (key) =>
          primaryFingerprint === normalizeFingerprint(key.expectedFingerprint) &&
          signingFingerprint ===
            normalizeFingerprint(key.expectedSigningFingerprint ?? key.expectedFingerprint),
      );
    });
    if (verificationResult.exitCode !== 0 || !trustedSignature) {
      throw new Error(
        `Detached signature verification failed for ${resourceDescription}: ${verificationResult.exitCode === 0 ? 'signature signer did not match the pinned fingerprints.' : formatCommandDiagnostics(verificationResult, 'signature was not valid.')}`,
      );
    }
  }, options.env);
}

/**
 * Convenience wrapper that verifies a Gradle wrapper JAR detached signature against the pinned
 * {@link GRADLE_TRUSTED_SIGNING_KEY_ALLOWLIST}.
 *
 * The trusted key set is loaded and validated lazily on the first call and cached for reuse
 * across subsequent wrapper verifications within the same process.
 *
 * @throws When the signature cannot be verified by any Gradle trusted key.
 */
export async function verifyGradleDetachedSignature(
  payload: Uint8Array,
  armoredSignature: string,
  resourceDescription: string,
): Promise<void> {
  gradleTrustedPublicKeysPromise ??= loadTrustedOpenPgpPublicKeys(
    GRADLE_TRUSTED_SIGNING_KEY_ALLOWLIST,
  );
  const verificationKeys = await gradleTrustedPublicKeysPromise;
  await verifyDetachedOpenPgpSignature(
    payload,
    armoredSignature,
    verificationKeys,
    resourceDescription,
  );
}

function normalizeFingerprint(value: string): string {
  return value.replaceAll(/[^A-Fa-f0-9]/g, '').toLowerCase();
}

async function readArmoredKeyFingerprints(
  armoredKey: string,
  command: string | undefined,
  env?: NodeJS.ProcessEnv,
): Promise<{
  readonly primaryFingerprint: string;
  readonly subkeyFingerprints: readonly string[];
}> {
  return await withTemporaryGpgHome(async (gpgHome) => {
    const keyPath = path.join(gpgHome, 'trusted-key.asc');
    const resolvedCommand = command?.trim() || (await resolveValidatedGpgCommand());
    await writeFile(keyPath, `${armoredKey.trim()}\n`, { encoding: 'utf8', flag: 'wx' });

    const result = await runCommand(resolvedCommand, [
      '--homedir',
      normalizePathForGpgCommand(gpgHome, resolvedCommand),
      '--batch',
      '--no-options',
      '--show-keys',
      '--with-colons',
      '--fingerprint',
      '--fingerprint',
      normalizePathForGpgCommand(keyPath, resolvedCommand),
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `Unable to inspect trusted OpenPGP key material: ${formatCommandDiagnostics(result, 'fingerprint extraction failed.')}`,
      );
    }

    const records = result.stdout.split(/\r?\n/u).map((line) => line.trim().split(':'));
    if (records.filter((fields) => fields[0] === 'pub').length !== 1) {
      throw new Error('Trusted OpenPGP key material must contain exactly one primary key.');
    }
    const fingerprints = records
      .filter((fields) => fields[0] === 'fpr')
      .map((fields) => normalizeFingerprint(fields[9] ?? ''));
    if (
      fingerprints.length === 0 ||
      fingerprints.some((fingerprint) => fingerprint.length !== 40)
    ) {
      throw new Error('Trusted OpenPGP key material did not expose valid fingerprints.');
    }
    return { primaryFingerprint: fingerprints[0], subkeyFingerprints: fingerprints.slice(1) };
  }, env);
}

async function withTemporaryGpgHome<T>(
  callback: (gpgHome: string) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const parentDirectory = env.RUNNER_TEMP?.trim() || os.tmpdir();
  const gpgHome = await mkdtemp(path.join(parentDirectory, 'buildish-mammoth-cache-gpg-'));

  try {
    return await callback(gpgHome);
  } finally {
    await rm(gpgHome, { recursive: true, force: true });
  }
}

async function runCommand(
  command: string | undefined,
  args: readonly string[],
): Promise<CompletedCommand> {
  const resolvedCommand = command?.trim() || (await resolveValidatedGpgCommand());

  return await new Promise((resolve, reject) => {
    const child = spawn(resolvedCommand, [...args], {
      env: buildMinimalChildEnv(process.env, { LANG: 'C', LC_ALL: 'C' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      const commandError = error as NodeJS.ErrnoException;
      if (commandError.code === 'ENOENT') {
        reject(
          new Error(
            `GnuPG command '${resolvedCommand}' is required for Gradle wrapper detached-signature verification but was not found on PATH. Install GnuPG and ensure '${resolvedCommand}' is available before running this action.`,
          ),
        );
        return;
      }

      reject(
        new Error(
          `Unable to execute '${resolvedCommand} ${args.join(' ')}': ${commandError.message}`,
        ),
      );
    });
    child.on('close', (code, signal) => {
      if (signal) {
        reject(new Error(`'${resolvedCommand} ${args.join(' ')}' terminated by signal ${signal}.`));
        return;
      }

      resolve({
        exitCode: code ?? 1,
        stderr,
        stdout,
      });
    });
  });
}

function formatCommandDiagnostics(result: CompletedCommand, fallback: string): string {
  const diagnostic = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  return diagnostic || fallback;
}
