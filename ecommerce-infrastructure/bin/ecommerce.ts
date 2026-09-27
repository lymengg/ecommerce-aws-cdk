#!/usr/bin/env node
import 'source-map-support/register';

import { App } from 'aws-cdk-lib';

import { EnvironmentConfig, getEnvironmentConfig, resolveEnvironmentName, resolveImageTag } from '../lib/config';
import { ApplicationStack } from '../lib/stacks/application-stack';
import { EcrStack } from '../lib/stacks/ecr-stack';
import { NetworkStack } from '../lib/stacks/network-stack';

const app = new App();

// The environment is selected by CDK context (`cdk deploy -c environment=prod`, defaulting to the
// value in cdk.json) or by the ENVIRONMENT variable, falling back to dev. See lib/config/index.ts.
const environment = resolveEnvironmentName(app);
const config = getEnvironmentConfig(environment);

// The image tag can be overridden at deploy time (`-c imageTag=v1.2.3` or IMAGE_TAG) without editing
// source. It is merged back into the configuration so the stacks still receive one config object.
const deployedConfig: EnvironmentConfig = {
  ...config,
  application: { ...config.application, imageTag: resolveImageTag(config, app) },
};

const network = new NetworkStack(app, `ecommerce-network-${environment}`, {
  // Account and region come from the environment configuration, never from this file. When the
  // account is not configured explicitly the CDK CLI resolves it from the active credentials.
  env: {
    account: config.account,
    region: config.region,
  },
  config,
  description: `E-commerce platform network foundation (${environment})`,
});

// The container registry is deployed before the compute that consumes it: the ECS service cannot
// start until an image has been pushed, and an image can only be pushed once the repository exists.
const registry = new EcrStack(app, `ecommerce-ecr-${environment}`, {
  env: {
    account: config.account,
    region: config.region,
  },
  config: deployedConfig,
  description: `E-commerce platform container registry (${environment})`,
});

// The application stack consumes the network stack's VPC and security groups and the registry, so
// the CDK CLI orders the stacks: network and registry must exist before compute can attach to them.
new ApplicationStack(app, `ecommerce-application-${environment}`, {
  env: {
    account: config.account,
    region: config.region,
  },
  config: deployedConfig,
  vpc: network.vpc,
  repository: registry.repository,
  albSecurityGroup: network.securityGroups.alb,
  applicationSecurityGroup: network.securityGroups.application,
  description: `E-commerce platform application compute (${environment})`,
});
