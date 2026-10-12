import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { getEnvironmentConfig } from '../lib/config';
import { EnvironmentConfig, EnvironmentName } from '../lib/config/types';
import { ApplicationStack } from '../lib/stacks/application-stack';
import { DatabaseStack } from '../lib/stacks/database-stack';
import { DnsStack } from '../lib/stacks/dns-stack';
import { RegistryLocation } from '../lib/stacks/ecr-stack';
import { FrontendStack } from '../lib/stacks/frontend-stack';
import { NetworkStack } from '../lib/stacks/network-stack';

/**
 * Account used in the tests only, so that the synthesised template is environment specific. The
 * stacks themselves never hardcode an account id - test/config.test.ts enforces that.
 */
const TEST_ACCOUNT = '123456789012';

/** The shared registry the test stacks pull from - same account here, a different one in uat/prod. */
const TEST_REGISTRY: RegistryLocation = { account: TEST_ACCOUNT, region: 'ap-southeast-1' };

const TEST_SITE = 'dev.example.com';
const TEST_API_ORIGIN = 'https://api.dev.example.com';

interface ResourceEntry {
  readonly logicalId: string;
  readonly properties: Record<string, any>;
}

interface BuiltStacks {
  readonly template: Template;
  readonly stack: FrontendStack;
}

/**
 * Builds the whole platform and then the frontend stack, exactly as `bin/ecommerce.ts` does, so the
 * cross-stack wiring (cluster, listener, load balancer, security group, repository, zone) is
 * exercised rather than stubbed. The registries are not built: both compute stacks consume them by
 * name, which is the whole contract.
 */
function buildStacks(environment: EnvironmentName): BuiltStacks {
  const app = new App();
  const config: EnvironmentConfig = getEnvironmentConfig(environment);
  const env = { account: TEST_ACCOUNT, region: config.region };

  const network = new NetworkStack(app, `test-network-${environment}`, { env, config });
  const database = new DatabaseStack(app, `test-database-${environment}`, {
    env,
    config,
    vpc: network.vpc,
    databaseSecurityGroup: network.securityGroups.database,
  });
  const dns = new DnsStack(app, `test-dns-${environment}`, { env, config });
  const application = new ApplicationStack(app, `test-application-${environment}`, {
    env,
    config,
    vpc: network.vpc,
    registry: TEST_REGISTRY,
    albSecurityGroup: network.securityGroups.alb,
    applicationSecurityGroup: network.securityGroups.application,
    database: {
      host: database.instance.dbInstanceEndpointAddress,
      port: database.instance.dbInstanceEndpointPort,
      databaseName: config.database.databaseName,
      secret: database.credentialsSecret,
    },
    dns: { zone: dns.zone, certificate: dns.certificate, domainName: dns.apiDomainName },
    auth: {
      issuerUrl: 'https://cognito-idp.example.com/pool',
      userPoolClientId: 'test-client-id',
      clientSecret: database.credentialsSecret,
      frontendUrl: `https://${TEST_SITE}`,
    },
  });

  const stack = new FrontendStack(app, `test-frontend-${environment}`, {
    env,
    config,
    registry: TEST_REGISTRY,
    cluster: application.cluster,
    applicationSecurityGroup: network.securityGroups.application,
    loadBalancer: application.api.loadBalancer,
    albSecurityGroup: network.securityGroups.alb,
    httpsListener: application.api.httpsListener!,
    zone: dns.zone,
  });

  return { template: Template.fromStack(stack), stack };
}

function resourcesOfType(template: Template, type: string): ResourceEntry[] {
  return Object.entries(template.findResources(type)).map(([logicalId, resource]) => ({
    logicalId,
    properties: (resource as any).Properties ?? {},
  }));
}

function single(template: Template, type: string): ResourceEntry {
  const resources = resourcesOfType(template, type);
  expect(resources).toHaveLength(1);
  return resources[0];
}

/** Serialises a value so a token, whatever its shape, can be asserted against by substring. */
function json(value: unknown): string {
  return JSON.stringify(value);
}

function tagMap(properties: Record<string, any>): Record<string, string> {
  return Object.fromEntries(
    (properties.Tags ?? []).map((tag: { Key: string; Value: string }) => [tag.Key, tag.Value]),
  );
}

function containerOf(template: Template): Record<string, any> {
  return single(template, 'AWS::ECS::TaskDefinition').properties.ContainerDefinitions[0];
}

function environmentOf(container: Record<string, any>): Record<string, unknown> {
  return Object.fromEntries(
    (container.Environment ?? []).map((entry: { Name: string; Value: unknown }) => [entry.Name, entry.Value]),
  );
}

