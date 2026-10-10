#!/usr/bin/env node
import 'source-map-support/register';

import { App } from 'aws-cdk-lib';

import { configuredAccountIds, ENVIRONMENT_NAMES, getEnvironmentConfig } from '../lib/config';
import { PipelineStack } from '../lib/stacks/pipeline-stack';

/**
 * Phase 8 entry point: the CI/CD pipeline itself.
 *
 *   npx cdk --app "npx ts-node --prefer-ts-exts bin/pipeline.ts" <command>
 *
 * Only the pipeline stack deploys from this app locally; the platform stages exist inside it for
 * the pipeline to synthesise. Once the pipeline exists it self-mutates, so this entry point is
 * needed again only for the first deploy and for work on the pipeline stack itself.
 *
 * Configuration is environment variables, exactly as for bin/ecommerce.ts, plus:
 *
 *   GITHUB_CONNECTION_ARN  CodeConnections connection to GitHub (created once in the console; the
 *                          OAuth handshake cannot be automated). May also be passed as the
 *                          `connectionArn` context value.
 *
 * Which environments the pipeline deploys is decided by which `ECOMMERCE_<ENV>_ACCOUNT` /
 * `ECOMMERCE_<ENV>_DOMAIN` pairs are set: dev is required; uat and prod join the pipeline - behind
 * a manual approval each - as soon as their pair exists. The same check runs inside the synth
 * build, so a pipeline execution always synthesises the same set of environments its configured
 * variables describe.
 */
const app = new App();

const connectionArn: string | undefined = process.env.GITHUB_CONNECTION_ARN ?? app.node.tryGetContext('connectionArn');
if (connectionArn === undefined || connectionArn === '') {
  throw new Error(
    'GitHub connection ARN is required. Create the CodeConnections connection in the console ' +
      '(status must be Available), then set GITHUB_CONNECTION_ARN or pass -c connectionArn=... ' +
      '- see README.md, "CI/CD pipeline".',
  );
}

// The pipeline account is the account dev lives in today: the stack deploys there once, and the
// env vars it forwards are exactly what the synth build will see.
const pipelineAccountId = process.env.ECOMMERCE_DEV_ACCOUNT;
const devDomain = process.env.ECOMMERCE_DEV_DOMAIN;
if (pipelineAccountId === undefined || pipelineAccountId === '' || devDomain === undefined || devDomain === '') {
  throw new Error(
    'ECOMMERCE_DEV_ACCOUNT and ECOMMERCE_DEV_DOMAIN are required - the pipeline deploys dev on every run.',
  );
}

// Every ECOMMERCE_* variable travels into the synth build so the pipeline synthesises the same
// configuration the deployer configured locally - including the dev NAT-gateway pause switch.
const synthEnvironment: Record<string, string> = {};
for (const [name, value] of Object.entries(process.env)) {
  if (name.startsWith('ECOMMERCE_') && value !== undefined) {
    synthEnvironment[name] = value;
  }
}

const environments = ENVIRONMENT_NAMES
  .filter((name) => {
    const configured =
      process.env[`ECOMMERCE_${name.toUpperCase()}_ACCOUNT`] !== undefined &&
      process.env[`ECOMMERCE_${name.toUpperCase()}_DOMAIN`] !== undefined;
    return name === 'dev' || configured;
  })
  .map((name) => getEnvironmentConfig(name));

new PipelineStack(app, 'ecommerce-pipeline', {
  env: { account: pipelineAccountId, region: getEnvironmentConfig('dev').region },
  connectionArn,
  // The shared registry lives in the pipeline account today; Phase 9's dedicated tooling account
  // is a one-line change here plus a re-pointed pull policy.
  registry: { account: pipelineAccountId, region: getEnvironmentConfig('dev').region },
  pullAccountIds: configuredAccountIds(),
  synthEnvironment,
  environments,
  description: 'E-commerce platform CI/CD pipeline (Phase 8)',
});
