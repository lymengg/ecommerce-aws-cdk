#!/usr/bin/env node
import 'source-map-support/register';

import { App } from 'aws-cdk-lib';

import { getEnvironmentConfig, resolveEnvironmentName } from '../lib/config';
import { PlatformStage } from '../lib/platform-stage';

/**
 * The platform team's per-environment entry point: deploys the shared foundation every service in
 * the environment attaches to - the VPC (`acme-network-<env>`) and the public DNS zone +
 * certificate (`acme-dns-<env>`).
 *
 *   npx cdk --app "npx ts-node --prefer-ts-exts bin/platform.ts" -c environment=dev deploy 'dev/**'
 *
 * Deploy this BEFORE `bin/ecommerce.ts`: service stacks import the `acme-<env>-*` CloudFormation
 * exports at deploy time, so a service deploy against a missing foundation fails on the export
 * rather than drifting. This mirrors the pipeline, which adds each environment's platform stage
 * ahead of its service stage.
 */
const app = new App();

const environment = resolveEnvironmentName(app);
const config = getEnvironmentConfig(environment);

new PlatformStage(app, environment, {
  env: { account: config.account, region: config.region },
  config,
});
