import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';

import { getEnvironmentConfig } from '../lib/config';
import { DnsConfig, EnvironmentConfig, EnvironmentName } from '../lib/config/types';
import { ApplicationStack } from '../lib/stacks/application-stack';
import { CognitoStack } from '../lib/stacks/cognito-stack';
import { DatabaseStack } from '../lib/stacks/database-stack';
import { DnsStack } from '../lib/stacks/dns-stack';
import { RegistryLocation } from '../lib/stacks/ecr-stack';
import { IngressStack } from '../lib/stacks/ingress-stack';
import { TierSecurityGroups } from '../lib/constructs/tier-security-groups';
import { NetworkStack } from '../lib/stacks/network-stack';

/**
 * Account used in the tests only, so that the synthesised template is environment specific. The
 * stacks themselves never hardcode an account id - test/config.test.ts enforces that.
 */
const TEST_ACCOUNT = '123456789012';

/** The shared registry the test stacks pull from - same account here, a different one in uat/prod. */
const TEST_REGISTRY: RegistryLocation = { account: TEST_ACCOUNT, region: 'ap-southeast-1' };

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
 * Builds the Phase 1 network stack, the Phase 3 database stack, the Phase 3.5 DNS stack, the
 * Phase 4 Cognito stack and the application stack in one app, exactly as `bin/ecommerce.ts` does,
 * so the cross-stack wiring is exercised rather than stubbed. The Phase 2 registry is not built:
 * the application consumes it by name, which is the whole contract.
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
  const dns =
    config.dns === undefined ? undefined : new DnsStack(app, `test-dns-${environment}`, { env, config });
  // The platform's shared ingress is built as a real stack: the application attaches to it exactly
  // as it does in EcommerceStage. With no DNS stack a stand-in certificate keeps the listener
  // buildable for the certificate-less template path.
  const ingress = new IngressStack(app, `test-ingress-${environment}`, {
    env,
    config,
    vpc: network.vpc,
    certificate:
      dns?.certificate ??
      Certificate.fromCertificateArn(
        network,
        'StandInCertificate',
        `arn:aws:acm:${config.region}:${TEST_ACCOUNT}:certificate/stand-in`,
      ),
  });
  // The service's security groups live in a stack of their own, like EcommerceSecurityStack:
  // attaching them to the network stack would make network -> ingress and ingress -> network a
  // cycle.
  const security = new Stack(app, `test-security-${environment}`, { env });
  const securityGroups = new TierSecurityGroups(security, 'SecurityGroups', {
    vpc: network.vpc,
    albSecurityGroup: ingress.securityGroup,
  });
  const database = new DatabaseStack(app, `test-database-${environment}`, {
    env,
    config,
    vpc: network.vpc,
    databaseSecurityGroup: securityGroups.database,
  });
  // The Cognito stack needs a domain for its callback URIs, so it is only built when one exists.
  const cognito =
    config.dns === undefined ? undefined : new CognitoStack(app, `test-cognito-${environment}`, { env, config });
  const application = new ApplicationStack(app, `test-application-${environment}`, {
    env,
    config,
    vpc: network.vpc,
    registry: TEST_REGISTRY,
    sharedLoadBalancer: ingress.loadBalancer,
    httpsListener: ingress.httpsListener,
    applicationSecurityGroup: securityGroups.application,
    database: {
      host: database.instance.dbInstanceEndpointAddress,
      port: database.instance.dbInstanceEndpointPort,
      databaseName: config.database.databaseName,
      secret: database.credentialsSecret,
    },
    dns:
      dns === undefined ? undefined : { zone: dns.zone, domainName: dns.apiDomainName },
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

    // The repository is imported by name, not redefined, so this stack must create no repository
    // itself and the image URI names exactly `ecommerce-dev-api`.
    template.resourceCountIs('AWS::ECR::Repository', 0);
    expect(json(container.Image)).toContain('ecommerce-api');
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

  test('adds no new security group rule for the authentication wiring', () => {
    const template = buildStacks('dev').template;

    // Phase 4 changes IAM and the task definition only: the security group model is untouched.
    expect(resourcesOfType(template, 'AWS::EC2::SecurityGroupIngress')).toHaveLength(0);
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

    // The repository is imported by name, so the grant scopes to the literal ARN suffix.
    expect(json(statements)).toContain('repository/ecommerce-api');
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

describe('ApplicationStack shared ingress attachment', () => {
  test('creates no load balancer, listener or security group of its own', () => {
    // The ingress chassis belongs to the platform's acme-ingress-<env> stack; the service only
    // attaches a rule and a target group to it.
    const template = buildStacks('dev').template;

    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 0);
    template.resourceCountIs('AWS::EC2::SecurityGroup', 0);
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
  });

  test('hangs a host rule for the API host on the shared HTTPS listener', () => {
    const rule = single(buildStacks('dev', { dns: TEST_DNS }).template, 'AWS::ElasticLoadBalancingV2::ListenerRule');

    expect(rule.properties.Priority).toBe(100);
    expect(rule.properties.Conditions).toEqual([
      { Field: 'host-header', HostHeaderConfig: { Values: [TEST_FQDN] } },
    ]);
    expect(rule.properties.Actions[0].Type).toBe('forward');
    expect(json(rule.properties.Actions[0].TargetGroupArn)).toContain('ApiTargetGroup');
    // The listener belongs to the ingress stack: the rule references it by ARN, it is not redefined.
    expect(json(rule.properties.ListenerArn)).toContain('test-ingress-dev');
  });
});

describe('ApplicationStack target group', () => {
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
      'AWS::ElasticLoadBalancingV2::TargetGroup',
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

describe('ApplicationStack DNS', () => {
  test('still builds without dns, but publishes no record and no HTTPS URL', () => {
    // Every environment configures a domain from Phase 4 on (auth needs HTTPS), so this exercises
    // the construct's optional-DNS branch directly rather than through a real environment.
    const template = buildStacks('dev', { dns: null }).template;

    template.resourceCountIs('AWS::Route53::RecordSet', 0);

    // ApiUrl is still the load balancer's own plaintext name, and there is no secondary HTTP output.
    const outputs = template.toJSON().Outputs;
    expect(json(outputs.ApiUrl.Value)).toContain('http://');
    expect(outputs.HttpApiUrl).toBeUndefined();
  });

  test('creates an alias A record to the shared load balancer, never an IP address', () => {
    const { template, dns } = buildStacks('dev', { dns: TEST_DNS });
    const record = single(template, 'AWS::Route53::RecordSet');

    expect(record.properties).toMatchObject({ Name: `${TEST_FQDN}.`, Type: 'A' });
    // Alias to the shared load balancer: its DNS name and canonical hosted zone id, resolved by
    // Route 53. The ALB belongs to the ingress stack, so the name arrives as an import.
    expect(json(record.properties.AliasTarget)).toContain('test-ingress');
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
});
