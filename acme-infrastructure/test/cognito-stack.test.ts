import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { getEnvironmentConfig } from '../lib/config';
import { DnsConfig, EnvironmentConfig, EnvironmentName } from '../lib/config/types';
import { CognitoStack } from '../lib/stacks/cognito-stack';

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
  readonly stack: CognitoStack;
}

/**
 * Builds the Phase 4 Cognito stack in one app, exactly as `bin/ecommerce.ts` does. The DNS block is
 * injected rather than read from the environment so the suite does not depend on a developer having
 * set `ECOMMERCE_<ENV>_DOMAIN`.
 */
function buildStacks(environment: EnvironmentName, dns: DnsConfig = TEST_DNS): BuiltStacks {
  const app = new App();
  const base = getEnvironmentConfig(environment);
  const config: EnvironmentConfig = { ...base, dns };
  const stack = new CognitoStack(app, `test-cognito-${environment}`, {
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
 * Cognito expresses user pool tags as the `UserPoolTags` map rather than the usual `Tags` list;
 * the app client and domain use `Tags`. Reading both keeps the tag assertions uniform.
 */
function tagMap(properties: Record<string, any>): Record<string, string> {
  if (properties.UserPoolTags !== undefined) {
    return properties.UserPoolTags;
  }
  return Object.fromEntries(
    (properties.Tags ?? []).map((tag: { Key: string; Value: string }) => [tag.Key, tag.Value]),
  );
}

describe('CognitoStack user pool', () => {
  test('creates an environment specific user pool', () => {
    const userPool = single(buildStacks('dev').template, 'AWS::Cognito::UserPool');

    expect(userPool.properties.UserPoolName).toBe('ecommerce-dev-users');
  });

  test('takes the password policy from configuration', () => {
    const dev = single(buildStacks('dev').template, 'AWS::Cognito::UserPool').properties.Policies.PasswordPolicy;
    const prod = single(buildStacks('prod').template, 'AWS::Cognito::UserPool').properties.Policies.PasswordPolicy;

    expect(dev).toMatchObject({
      MinimumLength: 8,
      RequireUppercase: false,
      RequireLowercase: true,
      // Cognito names the digit requirement `RequireNumbers` in CloudFormation.
      RequireNumbers: true,
      RequireSymbols: false,
    });
    // Production is the strict end of every lever: longer, and all four character classes.
    expect(prod).toMatchObject({
      MinimumLength: 14,
      RequireUppercase: true,
      RequireLowercase: true,
      RequireNumbers: true,
      RequireSymbols: true,
    });
  });

  test('takes the MFA mode from configuration, offering only time-based one-time passwords', () => {
    const dev = single(buildStacks('dev').template, 'AWS::Cognito::UserPool');
    const prod = single(buildStacks('prod').template, 'AWS::Cognito::UserPool');

    expect(dev.properties.MfaConfiguration).toBe('OFF');
    expect(prod.properties.MfaConfiguration).toBe('ON');
    // TOTP only: no SMS dependency.
    expect(prod.properties.EnabledMfas).toEqual(['SOFTWARE_TOKEN_MFA']);
  });

  test('takes self sign-up from configuration', () => {
    const dev = single(buildStacks('dev').template, 'AWS::Cognito::UserPool');
    const prod = single(buildStacks('prod').template, 'AWS::Cognito::UserPool');

    expect(dev.properties.AdminCreateUserConfig.AllowAdminCreateUserOnly).toBe(false);
    expect(prod.properties.AdminCreateUserConfig.AllowAdminCreateUserOnly).toBe(true);
  });

  test('auto-verifies a required email, so self-signed-up users can confirm themselves', () => {
    for (const environment of ['dev', 'uat', 'prod'] as EnvironmentName[]) {
      const pool = single(buildStacks(environment).template, 'AWS::Cognito::UserPool');

      // Cognito sends the confirmation code only for an auto-verified attribute, and only to an
      // attribute the user supplied; without both a self-signed-up user stays UNCONFIRMED and every
      // sign-in fails with "User is not confirmed". Requiring email makes the sign-up page collect
      // it; auto-verifying makes Cognito send the code. Sign-in itself stays by username.
      expect(pool.properties.AutoVerifiedAttributes).toEqual(['email']);
      const email = pool.properties.Schema.find((attribute: { Name: string }) => attribute.Name === 'email');
      expect(email).toMatchObject({ Name: 'email', Required: true, Mutable: true });
    }
  });

  test('follows the environment removal policy, retaining the pool in uat and prod', () => {
    buildStacks('dev').template.hasResource('AWS::Cognito::UserPool', { DeletionPolicy: 'Delete' });
    buildStacks('uat').template.hasResource('AWS::Cognito::UserPool', { DeletionPolicy: 'Retain' });
    buildStacks('prod').template.hasResource('AWS::Cognito::UserPool', { DeletionPolicy: 'Retain' });
  });

  test('does not enable deletion protection, so the pool can always be torn down', () => {
    for (const environment of ['dev', 'uat', 'prod'] as EnvironmentName[]) {
      expect(
        single(buildStacks(environment).template, 'AWS::Cognito::UserPool').properties.DeletionProtection,
      ).toBeUndefined();
    }
  });

  test('creates no identity pool: nothing exchanges a user token for AWS credentials', () => {
    buildStacks('dev').template.resourceCountIs('AWS::Cognito::IdentityPool', 0);
  });
});

describe('CognitoStack app client', () => {
  test('is a confidential client with a generated secret', () => {
    const client = single(buildStacks('dev').template, 'AWS::Cognito::UserPoolClient');

    expect(client.properties.GenerateSecret).toBe(true);
    expect(client.properties.ClientName).toBe('ecommerce-dev-api-client');
  });

  test('enables only the authorization code grant flow', () => {
    const client = single(buildStacks('dev').template, 'AWS::Cognito::UserPoolClient');

    expect(client.properties.AllowedOAuthFlows).toEqual(['code']);
    expect(client.properties.AllowedOAuthFlowsUserPoolClient).toBe(true);
    // The implicit, client credentials and password flows are never enabled - RFC 9700 deprecates
    // the resource owner password credentials grant, so no scriptable password login exists.
    expect(json(client.properties.AllowedOAuthFlows)).not.toContain('implicit');
    expect(json(client.properties.AllowedOAuthFlows)).not.toContain('client_credentials');
  });

  test('requests only the openid, email and profile scopes', () => {
    const client = single(buildStacks('dev').template, 'AWS::Cognito::UserPoolClient');

    expect(client.properties.AllowedOAuthScopes).toEqual(['openid', 'email', 'profile']);
  });

  test('registers exact callback URIs, never a wildcard', () => {
    const client = single(buildStacks('dev').template, 'AWS::Cognito::UserPoolClient');

    expect(client.properties.CallbackURLs).toEqual([
      `https://${TEST_FQDN}/login/oauth2/code/cognito`,
      'http://localhost:8080/login/oauth2/code/cognito',
    ]);
    for (const uri of client.properties.CallbackURLs) {
      expect(uri).not.toContain('*');
    }
  });

  test('registers the frontend origins as post-logout URIs, never the API', () => {
    const client = single(buildStacks('dev').template, 'AWS::Cognito::UserPoolClient');

    // The browser lands on the SPA after logout: the deployed apex and the local dev server. The
    // URIs are exact - no wildcard, and no API path.
    expect(client.properties.LogoutURLs).toEqual(['https://dev.example.com', 'http://localhost:5173']);
    expect(json(client.properties.LogoutURLs)).not.toContain('*');
    expect(json(client.properties.LogoutURLs)).not.toContain('/logout');
  });

  test('registers only the apex as a post-logout URI in production', () => {
    const client = single(buildStacks('prod').template, 'AWS::Cognito::UserPoolClient');

    // Production's CORS allowlist is the apex alone, so no localhost origin leaks in.
    expect(client.properties.LogoutURLs).toEqual(['https://prod.example.com']);
  });

  test('takes the token lifetimes from configuration, in minutes', () => {
    const dev = single(buildStacks('dev').template, 'AWS::Cognito::UserPoolClient').properties;
    const prod = single(buildStacks('prod').template, 'AWS::Cognito::UserPoolClient').properties;

    expect(dev).toMatchObject({
      AccessTokenValidity: 60,
      IdTokenValidity: 60,
      RefreshTokenValidity: 43200,
      TokenValidityUnits: { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'minutes' },
    });
    // Production keeps tokens short so a leaked one is useless quickly.
    expect(prod).toMatchObject({ AccessTokenValidity: 15, IdTokenValidity: 15, RefreshTokenValidity: 720 });
  });

  test('rotates refresh tokens and revokes them on logout', () => {
    const client = single(buildStacks('dev').template, 'AWS::Cognito::UserPoolClient');

    expect(client.properties.EnableTokenRevocation).toBe(true);
    expect(client.properties.RefreshTokenRotation).toEqual({ Feature: 'ENABLED', RetryGracePeriodSeconds: 60 });
  });

  test('enables only the SRP auth flow, never the password grant', () => {
    const client = single(buildStacks('dev').template, 'AWS::Cognito::UserPoolClient');

    expect(client.properties.ExplicitAuthFlows).toEqual(['ALLOW_USER_SRP_AUTH']);
    // Cognito rejects ALLOW_REFRESH_TOKEN_AUTH alongside refresh token rotation; the refresh flow is
    // implicit when rotation is on.
    expect(json(client.properties)).not.toContain('ALLOW_REFRESH_TOKEN_AUTH');
    // RFC 9700 deprecates the resource owner password credentials grant: no password login exists.
    expect(json(client.properties)).not.toContain('ALLOW_USER_PASSWORD_AUTH');
    expect(json(client.properties)).not.toContain('ALLOW_ADMIN_USER_PASSWORD_AUTH');
    expect(json(client.properties)).not.toContain('ALLOW_CUSTOM_AUTH');
  });
});

describe('CognitoStack domain and secret', () => {
  test('creates no domain: the managed login domain is a custom domain owned by the auth-domain stack', () => {
    // A Cognito custom domain is validated against the parent domain's A record, which only exists
    // once the frontend stack is deployed - so the domain is a leaf stack of its own rather than a
    // resource here. See auth-domain-stack.test.ts for the domain itself.
    buildStacks('dev').template.resourceCountIs('AWS::Cognito::UserPoolDomain', 0);
  });

  test('stores the client secret in Secrets Manager, not in the template', () => {
    const { template } = buildStacks('dev');
    const secret = single(template, 'AWS::SecretsManager::Secret');

    // The secret's value is the generated client secret, read at deploy time from the app client's
    // `UserPoolClient.ClientSecret` attribute, under the `clientSecret` field.
    expect(json(secret.properties.SecretString)).toContain('clientSecret');
    expect(json(secret.properties.SecretString)).toContain('UserPoolClient.ClientSecret');
    // The value itself never appears: there is no literal to leak.
    expect(json(template.toJSON())).not.toContain('"clientSecret":"');
  });
});

describe('CognitoStack managed login', () => {
  test('pins the Essentials feature plan, which managed login requires', () => {
    const pool = single(buildStacks('dev').template, 'AWS::Cognito::UserPool');

    expect(pool.properties.UserPoolTier).toBe('ESSENTIALS');
  });

  test('seeds a branding style per app client, without which managed login does not render', () => {
    const branding = single(buildStacks('dev').template, 'AWS::Cognito::ManagedLoginBranding');

    // The console auto-creates a branding style; CloudFormation does not, and a version-2 domain
    // renders a broken page for any client that has none. `UseCognitoProvidedValues` seeds the
    // default style, which the visual editor can re-brand later.
    expect(branding.properties.UseCognitoProvidedValues).toBe(true);
    expect(json(branding.properties.UserPoolId)).toContain('UserPool');
    expect(json(branding.properties.ClientId)).toContain('UserPoolApiClient');
  });
});

describe('CognitoStack baseline alarm', () => {
  test('alarms on sign-ins throttled by the user pool', () => {
    const alarm = single(buildStacks('dev').template, 'AWS::CloudWatch::Alarm');

    expect(alarm.properties).toMatchObject({
      Namespace: 'AWS/Cognito',
      MetricName: 'SignInThrottles',
      Statistic: 'Sum',
      ComparisonOperator: 'GreaterThanThreshold',
      TreatMissingData: 'notBreaching',
    });
    expect(alarm.properties.Dimensions).toHaveLength(1);
    expect(alarm.properties.Dimensions[0].Name).toBe('UserPool');
    expect(json(alarm.properties.Dimensions[0].Value)).toContain('UserPool');
  });
});

describe('CognitoStack tags', () => {
  test('tags the taggable resources with the project, environment and management tool', () => {
    const template = buildStacks('uat').template;

    // The app client and the domain are deliberately absent: their L2 constructs expose no tag
    // support, so there is nothing for the stack-level tag contract to apply to.
    for (const type of ['AWS::Cognito::UserPool', 'AWS::SecretsManager::Secret']) {
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

describe('CognitoStack outputs', () => {
  test('exports the pool id, client id, issuer url and client secret arn', () => {
    const template = buildStacks('dev').template;

    template.hasOutput('UserPoolId', { Export: { Name: 'ecommerce-dev-user-pool-id' } });
    template.hasOutput('UserPoolClientId', { Export: { Name: 'ecommerce-dev-user-pool-client-id' } });
    template.hasOutput('IssuerUrl', { Export: { Name: 'ecommerce-dev-cognito-issuer-url' } });
    template.hasOutput('ClientSecretArn', { Export: { Name: 'ecommerce-dev-client-secret-arn' } });
  });

  test('uses environment specific export names so environments do not clash', () => {
    const outputs = buildStacks('prod').template.toJSON().Outputs;

    expect(outputs.UserPoolId.Export.Name).toBe('ecommerce-prod-user-pool-id');
    expect(outputs.IssuerUrl.Export.Name).toBe('ecommerce-prod-cognito-issuer-url');
  });
});
