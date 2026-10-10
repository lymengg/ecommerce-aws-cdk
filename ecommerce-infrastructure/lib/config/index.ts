import { App } from 'aws-cdk-lib';
import { Construct } from 'constructs';

import { devConfig } from './dev';
import { prodConfig } from './prod';
import { uatConfig } from './uat';
import { ENVIRONMENT_NAMES, EnvironmentConfig, EnvironmentName, isEnvironmentName } from './types';
import { assertValidEnvironmentConfig } from './validation';

export * from './types';
export * from './validation';

const CONFIG_BY_ENVIRONMENT: Record<EnvironmentName, EnvironmentConfig> = {
  dev: devConfig,
  uat: uatConfig,
  prod: prodConfig,
};

/** Environment used when neither the CDK context nor the ENVIRONMENT variable is set. */
export const DEFAULT_ENVIRONMENT: EnvironmentName = 'dev';

/** CDK context key used to select the environment: `cdk synth -c environment=prod`. */
export const ENVIRONMENT_CONTEXT_KEY = 'environment';

/** CDK context key used to override the container image tag: `cdk deploy -c imageTag=v1.2.3`. */
export const IMAGE_TAG_CONTEXT_KEY = 'imageTag';

/**
 * Resolves the environment to deploy to, in order of precedence:
 *
 * 1. CDK context - `cdk deploy -c environment=prod`, or the default in `cdk.json`
 * 2. The `ENVIRONMENT` environment variable - convenient in CI pipelines
 * 3. {@link DEFAULT_ENVIRONMENT}
 */
export function resolveEnvironmentName(app?: App): EnvironmentName {
  const fromContext: unknown = app?.node.tryGetContext(ENVIRONMENT_CONTEXT_KEY);
  const candidate = String(fromContext ?? process.env.ENVIRONMENT ?? DEFAULT_ENVIRONMENT).toLowerCase();

  if (!isEnvironmentName(candidate)) {
    throw new Error(`Unknown environment "${candidate}". Expected one of: ${ENVIRONMENT_NAMES.join(', ')}.`);
  }

  return candidate;
}

/** Returns the validated configuration of an environment. */
export function getEnvironmentConfig(environment: EnvironmentName = resolveEnvironmentName()): EnvironmentConfig {
  const config = CONFIG_BY_ENVIRONMENT[environment];
  assertValidEnvironmentConfig(config);
  return config;
}

/**
 * The account ids of every configured environment: the set the shared registry allows to pull
 * images. An environment is "configured" the moment its `ECOMMERCE_<ENV>_ACCOUNT` variable exists -
 * the same rule {@link ../../bin/pipeline.ts} uses to decide which environments the pipeline
 * deploys, so the registry's pull policy always matches the pipeline's stage list.
 */
export function configuredAccountIds(): string[] {
  return ENVIRONMENT_NAMES.map(
    (name) => process.env[`ECOMMERCE_${name.toUpperCase()}_ACCOUNT`],
  ).filter((account): account is string => account !== undefined && account !== '');
}

/**
 * Resolves the container image tag to deploy, in order of precedence:
 *
 * 1. CDK context - `cdk deploy -c imageTag=v1.2.3`
 * 2. The `IMAGE_TAG` environment variable - convenient in CI pipelines
 * 3. The environment's configured default, `application.imageTag`
 *
 * The tag is baked into the task definition, so a mutable tag such as `latest` would make a task
 * replacement silently deploy an image nobody reviewed. It is rejected here rather than at ECS,
 * which would only fail after the service had already started rolling.
 */
export function resolveImageTag(
  config: EnvironmentConfig,
  scope?: Construct,
  defaultTag: string = config.application.imageTag,
): string {
  const fromContext: unknown = scope?.node.tryGetContext(IMAGE_TAG_CONTEXT_KEY);
  const candidate = String(fromContext ?? process.env.IMAGE_TAG ?? defaultTag).trim();

  if (candidate === '') {
    throw new Error('imageTag must not be empty.');
  }
  if (candidate.toLowerCase() === 'latest') {
    throw new Error('imageTag must be an immutable tag; "latest" is not allowed.');
  }

  return candidate;
}
