import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Mfa } from 'aws-cdk-lib/aws-cognito';
import { InstanceClass, InstanceSize, InstanceType } from 'aws-cdk-lib/aws-ec2';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { PostgresEngineVersion } from 'aws-cdk-lib/aws-rds';

import { EnvironmentConfig } from './types';

/**
 * Optional override for the frontend origin, read from the environment like the account id and the
 * domain so a real frontend URL never has to be committed to source. When unset, the local Vite dev
 * server is the only allowed origin.
 */
const frontendOrigin = process.env.ECOMMERCE_DEV_FRONTEND_ORIGIN;

/**
 * Development environment: the cheapest footprint that still mirrors the production topology.
 *
 * - A single NAT Gateway, so an Availability Zone failure breaks outbound traffic. This is a
 *   deliberate cost decision for dev only; uat and prod are redundant.
 * - Flow Logs disabled to keep CloudWatch ingestion cost at zero.
 * - Resources are destroyable so `cdk destroy` leaves nothing behind.
 * - The database is a single small instance with a one day backup window. It is still encrypted,
 *   still private and still has automated backups, because those are not things to get wrong while
 *   learning.
 */
export const devConfig: EnvironmentConfig = {
  environment: 'dev',
  account: process.env.ECOMMERCE_DEV_ACCOUNT,
  region: 'ap-southeast-1',
  vpcCidr: '10.0.0.0/16',
  maxAzs: 2,
  natGateways: 1,
  removalPolicy: RemovalPolicy.DESTROY,
  flowLogs: {
    enabled: false,
    retention: RetentionDays.ONE_WEEK,
  },
  // One task, the smallest Fargate size that comfortably runs a JVM: 0.5 vCPU and 1 GiB. A single
  // task means a deployment or an AZ failure briefly removes the only instance; that is acceptable
  // for dev and is why production does not share this value.
  application: {
    desiredCount: 1,
    cpu: 512,
    memoryLimitMiB: 1024,
    containerPort: 8080,
    healthCheckPath: '/actuator/health',
    imageTag: 'v0.1.0',
    logRetention: RetentionDays.ONE_WEEK,
  },
  // A single db.t4g.micro with 20 GiB of gp3 storage: the smallest burstable Graviton instance RDS
  // offers, which is plenty for a demo workload. `deletionProtection` is off and the removal policy
  // is DESTROY so `cdk destroy` really does remove everything, including the generated credentials.
  database: {
    databaseName: 'ecommerce',
    masterUsername: 'ecommerce',
    engineVersion: PostgresEngineVersion.VER_16,
    instanceType: InstanceType.of(InstanceClass.BURSTABLE4_GRAVITON, InstanceSize.MICRO),
    allocatedStorageGb: 20,
    backupRetentionDays: 1,
    multiAz: false,
    deletionProtection: false,
    removalPolicy: RemovalPolicy.DESTROY,
  },
  // The public subdomain is read from the environment, like the account id, so the domain never
  // ends up in source. From Phase 4 it is required rather than optional: the BFF's session cookie
  // is `Secure`, so an authentication-enabled environment must answer over HTTPS. Setting
  // ECOMMERCE_DEV_DOMAIN is therefore a required step of a dev deployment too.
  dns: process.env.ECOMMERCE_DEV_DOMAIN
    ? { zoneName: process.env.ECOMMERCE_DEV_DOMAIN, apiSubdomain: 'api' }
    : undefined,
  // Dev is deliberately the permissive end of every lever so a fresh environment is quick to sign
  // in to: the shortest password Cognito allows, no MFA, self sign-up on, and long-lived tokens.
  // None of this is a production posture - see prod.ts for the other end of each lever.
  auth: {
    passwordMinimumLength: 8,
    requireUppercase: false,
    requireLowercase: true,
    requireDigits: true,
    requireSymbols: false,
    mfa: Mfa.OFF,
    selfSignUpEnabled: true,
    accessTokenValidity: Duration.hours(1),
    idTokenValidity: Duration.hours(1),
    refreshTokenValidity: Duration.days(30),
    sessionTimeout: Duration.hours(8),
    // The frontend is built separately; in dev it is the Vite dev server. A same-site setup (or a
    // dev proxy) is what makes the session cookie work, because cross-site cookies are increasingly
    // blocked by browsers - see the README. ECOMMERCE_DEV_FRONTEND_ORIGIN replaces the default when
    // a real dev frontend is deployed somewhere else.
    allowedOrigins: frontendOrigin ? [frontendOrigin] : ['http://localhost:5173'],
    // Where the browser lands after Cognito logs the user out: the SPA, not the API.
    logoutUrl: frontendOrigin ?? 'http://localhost:5173',
  },
};
