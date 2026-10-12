import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { getEnvironmentConfig } from '../lib/config';
import { EnvironmentName } from '../lib/config/types';
import { DnsStack } from '../lib/stacks/dns-stack';
import { IngressStack } from '../lib/stacks/ingress-stack';
import { NetworkStack } from '../lib/stacks/network-stack';

const TEST_ACCOUNT = '123456789012';

interface ResourceEntry {
  readonly logicalId: string;
  readonly properties: Record<string, any>;
}

/**
 * Builds the platform foundation exactly as PlatformStage does: the network, the DNS stack (for
 * the shared certificate) and the ingress stack attached to both.
 */
function buildStacks(environment: EnvironmentName): { template: Template; stack: IngressStack } {
  const app = new App();
  const config = getEnvironmentConfig(environment);
  const env = { account: TEST_ACCOUNT, region: config.region };

  const network = new NetworkStack(app, `test-network-${environment}`, { env, config });
  const dns = new DnsStack(app, `test-dns-${environment}`, { env, config });
  const stack = new IngressStack(app, `test-ingress-${environment}`, {
    env,
    config,
    vpc: network.vpc,
    certificate: dns.certificate,
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

describe('IngressStack shared load balancer', () => {
  test('is internet-facing in the public subnets and shared across services', () => {
    const loadBalancer = single(buildStacks('dev').template, 'AWS::ElasticLoadBalancingV2::LoadBalancer');

    expect(loadBalancer.properties).toMatchObject({
      Type: 'application',
      Scheme: 'internet-facing',
      Name: 'acme-dev-alb',
    });
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
});

describe('IngressStack security group', () => {
  test('opens only 80 and 443 to the internet and nothing else', () => {
    const securityGroup = single(buildStacks('dev').template, 'AWS::EC2::SecurityGroup');
    const ingress = securityGroup.properties.SecurityGroupIngress as { FromPort: number; CidrIp?: string }[];

    for (const rule of ingress) {
      expect(rule.CidrIp).toBe('0.0.0.0/0');
      expect([80, 443]).toContain(rule.FromPort);
    }
    expect(ingress).toHaveLength(2);
  });

  test('scopes egress to the VPC on the shared backend port, never the internet', () => {
    const securityGroup = single(buildStacks('dev').template, 'AWS::EC2::SecurityGroup');
    const egress = securityGroup.properties.SecurityGroupEgress as { CidrIp: string; FromPort: number }[];

    // One rule, to the VPC CIDR on 8080: the ALB can only ever reach service tasks.
    expect(egress).toEqual([
      expect.objectContaining({ CidrIp: '10.0.0.0/16', FromPort: 8080, ToPort: 8080, IpProtocol: 'tcp' }),
    ]);
  });
});

describe('IngressStack listeners', () => {
  test('redirects all plaintext HTTP to HTTPS permanently', () => {
    const listeners = resourcesOfType(buildStacks('dev').template, 'AWS::ElasticLoadBalancingV2::Listener');
    const http = listeners.find(({ properties }) => properties.Port === 80)!;

    expect(http.properties.Protocol).toBe('HTTP');
    expect(http.properties.DefaultActions).toEqual([
      { Type: 'redirect', RedirectConfig: { Protocol: 'HTTPS', Port: '443', StatusCode: 'HTTP_301' } },
    ]);
  });

  test('terminates TLS with a TLS 1.2 floor and answers unmatched hosts with 404', () => {
    const listeners = resourcesOfType(buildStacks('dev').template, 'AWS::ElasticLoadBalancingV2::Listener');
    const https = listeners.find(({ properties }) => properties.Port === 443)!;

    expect(https.properties).toMatchObject({
      Port: 443,
      Protocol: 'HTTPS',
      // TLS 1.2 floor: the older RECOMMENDED policy still negotiates TLS 1.0/1.1.
      SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
    });
    // A fixed 404 default: no service is the implicit catch all on the shared listener.
    expect(https.properties.DefaultActions).toEqual([
      {
        Type: 'fixed-response',
        FixedResponseConfig: {
          StatusCode: '404',
          ContentType: 'text/plain',
          MessageBody: 'No service matched this host.',
        },
      },
    ]);
    // The shared certificate is consumed from the DNS stack by reference.
    expect(https.properties.Certificates).toHaveLength(1);
  });

  test('carries HSTS so every service response arrives over a pinned-HTTPS browser', () => {
    const listeners = resourcesOfType(buildStacks('dev').template, 'AWS::ElasticLoadBalancingV2::Listener');
    const https = listeners.find(({ properties }) => properties.Port === 443)!;
    const attributes = Object.fromEntries(
      (https.properties.ListenerAttributes ?? []).map((attribute: { Key: string; Value: string }) => [
        attribute.Key,
        attribute.Value,
      ]),
    );

    expect(attributes['routing.http.response.strict_transport_security.header_value']).toBe(
      'max-age=31536000; includeSubDomains',
    );
  });
});

describe('IngressStack exports', () => {
  test('publishes everything a service needs to attach under the acme-<env>-* contract', () => {
    const template = buildStacks('dev').template;

    template.hasOutput('LoadBalancerArn', { Export: { Name: 'acme-dev-alb-arn' } });
    template.hasOutput('LoadBalancerDnsName', { Export: { Name: 'acme-dev-alb-dns-name' } });
    template.hasOutput('LoadBalancerCanonicalHostedZoneId', { Export: { Name: 'acme-dev-alb-canonical-hosted-zone-id' } });
    template.hasOutput('AlbSecurityGroupId', { Export: { Name: 'acme-dev-alb-security-group-id' } });
    template.hasOutput('HttpsListenerArn', { Export: { Name: 'acme-dev-https-listener-arn' } });
  });
});
