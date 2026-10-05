import { Duration, RemovalPolicy } from 'aws-cdk-lib';

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

/**
 * Cognito's real password length limits. Asking for a shorter or longer minimum makes the user pool
 * fail to create, which is far too late to discover.
 */
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 99;

/** Cognito accepts an access/ID token lifetime between 5 minutes and 1 day. */
const MIN_TOKEN_VALIDITY = Duration.minutes(5);
const MAX_TOKEN_VALIDITY = Duration.days(1);

/** Cognito accepts a refresh token lifetime between 60 minutes and 10 years. */
const MIN_REFRESH_TOKEN_VALIDITY = Duration.minutes(60);
const MAX_REFRESH_TOKEN_VALIDITY = Duration.days(3650);

/**
 * An absolute web origin: scheme, host and optional port, with nothing after it. A wildcard, a
 * trailing slash, a path or a bare hostname are all rejected - the value goes into an
 * `Access-Control-Allow-Origin` header that is returned together with credentials, so it has to be
 * exactly the origin the browser sends and never `*`.
 */
const WEB_ORIGIN = /^https?:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;

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
  assertValidFrontendConfig(config.frontend, fail);
  assertValidDatabaseConfig(config.database, fail);
  assertValidDnsConfig(config, fail);
  assertValidAuthConfig(config, fail);
}

/**
 * Validates the authentication configuration against Cognito's real limits and the BFF's own
 * constraints.
 *
 * The user pool and app client reject an out-of-range password length or token lifetime at deploy
 * time, so the same rules are checked here. Two constraints are not Cognito's at all but the
 * platform's: the BFF keeps its session in memory, so it must run as a single task (see
 * {@link assertValidApplicationConfig}), and its `Secure` session cookie only works over HTTPS, so
 * an authentication-enabled environment must have a delegated domain. Auth is never optional in
 * this phase, so a configuration with `auth` but no `dns` is always rejected - the message says why,
 * because "add a domain" is not an obvious fix for a missing CORS origin.
 */
function assertValidAuthConfig(config: EnvironmentConfig, fail: (message: string) => never): void {
  const { auth } = config;

  if (
    !Number.isInteger(auth.passwordMinimumLength) ||
    auth.passwordMinimumLength < MIN_PASSWORD_LENGTH ||
    auth.passwordMinimumLength > MAX_PASSWORD_LENGTH
  ) {
    fail(
      `auth.passwordMinimumLength must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} ` +
        `characters, got ${auth.passwordMinimumLength}.`,
    );
  }

  assertTokenValidity('auth.accessTokenValidity', auth.accessTokenValidity, MIN_TOKEN_VALIDITY, MAX_TOKEN_VALIDITY, fail);
  assertTokenValidity('auth.idTokenValidity', auth.idTokenValidity, MIN_TOKEN_VALIDITY, MAX_TOKEN_VALIDITY, fail);
  assertTokenValidity(
    'auth.refreshTokenValidity',
    auth.refreshTokenValidity,
    MIN_REFRESH_TOKEN_VALIDITY,
    MAX_REFRESH_TOKEN_VALIDITY,
    fail,
  );

  // The session must not outlive the refresh token, or the BFF could hold a session it can no
  // longer refresh and the user would be signed out with an unhandled error instead of silently
  // re-authenticated.
  if (auth.sessionTimeout.toSeconds() <= 0) {
    fail('auth.sessionTimeout must be a positive duration.');
  }
  if (auth.sessionTimeout.toSeconds() > auth.refreshTokenValidity.toSeconds()) {
    fail(
      'auth.sessionTimeout must not exceed auth.refreshTokenValidity, or the BFF could hold a ' +
        'session it can no longer refresh.',
    );
  }

  if (auth.allowedOrigins.length === 0) {
    fail('auth.allowedOrigins must contain at least one frontend origin; the API answers with credentials.');
  }
  for (const origin of auth.allowedOrigins) {
    if (origin === '*' || !WEB_ORIGIN.test(origin)) {
      fail(
        `auth.allowedOrigins entry "${origin}" is not an absolute origin. Expected "scheme://host[:port]" ` +
          'and never "*", because credentials are allowed.',
      );
    }
  }

  // The frontend URL is registered with Cognito as an exact logout URI and is the OAuth2 login
  // success target, so a relative or wildcard value would make the app client fail to create (or
  // send the browser somewhere it should not go).
  if (auth.frontendUrl === '*' || !WEB_ORIGIN.test(auth.frontendUrl)) {
    fail(
      `auth.frontendUrl "${auth.frontendUrl}" is not an absolute origin. Expected "scheme://host[:port]" ` +
        'and never "*".',
    );
  }

  if (config.dns === undefined) {
    fail(
      'authentication requires a delegated domain (config.dns): the BFF session cookie is `Secure`, ' +
        'so the API must answer over HTTPS. Set the environment\'s domain variable, for example ' +
        'ECOMMERCE_DEV_DOMAIN.',
    );
  }
}

