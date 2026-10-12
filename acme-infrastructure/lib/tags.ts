import { Stack, Tags } from 'aws-cdk-lib';

import { EnvironmentConfig } from './config/types';

/** Project every resource belongs to. */
export const PROJECT_TAG = 'Ecommerce';

/** Tool that manages the resource. */
export const MANAGED_BY_TAG = 'CDK';

/**
 * Applies the platform tag contract at stack level. CDK propagates stack level tags to every
 * resource it creates - including resources added by later phases - so the tags never have to be
 * repeated per resource, and every stack tags its resources identically.
 */
export function applyPlatformTags(stack: Stack, config: EnvironmentConfig): void {
  Tags.of(stack).add('Project', PROJECT_TAG);
  Tags.of(stack).add('Environment', config.environment);
  Tags.of(stack).add('ManagedBy', MANAGED_BY_TAG);
}
