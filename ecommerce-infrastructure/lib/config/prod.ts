import { RemovalPolicy } from 'aws-cdk-lib';
import { InstanceClass, InstanceSize, InstanceType } from 'aws-cdk-lib/aws-ec2';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { PostgresEngineVersion } from 'aws-cdk-lib/aws-rds';

import { EnvironmentConfig } from './types';

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
};
