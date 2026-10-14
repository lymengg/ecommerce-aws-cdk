import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { getEnvironmentConfig } from '../lib/config';
import { DnsConfig, EnvironmentConfig, EnvironmentName } from '../lib/config/types';
import { AuthCertificateStack } from '../lib/stacks/auth-certificate-stack';

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
  readonly stack: AuthCertificateStack;
}

/**
 * Builds the auth certificate stack in one app, exactly as `bin/ecommerce.ts` does: in `us-east-1`.
 * The stack resolves the shared zone by name at synthesis; with no context provider registered the
 * lookup falls back to its dummy value, so the suite stays independent of credentials and of
 * `ECOMMERCE_<ENV>_DOMAIN` being set.
 */
function buildStacks(environment: EnvironmentName, dns: DnsConfig = TEST_DNS): BuiltStacks {
  const app = new App();
  const base = getEnvironmentConfig(environment);
  const config: EnvironmentConfig = { ...base, dns };
  const stack = new AuthCertificateStack(app, `test-auth-cert-${environment}`, {
    env: { account: TEST_ACCOUNT, region: 'us-east-1' },
    config,
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

describe('AuthCertificateStack certificate', () => {
  test('covers the auth subdomain only, never a wildcard', () => {
    const certificate = single(buildStacks('dev').template, 'AWS::CertificateManager::Certificate');

    // A Cognito custom domain needs a certificate for exactly its host name. A wildcard would cover
    // it too but would also authorise every other host in the zone.
    expect(certificate.properties).toMatchObject({
      DomainName: 'auth.dev.example.com',
      ValidationMethod: 'DNS',
    });
    expect(certificate.properties.SubjectAlternativeNames).toBeUndefined();
  });

  test('lives in us-east-1, the only region a Cognito custom domain reads certificates from', () => {
    // The custom domain is fronted by a Cognito-managed CloudFront distribution, and CloudFront is
    // global: its certificates must exist in us-east-1 wherever the pool itself runs.
    const { stack } = buildStacks('dev');

    expect(stack.region).toBe('us-east-1');
  });

  test('takes the auth subdomain and zone name from configuration', () => {
    const certificate = single(
      buildStacks('uat', { zoneName: 'uat.example.org', apiSubdomain: 'api', authSubdomain: 'login' }).template,
      'AWS::CertificateManager::Certificate',
    );

    expect(certificate.properties.DomainName).toBe('login.uat.example.org');
  });

  test('validates by DNS against the shared hosted zone', () => {
    const certificate = single(buildStacks('dev').template, 'AWS::CertificateManager::Certificate');

    // CloudFormation creates the validation record itself when HostedZoneId is supplied - no
    // recordset resources appear in the template. The zone is resolved by name at synthesis:
    // against the real provider it is the account's zone id; in this suite it is the lookup's
    // DUMMY placeholder. Route 53 is global, so a literal id works from us-east-1 where the
    // dns stack's CloudFormation export could never reach.
    expect(certificate.properties.DomainValidationOptions).toEqual([
      { DomainName: 'auth.dev.example.com', HostedZoneId: 'DUMMY' },
    ]);
  });
});
