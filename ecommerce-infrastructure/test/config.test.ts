import * as fs from 'fs';
import * as path from 'path';

import { App, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Mfa } from 'aws-cdk-lib/aws-cognito';

import {
  DEFAULT_ENVIRONMENT,
  ENVIRONMENT_NAMES,
  EnvironmentName,
  assertValidEnvironmentConfig,
  getEnvironmentConfig,
  resolveEnvironmentName,
  resolveImageTag,
} from '../lib/config';

const CONFIG_SOURCE_DIRECTORY = path.join(__dirname, '..', 'lib', 'config');

describe('environment configuration', () => {
  test.each(ENVIRONMENT_NAMES)('%s is valid and internally consistent', (environment: EnvironmentName) => {
    const config = getEnvironmentConfig(environment);

    expect(config.environment).toBe(environment);
    expect(config.region).toMatch(/^[a-z]{2}-[a-z]+-\d$/);
    expect(config.vpcCidr).toMatch(/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/);
    expect(config.maxAzs).toBeGreaterThanOrEqual(2);
    expect(config.natGateways).toBeGreaterThanOrEqual(0);
    expect(config.natGateways).toBeLessThanOrEqual(config.maxAzs);
  });

  test('uses a non overlapping CIDR block per environment', () => {
    const cidrBlocks = ENVIRONMENT_NAMES.map((environment) => getEnvironmentConfig(environment).vpcCidr);

    expect(new Set(cidrBlocks).size).toBe(cidrBlocks.length);
  });

  test('trades NAT gateway redundancy for cost in dev and the other way round in production', () => {
    const dev = getEnvironmentConfig('dev');
    const prod = getEnvironmentConfig('prod');

    expect(dev.natGateways).toBe(1);
    expect(dev.natGateways).toBeLessThan(dev.maxAzs);
    expect(prod.natGateways).toBe(prod.maxAzs);
  });

  test('keeps production and development configuration separate', () => {
    expect(getEnvironmentConfig('dev').removalPolicy).toBe(RemovalPolicy.DESTROY);
    expect(getEnvironmentConfig('prod').removalPolicy).toBe(RemovalPolicy.RETAIN);
    expect(getEnvironmentConfig('dev').flowLogs.enabled).toBe(false);
    expect(getEnvironmentConfig('prod').flowLogs.enabled).toBe(true);
  });

  test('never hardcodes an AWS account id in source', () => {
    const sources = fs
      .readdirSync(CONFIG_SOURCE_DIRECTORY)
      .filter((file) => file.endsWith('.ts'))
      .map((file) => fs.readFileSync(path.join(CONFIG_SOURCE_DIRECTORY, file), 'utf8'));

    for (const source of sources) {
      expect(source).not.toMatch(/\b\d{12}\b/);
    }
  });

  test('does not carry secrets', () => {
    for (const environment of ENVIRONMENT_NAMES) {
      // The auth configuration names a password *policy* (length, character classes), which is not a
      // credential, so the check looks for the fields that would actually carry a secret value.
      expect(JSON.stringify(getEnvironmentConfig(environment))).not.toMatch(
        /secret|accesskey|masterUserPassword|clientSecret/i,
      );
    }
  });

  test('rejects a configuration that would not produce a usable VPC', () => {
    const dev = getEnvironmentConfig('dev');

    expect(() => assertValidEnvironmentConfig({ ...dev, vpcCidr: '10.0.0.0' })).toThrow(/not a valid IPv4 CIDR/);
    expect(() => assertValidEnvironmentConfig({ ...dev, maxAzs: 0 })).toThrow(/maxAzs must be a positive integer/);
    expect(() => assertValidEnvironmentConfig({ ...dev, maxAzs: 2, natGateways: 3 })).toThrow(
      /natGateways must be between 0 and maxAzs/,
    );
    expect(() => assertValidEnvironmentConfig({ ...dev, region: ' ' })).toThrow(/region must not be empty/);
  });
});

