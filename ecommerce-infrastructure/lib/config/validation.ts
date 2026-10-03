import { RemovalPolicy } from 'aws-cdk-lib';

import { EnvironmentConfig } from './types';

/** Minimal IPv4 CIDR validation: dotted quad plus prefix length. */
const IPV4_CIDR = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

/** PostgreSQL identifiers we generate: lower case, starts with a letter, digits and underscores. */
const POSTGRES_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * Master user names RDS reserves for itself. Asking for one of these makes the instance fail to
 * create, which is far too late to discover.
 */
const RESERVED_MASTER_USERNAMES = ['postgres', 'rdsadmin', 'admin', 'root', 'rds_superuser'];

/** RDS accepts a backup retention between 0 (disabled) and 35 days. */
const MAX_BACKUP_RETENTION_DAYS = 35;

/** Smallest storage RDS accepts for a gp3 volume. */
const MIN_ALLOCATED_STORAGE_GB = 20;

/**
 * A DNS host name: one or more labels separated by dots, each starting and ending with a letter or
 * digit and at most 63 characters, with a top level label of at least two letters. Deliberately
 * conservative - it rejects the underscores, leading dashes and empty labels that Route 53 would
 * accept into a zone name but that would never resolve.
 */
const DNS_HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/i;

/** A single DNS label: the leftmost part of a name, with no dots. */
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

/** Inclusive integer range, used to spell out the larger Fargate memory tiers compactly. */
function range(start: number, end: number, step: number): number[] {
  const values: number[] = [];
  for (let value = start; value <= end; value += step) {
    values.push(value);
  }
  return values;
}

/**
 * The cpu/memory combinations Fargate actually accepts, in CPU units and MiB. A task definition
 * outside this table is rejected by ECS at deploy time, which is far too late to find out.
 */
const FARGATE_TASK_SIZES: Readonly<Record<number, readonly number[]>> = {
  256: [512, 1024, 2048],
  512: [1024, 2048, 3072, 4096],
  1024: [2048, 3072, 4096, 5120, 6144, 7168, 8192],
  2048: range(4096, 16384, 1024),
  4096: range(8192, 30720, 1024),
  8192: range(16384, 61440, 4096),
  16384: range(32768, 122880, 8192),
};

/**
 * Validates an environment configuration so a mistake fails immediately, with a message naming the
 * environment, instead of producing a template that only breaks halfway through a deployment.
 */
export function assertValidEnvironmentConfig(config: EnvironmentConfig): void {
  const fail = (message: string): never => {
    throw new Error(`Invalid configuration for environment "${config.environment}": ${message}`);
  };

  if (!IPV4_CIDR.test(config.vpcCidr)) {
    fail(`vpcCidr "${config.vpcCidr}" is not a valid IPv4 CIDR block.`);
  }
  if (!Number.isInteger(config.maxAzs) || config.maxAzs < 1) {
    fail(`maxAzs must be a positive integer, got ${config.maxAzs}.`);
  }
  if (!Number.isInteger(config.natGateways) || config.natGateways < 0 || config.natGateways > config.maxAzs) {
    fail(`natGateways must be between 0 and maxAzs (${config.maxAzs}), got ${config.natGateways}.`);
  }
  if (config.region.trim() === '') {
    fail('region must not be empty.');
  }

  assertValidApplicationConfig(config.application, fail);
  assertValidDatabaseConfig(config.database, fail);
  assertValidDnsConfig(config, fail);
}

/**
 * Validates the optional DNS/TLS configuration. DNS is optional so dev can still synthesise and
 * deploy HTTP-only, but production must have it: an environment that serves real traffic over
 * plaintext HTTP is not a production option, and failing at synth is the only way to guarantee the
 * TLS listener is never forgotten. When a `dns` block is present, the zone name and the API label
 * are checked against the DNS rules Route 53 would otherwise enforce at deploy time.
 */
