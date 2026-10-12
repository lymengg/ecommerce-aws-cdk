import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { getEnvironmentConfig } from '../lib/config';
import { EnvironmentName } from '../lib/config/types';
import { EcommerceSecurityStack } from '../lib/stacks/security-stack';

const TEST_ACCOUNT = '123456789012';

interface ResourceEntry {
  readonly logicalId: string;
  readonly properties: Record<string, any>;
}

function buildTemplate(environment: EnvironmentName): Template {
  const app = new App();
  const config = getEnvironmentConfig(environment);
  const stack = new EcommerceSecurityStack(app, `test-security-${environment}`, {
    env: { account: TEST_ACCOUNT, region: config.region },
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

/** The logical id a rule's GroupId points at, for rules rendered as separate resources. */
function groupIdRef(groupId: unknown): string | undefined {
  return (groupId as { 'Fn::GetAtt'?: string[] } | undefined)?.['Fn::GetAtt']?.[0];
}

describe('EcommerceSecurityStack security groups', () => {
  test('creates the service-owned tier security groups in the shared VPC', () => {
    const template = buildTemplate('dev');

    // The service owns its application and database groups; the load balancer group is the
    // platform's shared ingress group, imported - never created here.
    expect(securityGroupByDescription(template, 'Application tier, private subnets only')).toBeDefined();
    expect(securityGroupByDescription(template, 'Database tier, private subnets only')).toBeDefined();
    expect(resourcesOfType(template, 'AWS::EC2::SecurityGroup')).toHaveLength(2);
  });

  test('accepts no traffic directly from the internet on any of its own groups', () => {
    // The internet-facing group lives in the platform's ingress stack; the service's groups admit
    // traffic only from the shared ALB and from each other, both by security group reference.
    const template = buildTemplate('dev');
    const openIngress = resourcesOfType(template, 'AWS::EC2::SecurityGroup').flatMap(({ properties }) =>
      (properties.SecurityGroupIngress ?? []).filter(
        (rule: { CidrIp?: string; CidrIpv6?: string }) => rule.CidrIp === '0.0.0.0/0' || rule.CidrIpv6 === '::/0',
      ),
    );

    expect(openIngress).toHaveLength(0);
  });

  test('gives the application tier access from the shared load balancer group only', () => {
    const template = buildTemplate('dev');
    const application = securityGroupByDescription(template, 'Application tier, private subnets only');

    const ingress = resourcesOfType(template, 'AWS::EC2::SecurityGroupIngress').filter(
      ({ properties }) => groupIdRef(properties.GroupId) === application.logicalId,
    );

    expect(ingress).toHaveLength(1);
    expect(ingress[0].properties).toMatchObject({
      FromPort: 8080,
      ToPort: 8080,
      IpProtocol: 'tcp',
      // The shared ingress group is imported from the platform contract, not a group in this stack.
      SourceSecurityGroupId: { 'Fn::ImportValue': 'acme-dev-alb-security-group-id' },
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

describe('EcommerceSecurityStack foundation imports', () => {
  test('anchors the security groups in the shared VPC via the acme-<env> export', () => {
    const template = buildTemplate('dev');

    // The security groups and the shared-ALB acceptance rule are the consumers inside this stack,
    // so vpc-id and alb-security-group-id are the imports that materialise here; the subnet, zone,
    // listener and ALB-attribute imports resolve in the stacks that consume them downstream.
    for (const { properties } of resourcesOfType(template, 'AWS::EC2::SecurityGroup')) {
      expect(properties.VpcId).toEqual({ 'Fn::ImportValue': 'acme-dev-vpc-id' });
    }
  });
});
