import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { getEnvironmentConfig } from '../lib/config';
import { EnvironmentName } from '../lib/config/types';
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

function buildTemplate(environment: EnvironmentName): Template {
  const app = new App();
  const config = getEnvironmentConfig(environment);
  const stack = new NetworkStack(app, `test-network-${environment}`, {
    env: { account: TEST_ACCOUNT, region: config.region },
    config,
  });
  return Template.fromStack(stack);
}

/**
 * Synthesises a stack without a pinned account, which is how the CDK CLI runs the app by default:
 * the account is only resolved from the credentials at deploy time.
 */
function buildAgnosticTemplate(environment: EnvironmentName): Template {
  const app = new App();
  const config = getEnvironmentConfig(environment);
  const stack = new NetworkStack(app, `test-network-agnostic-${environment}`, {
    env: { region: config.region },
    config,
  });
  return Template.fromStack(stack);
}

function resourcesOfType(template: Template, type: string): ResourceEntry[] {
  return Object.entries(template.findResources(type)).map(([logicalId, resource]) => ({
    logicalId,
    properties: (resource as any).Properties ?? {},
  }));
}

function securityGroupByDescription(template: Template, description: string): ResourceEntry {
  const match = resourcesOfType(template, 'AWS::EC2::SecurityGroup').find(
    ({ properties }) => properties.GroupDescription === description,
  );
  if (match === undefined) {
    throw new Error(`No security group found with description "${description}"`);
  }
  return match;
}

function subnetsOfType(template: Template, subnetType: 'Public' | 'Private'): ResourceEntry[] {
  return resourcesOfType(template, 'AWS::EC2::Subnet').filter(({ properties }) =>
    (properties.Tags ?? []).some(
      (tag: { Key: string; Value: string }) => tag.Key === 'aws-cdk:subnet-type' && tag.Value === subnetType,
    ),
  );
}

/** Distinct Availability Zones the subnets are placed in. */
function availabilityZones(template: Template): string[] {
  const zones = resourcesOfType(template, 'AWS::EC2::Subnet').map(({ properties }) =>
    JSON.stringify(properties.AvailabilityZone),
  );
  return [...new Set(zones)];
}

/** Tags of a resource as a key/value map, independent of tag order. */
function tagMap(properties: Record<string, any>): Record<string, string> {
  return Object.fromEntries(
    (properties.Tags ?? []).map((tag: { Key: string; Value: string }) => [tag.Key, tag.Value]),
  );
}

/** The logical id a rule's GroupId points at, for rules rendered as separate resources. */
function groupIdRef(groupId: unknown): string | undefined {
  return (groupId as { 'Fn::GetAtt'?: string[] } | undefined)?.['Fn::GetAtt']?.[0];
}

function routesTo(template: Template, target: 'GatewayId' | 'NatGatewayId'): ResourceEntry[] {
  return resourcesOfType(template, 'AWS::EC2::Route').filter(({ properties }) => properties[target] !== undefined);
}

describe('NetworkStack VPC', () => {
  test('creates a VPC with the CIDR from the environment configuration', () => {
    const template = buildTemplate('dev');

    template.hasResourceProperties('AWS::EC2::VPC', {
      CidrBlock: '10.0.0.0/16',
      EnableDnsSupport: true,
      EnableDnsHostnames: true,
    });
  });

  test('uses a different, non overlapping CIDR per environment', () => {
    buildTemplate('dev').hasResourceProperties('AWS::EC2::VPC', { CidrBlock: '10.0.0.0/16' });
    buildTemplate('uat').hasResourceProperties('AWS::EC2::VPC', { CidrBlock: '10.1.0.0/16' });
    buildTemplate('prod').hasResourceProperties('AWS::EC2::VPC', { CidrBlock: '10.2.0.0/16' });
  });
});

