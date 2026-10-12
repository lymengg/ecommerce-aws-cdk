#!/usr/bin/env node
import 'source-map-support/register';

import { App } from 'aws-cdk-lib';

import { getEnvironmentConfig, resolveEnvironmentName } from '../lib/config';
import { PlatformStage } from '../lib/ecommerce-stage';
import { RegistryLocation } from '../lib/stacks/ecr-stack';

const app = new App();

// The environment is selected by CDK context (`cdk deploy -c environment=prod`, defaulting to the
// value in cdk.json) or by the ENVIRONMENT variable, falling back to dev. See lib/config/index.ts.
const environment = resolveEnvironmentName(app);
const config = getEnvironmentConfig(environment);

// The service team's entry point deploys ONLY the environment's stacks. The shared registry is a
// platform-owned resource - deployed once via `bin/registry.ts` into ACME_TOOLING_ACCOUNT,
// referenced here by location so the stacks can build image ARNs. The environment's own account
// is the fallback so a single-account setup still deploys with zero extra configuration.
const registry: RegistryLocation = {
  account: process.env.ACME_TOOLING_ACCOUNT ?? config.account,
  region: process.env.ACME_REGISTRY_REGION ?? config.region,
};

// Stack names are explicit inside the stage, so the deployed stacks keep the names they were
// created with (`ecommerce-network-dev`, ...) even though their construct paths are stage-scoped
// (`dev/ecommerce-network-dev`).
new PlatformStage(app, environment, {
  env: { account: config.account, region: config.region },
  config,
  registry,
});