describe('application configuration', () => {
  test.each(ENVIRONMENT_NAMES)('%s runs a single, validly sized, non-latest task', (environment: EnvironmentName) => {
    const application = getEnvironmentConfig(environment).application;

    expect(application.desiredCount).toBe(1);
    expect(application.containerPort).toBe(8080);
    expect(application.healthCheckPath).toBe('/actuator/health');
    expect(application.imageTag).not.toBe('latest');
  });

  test('rejects a Fargate cpu/memory pair ECS would refuse at deploy time', () => {
    const dev = getEnvironmentConfig('dev');

    expect(() =>
      assertValidEnvironmentConfig({ ...dev, application: { ...dev.application, cpu: 300 } }),
    ).toThrow(/application.cpu must be one of/);
    expect(() =>
      assertValidEnvironmentConfig({ ...dev, application: { ...dev.application, cpu: 512, memoryLimitMiB: 512 } }),
    ).toThrow(/not a valid Fargate memory size/);
  });

  test('rejects an invalid port, health check path, desired count or image tag', () => {
    const dev = getEnvironmentConfig('dev');
    const application = dev.application;

    expect(() => assertValidEnvironmentConfig({ ...dev, application: { ...application, containerPort: 0 } })).toThrow(
      /containerPort/,
    );
    expect(() =>
      assertValidEnvironmentConfig({ ...dev, application: { ...application, healthCheckPath: 'health' } }),
    ).toThrow(/healthCheckPath/);
    expect(() => assertValidEnvironmentConfig({ ...dev, application: { ...application, desiredCount: -1 } })).toThrow(
      /desiredCount/,
    );
    expect(() => assertValidEnvironmentConfig({ ...dev, application: { ...application, imageTag: 'latest' } })).toThrow(
      /immutable tag/,
    );
    expect(() => assertValidEnvironmentConfig({ ...dev, application: { ...application, imageTag: ' ' } })).toThrow(
      /must not be empty/,
    );
  });

  test('refuses more than one task while the BFF holds sessions in memory', () => {
    const dev = getEnvironmentConfig('dev');

    // Auto scaling would give each task its own session store and silently sign users out, so the
    // guard names the in-memory session store and the phase that removes the constraint.
    expect(() =>
      assertValidEnvironmentConfig({ ...dev, application: { ...dev.application, desiredCount: 2 } }),
    ).toThrow(/desiredCount must be 1 while the BFF holds sessions in memory/);
  });
});

describe('database configuration', () => {
  test.each(ENVIRONMENT_NAMES)('%s describes a valid, protected PostgreSQL instance', (environment: EnvironmentName) => {
    const database = getEnvironmentConfig(environment).database;

    expect(database.databaseName).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(database.masterUsername).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(database.masterUsername).not.toBe('postgres');
    expect(database.masterUsername).not.toBe('admin');
    expect(database.allocatedStorageGb).toBeGreaterThanOrEqual(20);
    expect(database.backupRetentionDays).toBeGreaterThanOrEqual(1);
    expect(database.backupRetentionDays).toBeLessThanOrEqual(35);
    expect(database.engineVersion.postgresMajorVersion).toBe('16');
  });

  test('keeps development cheap and production resilient', () => {
    const dev = getEnvironmentConfig('dev').database;
    const prod = getEnvironmentConfig('prod').database;

    expect(dev.multiAz).toBe(false);
    expect(dev.deletionProtection).toBe(false);
    expect(dev.removalPolicy).toBe(RemovalPolicy.DESTROY);

    expect(prod.multiAz).toBe(true);
    expect(prod.deletionProtection).toBe(true);
    expect(prod.removalPolicy).toBe(RemovalPolicy.RETAIN);
    expect(prod.backupRetentionDays).toBeGreaterThan(dev.backupRetentionDays);
  });

  test('never carries a database password', () => {
    for (const environment of ENVIRONMENT_NAMES) {
      const database = getEnvironmentConfig(environment).database;

      expect(JSON.stringify(database)).not.toMatch(/password/i);
      expect(Object.keys(database)).not.toContain('masterUserPassword');
    }
  });

  test('rejects a configuration RDS would refuse at deploy time', () => {
    const dev = getEnvironmentConfig('dev');
    const database = dev.database;

    expect(() => assertValidEnvironmentConfig({ ...dev, database: { ...database, databaseName: '9bad' } })).toThrow(
      /databaseName/,
    );
    expect(() =>
      assertValidEnvironmentConfig({ ...dev, database: { ...database, masterUsername: 'postgres' } }),
    ).toThrow(/reserved by RDS/);
    expect(() =>
      assertValidEnvironmentConfig({ ...dev, database: { ...database, allocatedStorageGb: 5 } }),
    ).toThrow(/allocatedStorageGb/);
    expect(() =>
      assertValidEnvironmentConfig({ ...dev, database: { ...database, backupRetentionDays: 0 } }),
    ).toThrow(/backupRetentionDays/);
    expect(() =>
      assertValidEnvironmentConfig({ ...dev, database: { ...database, backupRetentionDays: 36 } }),
    ).toThrow(/backupRetentionDays/);
  });

  test('rejects deletion protection that could never be switched off', () => {
    const dev = getEnvironmentConfig('dev');

    expect(() =>
      assertValidEnvironmentConfig({
        ...dev,
        database: { ...dev.database, deletionProtection: true, removalPolicy: RemovalPolicy.DESTROY },
      }),
    ).toThrow(/deletionProtection cannot be enabled/);
  });
});

