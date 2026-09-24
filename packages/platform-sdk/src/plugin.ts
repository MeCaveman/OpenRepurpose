import { z } from 'zod';
import type { PluginJsonValue } from './types.js';

/** The semver-major compatibility boundary implemented by this SDK package. */
export const OPENREPURPOSE_PLUGIN_API_VERSION = '1.0.0' as const;

export type PluginCapability =
  | {
      readonly id: string;
      readonly jobType: string;
      readonly kind: 'destination';
    }
  | {
      readonly id: string;
      readonly kind: 'media_transform' | 'source' | 'transcription_provider';
    };

export interface PluginConfigurationSchema {
  readonly [key: string]: PluginJsonValue;
  readonly type: 'object';
}

export type PluginFilesystemRoot = 'app_data' | 'media' | 'plugin_data' | 'temp';
export type PluginPermissionAccess = 'delete' | 'read' | 'write';

export interface PluginPermissions {
  /** Executable names, never command strings. Empty means no child-process permission. */
  readonly childProcesses: readonly string[];
  readonly filesystem: readonly {
    readonly access: readonly Extract<PluginPermissionAccess, 'read' | 'write'>[];
    readonly root: PluginFilesystemRoot;
  }[];
  /** Exact lower-case hosts or `*.example.com` subdomain patterns. */
  readonly networkHosts: readonly string[];
  readonly secrets: readonly {
    readonly access: readonly PluginPermissionAccess[];
    readonly name: string;
    readonly scope: 'account' | 'application';
  }[];
}

