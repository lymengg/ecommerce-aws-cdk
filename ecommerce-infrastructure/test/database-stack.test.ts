import { App, RemovalPolicy } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { getEnvironmentConfig } from '../lib/config';
import { EnvironmentName } from '../lib/config/types';
import { DatabaseStack } from '../lib/stacks/database-stack';
import { NetworkStack } from '../lib/stacks/network-stack';

/**
 * Account used in the tests only, so that the synthesised template is environment specific. The
 * stacks themselves never hardcode an account id - test/config.test.ts enforces that.
 */
const TEST_ACCOUNT = '123456789012';

interface ResourceEntry {
  readonly logicalId: string;
  readonly properties: Record<string, any>;
}

interface BuiltStacks {
  readonly template: Template;
  readonly network: NetworkStack;
  readonly database: DatabaseStack;
}

/**
 * Builds the Phase 1 network stack and the Phase 3 database stack in one app, exactly as
 * `bin/ecommerce.ts` does, so the database security group really is the one the application tier is
 * allowed to reach.
 */
function buildStacks(environment: EnvironmentName): BuiltStacks {
  const app = new App();
  const config = getEnvironmentConfig(environment);
  const env = { account: TEST_ACCOUNT, region: config.region };

  const network = new NetworkStack(app, `test-network-${environment}`, { env, config });
  const database = new DatabaseStack(app, `test-database-${environment}`, {
    env,
    config,
    vpc: network.vpc,
    databaseSecurityGroup: network.securityGroups.database,
  });

  return { template: Template.fromStack(database), network, database };
}

function resourcesOfType(template: Template, type: string): ResourceEntry[] {
  return Object.entries(template.findResources(type)).map(([logicalId, resource]) => ({
    logicalId,
    properties: (resource as any).Properties ?? {},
  }));
}

function single(template: Template, type: string): ResourceEntry {
  const resources = resourcesOfType(template, type);
  expect(resources).toHaveLength(1);
  return resources[0];
}

/** Serialises a value so a token, whatever its shape, can be asserted against by substring. */
function json(value: unknown): string {
  return JSON.stringify(value);
}

function tagMap(properties: Record<string, any>): Record<string, string> {
  return Object.fromEntries(
    (properties.Tags ?? []).map((tag: { Key: string; Value: string }) => [tag.Key, tag.Value]),
  );
}

describe('DatabaseStack instance', () => {
  test('creates one PostgreSQL instance sized from the environment configuration', () => {
    const config = getEnvironmentConfig('dev');
    const instance = single(buildStacks('dev').template, 'AWS::RDS::DBInstance');

    expect(instance.properties).toMatchObject({
      Engine: 'postgres',
      EngineVersion: config.database.engineVersion.postgresFullVersion,
      DBInstanceClass: 'db.t4g.micro',
      AllocatedStorage: String(config.database.allocatedStorageGb),
      DBName: config.database.databaseName,
    });
  });

  test('uses a larger instance and more storage in production', () => {
    const instance = single(buildStacks('prod').template, 'AWS::RDS::DBInstance');

    expect(instance.properties).toMatchObject({
      DBInstanceClass: 'db.t4g.small',
      AllocatedStorage: '50',
      MultiAZ: true,
    });
  });

  test('names the instance per environment so environments never collide', () => {
    buildStacks('dev').template.hasResourceProperties('AWS::RDS::DBInstance', {
      DBInstanceIdentifier: 'ecommerce-dev-db',
    });
    buildStacks('prod').template.hasResourceProperties('AWS::RDS::DBInstance', {
      DBInstanceIdentifier: 'ecommerce-prod-db',
    });
  });
});

describe('DatabaseStack network placement', () => {
  test('is never publicly accessible', () => {
    for (const environment of ['dev', 'uat', 'prod'] as EnvironmentName[]) {
      const instance = single(buildStacks(environment).template, 'AWS::RDS::DBInstance');
      expect(instance.properties.PubliclyAccessible).toBe(false);
    }
  });

  test('is placed in the isolated database subnets of the network stack', () => {
    const { template } = buildStacks('dev');
    const subnetGroup = single(template, 'AWS::RDS::DBSubnetGroup');
    const referenced = json(subnetGroup.properties.SubnetIds);

    // Two isolated subnets, one per Availability Zone, and no application or public subnet.
    expect(subnetGroup.properties.SubnetIds).toHaveLength(2);
    expect(referenced).toContain('databaseSubnet1Subnet');
    expect(referenced).toContain('databaseSubnet2Subnet');
    expect(referenced).not.toContain('privateSubnet');
    expect(referenced).not.toContain('publicSubnet');
  });

  test('uses the network stack database security group and defines no group or rule of its own', () => {
    const { template } = buildStacks('dev');
    const instance = single(template, 'AWS::RDS::DBInstance');

    expect(instance.properties.VPCSecurityGroups).toHaveLength(1);
    expect(json(instance.properties.VPCSecurityGroups)).toContain('SecurityGroupsDatabase');

    // The 5432 rule already lives in the network stack; this stack must not create a group or a
    // rule, and must never open the database to a CIDR.
    template.resourceCountIs('AWS::EC2::SecurityGroup', 0);
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
    expect(json(template.toJSON())).not.toContain('0.0.0.0/0');
  });
});

