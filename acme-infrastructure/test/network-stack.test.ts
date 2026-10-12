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

function subnetsOfType(template: Template, subnetType: 'Public' | 'Private' | 'Isolated'): ResourceEntry[] {
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
  test('creates one public, one private and one isolated subnet per Availability Zone', () => {
    const template = buildTemplate('dev');

    template.resourceCountIs('AWS::EC2::Subnet', 6);
    expect(subnetsOfType(template, 'Public')).toHaveLength(2);
    expect(subnetsOfType(template, 'Private')).toHaveLength(2);
    expect(subnetsOfType(template, 'Isolated')).toHaveLength(2);
  });

  test('spreads the subnets over two Availability Zones', () => {
    expect(availabilityZones(buildTemplate('dev'))).toHaveLength(2);
  });

  test('spreads the production subnets over three Availability Zones', () => {
    const template = buildTemplate('prod');

    expect(availabilityZones(template)).toHaveLength(3);
    template.resourceCountIs('AWS::EC2::Subnet', 9);
    expect(subnetsOfType(template, 'Isolated')).toHaveLength(3);
  });

  test('honours the configured Availability Zone count without a pinned account', () => {
    // Regression guard: CDK caps an environment-agnostic stack at two Availability Zones
    // (firstTwoAgnosticAzs), so relying on maxAzs silently produced a two zone production VPC.
    const template = buildAgnosticTemplate('prod');

    expect(availabilityZones(template)).toHaveLength(3);
    template.resourceCountIs('AWS::EC2::Subnet', 9);
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

describe('NetworkStack database subnets', () => {
  test('places the database subnets in isolated subnets with no route off the VPC', () => {
    const template = buildTemplate('dev');
    const isolatedSubnetIds = subnetsOfType(template, 'Isolated').map(({ logicalId }) => logicalId);

    const isolatedRouteTableIds = resourcesOfType(template, 'AWS::EC2::SubnetRouteTableAssociation')
      .filter(({ properties }) => isolatedSubnetIds.includes((properties.SubnetId as { Ref: string }).Ref))
      .map(({ properties }) => (properties.RouteTableId as { Ref: string }).Ref);

    // Every isolated subnet has its own route table...
    expect(isolatedRouteTableIds).toHaveLength(2);

    // ...and no route in the template belongs to any of them, so there is no path to the internet
    // gateway, to a NAT gateway, or anywhere else outside the VPC.
    for (const { properties } of resourcesOfType(template, 'AWS::EC2::Route')) {
      expect(isolatedRouteTableIds).not.toContain((properties.RouteTableId as { Ref: string }).Ref);
    }
  });

  test('still routes only the public and private subnets to the internet and NAT gateways', () => {
    const template = buildTemplate('dev');
    const defaultRoutes = resourcesOfType(template, 'AWS::EC2::Route').filter(
      ({ properties }) => properties.DestinationCidrBlock === '0.0.0.0/0',
    );

    expect(routesTo(template, 'GatewayId')).toHaveLength(2);
    expect(routesTo(template, 'NatGatewayId')).toHaveLength(2);
    expect(defaultRoutes).toHaveLength(4);
  });
});

describe('NetworkStack tags', () => {
  test('tags every resource with the project, environment and management tool', () => {
    const template = buildTemplate('uat');

    for (const type of ['AWS::EC2::VPC', 'AWS::EC2::Subnet', 'AWS::EC2::NatGateway']) {
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

    template.hasOutput('VpcId', { Export: { Name: 'acme-dev-vpc-id' } });
    template.hasOutput('PublicSubnetIds', { Export: { Name: 'acme-dev-public-subnet-ids' } });
    template.hasOutput('PrivateSubnetIds', { Export: { Name: 'acme-dev-private-subnet-ids' } });
    template.hasOutput('DatabaseSubnetIds', { Export: { Name: 'acme-dev-database-subnet-ids' } });
  });

  test('exports no security group ids - services own their security posture', () => {
    const template = buildTemplate('dev');

    template.resourceCountIs('AWS::EC2::SecurityGroup', 0);
    expect(Object.keys(template.toJSON().Outputs ?? {}).filter((name) => name.includes('SecurityGroup'))).toHaveLength(0);
  });

  test('lists one subnet id per Availability Zone', () => {
    const outputs = buildTemplate('dev').toJSON().Outputs;

    expect(outputs.PublicSubnetIds.Value['Fn::Join'][1]).toHaveLength(2);
    expect(outputs.PrivateSubnetIds.Value['Fn::Join'][1]).toHaveLength(2);
    expect(outputs.DatabaseSubnetIds.Value['Fn::Join'][1]).toHaveLength(2);
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
