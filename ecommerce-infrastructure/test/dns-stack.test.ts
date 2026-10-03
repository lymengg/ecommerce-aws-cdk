import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { getEnvironmentConfig } from '../lib/config';
import { DnsConfig, EnvironmentConfig, EnvironmentName } from '../lib/config/types';
import { DnsStack } from '../lib/stacks/dns-stack';

/**
 * Account used in the tests only, so that the synthesised template is environment specific. The
 * stacks themselves never hardcode an account id - test/config.test.ts enforces that.
 */
const TEST_ACCOUNT = '123456789012';

/** A delegated subdomain injected into the configuration, independent of the developer's shell. */
const TEST_DNS: DnsConfig = { zoneName: 'dev.example.com', apiSubdomain: 'api' };

interface ResourceEntry {
  readonly logicalId: string;
  readonly properties: Record<string, any>;
}

interface BuiltStacks {
  readonly template: Template;
  readonly stack: DnsStack;
}

/**
 * Builds the Phase 3.5 DNS stack in one app, exactly as `bin/ecommerce.ts` does. The DNS block is
 * injected rather than read from the environment so the suite does not depend on a developer having
 * set `ECOMMERCE_<ENV>_DOMAIN`.
 */
function buildStacks(environment: EnvironmentName, dns: DnsConfig = TEST_DNS): BuiltStacks {
  const app = new App();
  const base = getEnvironmentConfig(environment);
  const config: EnvironmentConfig = { ...base, dns };
  const stack = new DnsStack(app, `test-dns-${environment}`, {
    env: { account: TEST_ACCOUNT, region: config.region },
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

/** Serialises a value so a token, whatever its shape, can be asserted against by substring. */
function json(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Route 53 expresses tags as `HostedZoneTags` rather than the usual `Tags`; every other resource
 * here uses `Tags`. Reading both keeps the tag assertions uniform.
 */
function tagMap(properties: Record<string, any>): Record<string, string> {
  return Object.fromEntries(
    (properties.Tags ?? properties.HostedZoneTags ?? []).map((tag: { Key: string; Value: string }) => [
      tag.Key,
      tag.Value,
    ]),
  );
}

describe('DnsStack hosted zone', () => {
  test('creates a public hosted zone for the delegated subdomain', () => {
    const { template } = buildStacks('dev');
    const zone = single(template, 'AWS::Route53::HostedZone');

    // Public (no VPCs associated) and named for the delegated subdomain. Route 53 normalises the
    // name with a trailing dot.
    expect(zone.properties).toMatchObject({ Name: 'dev.example.com.' });
    expect(zone.properties.VPCs).toBeUndefined();
  });

  test('creates the zone rather than looking one up, so synth needs no credentials', () => {
    const { template } = buildStacks('dev');

    // A lookup would add a context/import parameter; the only parameter here is the one CDK always
    // adds for bootstrap version checks, so nothing is resolved at synth time.
    template.resourceCountIs('AWS::Route53::HostedZone', 1);
    expect(Object.keys(template.toJSON().Parameters ?? {})).toEqual(['BootstrapVersion']);
  });

  test('names the zone from the configured subdomain, not a literal', () => {
    const zone = single(buildStacks('uat', { zoneName: 'uat.example.org', apiSubdomain: 'api' }).template,
      'AWS::Route53::HostedZone');

    expect(zone.properties.Name).toBe('uat.example.org.');
  });
});

describe('DnsStack certificate', () => {
  test('covers the API fully qualified domain name', () => {
    const certificate = single(buildStacks('dev').template, 'AWS::CertificateManager::Certificate');

    expect(certificate.properties).toMatchObject({
      DomainName: 'api.dev.example.com',
      ValidationMethod: 'DNS',
    });
  });

  test('uses the API subdomain from configuration', () => {
    const certificate = single(
      buildStacks('dev', { zoneName: 'dev.example.com', apiSubdomain: 'www' }).template,
      'AWS::CertificateManager::Certificate',
    );

    expect(certificate.properties.DomainName).toBe('www.dev.example.com');
  });

  test('is DNS validated against the hosted zone it creates', () => {
    const { template } = buildStacks('dev');
    const zone = single(template, 'AWS::Route53::HostedZone');
    const certificate = single(template, 'AWS::CertificateManager::Certificate');

    // A single domain validation option that points ACM at the hosted zone, so ACM creates and
    // renews the validation CNAME itself - no email approval, no manual record.
    expect(certificate.properties.DomainValidationOptions).toHaveLength(1);
    expect(certificate.properties.DomainValidationOptions[0].DomainName).toBe('api.dev.example.com');
    expect(json(certificate.properties.DomainValidationOptions[0].HostedZoneId)).toContain(zone.logicalId);
  });

  test('covers only the API name - no wildcard and no extra subject alternative names', () => {
    const certificate = single(buildStacks('dev').template, 'AWS::CertificateManager::Certificate');

    expect(certificate.properties.DomainName).not.toContain('*');
    expect(certificate.properties.SubjectAlternativeNames).toBeUndefined();
  });
});

describe('DnsStack removal policy', () => {
  test('destroys the zone with dev and retains it in uat and prod', () => {
    buildStacks('dev').template.hasResource('AWS::Route53::HostedZone', { DeletionPolicy: 'Delete' });
    buildStacks('uat').template.hasResource('AWS::Route53::HostedZone', { DeletionPolicy: 'Retain' });
    buildStacks('prod').template.hasResource('AWS::Route53::HostedZone', { DeletionPolicy: 'Retain' });
  });
});

describe('DnsStack tags', () => {
  test('tags the zone and the certificate with the project, environment and management tool', () => {
    const template = buildStacks('uat').template;

    for (const type of ['AWS::Route53::HostedZone', 'AWS::CertificateManager::Certificate']) {
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

describe('DnsStack outputs', () => {
  test('exports the delegation name servers, the certificate arn and the API domain name', () => {
    const template = buildStacks('dev').template;

    template.hasOutput('HostedZoneNameServers', { Export: { Name: 'ecommerce-dev-hosted-zone-name-servers' } });
    template.hasOutput('CertificateArn', { Export: { Name: 'ecommerce-dev-certificate-arn' } });
    template.hasOutput('ApiDomainName', { Export: { Name: 'ecommerce-dev-api-domain-name' } });
  });

  test('exports the domain name the API answers on', () => {
    const outputs = buildStacks('dev').template.toJSON().Outputs;

    expect(outputs.ApiDomainName.Value).toBe('api.dev.example.com');
  });

  test('uses environment specific export names so environments do not clash', () => {
    const outputs = buildStacks('prod').template.toJSON().Outputs;

    expect(outputs.CertificateArn.Export.Name).toBe('ecommerce-prod-certificate-arn');
    expect(outputs.ApiDomainName.Export.Name).toBe('ecommerce-prod-api-domain-name');
  });
});
