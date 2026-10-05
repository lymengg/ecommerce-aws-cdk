import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';

import { getEnvironmentConfig } from '../lib/config';
import { DnsConfig, EnvironmentConfig, EnvironmentName } from '../lib/config/types';
import { ApplicationStack } from '../lib/stacks/application-stack';
import { CognitoStack } from '../lib/stacks/cognito-stack';
import { DatabaseStack } from '../lib/stacks/database-stack';
import { DnsStack } from '../lib/stacks/dns-stack';
import { EcrStack } from '../lib/stacks/ecr-stack';
import { NetworkStack } from '../lib/stacks/network-stack';

/**
 * Account used in the tests only, so that the synthesised template is environment specific. The
 * stacks themselves never hardcode an account id - test/config.test.ts enforces that.
 */
const TEST_ACCOUNT = '123456789012';

/** A delegated subdomain injected into the configuration, independent of the developer's shell. */
const TEST_DNS: DnsConfig = { zoneName: 'dev.example.com', apiSubdomain: 'api', authSubdomain: 'auth' };
const TEST_FQDN = 'api.dev.example.com';

interface ResourceEntry {
  readonly logicalId: string;
  readonly properties: Record<string, any>;
}

interface BuiltStacks {
  readonly template: Template;
  readonly network: NetworkStack;
  readonly database: DatabaseStack;
  readonly application: ApplicationStack;
  readonly dns?: DnsStack;
  readonly cognito?: CognitoStack;
}

/**
 * Builds the Phase 1 network stack, the Phase 2 registry stack, the Phase 3 database stack, the
 * Phase 3.5 DNS stack, the Phase 4 Cognito stack and the application stack in one app, exactly as
 * `bin/ecommerce.ts` does, so the cross-stack wiring is exercised rather than stubbed.
 *
 * `options.dns` overrides the subdomain for the tests that need a specific TLS path without
 * depending on `ECOMMERCE_<ENV>_DOMAIN`; `options.dns === null` strips it entirely, which is the
 * only way to reach the certificate-less listener now that every environment configures a domain
 * (authentication requires HTTPS).
 */
function buildStacks(environment: EnvironmentName, options: { dns?: DnsConfig | null } = {}): BuiltStacks {
  const app = new App();
  const base = getEnvironmentConfig(environment);
  const config: EnvironmentConfig =
    options.dns === null ? { ...base, dns: undefined } : options.dns === undefined ? base : { ...base, dns: options.dns };
  const env = { account: TEST_ACCOUNT, region: config.region };

  const network = new NetworkStack(app, `test-network-${environment}`, { env, config });
  const registry = new EcrStack(app, `test-ecr-${environment}`, { env, config });
  const database = new DatabaseStack(app, `test-database-${environment}`, {
    env,
    config,
    vpc: network.vpc,
    databaseSecurityGroup: network.securityGroups.database,
  });
  const dns =
    config.dns === undefined ? undefined : new DnsStack(app, `test-dns-${environment}`, { env, config });
  // The Cognito stack needs a domain for its callback URIs, so it is only built when one exists.
  const cognito =
    config.dns === undefined ? undefined : new CognitoStack(app, `test-cognito-${environment}`, { env, config });
  const application = new ApplicationStack(app, `test-application-${environment}`, {
    env,
    config,
    vpc: network.vpc,
    repository: registry.repository,
    albSecurityGroup: network.securityGroups.alb,
    applicationSecurityGroup: network.securityGroups.application,
    database: {
      host: database.instance.dbInstanceEndpointAddress,
      port: database.instance.dbInstanceEndpointPort,
      databaseName: config.database.databaseName,
      secret: database.credentialsSecret,
    },
    dns:
      dns === undefined ? undefined : { zone: dns.zone, certificate: dns.certificate, domainName: dns.apiDomainName },
    auth:
      cognito === undefined
        ? {
            // Only reachable from the certificate-less test: without a domain there is no pool, so a
            // stand-in secret is imported purely to keep the construct's wiring exercised.
            issuerUrl: 'https://cognito-idp.example.com/pool',
            userPoolClientId: 'test-client-id',
            clientSecret: Secret.fromSecretNameV2(network, 'StandInClientSecret', 'stand-in-client-secret'),
            frontendUrl: config.auth.frontendUrl,
          }
        : {
            issuerUrl: cognito.issuerUrl,
            userPoolClientId: cognito.userPoolClient.userPoolClientId,
            clientSecret: cognito.clientSecret,
            frontendUrl: config.auth.frontendUrl,
          },
  });

  return { template: Template.fromStack(application), network, database, application, dns, cognito };
}

