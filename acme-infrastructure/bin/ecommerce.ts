#!/usr/bin/env node
import 'source-map-support/register';

import { App } from 'aws-cdk-lib';

import { getEnvironmentConfig, resolveEnvironmentName } from '../lib/config';
import { EcommerceStage } from '../lib/ecommerce-stage';
import { RegistryLocation } from '../lib/stacks/ecr-stack';

const app = new App();

// The environment is selected by CDK context (`cdk deploy -c environment=prod`, defaulting to the
// value in cdk.json) or by the ENVIRONMENT variable, falling back to dev. See lib/config/index.ts.
const environment = resolveEnvironmentName(app);
const config = getEnvironmentConfig(environment);

// The service team's entry point deploys ONLY the ecommerce service's stacks. Two things it does
// NOT own, both platform resources deployed by other entry points:
// - the shared registry (`bin/registry.ts`, ACME_TOOLING_ACCOUNT), referenced here by location so
//   stacks can build image ARNs - the environment's own account is the fallback for a
//   single-account setup;
// - the network and DNS foundation (`bin/platform.ts`, acme-network/acme-dns), imported by the
//   stacks via the `acme-<env>-*` CloudFormation exports - deploy that entry point first.
const registry: RegistryLocation = {
  account: process.env.ACME_TOOLING_ACCOUNT ?? config.account,
  region: process.env.ACME_REGISTRY_REGION ?? config.region,
};

// Stack names are explicit inside the stage, so the deployed stacks keep the names they were
// created with (`ecommerce-database-dev`, ...) even though their construct paths are stage-scoped
// (`dev/ecommerce-database-dev`).
new EcommerceStage(app, environment, {
  env: { account: config.account, region: config.region },
  config,
  registry,
});