describe('NetworkStack subnets', () => {
  test('creates one public and one private subnet per Availability Zone', () => {
    const template = buildTemplate('dev');

    template.resourceCountIs('AWS::EC2::Subnet', 4);
    expect(subnetsOfType(template, 'Public')).toHaveLength(2);
    expect(subnetsOfType(template, 'Private')).toHaveLength(2);
  });

  test('spreads the subnets over two Availability Zones', () => {
    expect(availabilityZones(buildTemplate('dev'))).toHaveLength(2);
  });

  test('spreads the production subnets over three Availability Zones', () => {
    const template = buildTemplate('prod');

    expect(availabilityZones(template)).toHaveLength(3);
    template.resourceCountIs('AWS::EC2::Subnet', 6);
  });

  test('honours the configured Availability Zone count without a pinned account', () => {
    // Regression guard: CDK caps an environment-agnostic stack at two Availability Zones
    // (firstTwoAgnosticAzs), so relying on maxAzs silently produced a two zone production VPC.
    const template = buildAgnosticTemplate('prod');

    expect(availabilityZones(template)).toHaveLength(3);
    template.resourceCountIs('AWS::EC2::Subnet', 6);
    template.resourceCountIs('AWS::EC2::NatGateway', 3);
  });

  test('uses two Availability Zones in dev and uat, with or without a pinned account', () => {
    for (const environment of ['dev', 'uat'] as EnvironmentName[]) {
      expect(availabilityZones(buildTemplate(environment))).toHaveLength(2);
      expect(availabilityZones(buildAgnosticTemplate(environment))).toHaveLength(2);
    }
  });

  test('carves the subnets out of the VPC CIDR', () => {
    const cidrBlocks = subnetsOfType(buildTemplate('dev'), 'Public').map(
      ({ properties }) => properties.CidrBlock as string,
    );

    for (const cidrBlock of cidrBlocks) {
      expect(cidrBlock.startsWith('10.0.')).toBe(true);
    }
  });

  test('does not auto assign public IP addresses in the public subnets', () => {
    const template = buildTemplate('dev');

    for (const { properties } of subnetsOfType(template, 'Public')) {
      expect(properties.MapPublicIpOnLaunch).toBe(false);
    }
  });
});

describe('NetworkStack internet gateway', () => {
  test('creates exactly one internet gateway, attached to the VPC', () => {
    const template = buildTemplate('dev');

    template.resourceCountIs('AWS::EC2::InternetGateway', 1);
    template.resourceCountIs('AWS::EC2::VPCGatewayAttachment', 1);
  });

  test('routes public subnet traffic to the internet gateway', () => {
    const template = buildTemplate('dev');
    const internetGateway = resourcesOfType(template, 'AWS::EC2::InternetGateway')[0];

    const internetRoutes = routesTo(template, 'GatewayId');
    expect(internetRoutes).toHaveLength(2);
    for (const { properties } of internetRoutes) {
      expect(properties).toMatchObject({
        DestinationCidrBlock: '0.0.0.0/0',
        GatewayId: { Ref: internetGateway.logicalId },
      });
    }
  });

  test('attaches the public route tables to the public subnets', () => {
    const template = buildTemplate('dev');
    const publicSubnetIds = subnetsOfType(template, 'Public').map(({ logicalId }) => logicalId);

    const associations = resourcesOfType(template, 'AWS::EC2::SubnetRouteTableAssociation').map(
      ({ properties }) => (properties.SubnetId as { Ref: string }).Ref,
    );

    for (const subnetId of publicSubnetIds) {
      expect(associations).toContain(subnetId);
    }
  });
});

describe('NetworkStack NAT gateways', () => {
  test('dev uses a single NAT gateway to keep the cost down', () => {
    const template = buildTemplate('dev');

    template.resourceCountIs('AWS::EC2::NatGateway', 1);
    template.resourceCountIs('AWS::EC2::EIP', 1);
  });

  test('production uses one NAT gateway per Availability Zone', () => {
    buildTemplate('prod').resourceCountIs('AWS::EC2::NatGateway', 3);
  });

  test('places each NAT gateway in a public subnet with an elastic IP', () => {
    const template = buildTemplate('dev');
    const publicSubnetIds = subnetsOfType(template, 'Public').map(({ logicalId }) => logicalId);
    const elasticIps = resourcesOfType(template, 'AWS::EC2::EIP').map(({ logicalId }) => logicalId);

    for (const { properties } of resourcesOfType(template, 'AWS::EC2::NatGateway')) {
      expect(publicSubnetIds).toContain((properties.SubnetId as { Ref: string }).Ref);
      expect(elasticIps).toContain(groupIdRef(properties.AllocationId));
    }
  });

  test('routes private subnet traffic through a NAT gateway, never an internet gateway', () => {
    const template = buildTemplate('dev');
    const natGatewayIds = resourcesOfType(template, 'AWS::EC2::NatGateway').map(({ logicalId }) => logicalId);

    const natRoutes = routesTo(template, 'NatGatewayId');
    expect(natRoutes).toHaveLength(2);
    for (const { properties } of natRoutes) {
      expect(properties.DestinationCidrBlock).toBe('0.0.0.0/0');
      expect(natGatewayIds).toContain((properties.NatGatewayId as { Ref: string }).Ref);
    }
  });
});

