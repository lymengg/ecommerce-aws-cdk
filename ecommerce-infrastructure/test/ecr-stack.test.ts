import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { EcrStack } from '../lib/stacks/ecr-stack';

/** Account used in the tests only, so that the synthesised template is environment specific. */
const TEST_ACCOUNT = '123456789012';
const UAT_ACCOUNT = '222222222222';
const PROD_ACCOUNT = '333333333333';

interface ResourceEntry {
  readonly logicalId: string;
  readonly properties: Record<string, any>;
}

function buildTemplate(pullAccountIds: string[] = []): Template {
  const app = new App();
  const stack = new EcrStack(app, 'test-ecr', {
    env: { account: TEST_ACCOUNT, region: 'ap-southeast-1' },
    pullAccountIds,
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
  test('creates one repository per image, shared across environments', () => {
    const template = buildTemplate();

    // The API and the frontend have different lifecycles, so they get their own repositories -
    // but the pair is environment-agnostic: an image is promoted between environments, never
    // rebuilt into an environment-named repository.
    template.resourceCountIs('AWS::ECR::Repository', 2);
    template.hasResourceProperties('AWS::ECR::Repository', { RepositoryName: 'ecommerce-api' });
    template.hasResourceProperties('AWS::ECR::Repository', { RepositoryName: 'ecommerce-frontend' });
  });

  test('scans every pushed image in every repository', () => {
    for (const { properties } of repositories(buildTemplate())) {
      expect(properties.ImageScanningConfiguration).toEqual({ ScanOnPush: true });
    }
  });

  test('expires untagged images but keeps tagged ones', () => {
    const policyText = repository(buildTemplate(), 'ecommerce-api').properties
      .LifecyclePolicy.LifecyclePolicyText as string;

    expect(policyText).toContain('"tagStatus":"untagged"');
    expect(policyText).toContain('"type":"expire"');
  });

  test('retains the repositories - deleting the stack must not delete the images every environment pulls', () => {
    const template = buildTemplate();
    template.hasResource('AWS::ECR::Repository', { DeletionPolicy: 'Retain' });
    template.hasResource('AWS::ECR::Repository', { UpdateReplacePolicy: 'Retain' });
  });

  test('tags the repositories as shared platform infrastructure', () => {
    for (const resource of repositories(buildTemplate())) {
      expect(tagMap(resource.properties)).toMatchObject({
        Project: 'Ecommerce',
        Environment: 'shared',
        ManagedBy: 'CDK',
      });
    }
  });
});

describe('EcrStack cross-account pull', () => {
  test('grants each configured account pull on both repositories', () => {
    const template = buildTemplate([UAT_ACCOUNT, PROD_ACCOUNT]);

    // The pull grant lives inline on each repository's RepositoryPolicyText, not as a separate
    // AWS::ECR::RepositoryPolicy resource.
    for (const { properties } of repositories(template)) {
      const rendered = JSON.stringify(properties.RepositoryPolicyText?.Statement ?? []);
      expect(rendered).toContain(`:iam::${UAT_ACCOUNT}:root`);
      expect(rendered).toContain(`:iam::${PROD_ACCOUNT}:root`);
      expect(rendered).toContain('ecr:BatchGetImage');
    }
  });

  test('creates no repository policy when no pull accounts are configured', () => {
    for (const { properties } of repositories(buildTemplate())) {
      expect(properties.RepositoryPolicyText).toBeUndefined();
    }
  });
});

describe('EcrStack outputs', () => {
  test('exports where to push each image', () => {
    const template = buildTemplate();

    template.hasOutput('RepositoryUri', { Export: { Name: 'ecommerce-ecr-repository-uri' } });
    template.hasOutput('RepositoryName', { Export: { Name: 'ecommerce-ecr-repository-name' } });
    template.hasOutput('FrontendRepositoryUri', { Export: { Name: 'ecommerce-ecr-frontend-repository-uri' } });
    template.hasOutput('FrontendRepositoryName', { Export: { Name: 'ecommerce-ecr-frontend-repository-name' } });
  });
});