describe('DatabaseStack data protection', () => {
  test('encrypts storage with the RDS managed key', () => {
    const instance = single(buildStacks('dev').template, 'AWS::RDS::DBInstance');

    expect(instance.properties).toMatchObject({ StorageEncrypted: true, StorageType: 'gp3' });
  });

  test('always has automated backups, with a longer window per environment', () => {
    expect(single(buildStacks('dev').template, 'AWS::RDS::DBInstance').properties.BackupRetentionPeriod).toBe(1);
    expect(single(buildStacks('uat').template, 'AWS::RDS::DBInstance').properties.BackupRetentionPeriod).toBe(7);
    expect(single(buildStacks('prod').template, 'AWS::RDS::DBInstance').properties.BackupRetentionPeriod).toBe(30);
  });

  test('is deletable in dev but protected and retained in production', () => {
    const dev = single(buildStacks('dev').template, 'AWS::RDS::DBInstance');
    expect(dev.properties.DeletionProtection).toBe(false);
    // `cdk destroy` in dev must not leave automated backups behind to bill for.
    expect(dev.properties.DeleteAutomatedBackups).toBe(true);
    buildStacks('dev').template.hasResource('AWS::RDS::DBInstance', { DeletionPolicy: 'Delete' });

    const prod = single(buildStacks('prod').template, 'AWS::RDS::DBInstance');
    expect(prod.properties.DeletionProtection).toBe(true);
    expect(prod.properties.DeleteAutomatedBackups).toBe(false);
    buildStacks('prod').template.hasResource('AWS::RDS::DBInstance', { DeletionPolicy: 'Retain' });
  });

  test('keeps a standby in production only', () => {
    expect(single(buildStacks('dev').template, 'AWS::RDS::DBInstance').properties.MultiAZ).toBe(false);
    expect(single(buildStacks('prod').template, 'AWS::RDS::DBInstance').properties.MultiAZ).toBe(true);
  });
});

describe('DatabaseStack credentials', () => {
  test('generates the password in Secrets Manager instead of writing it down', () => {
    const secret = single(buildStacks('dev').template, 'AWS::SecretsManager::Secret');

    expect(secret.properties.GenerateSecretString).toMatchObject({
      GenerateStringKey: 'password',
      ExcludePunctuation: true,
    });
    expect(secret.properties.GenerateSecretString.SecretStringTemplate).toContain('username');
    // No literal password anywhere in the template: it only exists inside Secrets Manager.
    expect(secret.properties).not.toHaveProperty('SecretString');
    expect(json(secret.properties)).not.toMatch(/"password"\s*:\s*"[^"]/);
  });

  test('reads the master password from the secret as a dynamic reference', () => {
    const instance = single(buildStacks('dev').template, 'AWS::RDS::DBInstance');

    // A plain user name (not a secret reference) so rotating the secret does not replace the
    // instance, and a dynamic reference for the password so it is never resolved at synth time.
    expect(instance.properties.MasterUsername).toBe('ecommerce');
    const password = json(instance.properties.MasterUserPassword);
    expect(password).toContain('{{resolve:secretsmanager:');
    expect(password).toContain(':SecretString:password::');
  });

  test('retains the secret with the instance in production and destroys it in dev', () => {
    buildStacks('prod').template.hasResource('AWS::SecretsManager::Secret', { DeletionPolicy: 'Retain' });
    buildStacks('dev').template.hasResource('AWS::SecretsManager::Secret', { DeletionPolicy: 'Delete' });
  });

  test('never grants an administrator, power user or wildcard policy', () => {
    const templateJson = JSON.stringify(buildStacks('prod').template.toJSON());

    expect(templateJson).not.toContain('AdministratorAccess');
    expect(templateJson).not.toContain('PowerUserAccess');
    expect(templateJson).not.toContain('arn:aws:iam::aws:policy');
  });
});

describe('DatabaseStack tags', () => {
  test('tags the instance and the secret with the project, environment and management tool', () => {
    const template = buildStacks('uat').template;

    for (const type of ['AWS::RDS::DBInstance', 'AWS::SecretsManager::Secret']) {
      const resources = resourcesOfType(template, type);
      expect(resources.length).toBeGreaterThan(0);

      for (const { logicalId, properties } of resources) {
        expect({ [type]: logicalId, ...tagMap(properties) }).toMatchObject({
          [type]: logicalId,
          Project: 'Ecommerce',
          Environment: 'uat',
          ManagedBy: 'CDK',
        });
      }
    }
  });
});

describe('DatabaseStack outputs', () => {
  test('exports the endpoint, port, database name and secret arn', () => {
    const template = buildStacks('dev').template;

    template.hasOutput('DatabaseEndpoint', { Export: { Name: 'ecommerce-dev-db-endpoint' } });
    template.hasOutput('DatabasePort', { Export: { Name: 'ecommerce-dev-db-port' } });
    template.hasOutput('DatabaseName', { Export: { Name: 'ecommerce-dev-db-name' } });
    template.hasOutput('CredentialsSecretArn', { Export: { Name: 'ecommerce-dev-db-secret-arn' } });
  });

  test('uses environment specific export names so environments do not clash', () => {
    const outputs = buildStacks('prod').template.toJSON().Outputs;

    expect(outputs.DatabaseEndpoint.Export.Name).toBe('ecommerce-prod-db-endpoint');
    expect(outputs.CredentialsSecretArn.Export.Name).toBe('ecommerce-prod-db-secret-arn');
  });
});

describe('DatabaseStack removal policy', () => {
  test('follows the environment removal policy', () => {
    expect(getEnvironmentConfig('dev').database.removalPolicy).toBe(RemovalPolicy.DESTROY);
    expect(getEnvironmentConfig('uat').database.removalPolicy).toBe(RemovalPolicy.RETAIN);
    expect(getEnvironmentConfig('prod').database.removalPolicy).toBe(RemovalPolicy.RETAIN);
  });
});