describe('dns configuration', () => {
  test('production requires a delegated domain, because plaintext HTTP is not an option', () => {
    const prod = getEnvironmentConfig('prod');

    expect(prod.dns).toBeDefined();
    expect(prod.dns?.apiSubdomain).toBe('api');
    expect(() => assertValidEnvironmentConfig({ ...prod, dns: undefined })).toThrow(/dns is required in production/);
  });

  test('every environment requires a domain from Phase 4 on, because auth needs an HTTPS origin', () => {
    for (const environment of ['dev', 'uat'] as EnvironmentName[]) {
      const config = getEnvironmentConfig(environment);

      // Dev and uat used to be allowed to synthesise HTTP-only; an auth-enabled environment cannot,
      // because a `Secure` session cookie only works over HTTPS.
      expect(() => assertValidEnvironmentConfig({ ...config, dns: undefined })).toThrow(
        /authentication requires a delegated domain/,
      );
    }

    // Production has its own, older message, which the dns check raises first.
    expect(() => assertValidEnvironmentConfig({ ...getEnvironmentConfig('prod'), dns: undefined })).toThrow(
      /dns is required in production/,
    );
  });

  test('accepts a well formed delegated subdomain', () => {
    const dev = getEnvironmentConfig('dev');

    expect(() =>
      assertValidEnvironmentConfig({ ...dev, dns: { zoneName: 'dev.example.com', apiSubdomain: 'api' } }),
    ).not.toThrow();
  });

  test('rejects a zone name that is not a DNS host name', () => {
    const dev = getEnvironmentConfig('dev');

    for (const zoneName of ['bad_name', '-bad.example.com', 'example', 'bad..com', 'trailing-.com', '']) {
      expect(() =>
        assertValidEnvironmentConfig({ ...dev, dns: { zoneName, apiSubdomain: 'api' } }),
      ).toThrow(/dns.zoneName/);
    }
  });

  test('rejects an API subdomain that is not a single DNS label', () => {
    const dev = getEnvironmentConfig('dev');

    for (const apiSubdomain of ['bad_label', '-api', 'api.', 'api.example.com', '']) {
      expect(() =>
        assertValidEnvironmentConfig({ ...dev, dns: { zoneName: 'dev.example.com', apiSubdomain } }),
      ).toThrow(/dns.apiSubdomain/);
    }
  });
});

