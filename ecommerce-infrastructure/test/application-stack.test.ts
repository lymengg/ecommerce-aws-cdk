import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { getEnvironmentConfig } from '../lib/config';
import { EnvironmentName } from '../lib/config/types';
import { ApplicationStack } from '../lib/stacks/application-stack';
import { EcrStack } from '../lib/stacks/ecr-stack';
import { NetworkStack } from '../lib/stacks/network-stack';

/**
 * Account used in the tests only, so that the synthesised template is environment specific. The
 * stacks themselves never hardcode an account id - test/config.test.ts enforces that.
 */
const TEST_ACCOUNT = '123456789012';

interface ResourceEntry {
  readonly logicalId: string;
  readonly properties: Record<string, any>;
}

interface BuiltStacks {
  readonly template: Template;
  readonly network: NetworkStack;
  readonly application: ApplicationStack;
}

/**
 * Builds the Phase 1 network stack, the Phase 2 registry stack and the Phase 2 application stack in
 * one app, exactly as `bin/ecommerce.ts` does, so the cross-stack wiring is exercised rather than
 * stubbed.
 */
function buildStacks(environment: EnvironmentName): BuiltStacks {
  const app = new App();
  const config = getEnvironmentConfig(environment);
  const env = { account: TEST_ACCOUNT, region: config.region };

  const network = new NetworkStack(app, `test-network-${environment}`, { env, config });
  const registry = new EcrStack(app, `test-ecr-${environment}`, { env, config });
  const application = new ApplicationStack(app, `test-application-${environment}`, {
    env,
    config,
    vpc: network.vpc,
    repository: registry.repository,
    albSecurityGroup: network.securityGroups.alb,
    applicationSecurityGroup: network.securityGroups.application,
  });

  return { template: Template.fromStack(application), network, application };
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

function roleByDescription(template: Template, description: string): ResourceEntry {
  const match = resourcesOfType(template, 'AWS::IAM::Role').find(({ properties }) =>
    String(properties.Description ?? '').includes(description),
  );
  if (match === undefined) {
    throw new Error(`No IAM role found with description containing "${description}"`);
  }
  return match;
}

describe('ApplicationStack container image', () => {
  test('never deploys a mutable latest image tag', () => {
    const template = buildStacks('dev').template;
    const taskDefinition = single(template, 'AWS::ECS::TaskDefinition');

    const image = json(taskDefinition.properties.ContainerDefinitions[0].Image);
    expect(image).toContain(':v0.1.0');
    expect(image).not.toContain(':latest');
  });

  test('pulls the image from the repository created by the ECR stack', () => {
    const template = buildStacks('dev').template;
    const container = single(template, 'AWS::ECS::TaskDefinition').properties.ContainerDefinitions[0];

    // The repository is referenced, not redefined, so this stack must create no repository itself.
    template.resourceCountIs('AWS::ECR::Repository', 0);
    expect(json(container.Image)).toContain('Repository');
  });
});

describe('ApplicationStack ECS cluster', () => {
  test('creates an environment specific Fargate cluster in the Phase 1 VPC', () => {
    const template = buildStacks('dev').template;

    template.hasResourceProperties('AWS::ECS::Cluster', { ClusterName: 'ecommerce-dev-cluster' });
    template.resourceCountIs('AWS::ECS::Cluster', 1);
  });
});

describe('ApplicationStack task definition', () => {
  test('runs the container on Fargate with awsvpc networking', () => {
    const taskDefinition = single(buildStacks('dev').template, 'AWS::ECS::TaskDefinition');

    expect(taskDefinition.properties).toMatchObject({
      Cpu: '512',
      Memory: '1024',
      NetworkMode: 'awsvpc',
      RequiresCompatibilities: ['FARGATE'],
      Family: 'ecommerce-dev-api-task',
    });
  });

  test('sizes the task larger in production', () => {
    const taskDefinition = single(buildStacks('prod').template, 'AWS::ECS::TaskDefinition');

    expect(taskDefinition.properties).toMatchObject({ Cpu: '1024', Memory: '2048' });
  });

  test('exposes the application port and logs to the dedicated log group', () => {
    const template = buildStacks('dev').template;
    const container = single(template, 'AWS::ECS::TaskDefinition').properties.ContainerDefinitions[0];

    expect(container.Name).toBe('api');
    expect(container.Essential).toBe(true);
    expect(container.PortMappings).toEqual([{ ContainerPort: 8080, Protocol: 'tcp' }]);
    expect(container.Environment).toEqual([{ Name: 'SERVER_PORT', Value: '8080' }]);
    expect(container.LogConfiguration.LogDriver).toBe('awslogs');
    expect(container.LogConfiguration.Options['awslogs-stream-prefix']).toBe('api');
    expect(json(container.LogConfiguration.Options['awslogs-group'])).toContain('ApiLogGroup');
  });

  test('wires both the execution role and the task role into the task', () => {
    const template = buildStacks('dev').template;
    const taskDefinition = single(template, 'AWS::ECS::TaskDefinition');

    expect(taskDefinition.properties.ExecutionRoleArn).toBeDefined();
    expect(taskDefinition.properties.TaskRoleArn).toBeDefined();
    expect(taskDefinition.properties.ExecutionRoleArn).not.toEqual(taskDefinition.properties.TaskRoleArn);
  });
});

describe('ApplicationStack CloudWatch logs', () => {
  test('keeps container logs for the configured retention window', () => {
    expect(single(buildStacks('dev').template, 'AWS::Logs::LogGroup').properties).toMatchObject({
      LogGroupName: '/ecs/ecommerce-dev-api',
      RetentionInDays: 7,
    });
    expect(single(buildStacks('uat').template, 'AWS::Logs::LogGroup').properties.RetentionInDays).toBe(30);
  });

  test('retains the log group in production', () => {
    buildStacks('prod').template.hasResource('AWS::Logs::LogGroup', {
      DeletionPolicy: 'Retain',
      Properties: { RetentionInDays: 90 },
    });
  });
});

describe('ApplicationStack IAM', () => {
  test('gives the execution role only image pull and log write permissions', () => {
    const template = buildStacks('dev').template;
    const executionRole = roleByDescription(template, 'ECS task execution role');
    const policy = resourcesOfType(template, 'AWS::IAM::Policy').find(({ properties }) =>
      (properties.Roles ?? []).some((role: { Ref?: string }) => role.Ref === executionRole.logicalId),
    );

    expect(policy).toBeDefined();
    const statements = policy!.properties.PolicyDocument.Statement as {
      Action: string | string[];
      Resource: unknown;
    }[];
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
    expect(actions).not.toContain('*');
    expect(actions.some((action) => action.endsWith(':*'))).toBe(false);
  });

  test('scopes the image pull and log write grants to the specific repository and log group', () => {
    const template = buildStacks('dev').template;
    const executionRole = roleByDescription(template, 'ECS task execution role');
    const policy = resourcesOfType(template, 'AWS::IAM::Policy').find(({ properties }) =>
      (properties.Roles ?? []).some((role: { Ref?: string }) => role.Ref === executionRole.logicalId),
    )!;
    const statements = policy.properties.PolicyDocument.Statement as {
      Action: string | string[];
      Resource: unknown;
    }[];

    const wildcardResources = statements.filter(({ Resource }) => json(Resource) === '"*"');
    // ecr:GetAuthorizationToken is an account level action that cannot be scoped to a repository.
    expect(wildcardResources).toHaveLength(1);
    expect(json(wildcardResources[0].Action)).toContain('ecr:GetAuthorizationToken');

    expect(json(statements)).toContain('Repository');
    expect(json(statements)).toContain('ApiLogGroup');
  });

  test('gives the task role no permissions at all', () => {
    const template = buildStacks('dev').template;
    const taskRole = roleByDescription(template, 'Application task role');

    expect(taskRole.properties.ManagedPolicyArns).toBeUndefined();
    expect(taskRole.properties.Policies ?? []).toHaveLength(0);

    const attachedPolicies = resourcesOfType(template, 'AWS::IAM::Policy').filter(({ properties }) =>
      (properties.Roles ?? []).some((role: { Ref?: string }) => role.Ref === taskRole.logicalId),
    );
    expect(attachedPolicies).toHaveLength(0);
    expect(template.findResources('AWS::IAM::ManagedPolicy')).toEqual({});
  });

  test('never grants an administrator, power user or wildcard policy', () => {
    const templateJson = JSON.stringify(buildStacks('prod').template.toJSON());

    expect(templateJson).not.toContain('AdministratorAccess');
    expect(templateJson).not.toContain('PowerUserAccess');
    expect(templateJson).not.toContain('iam:PassRole');
    expect(templateJson).not.toContain('arn:aws:iam::aws:policy');
  });
});

describe('ApplicationStack ECS service', () => {
  test('runs exactly one Fargate task', () => {
    const service = single(buildStacks('dev').template, 'AWS::ECS::Service');

    expect(service.properties).toMatchObject({
      DesiredCount: 1,
      LaunchType: 'FARGATE',
      ServiceName: 'ecommerce-dev-api',
    });
  });

  test('runs the task in the private subnets with the application security group, without a public IP', () => {
    const service = single(buildStacks('dev').template, 'AWS::ECS::Service');
    const awsvpc = service.properties.NetworkConfiguration.AwsvpcConfiguration;

    expect(awsvpc.AssignPublicIp).toBe('DISABLED');
    expect(awsvpc.SecurityGroups).toHaveLength(1);
    expect(json(awsvpc.SecurityGroups)).toContain('SecurityGroupsApplication');
    expect(awsvpc.Subnets).toHaveLength(2);
    for (const subnet of awsvpc.Subnets) {
      expect(json(subnet)).toContain('privateSubnet');
    }
  });

  test('registers its tasks with the target group by container name and port', () => {
    const service = single(buildStacks('dev').template, 'AWS::ECS::Service');

    expect(service.properties.LoadBalancers).toHaveLength(1);
    expect(service.properties.LoadBalancers[0]).toMatchObject({
      ContainerName: 'api',
      ContainerPort: 8080,
    });
    expect(json(service.properties.LoadBalancers[0].TargetGroupArn)).toContain('ApiTargetGroup');
  });

  test('rolls a failed deployment back instead of leaving it half applied', () => {
    const service = single(buildStacks('dev').template, 'AWS::ECS::Service');

    expect(service.properties.DeploymentConfiguration.DeploymentCircuitBreaker).toEqual({
      Enable: true,
      Rollback: true,
    });
    expect(service.properties.HealthCheckGracePeriodSeconds).toBe(60);
    expect(service.properties.DeploymentConfiguration.MinimumHealthyPercent).toBe(100);
    expect(service.properties.DeploymentConfiguration.MaximumPercent).toBe(200);
  });

  test('propagates tags onto the running tasks', () => {
    const service = single(buildStacks('dev').template, 'AWS::ECS::Service');

    expect(service.properties.EnableECSManagedTags).toBe(true);
    expect(service.properties.PropagateTags).toBe('SERVICE');
  });
});

describe('ApplicationStack load balancer', () => {
  test('is internet-facing in the public subnets with the ALB security group', () => {
    const loadBalancer = single(buildStacks('dev').template, 'AWS::ElasticLoadBalancingV2::LoadBalancer');

    expect(loadBalancer.properties).toMatchObject({
      Type: 'application',
      Scheme: 'internet-facing',
      Name: 'ecommerce-dev-api-alb',
    });
    expect(loadBalancer.properties.SecurityGroups).toHaveLength(1);
    expect(json(loadBalancer.properties.SecurityGroups)).toContain('SecurityGroupsAlb');
    expect(loadBalancer.properties.Subnets).toHaveLength(2);
    for (const subnet of loadBalancer.properties.Subnets) {
      expect(json(subnet)).toContain('publicSubnet');
    }
  });

  test('is protected against deletion in production but not in dev', () => {
    const attributesOf = (template: Template) =>
      Object.fromEntries(
        single(template, 'AWS::ElasticLoadBalancingV2::LoadBalancer').properties.LoadBalancerAttributes.map(
          (attribute: { Key: string; Value: string }) => [attribute.Key, attribute.Value],
        ),
      );

    expect(attributesOf(buildStacks('dev').template)['deletion_protection.enabled']).toBe('false');
    expect(attributesOf(buildStacks('prod').template)['deletion_protection.enabled']).toBe('true');
  });

  test('opens only port 80 to the internet, and only on the load balancer', () => {
    const template = buildStacks('dev').template;

    // The Phase 1 security groups are referenced, never redefined, so the application stack must
    // contain no security group of its own.
    expect(resourcesOfType(template, 'AWS::EC2::SecurityGroup')).toHaveLength(0);

    const ingress = resourcesOfType(template, 'AWS::EC2::SecurityGroupIngress');
    expect(ingress).toHaveLength(1);
    expect(ingress[0].properties).toMatchObject({
      CidrIp: '0.0.0.0/0',
      Description: 'HTTP from the internet',
      FromPort: 80,
      ToPort: 80,
      IpProtocol: 'tcp',
    });
    expect(json(ingress[0].properties.GroupId)).toContain('SecurityGroupsAlb');
  });
});

describe('ApplicationStack listener and target group', () => {
  test('listens on HTTP port 80 and forwards to the target group', () => {
    const template = buildStacks('dev').template;
    const listener = single(template, 'AWS::ElasticLoadBalancingV2::Listener');

    expect(listener.properties).toMatchObject({ Port: 80, Protocol: 'HTTP' });
    expect(listener.properties.DefaultActions).toHaveLength(1);
    expect(listener.properties.DefaultActions[0].Type).toBe('forward');
    expect(json(listener.properties.DefaultActions[0].TargetGroupArn)).toContain('ApiTargetGroup');
  });

  test('health checks the Actuator health endpoint on the container port', () => {
    const targetGroup = single(buildStacks('dev').template, 'AWS::ElasticLoadBalancingV2::TargetGroup');

    expect(targetGroup.properties).toMatchObject({
      Name: 'ecommerce-dev-api-tg',
      Port: 8080,
      Protocol: 'HTTP',
      TargetType: 'ip',
      HealthCheckPath: '/actuator/health',
      HealthCheckProtocol: 'HTTP',
      HealthCheckIntervalSeconds: 30,
      HealthCheckTimeoutSeconds: 5,
      HealthyThresholdCount: 2,
      UnhealthyThresholdCount: 3,
      Matcher: { HttpCode: '200' },
    });
  });
});

describe('ApplicationStack tags', () => {
  test('tags every taggable resource with the project, environment and management tool', () => {
    const template = buildStacks('uat').template;

    for (const type of [
      'AWS::ECS::Cluster',
      'AWS::ECS::TaskDefinition',
      'AWS::ECS::Service',
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      'AWS::ElasticLoadBalancingV2::TargetGroup',
      'AWS::ElasticLoadBalancingV2::Listener',
      'AWS::Logs::LogGroup',
      'AWS::IAM::Role',
    ]) {
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
});

describe('ApplicationStack outputs', () => {
  test('exports how to reach the API and the ECS resources', () => {
    const template = buildStacks('dev').template;

    template.hasOutput('ClusterName', { Export: { Name: 'ecommerce-dev-ecs-cluster-name' } });
    template.hasOutput('ServiceName', { Export: { Name: 'ecommerce-dev-ecs-service-name' } });
    template.hasOutput('LoadBalancerDnsName', { Export: { Name: 'ecommerce-dev-alb-dns-name' } });
    template.hasOutput('ApiUrl', { Export: { Name: 'ecommerce-dev-api-url' } });
    template.hasOutput('TargetGroupArn', { Export: { Name: 'ecommerce-dev-target-group-arn' } });
  });

  test('uses environment specific export names so environments do not clash', () => {
    const outputs = buildStacks('prod').template.toJSON().Outputs;

    expect(outputs.ServiceName.Export.Name).toBe('ecommerce-prod-ecs-service-name');
    expect(outputs.ApiUrl.Export.Name).toBe('ecommerce-prod-api-url');
  });
});
