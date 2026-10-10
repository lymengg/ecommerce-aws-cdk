import { App, Stage } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

import { getEnvironmentConfig } from '../lib/config';
import { EnvironmentConfig } from '../lib/config/types';
import { PlatformStage, SharedRegistryStage } from '../lib/ecommerce-stage';
import { RegistryLocation } from '../lib/stacks/ecr-stack';
import { PipelineStack } from '../lib/stacks/pipeline-stack';

const PIPELINE_ACCOUNT = '111111111111';
const UAT_ACCOUNT = '222222222222';
const PROD_ACCOUNT = '333333333333';
const CONNECTION_ARN =
  'arn:aws:codeconnections:ap-southeast-1:111111111111:connection/00000000-0000-0000-0000-000000000000';
const REGISTRY: RegistryLocation = { account: PIPELINE_ACCOUNT, region: 'ap-southeast-1' };

const configured = (environment: 'dev' | 'uat' | 'prod', account: string): EnvironmentConfig => ({
  ...getEnvironmentConfig(environment),
  account,
});

interface ActionEntry {
  readonly Name: string;
  readonly ActionTypeId?: { readonly Category: string };
  readonly Configuration?: Record<string, any>;
}

const pipeline = (template: Template): {
  Stages: { Name: string; Actions: ActionEntry[] }[];
  ArtifactStores: { ArtifactStore: { EncryptionKey?: unknown }; Region: string }[];
} => Object.values(template.findResources('AWS::CodePipeline::Pipeline'))[0].Properties;

const stageNames = (template: Template): string[] => pipeline(template).Stages.map((s) => s.Name);

const stageActions = (template: Template, stage: string): ActionEntry[] =>
  pipeline(template).Stages.find((s) => s.Name === stage)?.Actions ?? [];

const pipelineProps = (environments: EnvironmentConfig[]) => ({
  env: { account: PIPELINE_ACCOUNT, region: 'ap-southeast-1' },
  connectionArn: CONNECTION_ARN,
  registry: REGISTRY,
  pullAccountIds: [PIPELINE_ACCOUNT, UAT_ACCOUNT, PROD_ACCOUNT],
  synthEnvironment: {},
  environments,
});

const pipelineTemplate = (environments: EnvironmentConfig[]): Template => {
  const app = new App();
  const stack = new PipelineStack(app, 'PipelineTest', pipelineProps(environments));
  return Template.fromStack(stack);
};

