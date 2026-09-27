import { RemovalPolicy } from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

import { EnvironmentConfig } from './types';

/**
 * Production environment: resilient by default.
 *
 * - Three Availability Zones with one NAT Gateway each. Losing an Availability Zone costs a third
 *   of the NAT capacity instead of all outbound connectivity. The higher NAT and data transfer
 *   cost is accepted here on purpose.
 * - Flow Logs enabled with a longer retention window for security investigations.
 * - `RemovalPolicy.RETAIN` for everything that supports it. Stateful resources added in later
 *   phases (RDS, ElastiCache, S3) additionally need deletion protection and backups, which is
 *   documented in the README.
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
};
