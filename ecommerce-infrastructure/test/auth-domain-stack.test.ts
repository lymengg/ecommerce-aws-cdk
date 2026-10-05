import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { UserPool } from 'aws-cdk-lib/aws-cognito';
import { HostedZone } from 'aws-cdk-lib/aws-route53';

import { getEnvironmentConfig } from '../lib/config';
import { DnsConfig, EnvironmentConfig, EnvironmentName } from '../lib/config/types';
import { AuthDomainStack } from '../lib/stacks/auth-domain-stack';

/**
 * Account used in the tests only, so that the synthesised template is environment specific. The
 * stacks themselves never hardcode an account id - test/config.test.ts enforces that.
 */
const TEST_ACCOUNT = '123456789012';

/** A delegated subdomain injected into the configuration, independent of the developer's shell. */
const TEST_DNS: DnsConfig = { zoneName: 'dev.example.com', apiSubdomain: 'api', authSubdomain: 'auth' };

interface ResourceEntry {
  readonly logicalId: string;
  readonly properties: Record<string, any>;
}

interface BuiltStacks {
  readonly template: Template;
  readonly stack: AuthDomainStack;
}

/**
 * Builds the auth domain stack in one app with imported dependencies - a pool, the us-east-1
 * certificate and the hosted zone are supplied as plain identifiers, so the suite needs no
 * credentials and no other stacks. In the real app the certificate ARN arrives across a region
 * boundary through CDK cross-region references; here a literal ARN exercises the same template
 * shape.
 */
function buildStacks(environment: EnvironmentName, dns: DnsConfig = TEST_DNS): BuiltStacks {
  // Same flag as cdk.json: the alias target reads the domain's CloudFrontDistribution attribute
  // directly instead of spinning up a custom resource to describe it.
  const app = new App({
    context: { '@aws-cdk/aws-route53-targets:userPoolDomainNameMethodWithoutCustomResource': true },
  });
  const base = getEnvironmentConfig(environment);
  const config: EnvironmentConfig = { ...base, dns };
  // Imports must be scoped inside a stack. A throwaway stack supplies the scope; the imported
  // attributes are literal strings, so consuming them in another stack emits no cross-stack link.
  const dependencies = new Stack(app, 'Dependencies', { env: { account: TEST_ACCOUNT, region: config.region } });
  const userPool = UserPool.fromUserPoolId(dependencies, 'Pool', 'us-east-1_Test1Pool');
  const certificate = Certificate.fromCertificateArn(
    dependencies,
    'Certificate',
    `arn:aws:acm:us-east-1:${TEST_ACCOUNT}:certificate/test-cert`,
  );
  const zone = HostedZone.fromHostedZoneAttributes(dependencies, 'Zone', {
    hostedZoneId: 'Z0000000000000000000TEST',
    zoneName: dns.zoneName,
  });
  const stack = new AuthDomainStack(app, `test-auth-domain-${environment}`, {
    env: { account: TEST_ACCOUNT, region: config.region },
    config,
    userPool,
    certificate,
    zone,
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

describe('AuthDomainStack custom domain', () => {
  test('serves managed login on the auth subdomain, not a Cognito prefix', () => {
    for (const environment of ['dev', 'uat', 'prod'] as EnvironmentName[]) {
      const { stack, template } = buildStacks(environment);
      const domain = single(template, 'AWS::Cognito::UserPoolDomain');

      // The Domain property is the whole host name: that is what makes it a custom domain, and
      // what replaces the old <prefix>.auth.<region>.amazoncognito.com address.
      expect(stack.authDomainName).toBe('auth.dev.example.com');
      expect(domain.properties.Domain).toBe('auth.dev.example.com');
      expect(domain.properties.UserPoolId).toBe('us-east-1_Test1Pool');
    }
  });

  test('points the domain at the us-east-1 certificate CloudFront requires', () => {
    const domain = single(buildStacks('dev').template, 'AWS::Cognito::UserPoolDomain');

    expect(domain.properties.CustomDomainConfig.CertificateArn).toBe(
      `arn:aws:acm:us-east-1:${TEST_ACCOUNT}:certificate/test-cert`,
    );
  });

  test('serves managed login (version 2), not the classic hosted UI Cognito defaults to', () => {
    for (const environment of ['dev', 'uat', 'prod'] as EnvironmentName[]) {
      const domain = single(buildStacks(environment).template, 'AWS::Cognito::UserPoolDomain');

      expect(domain.properties.ManagedLoginVersion).toBe(2);
    }
  });
});

describe('AuthDomainStack alias records', () => {
  test('publishes auth.<zone> on both address families, aliased to the managed distribution', () => {
    const { template } = buildStacks('dev');
    const records = resourcesOfType(template, 'AWS::Route53::RecordSet');

    expect(records).toHaveLength(2);
    const types = records.map((record) => record.properties.Type).sort();
    expect(types).toEqual(['A', 'AAAA']);
    for (const record of records) {
      expect(record.properties.Name).toBe('auth.dev.example.com.');
      // The target is the domain's CloudFrontDistribution attribute - the distribution Cognito
      // provisions for the custom domain.
      expect(json(record.properties.AliasTarget.DNSName)).toContain('CloudFrontDistribution');
    }
  });
});

describe('AuthDomainStack outputs', () => {
  test('exports the managed login URL', () => {
    const template = buildStacks('dev').template;

    template.hasOutput('AuthDomainUrl', {
      Value: 'https://auth.dev.example.com',
      Export: { Name: 'ecommerce-dev-auth-domain-url' },
    });
  });
});