describe('NetworkStack security groups', () => {
  test('creates the three tier security groups', () => {
    const template = buildTemplate('dev');

    expect(securityGroupByDescription(template, 'Internet facing load balancer tier')).toBeDefined();
    expect(securityGroupByDescription(template, 'Application tier, private subnets only')).toBeDefined();
    expect(securityGroupByDescription(template, 'Database tier, private subnets only')).toBeDefined();
  });

  test('only accepts inbound traffic from the internet on the load balancer, over TLS', () => {
    const template = buildTemplate('dev');
    const openIngress = resourcesOfType(template, 'AWS::EC2::SecurityGroup').flatMap(({ properties }) =>
      (properties.SecurityGroupIngress ?? []).filter(
        (rule: { CidrIp?: string; CidrIpv6?: string }) => rule.CidrIp === '0.0.0.0/0' || rule.CidrIpv6 === '::/0',
      ),
    );

    expect(openIngress).toHaveLength(1);
    expect(openIngress[0]).toMatchObject({ FromPort: 443, ToPort: 443, Description: 'HTTPS from the internet' });
  });

  test('gives the application tier access from the load balancer by security group reference', () => {
    const template = buildTemplate('dev');
    const alb = securityGroupByDescription(template, 'Internet facing load balancer tier');
    const application = securityGroupByDescription(template, 'Application tier, private subnets only');

    const ingress = resourcesOfType(template, 'AWS::EC2::SecurityGroupIngress').filter(
      ({ properties }) => groupIdRef(properties.GroupId) === application.logicalId,
    );

    expect(ingress).toHaveLength(1);
    expect(ingress[0].properties).toMatchObject({
      FromPort: 8080,
      ToPort: 8080,
      IpProtocol: 'tcp',
      SourceSecurityGroupId: { 'Fn::GetAtt': [alb.logicalId, 'GroupId'] },
    });
  });

  test('gives the database tier access from the application tier only, and never from a CIDR', () => {
    const template = buildTemplate('dev');
    const application = securityGroupByDescription(template, 'Application tier, private subnets only');
    const database = securityGroupByDescription(template, 'Database tier, private subnets only');

    const ingress = resourcesOfType(template, 'AWS::EC2::SecurityGroupIngress').filter(
      ({ properties }) => groupIdRef(properties.GroupId) === database.logicalId,
    );

    expect(ingress).toHaveLength(1);
    expect(ingress[0].properties).toMatchObject({
      FromPort: 5432,
      ToPort: 5432,
      IpProtocol: 'tcp',
      SourceSecurityGroupId: { 'Fn::GetAtt': [application.logicalId, 'GroupId'] },
    });
    expect(JSON.stringify(database.properties.SecurityGroupIngress ?? [])).not.toContain('0.0.0.0/0');
  });

  test('keeps the load balancer egress restricted to the application tier', () => {
    const template = buildTemplate('dev');
    const alb = securityGroupByDescription(template, 'Internet facing load balancer tier');
    const application = securityGroupByDescription(template, 'Application tier, private subnets only');

    // CloudFormation re-adds an allow-all egress rule when the inline egress list is empty, which is
    // why the group carries a no-traffic marker rule instead of an empty list.
    const inlineEgress = alb.properties.SecurityGroupEgress ?? [];
    expect(inlineEgress).not.toHaveLength(0);
    for (const rule of inlineEgress) {
      expect(rule.CidrIp).not.toBe('0.0.0.0/0');
      expect(rule.IpProtocol).not.toBe('-1');
    }

    const referencedEgress = resourcesOfType(template, 'AWS::EC2::SecurityGroupEgress').filter(
      ({ properties }) => groupIdRef(properties.GroupId) === alb.logicalId,
    );

    expect(referencedEgress).toHaveLength(1);
    expect(referencedEgress[0].properties).toMatchObject({
      FromPort: 8080,
      ToPort: 8080,
      DestinationSecurityGroupId: { 'Fn::GetAtt': [application.logicalId, 'GroupId'] },
    });
  });

  test('lets the application tier reach the database tier and the internet over TLS only', () => {
    const template = buildTemplate('dev');
    const application = securityGroupByDescription(template, 'Application tier, private subnets only');
    const database = securityGroupByDescription(template, 'Database tier, private subnets only');

    expect(application.properties.SecurityGroupEgress).toEqual([
      {
        CidrIp: '0.0.0.0/0',
        Description: 'Outbound HTTPS through the NAT Gateway',
        FromPort: 443,
        IpProtocol: 'tcp',
        ToPort: 443,
      },
    ]);

    const referencedEgress = resourcesOfType(template, 'AWS::EC2::SecurityGroupEgress').filter(
      ({ properties }) => groupIdRef(properties.GroupId) === application.logicalId,
    );

    expect(referencedEgress).toHaveLength(1);
    expect(referencedEgress[0].properties).toMatchObject({
      FromPort: 5432,
      DestinationSecurityGroupId: { 'Fn::GetAtt': [database.logicalId, 'GroupId'] },
    });
  });
});

