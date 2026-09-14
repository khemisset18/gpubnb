export const RELEASE_COMPATIBILITY_PROTOCOL = 1 as const;

export const RELEASE_FEATURE_PROTOCOLS = Object.freeze({
  agentRequestSignature: 2,
  hostPowerPolicy: 1,
  workspaceGateway: 1,
  supportReport: 1,
});

export type ReleaseFeatureProtocols = typeof RELEASE_FEATURE_PROTOCOLS;

export type ComponentCompatibility = {
  releaseCompatibilityProtocol: number;
  features: Partial<Record<keyof ReleaseFeatureProtocols, number>>;
};

export type CompatibilityProblem = {
  feature: keyof ReleaseFeatureProtocols | 'releaseCompatibilityProtocol';
  required: number;
  reported: number | null;
};

export type CompatibilityResult = {
  compatible: boolean;
  problems: CompatibilityProblem[];
};

export function releaseCompatibilityDescriptor(): ComponentCompatibility {
  return {
    releaseCompatibilityProtocol: RELEASE_COMPATIBILITY_PROTOCOL,
    features: { ...RELEASE_FEATURE_PROTOCOLS },
  };
}

/**
 * Compatibility is explicit and fail-closed. A missing protocol is not assumed
 * to mean "probably compatible": the caller gets a machine-readable problem and
 * can show an actionable upgrade/deployment-order message instead of silently
 * falling back to a semantically weaker behavior.
 */
export function evaluateComponentCompatibility(
  reported: ComponentCompatibility | null | undefined,
): CompatibilityResult {
  const problems: CompatibilityProblem[] = [];
  const reportedProtocol = Number.isInteger(reported?.releaseCompatibilityProtocol)
    ? Number(reported?.releaseCompatibilityProtocol)
    : null;

  if (reportedProtocol !== RELEASE_COMPATIBILITY_PROTOCOL) {
    problems.push({
      feature: 'releaseCompatibilityProtocol',
      required: RELEASE_COMPATIBILITY_PROTOCOL,
      reported: reportedProtocol,
    });
  }

  for (const [feature, required] of Object.entries(RELEASE_FEATURE_PROTOCOLS) as Array<[
    keyof ReleaseFeatureProtocols,
    number,
  ]>) {
    const value = reported?.features?.[feature];
    const normalized = Number.isInteger(value) ? Number(value) : null;
    if (normalized !== required) {
      problems.push({ feature, required, reported: normalized });
    }
  }

  return { compatible: problems.length === 0, problems };
}

export function compatibilityReason(result: CompatibilityResult): string | null {
  if (result.compatible) return null;
  const first = result.problems[0];
  if (!first) return 'release_compatibility_unknown';
  return `release_protocol_incompatible:${first.feature}:required=${first.required}:reported=${first.reported ?? 'missing'}`;
}