function roleByDescription(template: Template, description: string): ResourceEntry {
  const match = resourcesOfType(template, 'AWS::IAM::Role').find(({ properties }) =>
    String(properties.Description ?? '').includes(description),
  );
  if (match === undefined) {
    throw new Error(`No IAM role found with description containing "${description}"`);
  }
  return match;
}

describe('FrontendStack task definition', () => {
  test('runs nginx on Fargate with the configured size', () => {
    const taskDefinition = single(buildStacks('dev').template, 'AWS::ECS::TaskDefinition');

    expect(taskDefinition.properties).toMatchObject({
      Cpu: '256',
      Memory: '512',
      NetworkMode: 'awsvpc',
      RequiresCompatibilities: ['FARGATE'],
      Family: 'ecommerce-dev-frontend-task',
    });
  });

  test('sizes the task larger in production', () => {
    const taskDefinition = single(buildStacks('prod').template, 'AWS::ECS::TaskDefinition');

    expect(taskDefinition.properties).toMatchObject({ Cpu: '512', Memory: '1024' });
  });

  test('serves the SPA on the container port and logs to the dedicated log group', () => {
    const template = buildStacks('dev').template;
    const container = containerOf(template);

    expect(container.Name).toBe('frontend');
    expect(container.Essential).toBe(true);
    expect(container.PortMappings).toEqual([{ ContainerPort: 8080, Protocol: 'tcp' }]);
    expect(container.LogConfiguration.LogDriver).toBe('awslogs');
    expect(container.LogConfiguration.Options['awslogs-stream-prefix']).toBe('frontend');
    expect(json(container.LogConfiguration.Options['awslogs-group'])).toContain('LogGroup');
  });

  test('passes the API origin to nginx as plain environment, never a secret', () => {
    const container = containerOf(buildStacks('dev').template);

    expect(environmentOf(container).API_ORIGIN).toBe(TEST_API_ORIGIN);
    // The frontend needs no credential at all: there is nothing to inject.
    expect(container.Secrets).toBeUndefined();
  });

  test('pulls the image from the frontend repository, and creates no repository of its own', () => {
    const template = buildStacks('dev').template;

    template.resourceCountIs('AWS::ECR::Repository', 0);
    expect(json(containerOf(template).Image)).toContain('ecommerce-frontend');
    expect(json(containerOf(template).Image)).toContain(':v0.1.0');
    expect(json(containerOf(template).Image)).not.toContain(':latest');
  });
});

describe('FrontendStack IAM', () => {
  test('gives the execution role only image pull and log write permissions', () => {
    const template = buildStacks('dev').template;
    const executionRole = roleByDescription(template, 'Frontend task execution role');
    const policy = resourcesOfType(template, 'AWS::IAM::Policy').find(({ properties }) =>
      (properties.Roles ?? []).some((role: { Ref?: string }) => role.Ref === executionRole.logicalId),
    );

    expect(policy).toBeDefined();
    const statements = policy!.properties.PolicyDocument.Statement as { Action: string | string[]; Resource: unknown }[];
    const actions = statements.flatMap(({ Action }) => (Array.isArray(Action) ? Action : [Action]));

    expect(actions).toEqual(
      expect.arrayContaining([
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
        'ecr:BatchCheckLayerAvailability',
        'ecr:GetAuthorizationToken',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ]),
    );
    // No secrets, no wildcard actions, and no KMS statement.
    expect(actions).not.toContain('*');
    expect(actions.some((action) => action.startsWith('secretsmanager:'))).toBe(false);
    expect(actions.some((action) => action.startsWith('kms:'))).toBe(false);
  });

  test('gives the task role no permissions at all', () => {
    const template = buildStacks('dev').template;
    const taskRole = roleByDescription(template, 'Frontend task role');

    expect(taskRole.properties.ManagedPolicyArns).toBeUndefined();
    const attachedPolicies = resourcesOfType(template, 'AWS::IAM::Policy').filter(({ properties }) =>
      (properties.Roles ?? []).some((role: { Ref?: string }) => role.Ref === taskRole.logicalId),
    );
    expect(attachedPolicies).toHaveLength(0);
  });
});

