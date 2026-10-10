#!/usr/bin/env node
import 'source-map-support/register';

import { App } from 'aws-cdk-lib';

import { configuredAccountIds, getEnvironmentConfig, resolveEnvironmentName } from '../lib/config';
import { PlatformStage, SharedRegistryStage } from '../lib/ecommerce-stage';
import { RegistryLocation } from '../lib/stacks/ecr-stack';

const app = new App();

// The environment is selected by CDK context (`cdk deploy -c environment=prod`, defaulting to the
// value in cdk.json) or by the ENVIRONMENT variable, falling back to dev. See lib/config/index.ts.
const environment = resolveEnvironmentName(app);
const config = getEnvironmentConfig(environment);

// One registry serves every environment (Phase 8): images are built once and promoted, not
// rebuilt per environment. The registry lives in `ECOMMERCE_REGISTRY_ACCOUNT` /
// `ECOMMERCE_REGISTRY_REGION`, defaulting to the selected environment's own account and region -
// which keeps a same-account manual deploy working with no extra configuration.
const registry: RegistryLocation = {
  account: process.env.ECOMMERCE_REGISTRY_ACCOUNT ?? config.account,
  region: process.env.ECOMMERCE_REGISTRY_REGION ?? config.region,
};

// The platform is two stages rather than a flat list of stacks so the same code drives both a
// manual `cdk deploy` and the Phase 8 pipeline: the registry stage is what the pipeline's image
// build step needs to exist before it can push, and the platform stage is everything that consumes
// the pushed images. In a manual deploy both are created here and `cdk deploy 'dev*'` updates
// them; in the pipeline the build step sits between the registry stage and the first environment.
//
// Stack names are explicit inside the stages, so the deployed stacks keep the names they were
// created with (`ecommerce-network-dev`, ...) even though their construct paths are now
// stage-scoped (`dev/ecommerce-network-dev`).
new SharedRegistryStage(app, 'registry', {
  registry,
  pullAccountIds: configuredAccountIds(),
});

new PlatformStage(app, environment, {
  env: { account: config.account, region: config.region },
  config,
  registry,
});

// The registry must exist (and hold the image tag being deployed) before the platform deploys:
// no construct link expresses that across stages, so it is a deploy-order contract instead -
// `cdk deploy 'registry/**'` first, then `cdk deploy 'dev/**'`. The pipeline encodes the same
// order with a build step between the two stages.