describe('PipelineStack', () => {
  const dev = configured('dev', PIPELINE_ACCOUNT);

  it('creates a V2 pipeline named ecommerce-platform fed by the GitHub connection', () => {
    const template = pipelineTemplate([dev]);

    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Name: 'ecommerce-platform',
      PipelineType: 'V2',
    });
    const sourceAction = pipeline(template).Stages.find((s) => s.Name === 'Source')!.Actions[0];
    expect(sourceAction.Configuration?.ConnectionArn).toBe(CONNECTION_ARN);
    expect(sourceAction.Configuration?.FullRepositoryId).toBe('lymengg/ecommerce-aws-cdk');
    expect(sourceAction.Configuration?.BranchName).toBe('main');
  });

  it('keeps the cross-account artifact key so uat and prod deploy actions can read the assembly', () => {
    const template = pipelineTemplate([dev]);

    template.hasResourceProperties('AWS::KMS::Key', Match.objectLike({}));
    // V2 pipelines carry one artifact store per deployment region; every store is KMS-encrypted.
    for (const store of pipeline(template).ArtifactStores) {
      expect(store.ArtifactStore.EncryptionKey).toBeDefined();
    }
  });

  it('runs tests before the shared registry and builds the images before dev', () => {
    const template = pipelineTemplate([dev]);
    const names = stageNames(template);
    expect(names).toEqual(['Source', 'Build', 'UpdatePipeline', 'Assets', 'registry', 'dev']);

    const registryActions = stageActions(template, 'registry').map((a) => a.Name);
    expect(registryActions.slice(0, 3)).toEqual(['ApiTests', 'FrontendTests', 'InfrastructureTests']);
    expect(registryActions.slice(3)).toEqual(['ecommerce-ecr.Prepare', 'ecommerce-ecr.Deploy']);

    const devActions = stageActions(template, 'dev').map((a) => a.Name);
    expect(devActions[0]).toBe('BuildImages');
    expect(devActions[devActions.length - 1]).toBe('SmokeTests-dev');
    // The platform keeps every stack the manual workflow deploys, under its live stack name.
    for (const stack of [
      'ecommerce-cognito-dev',
      'ecommerce-dns-dev',
      'ecommerce-network-dev',
      'ecommerce-auth-cert-dev',
      'ecommerce-database-dev',
      'ecommerce-application-dev',
      'ecommerce-frontend-dev',
      'ecommerce-auth-domain-dev',
      'ecommerce-cost-dev',
    ]) {
      expect(devActions).toContain(`${stack}.Deploy`);
    }
  });

  it('builds the images once - uat and prod promote the identical artifact', () => {
    const template = pipelineTemplate([dev, configured('uat', UAT_ACCOUNT), configured('prod', PROD_ACCOUNT)]);
    const names = stageNames(template);
    expect(names).toEqual([
      'Source',
      'Build',
      'UpdatePipeline',
      'Assets',
      'registry',
      'dev',
      'uat',
      'prod',
    ]);

    // Exactly one build step in the whole pipeline: promotion never rebuilds.
    const allActions = pipeline(template).Stages.flatMap((s) => s.Actions).map((a) => a.Name);
    expect(allActions.filter((n) => n.startsWith('BuildImages'))).toEqual(['BuildImages']);

    const approval = (stage: string) =>
      stageActions(template, stage).filter((a) => a.ActionTypeId?.Category === 'Approval').map((a) => a.Name);
    expect(approval('dev')).toEqual([]);
    expect(approval('uat')).toEqual(['Promote_to_uat']);
    expect(approval('prod')).toEqual(['Promote_to_prod']);
  });

  it('targets each environment stage at its own account', () => {
    const app = new App();
    const stack = new PipelineStack(app, 'PipelineTest', pipelineProps([dev, configured('uat', UAT_ACCOUNT)]));

    const uat = stack.node.findChild('uat') as Stage;
    expect(uat.account).toBe(UAT_ACCOUNT);
    expect(uat.region).toBe('ap-southeast-1');
  });
});

describe('Environment stages', () => {
  const dev = configured('dev', PIPELINE_ACCOUNT);
  const env = { account: PIPELINE_ACCOUNT, region: 'ap-southeast-1' };

  // The stacks were deployed before stages existed; the explicit stackName is what makes CloudFormation
  // keep updating the same stacks instead of deploying stage-prefixed duplicates.
  it('preserves the deployed stack names inside the platform stage', () => {
    const app = new App();
    const platform = new PlatformStage(app, 'dev', { env, config: dev, registry: REGISTRY });

    expect(platform.network.stackName).toBe('ecommerce-network-dev');
    expect(platform.database.stackName).toBe('ecommerce-database-dev');
    expect(platform.dns.stackName).toBe('ecommerce-dns-dev');
    expect(platform.authCertificate.stackName).toBe('ecommerce-auth-cert-dev');
    expect(platform.cognito.stackName).toBe('ecommerce-cognito-dev');
    expect(platform.application.stackName).toBe('ecommerce-application-dev');
    expect(platform.frontend.stackName).toBe('ecommerce-frontend-dev');
    expect(platform.authDomain.stackName).toBe('ecommerce-auth-domain-dev');
    expect(platform.cost.stackName).toBe('ecommerce-cost-dev');
  });

  it('deploys the shared registry once, at the registry location', () => {
    const app = new App();
    const stage = new SharedRegistryStage(app, 'registry', {
      registry: REGISTRY,
      pullAccountIds: [PIPELINE_ACCOUNT],
    });

    expect(stage.registry.stackName).toBe('ecommerce-ecr');
    expect(stage.registry.account).toBe(PIPELINE_ACCOUNT);
    expect(stage.registry.region).toBe('ap-southeast-1');
  });

  it('deploys the auth certificate to us-east-1 regardless of the stage region', () => {
    const app = new App();
    const platform = new PlatformStage(app, 'dev', { env, config: dev, registry: REGISTRY });

    expect(platform.authCertificate.region).toBe('us-east-1');
    expect(platform.network.region).toBe('ap-southeast-1');
  });
});
