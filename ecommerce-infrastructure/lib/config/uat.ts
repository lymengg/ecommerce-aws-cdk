import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Mfa } from 'aws-cdk-lib/aws-cognito';
import { InstanceClass, InstanceSize, InstanceType } from 'aws-cdk-lib/aws-ec2';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { PostgresEngineVersion } from 'aws-cdk-lib/aws-rds';

import { EnvironmentConfig } from './types';

/**
 * The delegated subdomain, read once from the environment. From Phase 4 it is required rather than
 * optional (the BFF's session cookie is `Secure`), so UAT now needs `ECOMMERCE_UAT_DOMAIN` to
 * synthesise. Reading it into a local also lets the CORS allowlist be derived from it without
 * repeating the lookup.
 */
const domain = process.env.ECOMMERCE_UAT_DOMAIN;

/** Optional override for the frontend origin; see the dev configuration for why it is read here. */
const frontendOrigin = process.env.ECOMMERCE_UAT_FRONTEND_ORIGIN;

/**
 * UAT environment: production-like topology at a smaller scale.
 *
 * - Two NAT Gateways, one per Availability Zone, so an AZ failure does not take out outbound
 *   connectivity for the private subnets.
 * - Flow Logs enabled so traffic can be audited before the production rollout.
 * - Resources that support retention are retained on stack deletion; UAT data is not disposable
 *   by accident.
 * - The database keeps the dev instance size but takes a week of backups and protects the instance
 *   against deletion, so the data survives a test cycle and cannot be dropped by a stray command.
 */
export const uatConfig: EnvironmentConfig = {
  environment: 'uat',
  account: process.env.ECOMMERCE_UAT_ACCOUNT,
  region: 'ap-southeast-1',
  vpcCidr: '10.1.0.0/16',
  maxAzs: 2,
  natGateways: 2,
  removalPolicy: RemovalPolicy.RETAIN,
  flowLogs: {
    enabled: true,
    retention: RetentionDays.ONE_MONTH,
  },
  // Same single-task footprint as dev; UAT validates behaviour, not capacity. Logs are kept longer
  // so a failed acceptance test can still be investigated after the fact.
  application: {
    desiredCount: 1,
    cpu: 512,
    memoryLimitMiB: 1024,
    containerPort: 8080,
    healthCheckPath: '/actuator/health',
    imageTag: 'v0.1.0',
    logRetention: RetentionDays.ONE_MONTH,
  },
  // Same single-task footprint as dev; logs kept longer so a failed acceptance test can be read back.
  frontend: {
    desiredCount: 1,
    cpu: 256,
    memoryLimitMiB: 512,
    containerPort: 8080,
    healthCheckPath: '/healthz',
    imageTag: 'v0.1.0',
    logRetention: RetentionDays.ONE_MONTH,
  },
  // No Multi-AZ here: UAT accepts a slower failover in exchange for half the instance cost. What it
  // does not accept is losing the data, so deletion protection is on and the instance is retained.
  database: {
    databaseName: 'ecommerce',
    masterUsername: 'ecommerce',
    engineVersion: PostgresEngineVersion.VER_16,
    instanceType: InstanceType.of(InstanceClass.BURSTABLE4_GRAVITON, InstanceSize.MICRO),
    allocatedStorageGb: 20,
    backupRetentionDays: 7,
    multiAz: false,
    deletionProtection: true,
    removalPolicy: RemovalPolicy.RETAIN,
  },
  // Same delegation model as dev: the subdomain comes from the environment so it is never committed
  // to source. Required from Phase 4 on, because auth needs an HTTPS origin.
  dns: domain ? { zoneName: domain, apiSubdomain: 'api' } : undefined,
  // UAT sits between dev and prod: a real password policy and MFA available (but not forced, so a
  // tester without an authenticator can still sign in), and token lifetimes short enough that the
  // refresh path is exercised during acceptance testing.
  auth: {
    passwordMinimumLength: 10,
    requireUppercase: true,
    requireLowercase: true,
    requireDigits: true,
    requireSymbols: false,
    mfa: Mfa.OPTIONAL,
    selfSignUpEnabled: true,
    accessTokenValidity: Duration.minutes(30),
    idTokenValidity: Duration.minutes(30),
    refreshTokenValidity: Duration.days(7),
    sessionTimeout: Duration.hours(4),
    // The local frontend origin is allowed so acceptance tests can drive the deployed API from a
    // developer machine; the delegated apex is added so the same-site deployed frontend works too.
    // ECOMMERCE_UAT_FRONTEND_ORIGIN replaces the default with the real frontend origin.
    allowedOrigins: frontendOrigin
      ? [frontendOrigin]
      : ['http://localhost:5173', ...(domain ? [`https://${domain}`] : [])],
    // The SPA is the deployed apex, not the localhost origin that is only there so a developer
    // machine may call the API.
    frontendUrl: frontendOrigin ?? (domain ? `https://${domain}` : 'http://localhost:5173'),
  },
};