/** Finds the single listener on a given port, or fails the test if there is not exactly one. */
function listenerOnPort(template: Template, port: number): ResourceEntry {
  const listeners = resourcesOfType(template, 'AWS::ElasticLoadBalancingV2::Listener').filter(
    ({ properties }) => properties.Port === port,
  );
  expect(listeners).toHaveLength(1);
  return listeners[0];
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

describe('ApplicationStack database wiring', () => {
  test('passes the database endpoint as plain environment variables', () => {
    const template = buildStacks('dev').template;
    const container = single(template, 'AWS::ECS::TaskDefinition').properties.ContainerDefinitions[0];
    const environment = Object.fromEntries(
      (container.Environment ?? []).map((entry: { Name: string; Value: unknown }) => [entry.Name, entry.Value]),
    );

    expect(environment.SERVER_PORT).toBe('8080');
    expect(environment.DB_NAME).toBe('ecommerce');
    // The host and port are tokens resolved from the database stack, never literals in this stack.
    expect(json(environment.DB_HOST)).toContain('EndpointAddress');
    expect(json(environment.DB_PORT)).toContain('EndpointPort');
  });

  test('injects the credentials from Secrets Manager instead of carrying them', () => {
    const template = buildStacks('dev').template;
    const container = single(template, 'AWS::ECS::TaskDefinition').properties.ContainerDefinitions[0];
    const secrets = Object.fromEntries(
      (container.Secrets ?? []).map((secret: { Name: string; ValueFrom: unknown }) => [
        secret.Name,
        secret.ValueFrom,
      ]),
    );

    expect(Object.keys(secrets).sort()).toEqual(['COGNITO_CLIENT_SECRET', 'DB_PASSWORD', 'DB_USERNAME']);
    // ECS resolves `{{resolve:secretsmanager:<arn>:SecretString:<field>::}}` at container start.
    expect(json(secrets.DB_USERNAME)).toContain(':username::');
    expect(json(secrets.DB_PASSWORD)).toContain(':password::');
    expect(json(secrets.DB_PASSWORD)).toContain('Credentials');
    // No credential value ever appears in the template.
    expect(json(container)).not.toContain('password=');
  });

  test('creates no database resource of its own', () => {
    const template = buildStacks('dev').template;

    template.resourceCountIs('AWS::RDS::DBInstance', 0);
    template.resourceCountIs('AWS::SecretsManager::Secret', 0);
  });
});

describe('ApplicationStack authentication wiring', () => {
  test('passes the Cognito connection details as plain environment variables', () => {
    const template = buildStacks('dev').template;
    const container = single(template, 'AWS::ECS::TaskDefinition').properties.ContainerDefinitions[0];
    const environment = Object.fromEntries(
      (container.Environment ?? []).map((entry: { Name: string; Value: unknown }) => [entry.Name, entry.Value]),
    );

    // The issuer, client id and logout URI are tokens resolved from the Cognito stack, never
    // literals in this stack.
    expect(json(environment.COGNITO_ISSUER_URI)).toContain('test-cognito-dev');
    expect(json(environment.COGNITO_CLIENT_ID)).toContain('test-cognito-dev');
    // Post-logout the browser returns to the SPA, not the API.
    expect(environment.FRONTEND_URL).toBe('https://dev.example.com');
    // CORS origins are an explicit allowlist and never a wildcard: the local dev server and the
    // deployed dev SPA.
    expect(environment.CORS_ALLOWED_ORIGINS).toBe('http://localhost:5173,https://dev.example.com');
    expect(json(environment.CORS_ALLOWED_ORIGINS)).not.toContain('*');
    // Session timeout travels in the ISO-8601 form Spring Boot's Duration binding expects.
    expect(environment.SESSION_TIMEOUT).toBe('PT8H');
  });

  test('injects the Cognito client secret from Secrets Manager instead of carrying it', () => {
    const template = buildStacks('dev').template;
    const container = single(template, 'AWS::ECS::TaskDefinition').properties.ContainerDefinitions[0];
    const secrets = Object.fromEntries(
      (container.Secrets ?? []).map((secret: { Name: string; ValueFrom: unknown }) => [secret.Name, secret.ValueFrom]),
    );

    expect(Object.keys(secrets).sort()).toEqual(['COGNITO_CLIENT_SECRET', 'DB_PASSWORD', 'DB_USERNAME']);
    // The secret comes from the Cognito stack's secret, under the `clientSecret` field.
    expect(json(secrets.COGNITO_CLIENT_SECRET)).toContain(':clientSecret::');
    expect(json(secrets.COGNITO_CLIENT_SECRET)).toContain('ClientSecret');
    // No credential value ever appears in the template.
    expect(json(container)).not.toContain('client-secret-value');
  });

  test('defines no Cognito resource of its own, only references the Cognito stack', () => {
    const template = buildStacks('dev').template;

    template.resourceCountIs('AWS::Cognito::UserPool', 0);
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 0);
  });

  test('adds HSTS to the HTTPS listener so browsers never retry over plaintext', () => {
    const { template } = buildStacks('dev', { dns: TEST_DNS });
    const listener = listenerOnPort(template, 443);
    const attributes = Object.fromEntries(
      (listener.properties.ListenerAttributes ?? []).map((attribute: { Key: string; Value: string }) => [
        attribute.Key,
        attribute.Value,
      ]),
    );

    expect(attributes['routing.http.response.strict_transport_security.header_value']).toBe(
      'max-age=31536000; includeSubDomains',
    );
  });

  test('adds no new security group rule for the authentication wiring', () => {
    const template = buildStacks('dev').template;

    // Phase 4 changes IAM and the task definition only: the security group model is untouched.
    expect(resourcesOfType(template, 'AWS::EC2::SecurityGroupIngress')).toHaveLength(1);
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
  test('gives the execution role only image pull, log write and database secret permissions', () => {
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
        'secretsmanager:GetSecretValue',
      ]),
    );
    expect(actions).not.toContain('*');
    expect(actions.some((action) => action.endsWith(':*'))).toBe(false);
    expect(actions.some((action) => action.startsWith('kms:'))).toBe(false);
  });

  test('scopes the image pull, log write and secret read grants to the specific resources', () => {
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
    // Both secrets are read: the Phase 3 database credentials and the Phase 4 Cognito client secret.
    expect(json(statements)).toContain('Credentials');
    expect(json(statements)).toContain('ClientSecret');
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
  test('listens on HTTP port 80 and forwards to the target group when no certificate is configured', () => {
    // Every environment has a certificate from Phase 4 on, so the forwarding port 80 listener only
    // exists on a stack built without dns; the configured path redirects 80 to 443 instead.
    const template = buildStacks('dev', { dns: null }).template;
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

describe('ApplicationStack DNS and TLS', () => {
  test('still supports a certificate-less listener when a stack is built without dns', () => {
    // Every environment configures a domain from Phase 4 on (auth needs HTTPS), so this exercises
    // the construct's optional-certificate branch directly rather than through a real environment.
    const template = buildStacks('dev', { dns: null }).template;
    const listener = single(template, 'AWS::ElasticLoadBalancingV2::Listener');

    expect(listener.properties).toMatchObject({ Port: 80, Protocol: 'HTTP' });
    expect(listener.properties.DefaultActions[0].Type).toBe('forward');
    template.resourceCountIs('AWS::Route53::RecordSet', 0);

    // ApiUrl is still the load balancer's own plaintext name, and there is no secondary HTTP output.
    const outputs = template.toJSON().Outputs;
    expect(json(outputs.ApiUrl.Value)).toContain('http://');
    expect(outputs.HttpApiUrl).toBeUndefined();
  });

  test('terminates TLS on 443 and forwards to the existing target group', () => {
    const { template, dns } = buildStacks('dev', { dns: TEST_DNS });
    const listener = listenerOnPort(template, 443);

    expect(listener.properties).toMatchObject({
      Port: 443,
      Protocol: 'HTTPS',
      // TLS 1.2 floor: the older RECOMMENDED policy still negotiates TLS 1.0/1.1.
      SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
    });
    expect(listener.properties.DefaultActions).toHaveLength(1);
    expect(listener.properties.DefaultActions[0].Type).toBe('forward');
    expect(json(listener.properties.DefaultActions[0].TargetGroupArn)).toContain('ApiTargetGroup');

    // The certificate is consumed from the DNS stack by reference, never as a literal ARN string.
    expect(listener.properties.Certificates).toHaveLength(1);
    expect(json(listener.properties.Certificates[0].CertificateArn)).toContain(dns!.stackName);
  });

  test('redirects plaintext HTTP to HTTPS with a permanent redirect', () => {
    const template = buildStacks('dev', { dns: TEST_DNS }).template;
    const listener = listenerOnPort(template, 80);

    // A redirect action, not a forward: no plaintext request ever reaches the application.
    expect(listener.properties).toMatchObject({ Port: 80, Protocol: 'HTTP' });
    expect(listener.properties.DefaultActions).toEqual([
      { Type: 'redirect', RedirectConfig: { Protocol: 'HTTPS', Port: '443', StatusCode: 'HTTP_301' } },
    ]);
  });

  test('creates an alias A record to the load balancer, never an IP address', () => {
    const { template, dns } = buildStacks('dev', { dns: TEST_DNS });
    const record = single(template, 'AWS::Route53::RecordSet');

    expect(record.properties).toMatchObject({ Name: `${TEST_FQDN}.`, Type: 'A' });
    // Alias to the load balancer: its DNS name and canonical hosted zone id, resolved by Route 53.
    expect(json(record.properties.AliasTarget)).toContain('ApiLoadBalancer');
    expect(json(record.properties.AliasTarget)).toContain('DNSName');
    expect(record.properties.ResourceRecords).toBeUndefined();
    expect(record.properties.TTL).toBeUndefined();
    // The zone comes from the DNS stack by reference.
    expect(json(record.properties.HostedZoneId)).toContain(dns!.stackName);
  });

  test('defines neither the hosted zone nor the certificate, only references them', () => {
    const template = buildStacks('dev', { dns: TEST_DNS }).template;

    template.resourceCountIs('AWS::Route53::HostedZone', 0);
    template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
  });

  test('publishes the HTTPS URL and keeps the plaintext URL for the redirect check', () => {
    const template = buildStacks('dev', { dns: TEST_DNS }).template;
    const outputs = template.toJSON().Outputs;

    expect(outputs.ApiUrl.Value).toBe(`https://${TEST_FQDN}`);
    expect(outputs.ApiUrl.Export.Name).toBe('ecommerce-dev-api-url');
    expect(json(outputs.HttpApiUrl.Value)).toContain('http://');
    expect(outputs.HttpApiUrl.Export.Name).toBe('ecommerce-dev-api-http-url');
  });

  test('adds no duplicate rule for 443 - the Phase 1 security group already allows it', () => {
    const template = buildStacks('dev', { dns: TEST_DNS }).template;

    const ingress = resourcesOfType(template, 'AWS::EC2::SecurityGroupIngress');
    expect(ingress).toHaveLength(1);
    expect(ingress[0].properties).toMatchObject({ FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0' });
    expect(ingress.some(({ properties }) => properties.FromPort === 443)).toBe(false);
  });
});
