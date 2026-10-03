import { RemovalPolicy } from 'aws-cdk-lib';
import { InstanceClass, InstanceSize, InstanceType } from 'aws-cdk-lib/aws-ec2';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { PostgresEngineVersion } from 'aws-cdk-lib/aws-rds';

import { EnvironmentConfig } from './types';

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
  // to source, and omitting it keeps UAT HTTP-only until a zone has been delegated.
  dns: process.env.ECOMMERCE_UAT_DOMAIN
    ? { zoneName: process.env.ECOMMERCE_UAT_DOMAIN, apiSubdomain: 'api' }
    : undefined,
};
