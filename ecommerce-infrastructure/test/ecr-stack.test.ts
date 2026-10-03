import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { getEnvironmentConfig } from '../lib/config';
import { EnvironmentName } from '../lib/config/types';
import { EcrStack } from '../lib/stacks/ecr-stack';

/** Account used in the tests only, so that the synthesised template is environment specific. */
const TEST_ACCOUNT = '123456789012';

interface ResourceEntry {
  readonly logicalId: string;
  readonly properties: Record<string, any>;
}

function buildTemplate(environment: EnvironmentName): Template {
  const app = new App();
  const config = getEnvironmentConfig(environment);
  const stack = new EcrStack(app, `test-ecr-${environment}`, {
    env: { account: TEST_ACCOUNT, region: config.region },
    config,
  });
  return Template.fromStack(stack);
}

function repositories(template: Template): ResourceEntry[] {
  return Object.entries(template.findResources('AWS::ECR::Repository')).map(([logicalId, resource]) => ({
    logicalId,
    properties: (resource as any).Properties ?? {},
  }));
}

/** Finds one repository by the name it was created with. */
function repository(template: Template, name: string): ResourceEntry {
  const match = repositories(template).find(({ properties }) => properties.RepositoryName === name);
  if (match === undefined) {
    throw new Error(`No ECR repository named "${name}"`);
  }
  return match;
}

function tagMap(properties: Record<string, any>): Record<string, string> {
  return Object.fromEntries(
    (properties.Tags ?? []).map((tag: { Key: string; Value: string }) => [tag.Key, tag.Value]),
  );
}

describe('EcrStack repositories', () => {
  test('creates one repository per image, named per environment', () => {
    const template = buildTemplate('dev');

    // The API and the frontend have different lifecycles, so they get their own repositories.
    template.resourceCountIs('AWS::ECR::Repository', 2);
    template.hasResourceProperties('AWS::ECR::Repository', { RepositoryName: 'ecommerce-dev-api' });
    template.hasResourceProperties('AWS::ECR::Repository', { RepositoryName: 'ecommerce-dev-frontend' });
  });

  test('uses a different repository name per environment', () => {
    const prod = buildTemplate('prod');

    expect(repository(prod, 'ecommerce-prod-api').properties.RepositoryName).toBe('ecommerce-prod-api');
    expect(repository(prod, 'ecommerce-prod-frontend').properties.RepositoryName).toBe('ecommerce-prod-frontend');
  });

  test('scans every pushed image in every repository', () => {
    for (const { properties } of repositories(buildTemplate('dev'))) {
      expect(properties.ImageScanningConfiguration).toEqual({ ScanOnPush: true });
    }
  });

  test('expires untagged images but keeps tagged ones', () => {
    const policyText = repository(buildTemplate('dev'), 'ecommerce-dev-api').properties
      .LifecyclePolicy.LifecyclePolicyText as string;

    expect(policyText).toContain('"tagStatus":"untagged"');
    expect(policyText).toContain('"type":"expire"');
  });

  test('is emptied on delete in dev but retained in production', () => {
    expect(repository(buildTemplate('dev'), 'ecommerce-dev-api').properties.EmptyOnDelete).toBe(true);
    expect(repository(buildTemplate('dev'), 'ecommerce-dev-frontend').properties.EmptyOnDelete).toBe(true);
    buildTemplate('prod').hasResource('AWS::ECR::Repository', { DeletionPolicy: 'Retain' });
  });

  test('tags the repositories with the project, environment and management tool', () => {
    for (const resource of repositories(buildTemplate('uat'))) {
      expect(tagMap(resource.properties)).toMatchObject({
        Project: 'Ecommerce',
        Environment: 'uat',
        ManagedBy: 'CDK',
      });
    }
  });
});

describe('EcrStack outputs', () => {
  test('exports where to push each image', () => {
    const template = buildTemplate('dev');

    template.hasOutput('RepositoryUri', { Export: { Name: 'ecommerce-dev-ecr-repository-uri' } });
    template.hasOutput('RepositoryName', { Export: { Name: 'ecommerce-dev-ecr-repository-name' } });
    template.hasOutput('FrontendRepositoryUri', { Export: { Name: 'ecommerce-dev-ecr-frontend-repository-uri' } });
    template.hasOutput('FrontendRepositoryName', { Export: { Name: 'ecommerce-dev-ecr-frontend-repository-name' } });
  });
});
