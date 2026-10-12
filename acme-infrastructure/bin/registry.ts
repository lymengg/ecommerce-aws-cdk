#!/usr/bin/env node
import 'source-map-support/register';

import { App } from 'aws-cdk-lib';

import { configuredAccountIds, getEnvironmentConfig } from '../lib/config';
import { SharedRegistryStage } from '../lib/ecommerce-stage';
import { RegistryLocation } from '../lib/stacks/ecr-stack';

/**
 * The platform team's entry point: deploys ONLY the shared container registry (`acme-ecr`).
 *
 *   npx cdk --app "npx ts-node --prefer-ts-exts bin/registry.ts" deploy 'registry/**'
 *
 * Ownership follows the multi-team boundary: the registry is a platform resource that every
 * service pulls from, so it gets its own deployer rather than riding inside a service's app.
 * Service deploys (`bin/ecommerce.ts`) only need the registry's LOCATION to build image ARNs -
 * they never deploy it themselves.
 *
 * The registry lives in `ACME_REGISTRY_ACCOUNT` / `ACME_REGISTRY_REGION`, defaulting to the dev
 * account today - the tooling-account migration is setting those two variables plus a redeploy
 * once `acme-tooling` exists.
 */
const app = new App();

const dev = getEnvironmentConfig('dev');
const registry: RegistryLocation = {
  account: process.env.ACME_REGISTRY_ACCOUNT ?? dev.account,
  region: process.env.ACME_REGISTRY_REGION ?? dev.region,
};

new SharedRegistryStage(app, 'registry', {
  registry,
  pullAccountIds: configuredAccountIds(),
});
