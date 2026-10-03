import { RemovalPolicy } from 'aws-cdk-lib';
import { InstanceClass, InstanceSize, InstanceType } from 'aws-cdk-lib/aws-ec2';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { PostgresEngineVersion } from 'aws-cdk-lib/aws-rds';

import { EnvironmentConfig } from './types';

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
  // ends up in source. It is omitted entirely when unset, which is what lets dev synthesise and
  // deploy HTTP-only before a subdomain has been delegated to Route 53.
  dns: process.env.ECOMMERCE_DEV_DOMAIN
    ? { zoneName: process.env.ECOMMERCE_DEV_DOMAIN, apiSubdomain: 'api' }
    : undefined,
};
