#!/usr/bin/env node
import 'source-map-support/register';

import { App } from 'aws-cdk-lib';

import { configuredAccountIds, devConfig, toolingAccountId } from '../lib/config';
import { SharedRegistryStage } from '../lib/ecommerce-stage';
import { RegistryLocation } from '../lib/stacks/ecr-stack';

/**
 * The platform team's entry point: deploys ONLY the shared container registry (`acme-ecr`).
 *
 *   npx cdk --app "npx ts-node --prefer-ts-exts bin/registry.ts" deploy 'registry/**'
 *
 * Ownership follows the multi-team boundary: the registry is a tooling resource that every
 * service pulls from, so it is owned and deployed by the platform team, not by a service's app
 * and not by an environment. It lives in `ACME_TOOLING_ACCOUNT` (required) - until Organizations
 * provisions `acme-tooling`, set it to the one real account. `ACME_REGISTRY_REGION` overrides the
 * region; the platform's home region is the default.
 *
 * Service deploys (`bin/ecommerce.ts`) only need the registry's LOCATION to build image ARNs -
 * they never deploy it themselves.
 */
const app = new App();

const registry: RegistryLocation = {
  account: toolingAccountId(),
  region: process.env.ACME_REGISTRY_REGION ?? devConfig.region,
};

new SharedRegistryStage(app, 'registry', {
  registry,
  pullAccountIds: configuredAccountIds(),
});
