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

function repository(template: Template): ResourceEntry {
  const entries = Object.entries(template.findResources('AWS::ECR::Repository')).map(([logicalId, resource]) => ({
    logicalId,
    properties: (resource as any).Properties ?? {},
  }));
  expect(entries).toHaveLength(1);
  return entries[0];
}

function tagMap(properties: Record<string, any>): Record<string, string> {
  return Object.fromEntries(
    (properties.Tags ?? []).map((tag: { Key: string; Value: string }) => [tag.Key, tag.Value]),
  );
}

describe('EcrStack repository', () => {
  test('creates one environment specific repository', () => {
    const template = buildTemplate('dev');

    template.resourceCountIs('AWS::ECR::Repository', 1);
    template.hasResourceProperties('AWS::ECR::Repository', { RepositoryName: 'ecommerce-dev-api' });
    template.hasResourceProperties('AWS::ECR::Repository', {
      ImageScanningConfiguration: { ScanOnPush: true },
    });
  });

  test('uses a different repository name per environment', () => {
    buildTemplate('dev').hasResourceProperties('AWS::ECR::Repository', { RepositoryName: 'ecommerce-dev-api' });
    buildTemplate('prod').hasResourceProperties('AWS::ECR::Repository', { RepositoryName: 'ecommerce-prod-api' });
  });

  test('expires untagged images but keeps tagged ones', () => {
    const policyText = repository(buildTemplate('dev')).properties.LifecyclePolicy
      .LifecyclePolicyText as string;

    expect(policyText).toContain('"tagStatus":"untagged"');
    expect(policyText).toContain('"type":"expire"');
  });

  test('is emptied on delete in dev but retained in production', () => {
    expect(repository(buildTemplate('dev')).properties.EmptyOnDelete).toBe(true);
    buildTemplate('prod').hasResource('AWS::ECR::Repository', { DeletionPolicy: 'Retain' });
  });

  test('tags the repository with the project, environment and management tool', () => {
    const resource = repository(buildTemplate('uat'));

    expect(tagMap(resource.properties)).toMatchObject({
      Project: 'Ecommerce',
      Environment: 'uat',
      ManagedBy: 'CDK',
    });
  });
});

describe('EcrStack outputs', () => {
  test('exports where to push the image', () => {
    const template = buildTemplate('dev');

    template.hasOutput('RepositoryUri', { Export: { Name: 'ecommerce-dev-ecr-repository-uri' } });
    template.hasOutput('RepositoryName', { Export: { Name: 'ecommerce-dev-ecr-repository-name' } });
  });
});