describe('NetworkStack tags', () => {
  test('tags every resource with the project, environment and management tool', () => {
    const template = buildTemplate('uat');

    for (const type of ['AWS::EC2::VPC', 'AWS::EC2::Subnet', 'AWS::EC2::SecurityGroup', 'AWS::EC2::NatGateway']) {
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

  test('applies the environment tag of the deployed environment', () => {
    const template = buildTemplate('prod');
    const vpc = resourcesOfType(template, 'AWS::EC2::VPC')[0];

    expect(tagMap(vpc.properties).Environment).toBe('prod');
  });
});

describe('NetworkStack outputs', () => {
  test('exports the VPC and subnet ids for later stacks', () => {
    const template = buildTemplate('dev');

    template.hasOutput('VpcId', { Export: { Name: 'ecommerce-dev-vpc-id' } });
    template.hasOutput('PublicSubnetIds', { Export: { Name: 'ecommerce-dev-public-subnet-ids' } });
    template.hasOutput('PrivateSubnetIds', { Export: { Name: 'ecommerce-dev-private-subnet-ids' } });
  });

  test('exports the security group ids for later stacks', () => {
    const template = buildTemplate('dev');

    template.hasOutput('AlbSecurityGroupId', { Export: { Name: 'ecommerce-dev-alb-security-group-id' } });
    template.hasOutput('ApplicationSecurityGroupId', {
      Export: { Name: 'ecommerce-dev-application-security-group-id' },
    });
    template.hasOutput('DatabaseSecurityGroupId', {
      Export: { Name: 'ecommerce-dev-database-security-group-id' },
    });
  });

  test('lists one subnet id per Availability Zone', () => {
    const outputs = buildTemplate('dev').toJSON().Outputs;

    expect(outputs.PublicSubnetIds.Value['Fn::Join'][1]).toHaveLength(2);
    expect(outputs.PrivateSubnetIds.Value['Fn::Join'][1]).toHaveLength(2);
  });
});

describe('NetworkStack flow logs', () => {
  test('are off in dev to avoid CloudWatch ingestion cost', () => {
    buildTemplate('dev').resourceCountIs('AWS::EC2::FlowLog', 0);
  });

  test('capture all traffic in production', () => {
    const template = buildTemplate('prod');

    template.resourceCountIs('AWS::EC2::FlowLog', 1);
    template.hasResourceProperties('AWS::EC2::FlowLog', { TrafficType: 'ALL', ResourceType: 'VPC' });
    template.hasResource('AWS::Logs::LogGroup', {
      DeletionPolicy: 'Retain',
      Properties: { RetentionInDays: 90 },
    });
  });

  test('use a delivery role that is scoped to the log group', () => {
    const template = buildTemplate('prod');
    const deliveryPolicy = resourcesOfType(template, 'AWS::IAM::Policy').find(({ properties }) =>
      JSON.stringify(properties).includes('logs:PutLogEvents'),
    );

    expect(deliveryPolicy).toBeDefined();
    const statements = deliveryPolicy!.properties.PolicyDocument.Statement;
    const actions = statements.flatMap((statement: { Action: string | string[] }) =>
      Array.isArray(statement.Action) ? statement.Action : [statement.Action],
    );

    expect(actions).toEqual(expect.arrayContaining(['logs:CreateLogStream', 'logs:PutLogEvents']));
    expect(actions).not.toContain('*');
    expect(actions).not.toContain('logs:*');
    expect(JSON.stringify(statements.map((statement: { Resource: unknown }) => statement.Resource))).not.toContain('"*"');
  });

  test('never grant an administrator or wildcard managed policy', () => {
    const templateJson = JSON.stringify(buildTemplate('prod').toJSON());

    expect(templateJson).not.toContain('AdministratorAccess');
    expect(templateJson).not.toContain('PowerUserAccess');
    expect(templateJson).not.toContain('iam:PassRole');
  });
});