describe('auth configuration', () => {
  test.each(ENVIRONMENT_NAMES)('%s describes a valid user pool and BFF session', (environment: EnvironmentName) => {
    const auth = getEnvironmentConfig(environment).auth;

    expect(auth.passwordMinimumLength).toBeGreaterThanOrEqual(6);
    expect(auth.passwordMinimumLength).toBeLessThanOrEqual(99);
    expect(auth.allowedOrigins.length).toBeGreaterThan(0);
    for (const origin of auth.allowedOrigins) {
      expect(origin).toMatch(/^https?:\/\//);
      expect(origin).not.toBe('*');
    }
    expect(auth.accessTokenValidity.toSeconds()).toBeGreaterThanOrEqual(Duration.minutes(5).toSeconds());
    expect(auth.accessTokenValidity.toSeconds()).toBeLessThanOrEqual(Duration.days(1).toSeconds());
    expect(auth.sessionTimeout.toSeconds()).toBeLessThanOrEqual(auth.refreshTokenValidity.toSeconds());
    // The post-logout target is the SPA, registered with Cognito as an exact URI.
    expect(auth.logoutUrl).toMatch(/^https?:\/\/[^/]+$/);
    expect(auth.logoutUrl).not.toContain('*');
  });

  test('keeps development permissive and production strict', () => {
    const dev = getEnvironmentConfig('dev').auth;
    const prod = getEnvironmentConfig('prod').auth;

    expect(dev.mfa).toBe(Mfa.OFF);
    expect(dev.selfSignUpEnabled).toBe(true);
    expect(dev.requireSymbols).toBe(false);
    expect(dev.allowedOrigins).toContain('http://localhost:5173');

    expect(prod.mfa).toBe(Mfa.REQUIRED);
    expect(prod.selfSignUpEnabled).toBe(false);
    expect(prod.requireUppercase && prod.requireLowercase && prod.requireDigits && prod.requireSymbols).toBe(true);
    expect(prod.passwordMinimumLength).toBeGreaterThan(dev.passwordMinimumLength);
    expect(prod.accessTokenValidity.toSeconds()).toBeLessThan(dev.accessTokenValidity.toSeconds());
    expect(prod.refreshTokenValidity.toSeconds()).toBeLessThan(dev.refreshTokenValidity.toSeconds());
    expect(prod.sessionTimeout.toSeconds()).toBeLessThan(dev.sessionTimeout.toSeconds());
    expect(prod.allowedOrigins).not.toContain('http://localhost:5173');
  });

  test('never allows a wildcard CORS origin in any environment', () => {
    for (const environment of ENVIRONMENT_NAMES) {
      const auth = getEnvironmentConfig(environment).auth;

      expect(auth.allowedOrigins.some((origin) => origin.includes('*'))).toBe(false);
    }
  });

  test('rejects a password length Cognito would refuse at deploy time', () => {
    const dev = getEnvironmentConfig('dev');

    expect(() => assertValidEnvironmentConfig({ ...dev, auth: { ...dev.auth, passwordMinimumLength: 5 } })).toThrow(
      /passwordMinimumLength/,
    );
    expect(() => assertValidEnvironmentConfig({ ...dev, auth: { ...dev.auth, passwordMinimumLength: 100 } })).toThrow(
      /passwordMinimumLength/,
    );
  });

  test('rejects token lifetimes outside the range Cognito accepts', () => {
    const dev = getEnvironmentConfig('dev');
    const auth = dev.auth;

    expect(() =>
      assertValidEnvironmentConfig({ ...dev, auth: { ...auth, accessTokenValidity: Duration.minutes(1) } }),
    ).toThrow(/accessTokenValidity/);
    expect(() =>
      assertValidEnvironmentConfig({ ...dev, auth: { ...auth, accessTokenValidity: Duration.days(2) } }),
    ).toThrow(/accessTokenValidity/);
    expect(() =>
      assertValidEnvironmentConfig({ ...dev, auth: { ...auth, idTokenValidity: Duration.seconds(30) } }),
    ).toThrow(/idTokenValidity/);
    expect(() =>
      assertValidEnvironmentConfig({ ...dev, auth: { ...auth, refreshTokenValidity: Duration.minutes(30) } }),
    ).toThrow(/refreshTokenValidity/);
    expect(() =>
      assertValidEnvironmentConfig({ ...dev, auth: { ...auth, refreshTokenValidity: Duration.days(3651) } }),
    ).toThrow(/refreshTokenValidity/);
  });

  test('rejects a session that outlives the refresh token it depends on', () => {
    const dev = getEnvironmentConfig('dev');

    expect(() =>
      assertValidEnvironmentConfig({
        ...dev,
        auth: { ...dev.auth, sessionTimeout: Duration.days(60), refreshTokenValidity: Duration.days(30) },
      }),
    ).toThrow(/sessionTimeout must not exceed/);
  });

  test('rejects an empty, wildcard or relative CORS origin', () => {
    const dev = getEnvironmentConfig('dev');

    for (const allowedOrigins of [[], ['*'], ['dev.example.com'], ['https://dev.example.com/']]) {
      expect(() => assertValidEnvironmentConfig({ ...dev, auth: { ...dev.auth, allowedOrigins } })).toThrow(
        /allowedOrigins/,
      );
    }
  });

  test('rejects a wildcard, relative or empty post-logout URI', () => {
    const dev = getEnvironmentConfig('dev');

    for (const logoutUrl of ['*', 'shop.example.com', '', '/logout']) {
      expect(() => assertValidEnvironmentConfig({ ...dev, auth: { ...dev.auth, logoutUrl } })).toThrow(
        /auth.logoutUrl/,
      );
    }
  });
});

describe('image tag resolution', () => {
  test('reads the image tag from CDK context', () => {
    const app = new App({ context: { imageTag: 'v9.9.9' } });

    expect(resolveImageTag(getEnvironmentConfig('dev'), app)).toBe('v9.9.9');
  });

  test('falls back to the configured image tag', () => {
    delete process.env.IMAGE_TAG;
    const config = getEnvironmentConfig('dev');

    expect(resolveImageTag(config, new App())).toBe(config.application.imageTag);
  });

  test('rejects latest instead of silently deploying a mutable image', () => {
    const app = new App({ context: { imageTag: 'latest' } });

    expect(() => resolveImageTag(getEnvironmentConfig('dev'), app)).toThrow(/immutable tag/);
  });
});

describe('environment resolution', () => {
  test('reads the environment from CDK context', () => {
    const app = new App({ context: { environment: 'prod' } });

    expect(resolveEnvironmentName(app)).toBe('prod');
  });

  test('is case insensitive', () => {
    const app = new App({ context: { environment: 'UAT' } });

    expect(resolveEnvironmentName(app)).toBe('uat');
  });

  test('falls back to the default environment', () => {
    delete process.env.ENVIRONMENT;

    expect(resolveEnvironmentName()).toBe(DEFAULT_ENVIRONMENT);
  });

  test('rejects an unknown environment instead of guessing', () => {
    const app = new App({ context: { environment: 'staging' } });

    expect(() => resolveEnvironmentName(app)).toThrow(/Unknown environment "staging"/);
  });

  test('returns the configuration of the resolved environment', () => {
    const app = new App({ context: { environment: 'uat' } });

    expect(getEnvironmentConfig(resolveEnvironmentName(app)).environment).toBe('uat');
  });
});