export interface PluginManifest {
  readonly capabilities: readonly PluginCapability[];
  /** JSON Schema object for non-secret plugin configuration. */
  readonly configurationSchema: PluginConfigurationSchema;
  readonly id: string;
  readonly name: string;
  /** Supported forms: exact, caret, tilde, or a two-comparator range. */
  readonly requiredApiVersion: string;
  readonly permissions: PluginPermissions;
  readonly version: string;
}

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const rangePattern =
  /^(?:\^|~)?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$|^>=(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*) <(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const idPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const hostPattern = /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

const jsonValueSchema: z.ZodType<PluginJsonValue> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.null(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const capabilitySchema = z.discriminatedUnion('kind', [
  z
    .object({
      id: z.string().regex(idPattern),
      jobType: z.string().regex(idPattern),
      kind: z.literal('destination'),
    })
    .strict(),
  z.object({ id: z.string().regex(idPattern), kind: z.literal('source') }).strict(),
  z.object({ id: z.string().regex(idPattern), kind: z.literal('transcription_provider') }).strict(),
  z.object({ id: z.string().regex(idPattern), kind: z.literal('media_transform') }).strict(),
]);

const permissionAccessSchema = z.enum(['delete', 'read', 'write']);

export const pluginManifestSchema = z
  .object({
    capabilities: z.array(capabilitySchema).min(1),
    configurationSchema: z.object({ type: z.literal('object') }).catchall(jsonValueSchema),
    id: z.string().min(1).max(128).regex(idPattern),
    name: z.string().trim().min(1).max(128),
    permissions: z
      .object({
        childProcesses: z.array(z.string().trim().min(1).max(128)),
        filesystem: z.array(
          z
            .object({
              access: z.array(z.enum(['read', 'write'])).min(1),
              root: z.enum(['app_data', 'media', 'plugin_data', 'temp']),
            })
            .strict(),
        ),
        networkHosts: z.array(z.string().regex(hostPattern)),
        secrets: z.array(
          z
            .object({
              access: z.array(permissionAccessSchema).min(1),
              name: z.string().min(1).max(128).regex(idPattern),
              scope: z.enum(['account', 'application']),
            })
            .strict(),
        ),
      })
      .strict(),
    requiredApiVersion: z.string().regex(rangePattern),
    version: z.string().regex(semverPattern),
  })
  .strict()
  .superRefine((manifest, context) => {
    const capabilityKeys = new Set<string>();
    const destinationJobTypes = new Set<string>();
    for (const capability of manifest.capabilities) {
      const key = `${capability.kind}:${capability.id}`;
      if (capabilityKeys.has(key))
        context.addIssue({ code: 'custom', message: `Duplicate plugin capability: ${key}` });
      capabilityKeys.add(key);
      if (capability.kind === 'destination') {
        if (destinationJobTypes.has(capability.jobType))
          context.addIssue({
            code: 'custom',
            message: `Duplicate destination job type: ${capability.jobType}`,
          });
        destinationJobTypes.add(capability.jobType);
      }
    }
    for (const values of [manifest.permissions.childProcesses, manifest.permissions.networkHosts]) {
      if (new Set(values).size !== values.length)
        context.addIssue({
          code: 'custom',
          message: 'Plugin permissions must not contain duplicates.',
        });
    }
    const filesystemRoots = new Set<string>();
    for (const permission of manifest.permissions.filesystem) {
      if (filesystemRoots.has(permission.root))
        context.addIssue({
          code: 'custom',
          message: `Duplicate filesystem permission root: ${permission.root}`,
        });
      filesystemRoots.add(permission.root);
      if (new Set(permission.access).size !== permission.access.length)
        context.addIssue({
          code: 'custom',
          message: `Duplicate filesystem access for root: ${permission.root}`,
        });
    }
    const secretKeys = new Set<string>();
    for (const permission of manifest.permissions.secrets) {
      const key = `${permission.scope}:${permission.name}`;
      if (secretKeys.has(key))
        context.addIssue({ code: 'custom', message: `Duplicate secret permission: ${key}` });
      secretKeys.add(key);
      if (new Set(permission.access).size !== permission.access.length)
        context.addIssue({ code: 'custom', message: `Duplicate secret access: ${key}` });
    }
  });

export function parsePluginManifest(value: unknown): PluginManifest {
  return pluginManifestSchema.parse(value);
}

interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function parseSemver(value: string): Semver | undefined {
  const match = semverPattern.exec(value);
  if (match === null) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareSemver(left: Semver, right: Semver): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

/** Evaluates only the deliberately small range grammar accepted by the manifest schema. */
export function isPluginApiCompatible(
  requiredRange: string,
  apiVersion: string = OPENREPURPOSE_PLUGIN_API_VERSION,
): boolean {
  const api = parseSemver(apiVersion);
  if (api === undefined || !rangePattern.test(requiredRange)) return false;
  if (requiredRange.startsWith('>=')) {
    const [minimumText, maximumText] = requiredRange.split(' ');
    const minimum = parseSemver(minimumText!.slice(2));
    const maximum = parseSemver(maximumText!.slice(1));
    return (
      minimum !== undefined &&
      maximum !== undefined &&
      compareSemver(api, minimum) >= 0 &&
      compareSemver(api, maximum) < 0
    );
  }
  const operator = requiredRange[0];
  const base = parseSemver(
    operator === '^' || operator === '~' ? requiredRange.slice(1) : requiredRange,
  );
  if (base === undefined) return false;
  if (operator === '^') {
    const maximum =
      base.major > 0
        ? { major: base.major + 1, minor: 0, patch: 0 }
        : base.minor > 0
          ? { major: 0, minor: base.minor + 1, patch: 0 }
          : { major: 0, minor: 0, patch: base.patch + 1 };
    return compareSemver(api, base) >= 0 && compareSemver(api, maximum) < 0;
  }
  if (operator === '~')
    return (
      compareSemver(api, base) >= 0 &&
      compareSemver(api, { major: base.major, minor: base.minor + 1, patch: 0 }) < 0
    );
  return compareSemver(api, base) === 0;
}

export type PluginOrigin = 'bundled' | 'third_party';

export interface PluginLoadPolicy {
  readonly thirdParty: 'advanced' | 'disabled';
}

export const DEFAULT_PLUGIN_LOAD_POLICY: PluginLoadPolicy = { thirdParty: 'disabled' };

export type PluginLoadDecision =
  | { readonly allowed: true; readonly warning?: string }
  | {
      readonly allowed: false;
      readonly code: 'API_INCOMPATIBLE' | 'THIRD_PARTY_DISABLED' | 'TRUST_ACKNOWLEDGEMENT_REQUIRED';
      readonly reason: string;
    };

/**
 * Policy gate to run after parsing a manifest and before importing any plugin module. This is not a
 * sandbox: an allowed third-party plugin executes in-process with the application's privileges.
 */
export function evaluatePluginLoad(options: {
  readonly acknowledgedInProcessRisk?: boolean;
  readonly manifest: PluginManifest;
  readonly origin: PluginOrigin;
  readonly policy?: PluginLoadPolicy;
}): PluginLoadDecision {
  if (!isPluginApiCompatible(options.manifest.requiredApiVersion))
    return {
      allowed: false,
      code: 'API_INCOMPATIBLE',
      reason: `Plugin requires API ${options.manifest.requiredApiVersion}; host provides ${OPENREPURPOSE_PLUGIN_API_VERSION}.`,
    };
  if (options.origin === 'bundled') return { allowed: true };
  if ((options.policy ?? DEFAULT_PLUGIN_LOAD_POLICY).thirdParty === 'disabled')
    return {
      allowed: false,
      code: 'THIRD_PARTY_DISABLED',
      reason: 'Third-party plugin loading is disabled by default.',
    };
  if (options.acknowledgedInProcessRisk !== true)
    return {
      allowed: false,
      code: 'TRUST_ACKNOWLEDGEMENT_REQUIRED',
      reason:
        'Advanced plugin loading requires an explicit in-process code-execution acknowledgement.',
    };
  return {
    allowed: true,
    warning:
      'This plugin executes trusted code in-process with the same operating-system privileges as OpenRepurpose.',
  };
}
