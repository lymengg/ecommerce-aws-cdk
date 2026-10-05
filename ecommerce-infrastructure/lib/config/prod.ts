import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Mfa } from 'aws-cdk-lib/aws-cognito';
import { InstanceClass, InstanceSize, InstanceType } from 'aws-cdk-lib/aws-ec2';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { PostgresEngineVersion } from 'aws-cdk-lib/aws-rds';

import { EnvironmentConfig } from './types';

/** The delegated subdomain, required in production (see `dns` below and the validator). */
const domain = process.env.ECOMMERCE_PROD_DOMAIN;

/** Optional override for the frontend origin; see the dev configuration for why it is read here. */
const frontendOrigin = process.env.ECOMMERCE_PROD_FRONTEND_ORIGIN;

/**
 * Production environment: resilient by default.
 *
 * - Three Availability Zones with one NAT Gateway each. Losing an Availability Zone costs a third
 *   of the NAT capacity instead of all outbound connectivity. The higher NAT and data transfer
 *   cost is accepted here on purpose.
 * - Flow Logs enabled with a longer retention window for security investigations.
 * - `RemovalPolicy.RETAIN` for everything that supports it, including the database and the secret
 *   holding its credentials.
 * - The database is Multi-AZ with a month of backups and deletion protection. This is the one place
 *   where the extra cost of a standby buys something that cannot be added later.
 */
export const prodConfig: EnvironmentConfig = {
  environment: 'prod',
  account: process.env.ECOMMERCE_PROD_ACCOUNT,
  region: 'ap-southeast-1',
  vpcCidr: '10.2.0.0/16',
  maxAzs: 3,
  natGateways: 3,
  removalPolicy: RemovalPolicy.RETAIN,
  flowLogs: {
    enabled: true,
    retention: RetentionDays.THREE_MONTHS,
  },
  // A larger task than dev/uat: 1 vCPU and 2 GiB gives the JVM headroom under production traffic.
  // The count is still 1 in this phase - auto scaling, which is what actually makes production
  // resilient to losing a task, is a later phase and is called out in the README.
  application: {
    desiredCount: 1,
    cpu: 1024,
    memoryLimitMiB: 2048,
    containerPort: 8080,
    healthCheckPath: '/actuator/health',
    imageTag: 'v0.1.0',
    logRetention: RetentionDays.THREE_MONTHS,
  },
  // Two tasks, which the API cannot do while its sessions are in memory. nginx is stateless, so
  // losing one task - or an entire Availability Zone - costs nothing: the load balancer simply sends
  // the next request to the survivor. A slightly larger task than dev/uat for the same reason the
  // API is larger: headroom, not throughput (nginx serves static files for almost nothing).
  frontend: {
    desiredCount: 2,
    cpu: 512,
    memoryLimitMiB: 1024,
    containerPort: 8080,
    healthCheckPath: '/healthz',
    imageTag: 'v0.1.0',
    logRetention: RetentionDays.THREE_MONTHS,
  },
  // Multi-AZ doubles the instance cost, which is exactly the trade production is meant to make: a
  // single AZ failure becomes a failover instead of an outage. `RemovalPolicy.RETAIN` keeps the
  // instance (and its data) if the stack is ever deleted, and deletion protection stops that from
  // happening by accident in the first place.
  database: {
    databaseName: 'ecommerce',
    masterUsername: 'ecommerce',
    engineVersion: PostgresEngineVersion.VER_16,
    instanceType: InstanceType.of(InstanceClass.BURSTABLE4_GRAVITON, InstanceSize.SMALL),
    allocatedStorageGb: 50,
    backupRetentionDays: 30,
    multiAz: true,
    deletionProtection: true,
    removalPolicy: RemovalPolicy.RETAIN,
  },
  // Unlike dev and uat this is not really optional: the configuration validator refuses a
  // production environment without a `dns` block, because production must not serve plaintext HTTP.
  // Setting ECOMMERCE_PROD_DOMAIN is therefore a required step of a production deployment.
  dns: domain ? { zoneName: domain, apiSubdomain: 'api', authSubdomain: 'auth' } : undefined,
  // Production is the strict end of every authentication lever:
  //
  // - a long password with all four character classes,
  // - MFA required at sign-in,
  // - self sign-up off, so accounts are created by an administrator rather than by anyone who
  //   reaches the hosted UI,
  // - the shortest token lifetimes Cognito allows for the access and ID tokens, so a leaked token
  //   is useless within minutes, and a short refresh window so a stolen refresh token has little
  //   time to be replayed before rotation invalidates it,
  // - a short BFF session, and
  // - an allowlist that contains only the delegated apex, never a localhost origin and never `*`.
  auth: {
    passwordMinimumLength: 14,
    requireUppercase: true,
    requireLowercase: true,
    requireDigits: true,
    requireSymbols: true,
    mfa: Mfa.REQUIRED,
    selfSignUpEnabled: false,
    accessTokenValidity: Duration.minutes(15),
    idTokenValidity: Duration.minutes(15),
    refreshTokenValidity: Duration.hours(12),
    sessionTimeout: Duration.minutes(30),
    // Only the same-site frontend origin, or the explicit ECOMMERCE_PROD_FRONTEND_ORIGIN override.
    // Empty when no domain is configured, which cannot happen: the validator rejects production
    // without `dns` before it ever looks at this list.
    allowedOrigins: frontendOrigin ? [frontendOrigin] : domain ? [`https://${domain}`] : [],
    // The SPA is the deployed apex. Empty without a domain, which the `dns` check rejects first.
    frontendUrl: frontendOrigin ?? (domain ? `https://${domain}` : ''),
  },
};