/** Checks that a Cognito token lifetime falls inside the range the service accepts. */
function assertTokenValidity(
  name: string,
  value: Duration,
  minimum: Duration,
  maximum: Duration,
  fail: (message: string) => never,
): void {
  if (value.toSeconds() < minimum.toSeconds() || value.toSeconds() > maximum.toSeconds()) {
    fail(
      `${name} must be between ${minimum.toHumanString()} and ${maximum.toHumanString()}, got ` +
        `${value.toHumanString()}.`,
    );
  }
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
  if (!DNS_LABEL.test(dns.authSubdomain)) {
    fail(`dns.authSubdomain "${dns.authSubdomain}" is not a valid DNS label.`);
  }
  // Both labels get an alias record in the zone; identical values would make two stacks fight over
  // the same record name.
  if (dns.authSubdomain === dns.apiSubdomain) {
    fail(`dns.authSubdomain must differ from dns.apiSubdomain, got "${dns.authSubdomain}" for both.`);
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
  // Phase 4 keeps the BFF's HTTP sessions in memory. Two tasks would each hold a different copy of
  // the session store, so a request load balanced to the wrong task would look signed out - a bug
  // that only appears under load. Until sessions move to an external store (Redis/ElastiCache,
  // Phase 6) the service must run as exactly one task, and this guard makes that enforceable rather
  // than a comment someone can overlook when enabling auto scaling. Remove it when the session
  // store is externalised.
  if (application.desiredCount > 1) {
    fail(
      `application.desiredCount must be 1 while the BFF holds sessions in memory (got ` +
        `${application.desiredCount}). Auto scaling would split the session store and break login; ` +
        'externalise sessions to Redis/ElastiCache (Phase 6) before raising it.',
    );
  }

  assertValidFargateSize('application', application.cpu, application.memoryLimitMiB, fail);
  assertValidContainer('application', application, fail);
}

/**
 * Validates the static frontend tier. Same checks as the API tier - a Fargate size ECS accepts, a
 * valid port, an absolute health check path and an immutable image tag - but **without** the
 * single-task guard: nginx holds no session, so scaling it out is safe.
 */
function assertValidFrontendConfig(frontend: EnvironmentConfig['frontend'], fail: (message: string) => never): void {
  if (!Number.isInteger(frontend.desiredCount) || frontend.desiredCount < 0) {
    fail(`frontend.desiredCount must be a non-negative integer, got ${frontend.desiredCount}.`);
  }

  assertValidFargateSize('frontend', frontend.cpu, frontend.memoryLimitMiB, fail);
  assertValidContainer('frontend', frontend, fail);
}

/** The cpu/memory pair has to be one Fargate actually offers. */
function assertValidFargateSize(
  name: string,
  cpu: number,
  memoryLimitMiB: number,
  fail: (message: string) => never,
): void {
  const allowedMemory = FARGATE_TASK_SIZES[cpu];
  if (allowedMemory === undefined) {
    fail(`${name}.cpu must be one of ${Object.keys(FARGATE_TASK_SIZES).join(', ')} Fargate CPU units, got ${cpu}.`);
  } else if (!allowedMemory.includes(memoryLimitMiB)) {
    fail(
      `${name}.memoryLimitMiB ${memoryLimitMiB} is not a valid Fargate memory size for ${cpu} CPU units. ` +
        `Expected one of: ${allowedMemory.join(', ')}.`,
    );
  }
}

/** The container-facing settings both tiers share: port, health check path and image tag. */
function assertValidContainer(
  name: string,
  container: { containerPort: number; healthCheckPath: string; imageTag: string },
  fail: (message: string) => never,
): void {
  if (!Number.isInteger(container.containerPort) || container.containerPort < 1 || container.containerPort > 65535) {
    fail(`${name}.containerPort must be between 1 and 65535, got ${container.containerPort}.`);
  }
  if (!container.healthCheckPath.startsWith('/')) {
    fail(`${name}.healthCheckPath must start with "/", got "${container.healthCheckPath}".`);
  }
  if (container.imageTag.trim() === '') {
    fail(`${name}.imageTag must not be empty.`);
  }
  if (container.imageTag.toLowerCase() === 'latest') {
    fail(`${name}.imageTag must be an immutable tag; "latest" is not allowed.`);
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

