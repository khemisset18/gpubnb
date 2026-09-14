import { z } from 'zod';

import {
  compatibilityReason,
  evaluateComponentCompatibility,
  releaseCompatibilityDescriptor,
  type ComponentCompatibility,
} from './release-compatibility.js';

export type ReleaseCompatibilityMode = 'observe' | 'enforce';

type ReleaseCompatibilityEnvironment = {
  GPUBNB_RELEASE_COMPATIBILITY_MODE?: string | undefined;
};

const featureSchema = z.object({
  agentRequestSignature: z.number().int().min(0).max(1024).optional(),
  hostPowerPolicy: z.number().int().min(0).max(1024).optional(),
  workspaceGateway: z.number().int().min(0).max(1024).optional(),
  supportReport: z.number().int().min(0).max(1024).optional(),
}).strict();

const descriptorSchema = z.object({
  releaseCompatibilityProtocol: z.number().int().min(0).max(1024),
  features: featureSchema,
}).strict();

export type ReleaseCompatibilityObservation = {
  schemaVersion: 1;
  observedAt: string;
  compatible: boolean;
  reason: string | null;
  reported: ComponentCompatibility | null;
  expected: ComponentCompatibility;
};

export function releaseCompatibilityMode(
  env: ReleaseCompatibilityEnvironment = process.env,
): ReleaseCompatibilityMode {
  return String(env.GPUBNB_RELEASE_COMPATIBILITY_MODE ?? 'observe').trim().toLowerCase() === 'enforce'
    ? 'enforce'
    : 'observe';
}

function normalizedFeatures(
  value: z.infer<typeof featureSchema>,
): ComponentCompatibility['features'] {
  const features: ComponentCompatibility['features'] = {};
  if (value.agentRequestSignature !== undefined) features.agentRequestSignature = value.agentRequestSignature;
  if (value.hostPowerPolicy !== undefined) features.hostPowerPolicy = value.hostPowerPolicy;
  if (value.workspaceGateway !== undefined) features.workspaceGateway = value.workspaceGateway;
  if (value.supportReport !== undefined) features.supportReport = value.supportReport;
  return features;
}

export function evaluateReportedCompatibility(value: unknown): ReleaseCompatibilityObservation {
  const parsed = descriptorSchema.safeParse(value);
  const reported: ComponentCompatibility | null = parsed.success
    ? {
      releaseCompatibilityProtocol: parsed.data.releaseCompatibilityProtocol,
      features: normalizedFeatures(parsed.data.features),
    }
    : null;
  const evaluation = evaluateComponentCompatibility(reported);
  return {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    compatible: evaluation.compatible,
    reason: compatibilityReason(evaluation),
    reported,
    expected: releaseCompatibilityDescriptor(),
  };
}