describe('FrontendStack ECS service', () => {
  test('runs the configured number of tasks in the private subnets with the application security group', () => {
    const service = single(buildStacks('dev').template, 'AWS::ECS::Service');
    const awsvpc = service.properties.NetworkConfiguration.AwsvpcConfiguration;

    expect(service.properties).toMatchObject({
      DesiredCount: 1,
      LaunchType: 'FARGATE',
      ServiceName: 'ecommerce-dev-frontend',
    });
    expect(awsvpc.AssignPublicIp).toBe('DISABLED');
    expect(awsvpc.SecurityGroups).toHaveLength(1);
    expect(json(awsvpc.SecurityGroups)).toContain('SecurityGroupsApplication');
    for (const subnet of awsvpc.Subnets) {
      expect(json(subnet)).toContain('privateSubnet');
    }
  });

  test('may run more than one task in production, because nginx is stateless', () => {
    const service = single(buildStacks('prod').template, 'AWS::ECS::Service');

    expect(service.properties.DesiredCount).toBe(2);
  });

  test('registers with the frontend target group and rolls back a failed deployment', () => {
    const service = single(buildStacks('dev').template, 'AWS::ECS::Service');

    expect(service.properties.LoadBalancers[0]).toMatchObject({ ContainerName: 'frontend', ContainerPort: 8080 });
    expect(json(service.properties.LoadBalancers[0].TargetGroupArn)).toContain('TargetGroup');
    expect(service.properties.DeploymentConfiguration.DeploymentCircuitBreaker).toEqual({
      Enable: true,
      Rollback: true,
    });
  });
});

describe('FrontendStack target group', () => {
  test('health checks nginx on its own path, not the app shell', () => {
    const targetGroup = single(buildStacks('dev').template, 'AWS::ElasticLoadBalancingV2::TargetGroup');

    expect(targetGroup.properties).toMatchObject({
      Name: 'ecommerce-dev-frontend-tg',
      Port: 8080,
      Protocol: 'HTTP',
      TargetType: 'ip',
      HealthCheckPath: '/healthz',
      Matcher: { HttpCode: '200' },
    });
  });
});

describe('FrontendStack routing', () => {
  test('adds a host rule that sends the SPA host to the frontend target group', () => {
    const rule = single(buildStacks('dev').template, 'AWS::ElasticLoadBalancingV2::ListenerRule');

    expect(rule.properties.Priority).toBe(10);
    expect(rule.properties.Conditions).toEqual([
      { Field: 'host-header', HostHeaderConfig: { Values: [TEST_SITE] } },
    ]);
    expect(rule.properties.Actions[0].Type).toBe('forward');
    expect(json(rule.properties.Actions[0].TargetGroupArn)).toContain('TargetGroup');
    // The rule belongs to this stack, not the application stack: the listener is re-imported.
    expect(json(rule.properties.ListenerArn)).toContain('HttpsListener');
  });

  test('creates no listener of its own, and adds no security group rule', () => {
    const template = buildStacks('dev').template;

    template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 0);
    template.resourceCountIs('AWS::EC2::SecurityGroup', 0);
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
  });

  test('points the apex at the load balancer with IPv4 and IPv6 alias records', () => {
    const records = resourcesOfType(buildStacks('dev').template, 'AWS::Route53::RecordSet');
    const byType: Record<string, Record<string, any>> = Object.fromEntries(
      records.map((record): [string, Record<string, any>] => [record.properties.Type, record.properties]),
    );

    expect(Object.keys(byType).sort()).toEqual(['A', 'AAAA']);
    for (const properties of Object.values(byType)) {
      expect(properties.Name).toBe(`${TEST_SITE}.`);
      expect(json(properties.AliasTarget)).toContain('ApiLoadBalancer');
      expect(properties.ResourceRecords).toBeUndefined();
      expect(properties.TTL).toBeUndefined();
    }
  });
});

describe('FrontendStack tags and outputs', () => {
  test('tags every taggable resource with the project, environment and management tool', () => {
    const template = buildStacks('uat').template;

    for (const type of ['AWS::ECS::TaskDefinition', 'AWS::ECS::Service', 'AWS::Logs::LogGroup', 'AWS::IAM::Role']) {
      const resources = resourcesOfType(template, type);
      expect(resources.length).toBeGreaterThan(0);

      for (const { logicalId, properties } of resources) {
        expect({ [type]: logicalId, ...tagMap(properties) }).toMatchObject({
          [type]: logicalId,
          Project: 'Ecommerce',
          Environment: 'uat',
          ManagedBy: 'CDK',
        });
      }
    }
  });

  test('exports the site URL and the frontend ECS resources', () => {
    const template = buildStacks('dev').template;

    template.hasOutput('SiteUrl', { Export: { Name: 'ecommerce-dev-frontend-url' } });
    template.hasOutput('ServiceName', { Export: { Name: 'ecommerce-dev-frontend-service-name' } });
    template.hasOutput('TargetGroupArn', { Export: { Name: 'ecommerce-dev-frontend-target-group-arn' } });
  });

  test('publishes the SPA URL on the delegated apex', () => {
    expect(buildStacks('dev').stack.siteUrl).toBe(`https://${TEST_SITE}`);
  });
});
