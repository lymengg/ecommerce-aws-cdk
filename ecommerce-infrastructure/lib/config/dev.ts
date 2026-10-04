import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Mfa } from 'aws-cdk-lib/aws-cognito';
import { InstanceClass, InstanceSize, InstanceType } from 'aws-cdk-lib/aws-ec2';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { PostgresEngineVersion } from 'aws-cdk-lib/aws-rds';

import { EnvironmentConfig } from './types';

/** The delegated subdomain, required from Phase 4 on (auth needs an HTTPS origin). */
const domain = process.env.ECOMMERCE_DEV_DOMAIN;

/**
 * Optional override for the frontend origin, read from the environment like the account id and the
 * domain so a real frontend URL never has to be committed to source. When unset, the local Vite dev
 * server and the delegated apex are the allowed origins.
 */
const frontendOrigin = process.env.ECOMMERCE_DEV_FRONTEND_ORIGIN;

/**
 * Optional dev-only cost switch for the NAT gateway, the single largest line on a paused dev bill.
 * The gateway is only needed while the compute runs - image pulls, Secrets Manager and Cognito all
 * leave through it - so an environment stopped to save money can drop it with
 * `ECOMMERCE_DEV_NAT_GATEWAYS=0`. Unset keeps the documented single-NAT topology, so a normal
 * deployment and the test suite are unaffected.
 */
const natGateways =
  process.env.ECOMMERCE_DEV_NAT_GATEWAYS === undefined ? 1 : Number(process.env.ECOMMERCE_DEV_NAT_GATEWAYS);

/**
 * Development environment: the cheapest footprint that still mirrors the production topology.
 *
 * - A single NAT Gateway, so an Availability Zone failure breaks outbound traffic. This is a
 *   deliberate cost decision for dev only; uat and prod are redundant. Set
 *   `ECOMMERCE_DEV_NAT_GATEWAYS=0` to remove it while the environment is paused.
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
  natGateways,
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
  // The storefront is static files behind nginx: a quarter of a vCPU and 512 MiB is generous, and a
  // single task is plenty for dev. Being stateless, it could run more - see prod.
  frontend: {
    desiredCount: 1,
    cpu: 256,
    memoryLimitMiB: 512,
    containerPort: 8080,
    healthCheckPath: '/healthz',
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
  dns: domain ? { zoneName: domain, apiSubdomain: 'api' } : undefined,
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
    // The local Vite dev server is allowed so a developer machine can call the deployed API
    // directly; the delegated apex is added because that is where the deployed dev SPA runs
    // (CloudFront). A same-site setup (or the dev proxy) is what makes the session cookie work,
    // because cross-site cookies are increasingly blocked by browsers - see the README.
    allowedOrigins: frontendOrigin
      ? [frontendOrigin]
      : ['http://localhost:5173', ...(domain ? [`https://${domain}`] : [])],
    // The SPA: where the browser lands after login and after logout. The deployed dev frontend is
    // the apex; a local run falls back to the Vite dev server.
    frontendUrl: frontendOrigin ?? (domain ? `https://${domain}` : 'http://localhost:5173'),
  },
};