function assertValidDnsConfig(config: EnvironmentConfig, fail: (message: string) => never): void {
  const { dns } = config;

  if (dns === undefined) {
    if (config.environment === 'prod') {
      fail(
        'dns is required in production; plaintext HTTP is not a production option. ' +
          'Set ECOMMERCE_PROD_DOMAIN to the delegated subdomain, for example "prod.example.com".',
      );
    }
    return;
  }

  if (!DNS_HOSTNAME.test(dns.zoneName)) {
    fail(`dns.zoneName "${dns.zoneName}" is not a valid DNS host name.`);
  }
  if (!DNS_LABEL.test(dns.apiSubdomain)) {
    fail(`dns.apiSubdomain "${dns.apiSubdomain}" is not a valid DNS label.`);
  }
}

/**
 * Validates the application tier configuration. The Fargate cpu/memory pair is checked against the
 * combinations ECS accepts, and `latest` is rejected because the task definition must reference an
 * immutable image tag.
 */
function assertValidApplicationConfig(
  application: EnvironmentConfig['application'],
  fail: (message: string) => never,
): void {
  if (!Number.isInteger(application.desiredCount) || application.desiredCount < 0) {
    fail(`application.desiredCount must be a non-negative integer, got ${application.desiredCount}.`);
  }

  const allowedMemory = FARGATE_TASK_SIZES[application.cpu];
  if (allowedMemory === undefined) {
    fail(
      `application.cpu must be one of ${Object.keys(FARGATE_TASK_SIZES).join(', ')} Fargate CPU units, ` +
        `got ${application.cpu}.`,
    );
  } else if (!allowedMemory.includes(application.memoryLimitMiB)) {
    fail(
      `application.memoryLimitMiB ${application.memoryLimitMiB} is not a valid Fargate memory size for ` +
        `${application.cpu} CPU units. Expected one of: ${allowedMemory.join(', ')}.`,
    );
  }

  if (
    !Number.isInteger(application.containerPort) ||
    application.containerPort < 1 ||
    application.containerPort > 65535
  ) {
    fail(`application.containerPort must be between 1 and 65535, got ${application.containerPort}.`);
  }
  if (!application.healthCheckPath.startsWith('/')) {
    fail(`application.healthCheckPath must start with "/", got "${application.healthCheckPath}".`);
  }
  if (application.imageTag.trim() === '') {
    fail('application.imageTag must not be empty.');
  }
  if (application.imageTag.toLowerCase() === 'latest') {
    fail('application.imageTag must be an immutable tag; "latest" is not allowed.');
  }
}

/**
 * Validates the database tier configuration against the limits RDS enforces. The engine rejects an
 * invalid storage size, backup window or reserved user name when the instance is created, which is
 * the worst possible time to find out, so the same rules are checked here.
 */
function assertValidDatabaseConfig(
  database: EnvironmentConfig['database'],
  fail: (message: string) => never,
): void {
  if (!POSTGRES_IDENTIFIER.test(database.databaseName)) {
    fail(`database.databaseName "${database.databaseName}" is not a valid PostgreSQL identifier.`);
  }
  if (!POSTGRES_IDENTIFIER.test(database.masterUsername)) {
    fail(`database.masterUsername "${database.masterUsername}" is not a valid PostgreSQL identifier.`);
  }
  if (RESERVED_MASTER_USERNAMES.includes(database.masterUsername)) {
    fail(
      `database.masterUsername "${database.masterUsername}" is reserved by RDS. ` +
        `Expected anything but: ${RESERVED_MASTER_USERNAMES.join(', ')}.`,
    );
  }
  if (!Number.isInteger(database.allocatedStorageGb) || database.allocatedStorageGb < MIN_ALLOCATED_STORAGE_GB) {
    fail(
      `database.allocatedStorageGb must be an integer of at least ${MIN_ALLOCATED_STORAGE_GB} GiB, ` +
        `got ${database.allocatedStorageGb}.`,
    );
  }
  if (
    !Number.isInteger(database.backupRetentionDays) ||
    database.backupRetentionDays < 1 ||
    database.backupRetentionDays > MAX_BACKUP_RETENTION_DAYS
  ) {
    fail(
      `database.backupRetentionDays must be between 1 and ${MAX_BACKUP_RETENTION_DAYS} days ` +
        `(automated backups are required), got ${database.backupRetentionDays}.`,
    );
  }
  if (database.deletionProtection && database.removalPolicy === RemovalPolicy.DESTROY) {
    fail('database.deletionProtection cannot be enabled while database.removalPolicy is DESTROY.');
  }
}

